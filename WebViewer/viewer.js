/* SG-City offline WebGL viewer — zero dependencies.
 * Daylight engineering view: green land parcels bounded by continuous
 * streets with kerbs and centre markings, plus along-road name labels.
 * Includes POI labels and search-to-fly navigation. */
'use strict';

(function () {
  var DATA_BASE = '/LocalData/SGCityData';
  var LAYER_LABELS = {
    terrain: '地形/地块',
    water: '水面',
    roads: '道路',
    rail: '地铁/轻轨',
    buildings: '建筑',
  };

  /* Per-material visual tuning (applied by material name). */
  var MATERIAL_TUNE = {
    roadMajor: { emissiveScale: 2.6 },
    roadSecondary: { emissiveScale: 2.6 },
    roadMinor: { emissiveScale: 2.4 },
    roadCasing: { emissiveScale: 2.0 },
    roadMarking: { emissiveScale: 2.2 },
    windowCyan: { emissiveScale: 2.4 },
    windowWarm: { emissiveScale: 2.4 },
    water: { baseColorScale: [0.8, 0.9, 1.0] },
    roof: { baseColorScale: [1.1, 1.1, 1.25] },
    facade: { emissiveScale: 1.0 },
  };

  /* Well-known Marina Bay landmarks — always shown when in view. */
  var LANDMARK_NAMES = [
    'Marina Bay Sands', 'Merlion', 'Gardens by the Bay', 'Esplanade',
    'ArtScience', 'Singapore Flyer', 'Fullerton', 'Raffles Hotel',
    'Helix', 'Flower Dome', 'Cloud Forest', 'Lau Pa Sat',
    'One Raffles', 'UOB Plaza', 'OCBC Centre', 'Ocean Financial',
    'Asia Square', 'Marina One', 'The Sail', 'Millenia Tower',
    'Suntec', 'National Gallery', 'Victoria Theatre', 'Fort Canning',
    'Clarke Quay', 'Boat Quay', 'China Square', 'Apple Marina Bay Sands',
    'Raffles Place', 'Clifford Pier', 'Bayfront',
    'Botanic Garden', 'Singapore Botanic', 'Orchard', 'Istana',
    'Sentosa', 'Resorts World', 'VivoCity', 'HarbourFront', 'Mount Faber',
    'Chinatown', 'Bugis', 'National Museum', 'City Hall',
  ];
  var LANDMARK_KINDS = {
    attraction: 1, museum: 1, casino: 1, viewpoint: 1,
    arts_centre: 1, gallery: 1, theatre: 1, aquarium: 1,
    theme_park: 1, ferry_terminal: 1,
  };

  var canvas = document.getElementById('scene');
  var statusEl = document.getElementById('status');
  var layersEl = document.getElementById('layers');
  var statsEl = document.getElementById('stats');
  var labelsEl = document.getElementById('labels');
  var searchInput = document.getElementById('search');
  var searchList = document.getElementById('search-list');
  var todToggle = document.getElementById('tod-toggle');
  var hlCanvas = document.getElementById('highlight');
  var hlCtx = hlCanvas.getContext('2d');
  var roadPanelEl = document.getElementById('road-panel');
  var roadFilterEl = document.getElementById('road-filter');
  var roadListEl = document.getElementById('road-list');
  var roadClearEl = document.getElementById('road-clear');

  var gl = canvas.getContext('webgl2', { antialias: true });
  var isWebGL2 = !!gl;
  if (!gl) {
    gl = canvas.getContext('webgl', { antialias: true });
    if (gl) gl.getExtension('OES_element_index_uint');
  }
  if (!gl) {
    statusEl.textContent = '此浏览器不支持 WebGL，无法渲染三维城市。';
    statusEl.classList.add('error');
    return;
  }

  /* ---------- shaders ---------- */
  var VS = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'varying vec3 vNormal;',
    'varying vec3 vWorld;',
    'void main() {',
    '  vNormal = aNormal;',
    '  vWorld = aPos;',
    '  gl_Position = uProj * uView * vec4(aPos, 1.0);',
    '}',
  ].join('\n');

  var FS = [
    'precision mediump float;',
    'varying vec3 vNormal;',
    'varying vec3 vWorld;',
    'uniform vec3 uBaseColor;',
    'uniform vec3 uEmissive;',
    'uniform vec3 uAmbient;',
    'uniform vec3 uLightDir;',
    'uniform vec3 uLightColor;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uFogColor;',
    'uniform float uFogDensity;',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  float diff = max(dot(n, normalize(uLightDir)), 0.0);',
    '  vec3 color = uBaseColor * (uAmbient + uLightColor * diff) + uEmissive;',
    '  float d = length(vWorld - uCamPos);',
    '  float fog = 1.0 - exp(-pow(d * uFogDensity, 2.0));',
    '  color = mix(color, uFogColor, clamp(fog, 0.0, 1.0));',
    '  color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));',
    '  gl_FragColor = vec4(color, 1.0);',
    '}',
  ].join('\n');

  /* Street lamp point sprites (warm glow). */
  var VS_POINTS = [
    'attribute vec3 aPos;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'uniform float uPixelRatio;',
    'varying float vFade;',
    'void main() {',
    '  vec4 mv = uView * vec4(aPos, 1.0);',
    '  float dist = max(length(mv.xyz), 1.0);',
    '  gl_PointSize = clamp(uPixelRatio * 900.0 / dist, 2.0, 13.0);',
    '  vFade = clamp(320.0 / dist, 0.12, 1.0);',
    '  gl_Position = uProj * mv;',
    '}',
  ].join('\n');

  var FS_POINTS = [
    'precision mediump float;',
    'varying float vFade;',
    'uniform float uDayFade;',
    'void main() {',
    '  vec2 c = gl_PointCoord * 2.0 - 1.0;',
    '  float r2 = dot(c, c);',
    '  if (r2 > 1.0) discard;',
    '  float glow = exp(-r2 * 3.5) * vFade * uDayFade;',
    '  gl_FragColor = vec4(vec3(1.0, 0.72, 0.36) * glow, glow);',
    '}',
  ].join('\n');

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function createProgram(vsSource, fsSource) {
    var program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Shader link failed: ' + gl.getProgramInfoLog(program));
    }
    return program;
  }

  var program, programPoints;
  try {
    program = createProgram(VS, FS);
    programPoints = createProgram(VS_POINTS, FS_POINTS);
  } catch (err) {
    statusEl.textContent = '着色器编译失败: ' + err.message;
    statusEl.classList.add('error');
    return;
  }

  var u = {};
  gl.useProgram(program);
  ['aPos', 'aNormal'].forEach(function (name) {
    u[name] = gl.getAttribLocation(program, name);
  });
  ['uProj', 'uView', 'uBaseColor', 'uEmissive', 'uAmbient', 'uLightDir',
    'uLightColor', 'uCamPos', 'uFogColor', 'uFogDensity'].forEach(function (name) {
    u[name] = gl.getUniformLocation(program, name);
  });

  var up = {};
  gl.useProgram(programPoints);
  up.aPos = gl.getAttribLocation(programPoints, 'aPos');
  up.uProj = gl.getUniformLocation(programPoints, 'uProj');
  up.uView = gl.getUniformLocation(programPoints, 'uView');
  up.uPixelRatio = gl.getUniformLocation(programPoints, 'uPixelRatio');
  up.uDayFade = gl.getUniformLocation(programPoints, 'uDayFade');

  /* Day / night lighting presets (linear space, gamma applied in shader). */
  var NIGHT = {
    ambient: [0.008, 0.026, 0.03],
    lightDir: [-0.45, 0.8, -0.4],
    lightColor: [0.22, 0.4, 0.45],
    fogColor: [0.005, 0.038, 0.048],
    fogDensity: 0.00011,
  };
  var DAY = {
    ambient: [0.55, 0.58, 0.62],
    lightDir: [-0.32, 0.78, -0.5],
    lightColor: [1.05, 1.0, 0.92],
    fogColor: [0.82, 0.86, 0.88],
    fogDensity: 0.000025,
  };

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function lerp3(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }

  var dayAmount = 1;   // 0 = night, 1 = day (daylight engineering view default)
  var dayTarget = 1;

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(DAY.fogColor[0], DAY.fogColor[1], DAY.fogColor[2], 1.0);

  /* ---------- tiny matrix helpers (column-major) ---------- */
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var nf = 1 / (near - far);
    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ];
  }

  function norm3(v) {
    var len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }
  function cross3(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function sub3(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function lookAt(eye, center, upv) {
    var z = norm3(sub3(eye, center));
    var x = norm3(cross3(upv, z));
    var y = cross3(z, x);
    return [
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
      1,
    ];
  }

  function mat4Multiply(a, b) {
    var out = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        var s = 0;
        for (var k = 0; k < 4; k++) {
          s += a[k * 4 + r] * b[c * 4 + k];
        }
        out[c * 4 + r] = s;
      }
    }
    return out;
  }

  /* Project a world-space point to CSS pixel coordinates. */
  function projectPoint(world, viewProj, w, h) {
    var x = world[0], y = world[1], z = world[2];
    var cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    var cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    var cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (cw <= 1) return null;
    return [(cx / cw * 0.5 + 0.5) * w, (1 - (cy / cw * 0.5 + 0.5)) * h, cw];
  }

  /* ---------- camera ---------- */
  var DEFAULT_CAM = {
    target: [0, 40, 0],
    yaw: -0.12,
    pitch: 0.3,
    dist: 10000,
  };
  var camera = {
    target: DEFAULT_CAM.target.slice(),
    yaw: DEFAULT_CAM.yaw,
    pitch: DEFAULT_CAM.pitch,
    dist: DEFAULT_CAM.dist,
  };
  var fly = null; // {from, to, t}

  function cameraEye() {
    var cp = Math.cos(camera.pitch);
    return [
      camera.target[0] + camera.dist * cp * Math.sin(camera.yaw),
      camera.target[1] + camera.dist * Math.sin(camera.pitch),
      camera.target[2] + camera.dist * cp * Math.cos(camera.yaw),
    ];
  }

  function resetCamera() {
    flyTo(DEFAULT_CAM.target.slice(), DEFAULT_CAM.dist, 1.2);
  }

  function flyTo(target, dist, duration) {
    fly = {
      fromTarget: camera.target.slice(),
      toTarget: target.slice(),
      fromDist: camera.dist,
      toDist: dist,
      fromYaw: camera.yaw,
      toYaw: DEFAULT_CAM.yaw,
      t: 0,
      duration: duration || 1.6,
    };
  }

  /* ---------- state ---------- */
  var layers = [];
  var totalTriangles = 0;
  var origin = null; // {lon, lat, height}
  var pois = [];     // {name, kind, x, z, el, tier}
  var poiByName = {};
  var roadLabels = []; // {name, tier, x, z, dx, dz, hw, el}
  var roadNameCount = 0;
  var roadIndex = {};      // name -> {name, roadClass, ref, lines:[[x,z]..], cx, cz, extent}
  var selectedRoad = null; // highlighted road entry
  var selectedPlace = null; // {x, z, name}
  var groundSampler = null; // coarse client-side ground height for the overlay
  var lampCount = 0;
  var lampBuf = null;

  /* lng/lat -> local meters (x = east, z = south; GLB Y is up). */
  var M_PER_DEG_LAT = 110574;
  function toLocal(lon, lat) {
    var mPerDegLon = 111320 * Math.cos(origin.latitude * Math.PI / 180);
    return [
      (lon - origin.longitude) * mPerDegLon,
      -(lat - origin.latitude) * M_PER_DEG_LAT,
    ];
  }

  /* ---------- data loading ---------- */
  function fetchJson(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + url);
      return res.json();
    });
  }

  /* Resolve a tileset-relative content URI without new URL(): relative base
   * URLs are valid for fetch but throw "Invalid base URL" in the constructor. */
  function resolveRelative(baseUrl, uri) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(uri)) {
      return uri;
    }
    return baseUrl.slice(0, baseUrl.lastIndexOf('/') + 1) + uri;
  }

  function loadLayer(layerMeta) {
    var tilesetUrl = DATA_BASE + '/' + layerMeta.entry;
    return fetchJson(tilesetUrl).then(function (tileset) {
      var root = tileset.root || {};
      var content = root.content || (root.contents && root.contents[0]);
      if (!content || !content.uri) {
        throw new Error(layerMeta.id + ': tileset 缺少 content');
      }
      var glbUrl = resolveRelative(tilesetUrl, content.uri);
      return fetch(glbUrl).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + glbUrl);
        return res.arrayBuffer();
      }).then(function (buffer) {
        var parsed = SGCityGLB.parseGLB(buffer);
        return {
          id: layerMeta.id,
          label: LAYER_LABELS[layerMeta.id] || layerMeta.id,
          visible: layerMeta.visible !== false,
          parsed: parsed,
          gpu: [],
        };
      });
    });
  }

  /* ---------- material tuning ---------- */
  function tuneMaterial(m) {
    var tune = MATERIAL_TUNE[m.name];
    if (!tune) {
      if (/^rail_/.test(m.name)) tune = { emissiveScale: 2.2 };
      else return m;
    }
    var out = {
      name: m.name,
      baseColor: m.baseColor.slice(),
      emissive: m.emissive.slice(),
      doubleSided: m.doubleSided,
    };
    if (tune.baseColorScale) {
      out.baseColor[0] *= tune.baseColorScale[0];
      out.baseColor[1] *= tune.baseColorScale[1];
      out.baseColor[2] *= tune.baseColorScale[2];
    }
    if (tune.emissiveScale) {
      out.emissive[0] *= tune.emissiveScale;
      out.emissive[1] *= tune.emissiveScale;
      out.emissive[2] *= tune.emissiveScale;
    }
    if (tune.emissive) {
      out.emissive = tune.emissive.slice();
    }
    return out;
  }

  /* Material presets for the daylight engineering view: matches the reference
   * night-render palette — bright steel-blue carriageways read as continuous
   * solid bands against dark, varied green parcels (no "all green" ambiguity,
   * and dark asphalt no longer blends into the ground at distance). */
  var DAY_MATERIAL = {
    roadMajor: { baseColor: [0.115, 0.205, 0.315] },
    roadSecondary: { baseColor: [0.105, 0.190, 0.295] },
    roadMinor: { baseColor: [0.095, 0.175, 0.275] },
    roadTunnel: { baseColor: [0.055, 0.100, 0.165] },
    roadCasing: { baseColor: [0.185, 0.300, 0.420] },
    roadMarking: { baseColor: [0.82, 0.84, 0.87] },
    water: { baseColor: [0.010, 0.045, 0.110] },
    ground: { baseColor: [0.020, 0.085, 0.036] },
    groundFlat: { baseColor: [0.008, 0.022, 0.017] },
    block0: { baseColor: [0.020, 0.090, 0.038] },
    block1: { baseColor: [0.032, 0.135, 0.052] },
    block2: { baseColor: [0.048, 0.180, 0.068] },
    block3: { baseColor: [0.026, 0.110, 0.045] },
    parcel0: { baseColor: [0.008, 0.020, 0.016] },
    parcel1: { baseColor: [0.010, 0.026, 0.020] },
    parcel2: { baseColor: [0.012, 0.032, 0.024] },
    parcel3: { baseColor: [0.009, 0.023, 0.018] },
    roof: { baseColor: [0.030, 0.055, 0.100] },
    facade: { baseColor: [0.055, 0.110, 0.160] },
    windowCyan: { baseColor: [0.10, 0.22, 0.26] },
    windowWarm: { baseColor: [0.22, 0.20, 0.15] },
  };

  function tuneDayMaterial(m) {
    var tune = DAY_MATERIAL[m.name];
    var out = {
      name: m.name,
      baseColor: m.baseColor.slice(),
      emissive: [0, 0, 0],
      doubleSided: m.doubleSided,
    };
    if (/^rail_/.test(m.name)) {
      // Transit lines: keep their line colour, drop the emissive glow by day.
      return out;
    }
    if (tune) {
      out.baseColor = tune.baseColor.slice();
    } else {
      // Unknown material: lift the dark night base toward a daylight tone.
      for (var i = 0; i < 3; i++) {
        out.baseColor[i] = Math.min(1, m.baseColor[i] * 2.2 + 0.35);
      }
    }
    return out;
  }

  function uploadLayer(layer) {
    var fallbackMaterial = {
      name: '', baseColor: [0.5, 0.5, 0.5], emissive: [0, 0, 0], doubleSided: true,
    };
    layer.parsed.primitives.forEach(function (prim) {
      var positions = new Float32Array(prim.positions.length * 3);
      for (var i = 0; i < prim.positions.length; i++) {
        var p = prim.positions[i];
        positions[i * 3] = p[0];
        positions[i * 3 + 1] = p[1];
        positions[i * 3 + 2] = p[2];
      }
      var normals = new Float32Array(prim.positions.length * 3);
      if (prim.normals) {
        for (var n = 0; n < prim.normals.length; n++) {
          var nv = prim.normals[n];
          normals[n * 3] = nv[0];
          normals[n * 3 + 1] = nv[1];
          normals[n * 3 + 2] = nv[2];
        }
      }

      var posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

      var nrmBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
      gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);

      var idxBuf = null;
      var count = 0;
      if (prim.indices && prim.indices.length) {
        var indices = new Uint32Array(prim.indices);
        count = indices.length;
        idxBuf = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      } else {
        count = prim.positions.length;
      }

      totalTriangles += Math.floor(count / 3);
      var nightMat = tuneMaterial(
        layer.parsed.materials[prim.materialIndex] || fallbackMaterial);
      layer.gpu.push({
        posBuf: posBuf,
        nrmBuf: nrmBuf,
        idxBuf: idxBuf,
        count: count,
        material: nightMat,
        dayMaterial: tuneDayMaterial(nightMat),
      });
    });
  }

  /* ---------- street lamps: warm glow points sampled along roads ---------- */
  function buildStreetLamps() {
    var roads = null;
    for (var i = 0; i < layers.length; i++) {
      if (layers[i].id === 'roads') roads = layers[i];
    }
    if (!roads) return;

    var pts = [];
    roads.parsed.primitives.forEach(function (prim) {
      var pos = prim.positions;
      var step = Math.max(24, Math.floor(pos.length / 1100));
      for (var i = 0; i < pos.length; i += step) {
        var v = pos[i];
        pts.push(v[0], v[1] + 0.8, v[2]);
      }
    });
    lampCount = Math.floor(pts.length / 3);
    lampBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, lampBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
  }

  /* ---------- POI labels & search ---------- */
  function loadPois() {
    return fetchJson(DATA_BASE + '/search.json').then(function (index) {
      var seen = {};
      Object.keys(index).forEach(function (key) {
        var e = index[key];
        if (!e || !e.name || seen[e.name]) return;
        seen[e.name] = true;
        var local = toLocal(e.longitude, e.latitude);
        var lower = e.name.toLowerCase();
        var isLandmark = false;
        for (var li = 0; li < LANDMARK_NAMES.length; li++) {
          if (lower.indexOf(LANDMARK_NAMES[li].toLowerCase()) !== -1) {
            isLandmark = true;
            break;
          }
        }
        var kindWeight = LANDMARK_KINDS[e.kind] ? 1 : 0;
        var tier = isLandmark ? 0 : (kindWeight ? 1 : (e.kind === 'building' ? 2 : -1));
        if (tier < 0) return;
        pois.push({
          name: e.name,
          kind: e.kind,
          x: local[0],
          z: local[1],
          tier: tier,
          hw: textWidthPx(e.name, tier === 0 ? 14 : tier === 1 ? 12 : 10) / 2 + 8,
          el: null,
        });
        poiByName[e.name] = local;
      });

      // Populate the search datalist with ALL named entries.
      var frag = document.createDocumentFragment();
      Object.keys(index).forEach(function (key) {
        var e = index[key];
        if (!e || !e.name) return;
        var local = toLocal(e.longitude, e.latitude);
        poiByName[e.name] = local;
        var option = document.createElement('option');
        option.value = e.name;
        frag.appendChild(option);
      });
      searchList.innerHTML = '';
      searchList.appendChild(frag);

      pois.forEach(function (poi) {
        var el = document.createElement('div');
        el.className = 'poi-label tier' + poi.tier;
        el.innerHTML = '<i></i><span></span>';
        el.lastChild.textContent = poi.name;
        el.title = poi.kind;
        el.addEventListener('click', function () {
          selectedRoad = null;
          selectedPlace = { x: poi.x, z: poi.z, name: poi.name };
          if (roadPanelEl._rerender) roadPanelEl._rerender();
          flyTo([poi.x, 60, poi.z], 900, 1.4);
        });
        labelsEl.appendChild(el);
        poi.el = el;
      });
    });
  }

  /* ---------- along-road name labels ---------- */
  function textWidthPx(text, fontSize) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      w += text.charCodeAt(i) > 0x2e7f ? fontSize : fontSize * 0.56;
    }
    return w;
  }

  function loadRoadNames() {
    return fetchJson(DATA_BASE + '/road-names.json').then(function (roads) {
      roadNameCount = roads.length;
      var SPACING = [320, 430, 560];
      var MAX_PER_LINE = [14, 10, 6];
      roads.forEach(function (road) {
        var tier = road.roadClass === 'roadMajor' ? 0 :
                   road.roadClass === 'roadSecondary' ? 1 : 2;
        var fontSize = tier === 0 ? 12 : tier === 1 ? 11 : 10;
        var hw = textWidthPx(road.name, fontSize) / 2 + 5;
        var entry = { name: road.name, roadClass: road.roadClass, ref: road.ref || '', tier: tier, lines: [] };
        var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        road.lines.forEach(function (line) {
          var pts = line.map(function (c) { return toLocal(c[0], c[1]); });
          entry.lines.push(pts);
          for (var pi = 0; pi < pts.length; pi++) {
            minX = Math.min(minX, pts[pi][0]); maxX = Math.max(maxX, pts[pi][0]);
            minZ = Math.min(minZ, pts[pi][1]); maxZ = Math.max(maxZ, pts[pi][1]);
          }
          var cum = [0];
          for (var i = 1; i < pts.length; i++) {
            cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
          }
          var total = cum[cum.length - 1];
          if (total < 60) return;
          var count = Math.min(MAX_PER_LINE[tier], Math.max(1, Math.floor(total / SPACING[tier])));
          for (var k = 0; k < count; k++) {
            var target = total * (k + 0.5) / count;
            var si = 1;
            while (si < cum.length - 1 && cum[si] < target) si++;
            var segLen = Math.max(1e-6, cum[si] - cum[si - 1]);
            var t = (target - cum[si - 1]) / segLen;
            var ax = pts[si - 1][0] + (pts[si][0] - pts[si - 1][0]) * t;
            var az = pts[si - 1][1] + (pts[si][1] - pts[si - 1][1]) * t;
            var dx = pts[si][0] - pts[si - 1][0];
            var dz = pts[si][1] - pts[si - 1][1];
            var dl = Math.hypot(dx, dz) || 1;
            var el = document.createElement('div');
            el.className = 'road-label tier' + tier;
            el.textContent = road.name;
            el.title = road.ref ? road.name + ' · ' + road.ref : road.name;
            (function (n) {
              el.addEventListener('click', function () { selectRoad(n); });
            })(road.name);
            labelsEl.appendChild(el);
            roadLabels.push({ name: road.name, tier: tier, x: ax, z: az, dx: dx / dl, dz: dz / dl, hw: hw, el: el });
          }
        });
        if (entry.lines.length) {
          entry.cx = (minX + maxX) / 2;
          entry.cz = (minZ + maxZ) / 2;
          entry.extent = Math.max(maxX - minX, maxZ - minZ);
          roadIndex[road.name] = entry;
        }
      });
      buildRoadPanel();
    });
  }

  /* ---------- right panel: filter built roads, click to highlight ---------- */
  var ROAD_TAG = ['主干', '次干', '支路'];
  function buildRoadPanel() {
    var names = Object.keys(roadIndex).sort(function (a, b) {
      var ta = roadIndex[a].tier, tb = roadIndex[b].tier;
      return ta !== tb ? ta - tb : a.localeCompare(b);
    });
    function render(filter) {
      var f = (filter || '').trim().toLowerCase();
      roadListEl.innerHTML = '';
      var frag = document.createDocumentFragment();
      var shown = 0;
      for (var i = 0; i < names.length && shown < 400; i++) {
        var name = names[i];
        var entry = roadIndex[name];
        if (f && name.toLowerCase().indexOf(f) === -1 &&
            entry.ref.toLowerCase().indexOf(f) === -1) continue;
        shown++;
        var row = document.createElement('button');
        row.className = 'road-row' + (selectedRoad && selectedRoad.name === name ? ' active' : '');
        row.type = 'button';
        var tag = document.createElement('span');
        tag.className = 'tag t' + entry.tier;
        tag.textContent = ROAD_TAG[entry.tier];
        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = entry.ref ? name + ' · ' + entry.ref : name;
        row.appendChild(tag);
        row.appendChild(nm);
        (function (n) {
          row.addEventListener('click', function () { selectRoad(n); });
        })(name);
        frag.appendChild(row);
      }
      roadListEl.appendChild(frag);
    }
    roadFilterEl.addEventListener('input', function () { render(roadFilterEl.value); });
    render('');
    roadPanelEl._rerender = function () { render(roadFilterEl.value); };
  }

  function selectRoad(name) {
    var entry = roadIndex[name];
    if (!entry) return;
    selectedRoad = entry;
    selectedPlace = null;
    var dist = Math.min(6000, Math.max(420, entry.extent * 1.15));
    flyTo([entry.cx, 40, entry.cz], dist, 1.4);
    statusEl.textContent = '高亮道路: ' + name + (entry.ref ? ' · ' + entry.ref : '');
    statusEl.classList.remove('error');
    if (roadPanelEl._rerender) roadPanelEl._rerender();
  }

  function clearSelection() {
    selectedRoad = null;
    selectedPlace = null;
    if (roadPanelEl._rerender) roadPanelEl._rerender();
  }

  /* Coarse ground-height sampler rebuilt from the terrain mesh so the 2D
     highlight overlay hugs the draped road surface on slopes. */
  function buildGroundSampler() {
    var terrain = null;
    for (var i = 0; i < layers.length; i++) if (layers[i].id === 'terrain') terrain = layers[i];
    if (!terrain) return;
    var N = 160;
    var minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    var pts = [];
    terrain.parsed.primitives.forEach(function (prim) {
      prim.positions.forEach(function (p) {
        pts.push(p);
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
      });
    });
    var sx = (maxX - minX) / N, sz = (maxZ - minZ) / N;
    var sum = new Float64Array((N + 1) * (N + 1));
    var cnt = new Float64Array((N + 1) * (N + 1));
    pts.forEach(function (p) {
      var c = Math.max(0, Math.min(N, Math.round((p[0] - minX) / sx)));
      var r = Math.max(0, Math.min(N, Math.round((p[2] - minZ) / sz)));
      var o = r * (N + 1) + c;
      sum[o] += p[1]; cnt[o] += 1;
    });
    var h = new Float64Array((N + 1) * (N + 1));
    for (var k = 0; k < h.length; k++) h[k] = cnt[k] ? sum[k] / cnt[k] : 0;
    groundSampler = function (x, z) {
      var u = Math.max(0, Math.min(N, (x - minX) / sx));
      var v = Math.max(0, Math.min(N, (z - minZ) / sz));
      var c = Math.min(N - 1, Math.floor(u)), r = Math.min(N - 1, Math.floor(v));
      var fu = u - c, fv = v - r;
      var a = h[r * (N + 1) + c], b = h[r * (N + 1) + c + 1];
      var cc = h[(r + 1) * (N + 1) + c + 1], d = h[(r + 1) * (N + 1) + c];
      return a * (1 - fu) * (1 - fv) + b * fu * (1 - fv) + cc * fu * fv + d * (1 - fu) * fv;
    };
  }

  /* Screen-space highlight: always visible above the scene, hugs the road. */
  function drawHighlight(viewProj) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (hlCanvas.width !== Math.floor(w * dpr) || hlCanvas.height !== Math.floor(h * dpr)) {
      hlCanvas.width = Math.floor(w * dpr);
      hlCanvas.height = Math.floor(h * dpr);
    }
    hlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hlCtx.clearRect(0, 0, w, h);
    if (!selectedRoad && !selectedPlace) return;
    var gy = groundSampler || function () { return 0; };
    var core = Math.min(10, Math.max(2.5, 6000 / camera.dist));
    if (selectedRoad) {
      hlCtx.lineJoin = 'round';
      hlCtx.lineCap = 'round';
      for (var pass = 0; pass < 2; pass++) {
        hlCtx.strokeStyle = pass === 0 ? 'rgba(255,154,60,0.28)' : 'rgba(255,176,32,0.95)';
        hlCtx.lineWidth = pass === 0 ? core * 2.8 : core;
        selectedRoad.lines.forEach(function (line) {
          hlCtx.beginPath();
          var started = false;
          for (var i = 0; i < line.length; i++) {
            var x = line[i][0], z = line[i][1];
            var s = projectPoint([x, gy(x, z) + 1.2, z], viewProj, w, h);
            if (!s) { started = false; continue; }
            if (!started) { hlCtx.moveTo(s[0], s[1]); started = true; }
            else hlCtx.lineTo(s[0], s[1]);
          }
          hlCtx.stroke();
        });
      }
    }
    if (selectedPlace) {
      var px = selectedPlace.x, pz = selectedPlace.z;
      var s = projectPoint([px, gy(px, pz) + 1.5, pz], viewProj, w, h);
      if (s) {
        var pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
        var r = Math.min(26, Math.max(7, 4000 / camera.dist)) * (1 + pulse * 0.25);
        hlCtx.strokeStyle = 'rgba(255,176,32,0.95)';
        hlCtx.lineWidth = 3;
        hlCtx.beginPath();
        hlCtx.arc(s[0], s[1], r, 0, Math.PI * 2);
        hlCtx.stroke();
        hlCtx.fillStyle = 'rgba(255,209,102,0.9)';
        hlCtx.beginPath();
        hlCtx.arc(s[0], s[1], 3.5, 0, Math.PI * 2);
        hlCtx.fill();
      }
    }
  }

  function updateLabels(viewProj) {
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    var d = camera.dist;
    /* Keep labels out of the translucent UI panels: without backdrop-blur
       support labels behind them would show through as garbled text. */
    var panelRect = document.getElementById('panel').getBoundingClientRect();
    var ctrlRect = document.getElementById('controls').getBoundingClientRect();
    var roadRect = roadPanelEl.getBoundingClientRect();
    function underUi(x0, y0, x1, y1) {
      return (x1 > panelRect.left - 6 && x0 < panelRect.right + 6 &&
              y1 > panelRect.top - 6 && y0 < panelRect.bottom + 6) ||
             (x1 > ctrlRect.left - 6 && x0 < ctrlRect.right + 6 &&
              y1 > ctrlRect.top - 6 && y0 < ctrlRect.bottom + 6) ||
             (x1 > roadRect.left - 6 && x0 < roadRect.right + 6 &&
              y1 > roadRect.top - 6 && y0 < roadRect.bottom + 6);
    }
    var visible = [];
    for (var i = 0; i < pois.length; i++) {
      var poi = pois[i];
      if ((poi.tier === 2 && d > 1800) ||
          (poi.tier === 1 && d > 5200) ||
          (poi.tier === 0 && d > 14000)) {
        poi.el.style.display = 'none';
        continue;
      }
      var screen = projectPoint([poi.x, 120, poi.z], viewProj, w, h);
      if (!screen || screen[0] < -80 || screen[0] > w + 80 || screen[1] < 20 || screen[1] > h + 40 ||
          underUi(screen[0] - poi.hw, screen[1] - 20, screen[0] + poi.hw, screen[1])) {
        poi.el.style.display = 'none';
        continue;
      }
      visible.push({ poi: poi, x: screen[0], y: screen[1] });
    }
    // Important tiers first so they win any overlap.
    visible.sort(function (a, b) { return a.poi.tier - b.poi.tier; });
    var placed = [];
    function clashes(x, y, hw, hh) {
      for (var k = 0; k < placed.length; k++) {
        if (Math.abs(placed[k].x - x) < placed[k].hw + hw &&
            Math.abs(placed[k].y - y) < placed[k].hh + hh) return true;
      }
      return false;
    }
    for (var j = 0; j < visible.length; j++) {
      var item = visible[j];
      var el = item.poi.el;
      if (clashes(item.x, item.y, item.poi.hw, 9)) {
        el.style.display = 'none';
        continue;
      }
      placed.push({ x: item.x, y: item.y, hw: item.poi.hw, hh: 9 });
      el.style.display = 'flex';
      el.style.transform = 'translate(-50%, -100%) translate(' +
        item.x.toFixed(1) + 'px,' + item.y.toFixed(1) + 'px)';
      el.style.opacity = String(Math.min(1, Math.max(0.3, 1.6 - d / 9000)));
    }

    /* Road name labels: rotated to follow the street direction on screen. */
    var roadsLayerVisible = true;
    for (var li = 0; li < layers.length; li++) {
      if (layers[li].id === 'roads') roadsLayerVisible = layers[li].visible;
    }
    var roadVisible = [];
    if (roadsLayerVisible) {
      for (var r = 0; r < roadLabels.length; r++) {
        var rl = roadLabels[r];
        if ((rl.tier === 2 && d > 1900) ||
            (rl.tier === 1 && d > 4600) ||
            (rl.tier === 0 && d > 10500)) {
          rl.el.style.display = 'none';
          continue;
        }
        var s1 = projectPoint([rl.x, 2, rl.z], viewProj, w, h);
        if (!s1 || s1[0] < -100 || s1[0] > w + 100 || s1[1] < 20 || s1[1] > h + 60) {
          rl.el.style.display = 'none';
          continue;
        }
        var s2 = projectPoint([rl.x + rl.dx * 30, 2, rl.z + rl.dz * 30], viewProj, w, h);
        var angle = s2 ? Math.atan2(s2[1] - s1[1], s2[0] - s1[0]) : 0;
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
        var hw = Math.abs(Math.cos(angle)) * rl.hw + Math.abs(Math.sin(angle)) * 8;
        var hh = Math.abs(Math.sin(angle)) * rl.hw + Math.abs(Math.cos(angle)) * 8;
        if (underUi(s1[0] - hw, s1[1] - hh, s1[0] + hw, s1[1] + hh)) {
          rl.el.style.display = 'none';
          continue;
        }
        roadVisible.push({ rl: rl, x: s1[0], y: s1[1], angle: angle, hw: hw, hh: hh });
      }
      roadVisible.sort(function (a, b) { return a.rl.tier - b.rl.tier; });
    }
    var roadShown = 0;
    for (var q = 0; q < roadVisible.length; q++) {
      var rv = roadVisible[q];
      var rel = rv.rl.el;
      if (roadShown >= 150) { rel.style.display = 'none'; continue; }
      var hw = rv.hw;
      var hh = rv.hh;
      if (clashes(rv.x, rv.y, hw, hh)) { rel.style.display = 'none'; continue; }
      placed.push({ x: rv.x, y: rv.y, hw: hw, hh: hh });
      roadShown++;
      rel.style.display = 'block';
      rel.style.transform = 'translate(-50%, -50%) translate(' +
        rv.x.toFixed(1) + 'px,' + rv.y.toFixed(1) + 'px) rotate(' +
        rv.angle.toFixed(3) + 'rad)';
      rel.style.opacity = String(Math.min(1, Math.max(0.35, 1.7 - d / 8000)));
    }
  }

  /* ---------- UI ---------- */
  function buildLayerPanel() {
    layersEl.innerHTML = '';
    layers.forEach(function (layer) {
      var row = document.createElement('label');
      row.className = 'layer-row';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = layer.visible;
      box.addEventListener('change', function () {
        layer.visible = box.checked;
      });
      var name = document.createElement('span');
      name.textContent = layer.label;
      row.appendChild(box);
      row.appendChild(name);
      layersEl.appendChild(row);
    });
  }

  /* ---------- render loop ---------- */
  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.floor(canvas.clientWidth * dpr);
    var h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw() {
    resize();

    if (fly) {
      fly.t += 1 / 60;
      var k = Math.min(1, fly.t / fly.duration);
      k = k * k * (3 - 2 * k); // smoothstep
      for (var c = 0; c < 3; c++) {
        camera.target[c] = fly.fromTarget[c] + (fly.toTarget[c] - fly.fromTarget[c]) * k;
      }
      camera.dist = fly.fromDist + (fly.toDist - fly.fromDist) * k;
      camera.yaw = fly.fromYaw + (fly.toYaw - fly.fromYaw) * k;
      if (fly.t >= fly.duration) fly = null;
    }

    // Smooth day <-> night transition.
    dayAmount += (dayTarget - dayAmount) * 0.08;
    if (Math.abs(dayTarget - dayAmount) < 0.001) dayAmount = dayTarget;
    var ambient = lerp3(NIGHT.ambient, DAY.ambient, dayAmount);
    var lightDir = lerp3(NIGHT.lightDir, DAY.lightDir, dayAmount);
    var lightColor = lerp3(NIGHT.lightColor, DAY.lightColor, dayAmount);
    var fogColor = lerp3(NIGHT.fogColor, DAY.fogColor, dayAmount);
    var fogDensity = lerp(NIGHT.fogDensity, DAY.fogDensity, dayAmount);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(fogColor[0], fogColor[1], fogColor[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    var eye = cameraEye();
    var view = lookAt(eye, camera.target, [0, 1, 0]);
    var proj = perspective(
      (55 * Math.PI) / 180,
      canvas.width / Math.max(canvas.height, 1),
      5,
      80000,
    );

    gl.useProgram(program);
    gl.uniformMatrix4fv(u.uProj, false, new Float32Array(proj));
    gl.uniformMatrix4fv(u.uView, false, new Float32Array(view));
    gl.uniform3fv(u.uAmbient, ambient);
    gl.uniform3fv(u.uLightDir, lightDir);
    gl.uniform3fv(u.uLightColor, lightColor);
    gl.uniform3fv(u.uCamPos, eye);
    gl.uniform3fv(u.uFogColor, fogColor);
    gl.uniform1f(u.uFogDensity, fogDensity);

    gl.enableVertexAttribArray(u.aPos);
    gl.enableVertexAttribArray(u.aNormal);
    gl.disable(gl.BLEND);
    gl.depthMask(true);

    layers.forEach(function (layer) {
      if (!layer.visible) return;
      layer.gpu.forEach(function (g) {
        var m = g.material;
        var dm = g.dayMaterial;
        gl.uniform3fv(u.uBaseColor, lerp3(m.baseColor, dm.baseColor, dayAmount));
        gl.uniform3fv(u.uEmissive, lerp3(m.emissive, dm.emissive, dayAmount));
        if (m.doubleSided) {
          gl.disable(gl.CULL_FACE);
        } else {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.BACK);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, g.posBuf);
        gl.vertexAttribPointer(u.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.nrmBuf);
        gl.vertexAttribPointer(u.aNormal, 3, gl.FLOAT, false, 0, 0);

        if (g.idxBuf) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idxBuf);
          gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
        } else {
          gl.drawArrays(gl.TRIANGLES, 0, g.count);
        }
      });
    });

    /* Street lamps: additive warm glow points on top of the scene (night only). */
    if (lampBuf && lampCount && dayAmount < 0.99) {
      gl.useProgram(programPoints);
      gl.uniformMatrix4fv(up.uProj, false, new Float32Array(proj));
      gl.uniformMatrix4fv(up.uView, false, new Float32Array(view));
      gl.uniform1f(up.uPixelRatio, window.devicePixelRatio || 1);
      gl.uniform1f(up.uDayFade, 1 - dayAmount);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.bindBuffer(gl.ARRAY_BUFFER, lampBuf);
      gl.enableVertexAttribArray(up.aPos);
      gl.vertexAttribPointer(up.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, lampCount);
      gl.disableVertexAttribArray(up.aPos);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    var viewProj = mat4Multiply(proj, view);
    updateLabels(viewProj);
    drawHighlight(viewProj);

    requestAnimationFrame(draw);
  }

  /* ---------- input ---------- */
  var drag = null;

  canvas.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });

  canvas.addEventListener('mousedown', function (e) {
    drag = { button: e.button, x: e.clientX, y: e.clientY };
    fly = null;
    e.preventDefault();
  });

  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.button === 0 && !e.shiftKey) {
      camera.yaw += dx * 0.005;
      camera.pitch = Math.min(1.5, Math.max(0.03, camera.pitch + dy * 0.005));
    } else {
      var scale = camera.dist * 0.0016;
      var cy = Math.cos(camera.yaw);
      var sy = Math.sin(camera.yaw);
      camera.target[0] += (-dx * cy + dy * -sy) * scale;
      camera.target[2] += (-dx * -sy + dy * -cy) * scale;
    }
  });

  window.addEventListener('mouseup', function () {
    drag = null;
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    fly = null;
    var factor = Math.exp(e.deltaY * 0.001);
    camera.dist = Math.min(20000, Math.max(120, camera.dist * factor));
  }, { passive: false });

  canvas.addEventListener('dblclick', function () {
    resetCamera();
  });

  /* Touch: 1 finger orbit, 2 finger pinch zoom + pan. */
  var touch = null;
  canvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    fly = null;
    if (e.touches.length === 1) {
      touch = { mode: 'orbit', x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length >= 2) {
      var a = e.touches[0];
      var b = e.touches[1];
      touch = {
        mode: 'pinch',
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      };
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (!touch) return;
    if (touch.mode === 'orbit' && e.touches.length === 1) {
      var t = e.touches[0];
      camera.yaw += (t.clientX - touch.x) * 0.005;
      camera.pitch = Math.min(1.5, Math.max(0.03, camera.pitch + (t.clientY - touch.y) * 0.005));
      touch.x = t.clientX;
      touch.y = t.clientY;
    } else if (touch.mode === 'pinch' && e.touches.length >= 2) {
      var a = e.touches[0];
      var b = e.touches[1];
      var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (touch.dist > 0) {
        camera.dist = Math.min(20000, Math.max(120, camera.dist * (touch.dist / d)));
      }
      var mx = (a.clientX + b.clientX) / 2;
      var my = (a.clientY + b.clientY) / 2;
      var scale = camera.dist * 0.0016;
      var cy = Math.cos(camera.yaw);
      var sy = Math.sin(camera.yaw);
      camera.target[0] += (-(mx - touch.x) * cy + (my - touch.y) * -sy) * scale;
      camera.target[2] += (-(mx - touch.x) * -sy + (my - touch.y) * -cy) * scale;
      touch.dist = d;
      touch.x = mx;
      touch.y = my;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', function () {
    touch = null;
  });

  /* Search: pick a name -> highlight (road ribbon / place ring) and fly there. */
  function goSearch() {
    var name = searchInput.value.trim();
    if (!name) return;
    if (roadIndex[name]) { selectRoad(name); return; }
    var local = poiByName[name];
    if (!local) {
      statusEl.textContent = '未找到: ' + name;
      statusEl.classList.add('error');
      return;
    }
    selectedRoad = null;
    selectedPlace = { x: local[0], z: local[1], name: name };
    if (roadPanelEl._rerender) roadPanelEl._rerender();
    statusEl.textContent = '飞往并高亮 ' + name;
    statusEl.classList.remove('error');
    flyTo([local[0], 60, local[1]], 850, 1.6);
  }

  searchInput.addEventListener('change', goSearch);
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') goSearch();
  });
  document.getElementById('search-btn').addEventListener('click', goSearch);
  roadClearEl.addEventListener('click', clearSelection);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') clearSelection();
  });

  /* Day / night toggle. */
  todToggle.addEventListener('click', function () {
    dayTarget = dayTarget > 0.5 ? 0 : 1;
    document.body.classList.toggle('day', dayTarget > 0.5);
    todToggle.textContent = dayTarget > 0.5 ? '🌙 夜晚' : '☀️ 白天';
  });

  window.addEventListener('resize', resize);

  /* Shareable viewpoint: #cam=x,z,dist (local metres) for engineering links. */
  var camMatch = /^#cam=(-?[\d.]+),(-?[\d.]+),([\d.]+)$/.exec(window.location.hash);
  if (camMatch) {
    camera.target = [parseFloat(camMatch[1]), 40, parseFloat(camMatch[2])];
    camera.dist = Math.min(20000, Math.max(120, parseFloat(camMatch[3])));
  }

  /* ---------- boot ---------- */
  fetchJson(DATA_BASE + '/manifest.json')
    .then(function (manifest) {
      origin = manifest.origin;
      var sequence = Promise.resolve();
      manifest.layers.forEach(function (layerMeta) {
        sequence = sequence.then(function () {
          statusEl.textContent = '正在加载 ' + (LAYER_LABELS[layerMeta.id] || layerMeta.id) + '…';
          return loadLayer(layerMeta).then(function (layer) {
            layers.push(layer);
            uploadLayer(layer);
          });
        });
      });
      return sequence.then(function () {
        statusEl.textContent = '正在加载地名索引…';
        return loadPois();
      }).then(function () {
        statusEl.textContent = '正在加载路名…';
        return loadRoadNames();
      }).then(function () {
        buildStreetLamps();
        buildGroundSampler();
        var roadMatch = /[#&]road=([^&]+)/.exec(window.location.hash);
        if (roadMatch) selectRoad(decodeURIComponent(roadMatch[1]));
      });
    })
    .then(function () {
      buildLayerPanel();
      document.body.classList.add('day');
      todToggle.textContent = '🌙 夜晚';
      statusEl.textContent = '就绪 · 100% 离线数据 · 点击标签或搜索可定位';
      statusEl.classList.add('ok');
      statsEl.textContent =
        layers.length + ' 个图层 · ' +
        totalTriangles.toLocaleString() + ' 三角面 · ' +
        roadNameCount.toLocaleString() + ' 条路名 · ' +
        Object.keys(poiByName).length.toLocaleString() + ' 个地名';
      draw();
    })
    .catch(function (err) {
      statusEl.textContent = '加载失败: ' + err.message;
      statusEl.classList.add('error');
    });
})();
