import { clipLineToBbox, clipRingToBbox, triangulate } from './geometry.mjs';
import { decodePng } from './png.mjs';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGeoContext,
  hashString,
  latitudeToTileY,
  longitudeToTileX,
  polygonArea,
  regionFromBbox,
  signedArea,
  stitchRings
} from './geo.mjs';
import { MeshBuilder } from './gltf.mjs';
import { loadLtaRoadSectionLines } from './lta-roads.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RAW = resolve(ROOT, 'LocalData/raw');
const OUTPUT = resolve(ROOT, 'LocalData/SGCityData');
const OFFLINE = process.argv.includes('--offline');
const BBOX = { south: 1.242, west: 103.795, north: 1.335, east: 103.950 };
const ORIGIN = { longitude: 103.8725, latitude: 1.2885, height: 0 };
const DATA_VERSION = 'p0.8';
const PROPOSAL_CONNECTIONS = [{
  id: 'rhu-cross-bay-east-review',
  name: 'Rhu Cross 方案连接（待核实）',
  status: 'scheme_placeholder_not_existing_road',
  note: 'User-approved scheme connector; no LTA kerb evidence along this approximately 55 m gap. Not an existing road or surveyed alignment.',
  coordinates: [
    [103.87303653642826, 1.2852588640073963],
    [103.8728607, 1.2848421],
  ],
}];
const TERRAIN_ZOOM = 13;
const BUILDING_HEIGHT_SCALE = 0.55;
const geo = createGeoContext(ORIGIN);

/* Green is reserved for hills / steep vegetated terrain. Ordinary urban parcels
   use neutral dark slate shades, close to water in luminance but without its
   blue hue, so flat high-elevation districts are not mistaken for hills. */
const BLOCK_SHADES = [
  [0.020, 0.090, 0.038, 1],
  [0.032, 0.135, 0.052, 1],
  [0.048, 0.180, 0.068, 1],
  [0.026, 0.110, 0.045, 1]
];
const PARCEL_SHADES = [
  [0.018, 0.022, 0.027, 1],
  [0.023, 0.028, 0.034, 1],
  [0.029, 0.035, 0.042, 1],
  [0.021, 0.026, 0.031, 1]
];

const MATERIALS = {
  ground: { baseColor: [0.020, 0.085, 0.036, 1], roughness: 0.96 },
  groundFlat: { baseColor: [0.014, 0.019, 0.024, 1], roughness: 0.96 },
  block0: { baseColor: BLOCK_SHADES[0], roughness: 0.95 },
  block1: { baseColor: BLOCK_SHADES[1], roughness: 0.95 },
  block2: { baseColor: BLOCK_SHADES[2], roughness: 0.95 },
  block3: { baseColor: BLOCK_SHADES[3], roughness: 0.95 },
  parcel0: { baseColor: PARCEL_SHADES[0], roughness: 0.95 },
  parcel1: { baseColor: PARCEL_SHADES[1], roughness: 0.95 },
  parcel2: { baseColor: PARCEL_SHADES[2], roughness: 0.95 },
  parcel3: { baseColor: PARCEL_SHADES[3], roughness: 0.95 },
  water: { baseColor: [0.010, 0.045, 0.110, 1], emissive: [0.002, 0.012, 0.025], roughness: 0.32, doubleSided: true },
  roadMajor: { baseColor: [0.045, 0.10, 0.20, 1], emissive: [0.006, 0.020, 0.038], roughness: 0.7, doubleSided: true },
  roadSecondary: { baseColor: [0.050, 0.11, 0.21, 1], emissive: [0.005, 0.017, 0.033], roughness: 0.75, doubleSided: true },
  roadMinor: { baseColor: [0.058, 0.12, 0.22, 1], emissive: [0.004, 0.014, 0.028], roughness: 0.8, doubleSided: true },
  roadTunnel: { baseColor: [0.030, 0.060, 0.110, 1], emissive: [0.003, 0.008, 0.016], roughness: 0.8, doubleSided: true },
  roadCasing: { baseColor: [0.20, 0.33, 0.50, 1], emissive: [0.010, 0.022, 0.040], roughness: 0.85, doubleSided: true },
  roadMajorCasing: { baseColor: [0.20, 0.33, 0.50, 1], emissive: [0.010, 0.022, 0.040], roughness: 0.85, doubleSided: true },
  roadMarking: { baseColor: [0.78, 0.80, 0.82, 1], emissive: [0.05, 0.055, 0.06], roughness: 0.6, doubleSided: true },
  roadProposed: { baseColor: [0.95, 0.32, 0.035, 1], emissive: [0.35, 0.08, 0.005], roughness: 0.65, doubleSided: true },
  roof: { baseColor: [0.012, 0.032, 0.045, 1], roughness: 0.82 },
  facade: { baseColor: [0.018, 0.065, 0.075, 1], metallic: 0.15, roughness: 0.42 },
  windowCyan: { baseColor: [0.01, 0.22, 0.16, 1], emissive: [0.08, 0.90, 0.62], emissiveStrength: 3.5, roughness: 0.5, doubleSided: true },
  windowWarm: { baseColor: [0.25, 0.14, 0.035, 1], emissive: [1.0, 0.56, 0.18], emissiveStrength: 2.4, roughness: 0.5, doubleSided: true }
};

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function download(url, destination, options = {}) {
  if (existsSync(destination)) return readFile(destination);
  if (OFFLINE) throw new Error(`Offline input missing: ${destination}`);
  const attempts = options.retries ?? 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      headers: { 'User-Agent': 'SG-City-P0/0.1 (offline city-map authoring)', ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(options.timeout ?? 240000)
    });
    if (response.ok) {
      const data = Buffer.from(await response.arrayBuffer());
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data);
      return data;
    }
    lastError = new Error(`Download failed ${response.status}: ${url}`);
    if (attempt < attempts) {
      console.warn(`[download] ${url} -> ${response.status}; retry ${attempt}/${attempts - 1}...`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw lastError;
}

function overpassQuery() {
  const bbox = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
  return `[out:json][timeout:300];
(
  way["building"](${bbox});
  relation["building"](${bbox});
  way["highway"](${bbox});
  way["railway"~"^(subway|rail|light_rail|monorail|narrow_gauge|funicular)$"](${bbox});
  relation["route"~"^(subway|light_rail|monorail)$"](${bbox});
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  way["landuse"="reservoir"](${bbox});
  relation["landuse"="reservoir"](${bbox});
  way["waterway"="riverbank"](${bbox});
  node["tourism"]["name"](${bbox});
  node["amenity"]["name"](${bbox});
);
out body;
>;
out skel qt;`;
}

async function loadOsm() {
  const path = resolve(RAW, 'sg-southcore-osm.json');
  const query = overpassQuery();
  const endpoints = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter',
  ];
  let lastError;
  let data;
  for (const endpoint of endpoints) {
    try {
      data = await download(endpoint, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`,
        timeout: 300000,
        retries: 2
      });
      break;
    } catch (error) {
      lastError = error;
      console.warn(`[SG-City] Overpass endpoint failed: ${error.message}`);
    }
  }
  if (!data) throw lastError;
  return { data: JSON.parse(data.toString('utf8')), rawBytes: data.length, rawSha256: sha256(data) };
}

async function loadTerrainSampler() {
  const minX = Math.floor(longitudeToTileX(BBOX.west, TERRAIN_ZOOM));
  const maxX = Math.floor(longitudeToTileX(BBOX.east, TERRAIN_ZOOM));
  const minY = Math.floor(latitudeToTileY(BBOX.north, TERRAIN_ZOOM));
  const maxY = Math.floor(latitudeToTileY(BBOX.south, TERRAIN_ZOOM));
  const tiles = new Map();
  const provenance = [];

  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${x}/${y}.png`;
      const path = resolve(RAW, `terrain/${TERRAIN_ZOOM}/${x}/${y}.png`);
      const data = await download(url, path, { timeout: 90000 });
      tiles.set(`${x}/${y}`, { x, y, png: decodePng(data) });
      provenance.push({ z: TERRAIN_ZOOM, x, y, url, sha256: sha256(data), bytes: data.length });
    }
  }

  function pixel(tile, x, y) {
    const px = Math.max(0, Math.min(tile.png.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(tile.png.height - 1, Math.round(y)));
    const index = (tile.png.width * py + px) * 4;
    return tile.png.data[index] * 256 + tile.png.data[index + 1] + tile.png.data[index + 2] / 256 - 32768;
  }

  return {
    provenance,
    sample(longitude, latitude) {
      const globalX = longitudeToTileX(longitude, TERRAIN_ZOOM) * 256;
      const globalY = latitudeToTileY(latitude, TERRAIN_ZOOM) * 256;
      const tileX = Math.floor(globalX / 256);
      const tileY = Math.floor(globalY / 256);
      const tile = tiles.get(`${tileX}/${tileY}`);
      if (!tile) return 0;
      const localX = globalX - tileX * 256;
      const localY = globalY - tileY * 256;
      const x0 = Math.floor(localX);
      const y0 = Math.floor(localY);
      const fx = localX - x0;
      const fy = localY - y0;
      const top = pixel(tile, x0, y0) * (1 - fx) + pixel(tile, x0 + 1, y0) * fx;
      const bottom = pixel(tile, x0, y0 + 1) * (1 - fx) + pixel(tile, x0 + 1, y0 + 1) * fx;
      return top * (1 - fy) + bottom * fy;
    }
  };
}

function indexOsm(data) {
  const nodes = new Map();
  const ways = new Map();
  const relations = [];
  for (const element of data.elements) {
    if (element.type === 'node') nodes.set(element.id, element);
    if (element.type === 'way') ways.set(element.id, element);
    if (element.type === 'relation') relations.push(element);
  }
  return { nodes, ways, relations };
}

function wayCoordinates(way, nodes) {
  if (way.coordinates) return way.coordinates;
  if (!way.nodes) return [];
  return way.nodes.map((id) => {
    const node = nodes.get(id);
    return node ? [id, node.lon, node.lat] : null;
  }).filter(Boolean);
}

/* Douglas-Peucker line simplification: removes the micro-vertices that make
   OSM road/rail ways look jagged, keeping the smooth overall shape. Coords
   are [id, lon, lat] triplets; tolerance is in degrees. */
const LINE_SIMPLIFY_TOL = 0.00006;

function simplifyLine(coords, tolerance) {
  if (coords.length <= 2) return coords.slice();
  const keep = new Array(coords.length).fill(false);
  keep[0] = true;
  keep[coords.length - 1] = true;
  const toleranceSq = tolerance * tolerance;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const current = stack.pop();
    const start = current[0];
    const end = current[1];
    if (end <= start + 1) continue;
    const ax = coords[start][1];
    const ay = coords[start][2];
    const dx = coords[end][1] - ax;
    const dy = coords[end][2] - ay;
    const lengthSq = dx * dx + dy * dy;
    let maxDistanceSq = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      let distanceSq;
      if (lengthSq === 0) {
        const ex = coords[i][1] - ax;
        const ey = coords[i][2] - ay;
        distanceSq = ex * ex + ey * ey;
      } else {
        const t = Math.max(0, Math.min(1, ((coords[i][1] - ax) * dx + (coords[i][2] - ay) * dy) / lengthSq));
        const px = ax + t * dx;
        const py = ay + t * dy;
        const ex = coords[i][1] - px;
        const ey = coords[i][2] - py;
        distanceSq = ex * ex + ey * ey;
      }
      if (distanceSq > maxDistanceSq) {
        maxDistanceSq = distanceSq;
        maxIndex = i;
      }
    }
    if (maxDistanceSq > toleranceSq) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  return coords.filter((_, index) => keep[index]);
}

function collectClosedPolygons(index, predicate, kind, stats) {
  const output = [];
  for (const way of index.ways.values()) {
    if (!predicate(way.tags ?? {})) continue;
    const coordinates = wayCoordinates(way, index.nodes);
    if (coordinates.length >= 4 && coordinates[0][0] === coordinates.at(-1)[0]) {
      output.push({ id: `way/${way.id}`, tags: way.tags ?? {}, ring: coordinates });
    }
  }
  for (const relation of index.relations) {
    if (!predicate(relation.tags ?? {})) continue;
    const outerWays = (relation.members ?? [])
      .filter((member) => member.type === 'way' && member.role !== 'inner')
      .map((member) => wayCoordinates(index.ways.get(member.ref), index.nodes))
      .filter((way) => way.length > 0);
    const rings = stitchRings(outerWays);
    if (rings.length === 0) stats[`${kind}UnclosedRelations`] += 1;
    for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      output.push({ id: `relation/${relation.id}/${ringIndex}`, tags: relation.tags ?? {}, ring: rings[ringIndex] });
    }
  }
  return output;
}

function safeTriangulate(flatCoordinates) {
  try {
    return triangulate(flatCoordinates);
  } catch {
    return null;
  }
}

function clipPolygonFeature(feature) {
  const ring = clipRingToBbox(feature.ring, BBOX);
  return ring.length >= 4 ? { ...feature, ring } : null;
}

function centroid(ring) {
  let x = 0;
  let y = 0;
  let lon = 0;
  let lat = 0;
  const count = ring.length - 1;
  for (const point of ring.slice(0, -1)) {
    lon += point[1];
    lat += point[2];
  }
  lon /= count;
  lat /= count;
  const projected = geo.project(lon, lat);
  x = projected[0];
  y = projected[1];
  return { x, y, longitude: lon, latitude: lat };
}

function localRing(ring, baseHeight) {
  return ring.map((point) => geo.project(point[1], point[2], baseHeight));
}

function inferHeight(feature, area, stats) {
  const tags = feature.tags;
  if (tags.height && Number.isFinite(Number.parseFloat(tags.height))) {
    stats.heightMeasured += 1;
    return Math.max(3, Math.min(400, Number.parseFloat(tags.height)));
  }
  if (tags['building:levels'] && Number.isFinite(Number.parseFloat(tags['building:levels']))) {
    stats.heightLevels += 1;
    return Math.max(4, Math.min(400, Number.parseFloat(tags['building:levels']) * 3.2));
  }
  stats.heightEstimated += 1;
  const seed = hashString(feature.id);
  let height = 12 + seed % 24;
  if (area > 2000) height += 16;
  if (area > 6000) height += 20;
  if (tags.building === 'commercial' || tags.building === 'office') height += 12;
  return Math.min(120, height);
}

function roadClass(tags) {
  if (['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'].includes(tags.highway)) return 'roadMajor';
  if (['secondary', 'secondary_link', 'tertiary', 'tertiary_link'].includes(tags.highway)) return 'roadSecondary';
  return 'roadMinor';
}

function roadWidth(tags) {
  if (tags.width && Number.isFinite(Number.parseFloat(tags.width))) return Math.min(40, Math.max(1.5, Number.parseFloat(tags.width)));
  const lanes = Number.parseFloat(tags.lanes);
  if (Number.isFinite(lanes)) return Math.min(40, Math.max(3, lanes * 3.2));
  const material = roadClass(tags);
  if (material === 'roadMajor') return 12;
  if (material === 'roadSecondary') return 8;
  return tags.highway === 'service' ? 4 : 5;
}

/* Vehicular roads rendered as streets (footways/paths are not streets). */
const VEHICLE_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'service', 'living_street', 'road', 'busway', 'bus_guideway'
]);
/* Roads that partition land into blocks: at-grade carriageways only.
   Singapore estate streets are largely tagged `service`, so they must be
   included or parcels stay block-sized instead of plot-sized; sliver faces
   from driveways are removed by the minimum-area filter. Grade-separated
   links are excluded. */
const BLOCK_HIGHWAYS = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'road', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'
]);
/* ~0.44 m tolerance: keeps OSM geometry essentially exact for engineering use. */
const ROAD_SIMPLIFY_TOL = 0.000004;
const ROAD_LIFT = 0.50;      // road surface above terrain
const CASING_LIFT = 0.40;    // kerb/sidewalk band under the surface
const BLOCK_LIFT = 0.22;     // parcel fill above terrain
const CASING_EXTRA = 0.5;    // metres of kerb band on each side (thin kerb line)
/* Terrain/road/parcel height field resolution. Every draped polygon is clipped
   against these grid triangles, so inside each triangle the height field is
   exactly linear and the lift ordering (block < casing < surface < marking)
   holds everywhere, including steep hills and shorelines. */
const GRID_STEPS = 160;

/* Shared piecewise-linear height field in local ENU metres. Roads, kerbs,
   markings and parcel fills all drape on this exact field (not on the raw
   terrain sampler), which is what keeps them from being buried by the ground
   mesh or by floating parcel slabs on slopes. */
function createHeightField(terrain) {
  const steps = GRID_STEPS;
  const corner = geo.project(BBOX.west, BBOX.south, 0);
  const eMin = corner[0];
  const nMin = corner[1];
  const eMax = geo.project(BBOX.east, BBOX.south, 0)[0];
  const nMax = geo.project(BBOX.west, BBOX.north, 0)[1];
  const cellE = (eMax - eMin) / steps;
  const cellN = (nMax - nMin) / steps;
  const mLon = geo.project(ORIGIN.longitude + 0.01, ORIGIN.latitude, 0)[0] / 0.01;
  const mLat = geo.project(ORIGIN.longitude, ORIGIN.latitude + 0.01, 0)[1] / 0.01;
  const es = new Float64Array(steps + 1);
  const ns = new Float64Array(steps + 1);
  const h = new Float64Array((steps + 1) * (steps + 1));
  for (let c = 0; c <= steps; c += 1) es[c] = eMin + cellE * c;
  for (let r = 0; r <= steps; r += 1) ns[r] = nMin + cellN * r;
  for (let r = 0; r <= steps; r += 1) {
    const lat = ORIGIN.latitude + ns[r] / mLat;
    for (let c = 0; c <= steps; c += 1) {
      const lon = ORIGIN.longitude + es[c] / mLon;
      h[r * (steps + 1) + c] = terrain.sample(lon, lat);
    }
  }
  function at(e, n) {
    const u = Math.max(0, Math.min(steps, (e - eMin) / cellE));
    const v = Math.max(0, Math.min(steps, (n - nMin) / cellN));
    const c = Math.min(steps - 1, Math.floor(u));
    const r = Math.min(steps - 1, Math.floor(v));
    const fu = u - c;
    const fv = v - r;
    const a = h[r * (steps + 1) + c];
    const b = h[r * (steps + 1) + c + 1];
    const cc = h[(r + 1) * (steps + 1) + c + 1];
    const d = h[(r + 1) * (steps + 1) + c];
    // same diagonal split as the terrain mesh: triangle (a,b,c) for fu>=fv
    return fu >= fv ? a + (b - a) * fu + (cc - b) * fv : a + (d - a) * fv + (cc - d) * fu;
  }
  function* trisInBbox(minE, minN, maxE, maxN) {
    const c0 = Math.max(0, Math.floor((minE - eMin) / cellE));
    const c1 = Math.min(steps - 1, Math.ceil((maxE - eMin) / cellE));
    const r0 = Math.max(0, Math.floor((minN - nMin) / cellN));
    const r1 = Math.min(steps - 1, Math.ceil((maxN - nMin) / cellN));
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const a = [es[c], ns[r]];
        const b = [es[c + 1], ns[r]];
        const cc = [es[c + 1], ns[r + 1]];
        const d = [es[c], ns[r + 1]];
        yield [a, b, cc];
        yield [a, cc, d];
      }
    }
  }
  return { steps, eMin, nMin, eMax, nMax, cellE, cellN, es, ns, h, at, trisInBbox };
}

/* Sutherland-Hodgman: clip any subject ring against a convex CCW triangle. */
function clipConvex(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i += 1) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const inside = (p) => ex * (p[1] - a[1]) - ey * (p[0] - a[0]) >= -1e-9;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j += 1) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur, a, b, ex, ey));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur, a, b, ex, ey));
      }
    }
  }
  return out;
}

function intersect(p, q, a, b, ex, ey) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const den = ex * dy - ey * dx;
  const t = den === 0 ? 0 : (ex * (p[1] - a[1]) - ey * (p[0] - a[0])) / -den;
  const tc = Math.max(0, Math.min(1, t));
  const x = p[0] + dx * tc;
  const y = p[1] + dy * tc;
  if (p[2] === undefined || q[2] === undefined) return [x, y];
  return [x, y, p[2] + (q[2] - p[2]) * tc];
}

/* Drape a polygon on the height field: clip it into grid-triangle pieces and
   fan-triangulate each piece. Every piece lies inside one grid triangle where
   the field is linear, so vertex lifts order exactly against other layers. */
function emitDraped(mesh, field, poly, lift, material) {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const p of poly) {
    minE = Math.min(minE, p[0]); maxE = Math.max(maxE, p[0]);
    minN = Math.min(minN, p[1]); maxN = Math.max(maxN, p[1]);
  }
  for (const tri of field.trisInBbox(minE, minN, maxE, maxN)) {
    const raw = clipConvex(poly, tri);
    const piece = [];
    for (const p of raw) {
      const last = piece.at(-1);
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-7) piece.push(p);
    }
    while (piece.length > 1 && Math.hypot(piece[0][0] - piece.at(-1)[0], piece[0][1] - piece.at(-1)[1]) <= 1e-7) piece.pop();
    if (piece.length < 3) continue;
    let area = 0;
    for (let i = 0; i < piece.length; i += 1) {
      const p = piece[i];
      const q = piece[(i + 1) % piece.length];
      area += p[0] * q[1] - q[0] * p[1];
    }
    if (Math.abs(area) < 1e-6) continue;
    const triangles = safeTriangulate(piece.flatMap((p) => [p[0], p[1]]));
    if (!triangles) continue;
    const verts = piece.map((p) => geo.toGltf([p[0], p[1], field.at(p[0], p[1]) + (p[2] || 0) + lift]));
    for (let i = 0; i < triangles.length; i += 3) {
      mesh.addTriangle([verts[triangles[i]], verts[triangles[i + 1]], verts[triangles[i + 2]]], material, [0, 1, 0]);
    }
  }
}

function isVehicleRoad(tags) {
  return Boolean(tags.highway) && tags.area !== 'yes' && VEHICLE_HIGHWAYS.has(tags.highway);
}

/* Keep the complete road network for engineering context. Access and
   construction attributes affect interpretation, not geometric visibility:
   filtering them can disconnect otherwise continuous routes. */
function isDisplayRoad(tags) {
  return isVehicleRoad(tags);
}

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

/* Match LTA geometry to nearby OSM attributes in local metres. The official
   2026 SHP has road codes/categories but no names, so matching is spatial;
   distances are reported instead of presenting all attributes as surveyed. */
function mergeLtaRoads(osmRoads, nodes, lta) {
  const streetWays = osmRoads.filter((way) => isVehicleRoad(way.tags ?? {}));
  const cellSize = 150;
  const grid = new Map();
  const byWay = new Map();
  const key = (x, y) => `${x},${y}`;
  for (const way of streetWays) {
    const coordinates = wayCoordinates(way, nodes);
    const local = coordinates.map((coord) => geo.project(coord[1], coord[2], 0));
    const record = { way, local, segments: [] };
    byWay.set(way.id, record);
    for (let index = 0; index + 1 < local.length; index += 1) {
      const a = local[index];
      const b = local[index + 1];
      const segment = { a, b, wayId: way.id };
      record.segments.push(segment);
      const minX = Math.floor(Math.min(a[0], b[0]) / cellSize);
      const maxX = Math.floor(Math.max(a[0], b[0]) / cellSize);
      const minY = Math.floor(Math.min(a[1], b[1]) / cellSize);
      const maxY = Math.floor(Math.max(a[1], b[1]) / cellSize);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const k = key(x, y);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(segment);
        }
      }
    }
  }

  function candidates(point, radius) {
    const found = new Map();
    const minX = Math.floor((point[0] - radius) / cellSize);
    const maxX = Math.floor((point[0] + radius) / cellSize);
    const minY = Math.floor((point[1] - radius) / cellSize);
    const maxY = Math.floor((point[1] + radius) / cellSize);
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (const segment of grid.get(key(x, y)) ?? []) {
          if (!found.has(segment.wayId)) found.set(segment.wayId, byWay.get(segment.wayId));
        }
      }
    }
    return [...found.values()];
  }

  function scoreCandidate(record, samples) {
    let total = 0;
    let maximum = 0;
    for (const sample of samples) {
      let minimum = Infinity;
      for (const segment of record.segments) {
        minimum = Math.min(minimum, pointSegmentDistance(sample, segment.a, segment.b));
      }
      total += minimum;
      maximum = Math.max(maximum, minimum);
    }
    return { mean: total / samples.length, maximum };
  }

  const matchedOsm = new Set();
  const distances = [];
  const categoryMatches = {};
  let unmatched = 0;
  const official = [];
  for (const way of lta.ways) {
    const coordinates = wayCoordinates(way, nodes);
    const local = coordinates.map((coord) => geo.project(coord[1], coord[2], 0));
    const sampleIndexes = [...new Set([0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(t * (local.length - 1))))];
    const samples = sampleIndexes.map((index) => local[index]);
    const candidateMap = new Map();
    for (const sample of samples) {
      for (const record of candidates(sample, 120)) candidateMap.set(record.way.id, record);
    }
    let best = null;
    for (const record of candidateMap.values()) {
      const score = scoreCandidate(record, samples);
      if (!best || score.mean < best.mean) best = { record, ...score };
    }
    const category = way.tags['lta:category'];
    const matched = best && best.mean <= 40 && best.maximum <= 120;
    const osmTags = matched ? best.record.way.tags ?? {} : {};
    const fallbackHighway = {
      CAT1: 'motorway', CAT2: 'trunk', CAT3: 'primary',
      CAT4: 'tertiary', CAT5: 'residential', NCAT: 'unclassified',
    }[category] ?? 'unclassified';
    if (matched) {
      matchedOsm.add(best.record.way.id);
      distances.push(best.mean);
      if (!categoryMatches[category]) categoryMatches[category] = {};
      const highway = osmTags.highway ?? 'unknown';
      categoryMatches[category][highway] = (categoryMatches[category][highway] ?? 0) + 1;
    } else {
      unmatched += 1;
    }
    official.push({
      ...way,
      tags: {
        ...osmTags,
        ...way.tags,
        highway: osmTags.highway ?? fallbackHighway,
        source: 'lta-road-section-line',
        ...(matched ? { 'match:distance': best.mean.toFixed(2) } : { 'match:status': 'unmatched' }),
      },
    });
  }

  /* The 2026 LTA extract omits names on some records. Recover a name only
     when all named records with the SAME official road code agree; never
     invent a connection or borrow a name from a merely nearby street. */
  const namesByCode = new Map();
  for (const way of official) {
    const code = way.tags['lta:road_code'];
    const name = way.tags.name;
    if (!code || !name || way.tags.access === 'private' || way.tags.construction) continue;
    if (!namesByCode.has(code)) namesByCode.set(code, []);
    namesByCode.get(code).push(way);
  }
  let topologyNamed = 0;
  for (const way of official) {
    if (way.tags.name) continue;
    const candidates = namesByCode.get(way.tags['lta:road_code']) ?? [];
    const names = [...new Set(candidates.map((candidate) => candidate.tags.name))];
    if (names.length !== 1) continue;
    const reference = candidates[0];
    const minorPair = roadClass(way.tags) === 'roadMinor' && roadClass(reference.tags) === 'roadMinor';
    way.tags = {
      ...way.tags,
      name: names[0],
      ...(minorPair ? {
        highway: reference.tags.highway,
        lanes: reference.tags.lanes,
        width: reference.tags.width,
      } : {}),
      'name:source': 'lta-shared-road-code',
    };
    topologyNamed += 1;
  }

  const supplemental = streetWays.filter((way) => !matchedOsm.has(way.id)).map((way) => ({
    ...way,
    tags: { ...(way.tags ?? {}), source: 'osm-overpass' },
  }));
  distances.sort((a, b) => a - b);
  const meanDistance = distances.length ? distances.reduce((sum, value) => sum + value, 0) / distances.length : null;
  const p95Distance = distances.length ? distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.95))] : null;
  return {
    roads: [...official, ...supplemental],
    stats: {
      ltaOfficialWays: official.length,
      ltaMatchedWays: distances.length,
      ltaUnmatchedWays: unmatched,
      ltaTopologyNamedWays: topologyNamed,
      osmSupplementWays: supplemental.length,
      ltaMatchMeanDistanceM: meanDistance === null ? null : Number(meanDistance.toFixed(2)),
      ltaMatchP95DistanceM: p95Distance === null ? null : Number(p95Distance.toFixed(2)),
      ltaCategoryMatches: categoryMatches,
    },
  };
}

/* Clip an open polyline ([id,lon,lat] triplets) to the bbox, returning
   continuous runs so ribbons stay unbroken inside the map area. */
function clipPolylineToBbox(coords, bbox) {
  const runs = [];
  let current = null;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const clipped = clipLineToBbox(coords[i], coords[i + 1], bbox);
    if (!clipped) { current = null; continue; }
    const [start, end] = clipped;
    if (!current ||
        Math.abs(current.at(-1)[1] - start[1]) > 1e-12 ||
        Math.abs(current.at(-1)[2] - start[2]) > 1e-12) {
      current = [start];
      runs.push(current);
    }
    current.push(end);
  }
  return runs;
}

/* Offset a polyline into left/right ribbon edges with miter joins so the
   strip is continuous through every bend (no per-segment gaps). */
function ribbonEdges(points, halfWidth) {
  const left = [];
  const right = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const prev = points[i - 1];
    const next = points[i + 1];
    let ox;
    let oy;
    if (prev && next) {
      let d1x = p[0] - prev[0];
      let d1y = p[1] - prev[1];
      const l1 = Math.hypot(d1x, d1y) || 1;
      d1x /= l1; d1y /= l1;
      let d2x = next[0] - p[0];
      let d2y = next[1] - p[1];
      const l2 = Math.hypot(d2x, d2y) || 1;
      d2x /= l2; d2y /= l2;
      let mx = -d1y - d2y;
      let my = d1x + d2x;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-6) {
        ox = -d1y * halfWidth;
        oy = d1x * halfWidth;
      } else {
        mx /= ml; my /= ml;
        const cosHalf = mx * -d1y + my * d1x;
        const scale = halfWidth / Math.max(0.4, cosHalf); // clamp miter spikes
        ox = mx * scale;
        oy = my * scale;
      }
    } else {
      const d = next ? [next[0] - p[0], next[1] - p[1]] : [p[0] - prev[0], p[1] - prev[1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      ox = -d[1] / l * halfWidth;
      oy = d[0] / l * halfWidth;
    }
    left.push([p[0] + ox, p[1] + oy, p[2]]);
    right.push([p[0] - ox, p[1] - oy, p[2]]);
  }
  return { left, right };
}

function emitRibbon(mesh, field, points, halfWidth, lift, material) {
  const { left, right } = ribbonEdges(points, halfWidth);
  for (let i = 0; i < points.length - 1; i += 1) {
    emitDraped(mesh, field, [left[i], left[i + 1], right[i + 1], right[i]], lift, material);
  }
}

/* Octagonal disc that seals the junction between two way ribbons. */
function emitCap(mesh, field, center, radius, lift, material) {
  const ring = [];
  for (let k = 0; k < 8; k += 1) {
    const a = k / 8 * 2 * Math.PI;
    ring.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
  }
  emitDraped(mesh, field, ring, lift, material);
}

/* Dashed centre line along the polyline arc length (all street classes). */
function emitCenterDashes(mesh, field, points, lift, minor, options = {}) {
  const dash = options.dash ?? (minor ? 3 : 4);
  const gap = options.gap ?? (minor ? 12 : 6);
  const halfW = options.halfWidth ?? (minor ? 0.22 : 0.28);
  const material = options.material ?? 'roadMarking';
  let dist = 0;
  let nextDash = 4;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segLen < 1e-6) continue;
    const ux = (b[0] - a[0]) / segLen;
    const uy = (b[1] - a[1]) / segLen;
    while (nextDash < dist + segLen) {
      const t0 = nextDash - dist;
      const t1 = Math.min(t0 + dash, segLen);
      const sx = a[0] + ux * t0;
      const sy = a[1] + uy * t0;
      const ex = a[0] + ux * t1;
      const ey = a[1] + uy * t1;
      const ox = -uy * halfW;
      const oy = ux * halfW;
      const la = (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * (t0 / segLen);
      const lb = (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * (t1 / segLen);
      emitDraped(mesh, field, [
        [sx + ox, sy + oy, la],
        [ex + ox, ey + oy, lb],
        [ex - ox, ey - oy, lb],
        [sx - ox, sy - oy, la]
      ], lift, material);
      nextDash += dash + gap;
    }
    dist += segLen;
  }
}

async function buildRoads(ways, nodes, field) {
  const mesh = new MeshBuilder({
    roadMajor: MATERIALS.roadMajor,
    roadSecondary: MATERIALS.roadSecondary,
    roadMinor: MATERIALS.roadMinor,
    roadTunnel: MATERIALS.roadTunnel,
    roadCasing: MATERIALS.roadCasing,
    roadMajorCasing: MATERIALS.roadMajorCasing,
    roadMarking: MATERIALS.roadMarking
  });
  const streetWays = ways.filter((way) => isDisplayRoad(way.tags ?? {}));

  /* Node occurrence count across all street ways: >=2 means a junction where
     ribbons from different ways meet and need a sealing cap. */
  const nodeUse = new Map();
  for (const way of streetWays) {
    for (const coordinate of wayCoordinates(way, nodes)) {
      const id = coordinate[0];
      nodeUse.set(id, (nodeUse.get(id) ?? 0) + 1);
    }
  }

  /* Grade-separation lift shared per node: adjacent ways (bridge vs at-grade,
     tunnel portal vs open cut) meet at the SAME height so decks never step or
     gap at joins. Underground ways are drawn at grade in a distinct tunnel
     colour so the network reads continuous instead of stopping at portals. */
  const baseLiftOf = (tags) => {
    const layer = Number.parseFloat(tags.layer) || 0;
    const underground = (tags.tunnel && tags.tunnel !== 'no') || layer < 0;
    if (underground) return 0;
    return tags.bridge && tags.bridge !== 'no' ? 5 + layer * 2.5 : layer * 1.5;
  };
  const nodeLift = new Map();
  for (const way of streetWays) {
    const bl = baseLiftOf(way.tags ?? {});
    for (const coordinate of wayCoordinates(way, nodes)) {
      const id = coordinate[0];
      nodeLift.set(id, Math.max(nodeLift.get(id) ?? 0, bl));
    }
  }

  let segments = 0;
  let caps = 0;
  for (const way of streetWays) {
    const tags = way.tags ?? {};
    const coordinates = simplifyLine(wayCoordinates(way, nodes), ROAD_SIMPLIFY_TOL);
    if (coordinates.length < 2) continue;
    const underground = (tags.tunnel && tags.tunnel !== 'no') || (Number.parseFloat(tags.layer) || 0) < 0;
    const material = underground ? 'roadTunnel' : roadClass(tags);
    const casingMaterial = material === 'roadMajor' ? 'roadMajorCasing' : 'roadCasing';
    const casingExtra = material === 'roadMajor' ? 1.0 : CASING_EXTRA;
    const halfWidth = roadWidth(tags) / 2;
    const runs = clipPolylineToBbox(coordinates, BBOX);
    for (const run of runs) {
      if (run.length < 2) continue;
      const points = run.map((coord) => {
        const p = geo.project(coord[1], coord[2], 0);
        return [p[0], p[1], nodeLift.get(coord[0]) ?? baseLiftOf(tags)];
      });
      emitRibbon(mesh, field, points, halfWidth + casingExtra, CASING_LIFT, casingMaterial);
      emitRibbon(mesh, field, points, halfWidth, ROAD_LIFT, material);
      emitCenterDashes(mesh, field, points, ROAD_LIFT + 0.06, material === 'roadMinor');
      segments += points.length - 1;
    }
    /* Seal way-end junctions (internal bends are already mitered). */
    for (const end of [coordinates[0], coordinates.at(-1)]) {
      const id = end[0];
      if ((nodeUse.get(id) ?? 0) < 2) continue;
      if (end[1] < BBOX.west || end[1] > BBOX.east || end[2] < BBOX.south || end[2] > BBOX.north) continue;
      const p = geo.project(end[1], end[2], 0);
      const endLift = nodeLift.get(id) ?? baseLiftOf(tags);
      emitCap(mesh, field, [p[0], p[1]], halfWidth + casingExtra, CASING_LIFT + endLift, casingMaterial);
      emitCap(mesh, field, [p[0], p[1]], halfWidth, ROAD_LIFT + endLift, material);
      caps += 1;
    }
  }
  const result = await mesh.writeGlb(resolve(OUTPUT, 'roads/content.glb'));
  return { ...result, segments, caps, streetWays: streetWays.length };
}

/* User-approved scheme placeholders, deliberately separate from existing roads. */
async function buildProposalConnections(field) {
  const mesh = new MeshBuilder({ roadProposed: MATERIALS.roadProposed });
  let segments = 0;
  for (const connection of PROPOSAL_CONNECTIONS) {
    const points = connection.coordinates.map(([longitude, latitude]) => {
      const p = geo.project(longitude, latitude, 0);
      return [p[0], p[1], 0];
    });
    emitCenterDashes(mesh, field, points, 0.70, false, {
      dash: 7, gap: 4, halfWidth: 2.5, material: 'roadProposed',
    });
    segments += 1;
  }
  const result = await mesh.writeGlb(resolve(OUTPUT, 'proposals/content.glb'));
  await writeJson(resolve(OUTPUT, 'proposal-connections.json'), PROPOSAL_CONNECTIONS);
  return { ...result, connections: segments };
}

/* ---------- land blocks: faces of the at-grade road graph ---------- */

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* Extract closed faces (city blocks) from the road planar graph. OSM ways
   share node ids at junctions, so topology comes straight from the data. */
function extractBlockFaces(ways, nodes) {
  const edges = [];           // directed half-edges {from, to}
  const outgoing = new Map(); // nodeId -> [halfEdgeIndex]
  const seen = new Set();
  for (const way of ways) {
    const tags = way.tags ?? {};
    if (!BLOCK_HIGHWAYS.has(tags.highway) || tags.area === 'yes') continue;
    if ((tags.bridge && tags.bridge !== 'no') || (tags.tunnel && tags.tunnel !== 'no')) continue;
    const ids = way.nodes ?? [];
    for (let i = 0; i < ids.length - 1; i += 1) {
      const a = ids[i];
      const b = ids[i + 1];
      if (a === b || !nodes.has(a) || !nodes.has(b)) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const e = edges.length;
      edges.push({ from: a, to: b }, { from: b, to: a });
      if (!outgoing.has(a)) outgoing.set(a, []);
      if (!outgoing.has(b)) outgoing.set(b, []);
      outgoing.get(a).push(e);
      outgoing.get(b).push(e + 1);
    }
  }

  const position = new Map(); // halfEdgeIndex -> slot in its node's sorted list
  const mPerDegLon = 111320 * Math.cos(ORIGIN.latitude * Math.PI / 180);
  for (const [id, list] of outgoing) {
    const n = nodes.get(id);
    list.sort((e1, e2) => {
      const t1 = nodes.get(edges[e1].to);
      const t2 = nodes.get(edges[e2].to);
      return Math.atan2(t1.lat - n.lat, (t1.lon - n.lon) * mPerDegLon) -
             Math.atan2(t2.lat - n.lat, (t2.lon - n.lon) * mPerDegLon);
    });
    list.forEach((e, slot) => position.set(e, slot));
  }

  /* Next half-edge keeping the face on the left: at the target node take the
     clockwise-predecessor of the twin. Inner faces come out CCW (positive area). */
  function nextHalfEdge(e) {
    const twin = e ^ 1;
    const list = outgoing.get(edges[twin].from);
    const slot = position.get(twin);
    return list[(slot - 1 + list.length) % list.length];
  }

  const visited = new Uint8Array(edges.length);
  const faces = [];
  for (let e = 0; e < edges.length; e += 1) {
    if (visited[e]) continue;
    const ring = [];
    let cur = e;
    let guard = 0;
    while (!visited[cur] && guard < 200000) {
      visited[cur] = 1;
      ring.push(edges[cur].from);
      cur = nextHalfEdge(cur);
      guard += 1;
    }
    if (cur === e && ring.length >= 3) faces.push(ring);
  }
  return faces;
}

function buildBlocks(ways, nodes, terrain, waterFeatures) {
  const faces = extractBlockFaces(ways, nodes);
  const waterLocal = waterFeatures.map((feature) => {
    const ring = feature.ring.map((p) => geo.project(p[1], p[2], 0));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    return { ring, minX, minY, maxX, maxY };
  });

  const blocks = [];
  let skippedSmall = 0;
  let skippedWater = 0;
  let skippedTriangulation = 0;
  for (const face of faces) {
    const projected = face.map((id) => {
      const n = nodes.get(id);
      return geo.project(n.lon, n.lat, 0);
    });
    const area = signedArea(projected);
    if (area < 150 || area > 6e7) { skippedSmall += 1; continue; }

    let cx = 0, cy = 0, cLon = 0, cLat = 0;
    for (let i = 0; i < face.length; i += 1) {
      cx += projected[i][0]; cy += projected[i][1];
      const n = nodes.get(face[i]);
      cLon += n.lon; cLat += n.lat;
    }
    cx /= face.length; cy /= face.length;
    cLon /= face.length; cLat /= face.length;
    if (terrain.sample(cLon, cLat) <= 0.05) { skippedWater += 1; continue; }
    let inWater = false;
    for (const w of waterLocal) {
      if (cx < w.minX || cx > w.maxX || cy < w.minY || cy > w.maxY) continue;
      if (pointInRing(cx, cy, w.ring)) { inWater = true; break; }
    }
    if (inWater) { skippedWater += 1; continue; }

    /* Draped fill: clipped against the terrain grid at emit time so the parcel
       top follows the ground instead of floating as a flat slab on slopes.
       Classify hills by local relief, not absolute altitude: otherwise flat
       urban districts above 18 m are incorrectly painted green. */
    const mLon = 111320 * Math.cos(ORIGIN.latitude * Math.PI / 180);
    const hillAt = (x, y) => {
      const lon = ORIGIN.longitude + x / mLon;
      const lat = ORIGIN.latitude - y / 110574;
      const h = terrain.sample(lon, lat);
      const e = terrain.sample(lon + 0.002, lat);
      const w = terrain.sample(lon - 0.002, lat);
      const n = terrain.sample(lon, lat + 0.002);
      const s = terrain.sample(lon, lat - 0.002);
      const relief = Math.max(Math.abs(e - h), Math.abs(w - h), Math.abs(n - h), Math.abs(s - h));
      const slope = relief / (0.002 * mLon);
      return slope > 0.10 || (h > 45 && slope > 0.035);
    };
    const lift = BLOCK_LIFT + Math.min(0.12, 6 / Math.sqrt(area));
    const hill = hillAt(cx, cy);
    const shades = hill ? BLOCK_SHADES : PARCEL_SHADES;
    const prefix = hill ? 'block' : 'parcel';
    const faceKey = face.slice().sort((a, b) => a - b).join('_');
    /* Park/golf-scale faces (>40 ha) read as "empty ground" because one uniform
       shade covers everything. Subdivide them visually into ~180 m cells with
       per-cell shades so the parcel mosaic reads like the street grid. Real
       street-bounded parcels keep their exact OSM boundaries. */
    if (area > 4e5) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of projected) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
      const CELL = 180;
      for (let gy = Math.floor(minY / CELL); gy <= Math.floor(maxY / CELL); gy += 1) {
        for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx += 1) {
          const x0 = gx * CELL, y0 = gy * CELL;
          const piece = clipConvex(projected, [[x0, y0], [x0 + CELL, y0], [x0 + CELL, y0 + CELL], [x0, y0 + CELL]]);
          if (piece.length < 3) continue;
          const pieceArea = signedArea(piece);
          if (pieceArea < 150) continue;
          const shade = hashString(`${faceKey}_${gx}_${gy}`) % shades.length;
          const cellHill = hillAt(x0 + CELL / 2, y0 + CELL / 2);
          blocks.push({
            ring: piece,
            lift: BLOCK_LIFT + Math.min(0.12, 6 / Math.sqrt(pieceArea)),
            area: pieceArea,
            material: `${cellHill ? 'block' : 'parcel'}${shade}`,
          });
        }
      }
      continue;
    }
    const shade = hashString(faceKey) % shades.length;
    blocks.push({ ring: projected.map((p) => [p[0], p[1]]), lift, area, material: `${prefix}${shade}` });
  }
  blocks.sort((a, b) => b.area - a.area);
  return { blocks, faces: faces.length, skippedSmall, skippedWater, skippedTriangulation };
}

async function buildTerrain(field, blocks) {
  const mesh = new MeshBuilder({
    ground: MATERIALS.ground,
    groundFlat: MATERIALS.groundFlat,
    water: MATERIALS.water,
    block0: MATERIALS.block0,
    block1: MATERIALS.block1,
    block2: MATERIALS.block2,
    block3: MATERIALS.block3,
    parcel0: MATERIALS.parcel0,
    parcel1: MATERIALS.parcel1,
    parcel2: MATERIALS.parcel2,
    parcel3: MATERIALS.parcel3
  });
  const steps = field.steps;
  const points = [];
  for (let row = 0; row <= steps; row += 1) {
    const line = [];
    for (let column = 0; column <= steps; column += 1) {
      const elevation = field.h[row * (steps + 1) + column] - 0.20;
      line.push({ point: geo.toGltf([field.es[column], field.ns[row], elevation]), elevation });
    }
    points.push(line);
  }
  for (let row = 0; row < steps; row += 1) {
    for (let column = 0; column < steps; column += 1) {
      const a = points[row][column];
      const b = points[row][column + 1];
      const c = points[row + 1][column + 1];
      const d = points[row + 1][column];
      const elevs = [a.elevation, b.elevation, c.elevation, d.elevation];
      const avg = (a.elevation + b.elevation + c.elevation + d.elevation) / 4;
      const range = Math.max(...elevs) - Math.min(...elevs);
      const material = elevs.every((e) => e <= 0.05) ? 'water'
        : (range > 8 || (avg > 45 && range > 3) ? 'ground' : 'groundFlat');
      mesh.addTriangle([a.point, c.point, b.point], material, [0, 1, 0]);
      mesh.addTriangle([a.point, d.point, c.point], material, [0, 1, 0]);
    }
  }
  /* Real land parcels enclosed by the road network, draped on the same height
     field as the ground so lifts order exactly on hills and shorelines. */
  for (const block of blocks) {
    emitDraped(mesh, field, block.ring, block.lift, block.material);
  }
  return mesh.writeGlb(resolve(OUTPUT, 'terrain/content.glb'));
}

async function buildWater(features, field) {
  const mesh = new MeshBuilder({ water: MATERIALS.water });
  let polygons = 0;
  for (const feature of features) {
    const projected = localRing(feature.ring, 0);
    if (Math.abs(polygonArea(projected)) < 1) continue;
    emitDraped(mesh, field, projected.map((p) => [p[0], p[1]]), 0.18, 'water');
    polygons += 1;
  }
  const result = await mesh.writeGlb(resolve(OUTPUT, 'water/content.glb'));
  return { ...result, polygons, triangulationFailures: 0 };
}

/* Official Singapore MRT/LRT line colours, keyed by OSM route `ref`. */
const LINE_COLOURS = {
  NS: '#DA291C', EW: '#009645', CC: '#F9A825', DT: '#005EC4', NE: '#990089',
  TE: '#9D5B25', BP: '#748477', SK: '#748477', PG: '#748477'
};

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function railColourKey(rgb) {
  return `rail_${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

function buildRailColours(index) {
  const map = new Map();
  for (const relation of index.relations) {
    const tags = relation.tags ?? {};
    if (!['subway', 'light_rail', 'monorail'].includes(tags.route)) continue;
    let rgb = hexToRgb(tags.colour ?? tags.color ?? '');
    if (!rgb && tags.ref && LINE_COLOURS[tags.ref]) rgb = hexToRgb(LINE_COLOURS[tags.ref]);
    if (!rgb) continue;
    for (const member of relation.members ?? []) {
      if (member.type === 'way') map.set(member.ref, rgb);
    }
  }
  return map;
}

function railMaterial(rgb) {
  const colour = rgb.map((v) => v / 255);
  return { baseColor: [...colour, 1], emissive: colour, emissiveStrength: 2.4, roughness: 0.5, doubleSided: true };
}

async function buildRail(ways, nodes, railColours, field) {
  const DEFAULT_COLOUR = [139, 128, 224];
  const lines = [];
  const colours = new Map();
  for (const way of ways) {
    const tags = way.tags ?? {};
    if (!tags.railway || tags.area === 'yes') continue;
    if (!/^(subway|rail|light_rail|monorail|narrow_gauge|funicular)$/.test(tags.railway)) continue;
    const coordinates = simplifyLine(wayCoordinates(way, nodes), LINE_SIMPLIFY_TOL);
    if (coordinates.length < 2) continue;
    let rgb = railColours.get(way.id);
    if (!rgb) rgb = hexToRgb(tags.colour ?? tags.color ?? '') || DEFAULT_COLOUR;
    const key = railColourKey(rgb);
    colours.set(key, rgb);
    lines.push({ coordinates, key });
  }

  const materials = {};
  for (const [key, rgb] of colours) materials[key] = railMaterial(rgb);
  const mesh = new MeshBuilder(materials);
  const halfWidth = 2.2;
  let segments = 0;

  for (const line of lines) {
    const { coordinates, key } = line;
    for (let i = 0; i < coordinates.length - 1; i += 1) {
      const clipped = clipLineToBbox(coordinates[i], coordinates[i + 1], BBOX);
      if (!clipped) continue;
      const start = clipped[0];
      const end = clipped[1];
      const a = geo.project(start[1], start[2], 0);
      const b = geo.project(end[1], end[2], 0);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 0.05) continue;
      const offset = [dy / length * halfWidth, -dx / length * halfWidth, 0];
      emitDraped(mesh, field, [
        [a[0] + offset[0], a[1] + offset[1]],
        [b[0] + offset[0], b[1] + offset[1]],
        [b[0] - offset[0], b[1] - offset[1]],
        [a[0] - offset[0], a[1] - offset[1]]
      ], 0.62, key);
      segments += 1;
    }
  }

  const result = await mesh.writeGlb(resolve(OUTPUT, 'rail/content.glb'));
  return { ...result, segments, lines: lines.length };
}

async function buildBuildings(features, field) {
  const mesh = new MeshBuilder({
    roof: MATERIALS.roof,
    facade: MATERIALS.facade,
    windowCyan: MATERIALS.windowCyan,
    windowWarm: MATERIALS.windowWarm
  });
  const stats = { heightMeasured: 0, heightLevels: 0, heightEstimated: 0, buildings: 0, windows: 0, skippedTiny: 0, triangulationFailures: 0 };
  const heightRecords = [];

  for (const feature of features) {
    const center = centroid(feature.ring);
    const base = Math.max(0, field.at(center.x, center.y));
    const projected = localRing(feature.ring, base);
    const area = polygonArea(projected);
    if (area < 8) {
      stats.skippedTiny += 1;
      continue;
    }
    const sourceHeight = inferHeight(feature, area, stats);
    const height = Math.max(1.5, sourceHeight * BUILDING_HEIGHT_SCALE);
    const top = base + height;
    const flat = projected.flatMap((point) => [point[0], point[1]]);
    const triangles = safeTriangulate(flat);
    if (!triangles) {
      stats.triangulationFailures += 1;
      continue;
    }
    for (let index = 0; index < triangles.length; index += 3) {
      const vertices = triangles.slice(index, index + 3).map((vertex) => {
        const point = projected[vertex];
        return geo.toGltf([point[0], point[1], top]);
      });
      mesh.addTriangle(vertices, 'roof', [0, 1, 0]);
    }

    const ccw = signedArea(projected) > 0;
    for (let index = 0; index < projected.length - 1; index += 1) {
      const a = projected[index];
      const b = projected[index + 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 0.1) continue;
      const outward = ccw ? [dy / length, -dx / length, 0] : [-dy / length, dx / length, 0];
      const wall = [
        geo.toGltf(a),
        geo.toGltf(b),
        geo.toGltf([b[0], b[1], top]),
        geo.toGltf([a[0], a[1], top])
      ];
      mesh.addQuad(wall, 'facade', geo.toGltf(outward));

      if (height < 20 || length < 7 || stats.windows >= 18000) continue;
      const columns = Math.min(5, Math.floor(length / 7));
      const rows = Math.min(7, Math.floor(height / 5));
      const tangent = [dx / length, dy / length, 0];
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          if (stats.windows >= 18000) break;
          const t = (column + 1) / (columns + 1);
          const z = base + (row + 1) * height / (rows + 1);
          const centerPoint = [
            a[0] + dx * t + outward[0] * 0.10,
            a[1] + dy * t + outward[1] * 0.10,
            z
          ];
          const halfWidth = 0.65;
          const halfHeight = 0.85;
          const windowVertices = [
            [centerPoint[0] - tangent[0] * halfWidth, centerPoint[1] - tangent[1] * halfWidth, z - halfHeight],
            [centerPoint[0] + tangent[0] * halfWidth, centerPoint[1] + tangent[1] * halfWidth, z - halfHeight],
            [centerPoint[0] + tangent[0] * halfWidth, centerPoint[1] + tangent[1] * halfWidth, z + halfHeight],
            [centerPoint[0] - tangent[0] * halfWidth, centerPoint[1] - tangent[1] * halfWidth, z + halfHeight]
          ].map(geo.toGltf);
          const material = hashString(`${feature.id}/${index}/${row}/${column}`) % 7 === 0 ? 'windowWarm' : 'windowCyan';
          mesh.addQuad(windowVertices, material, geo.toGltf(outward));
          stats.windows += 1;
        }
      }
    }
    stats.buildings += 1;
    heightRecords.push({ id: feature.id, name: feature.tags.name ?? null, height, sourceHeight, displayScale: BUILDING_HEIGHT_SCALE, base, area, heightSource: feature.tags.height ? 'osm_height' : feature.tags['building:levels'] ? 'osm_levels' : 'deterministic_estimate' });
  }
  const result = await mesh.writeGlb(resolve(OUTPUT, 'buildings/content.glb'));
  await writeJson(resolve(OUTPUT, 'building-heights.json'), heightRecords);
  return { ...result, ...stats };
}

/* ---------- road names: merged continuous polylines per named street ---------- */

/* Greedily stitch open way segments that share endpoint node ids. */
function stitchLines(segments) {
  const remaining = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const lines = [];
  while (remaining.length) {
    const line = remaining.shift();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i += 1) {
        const candidate = remaining[i];
        const head = line[0];
        const tail = line.at(-1);
        if (candidate.at(-1)[0] === head[0]) {
          line.unshift(...candidate.slice(0, -1));
        } else if (candidate[0][0] === head[0]) {
          line.unshift(...candidate.slice(1).reverse());
        } else if (candidate[0][0] === tail[0]) {
          line.push(...candidate.slice(1));
        } else if (candidate.at(-1)[0] === tail[0]) {
          line.push(...candidate.slice(0, -1).reverse());
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    lines.push(line);
  }
  return lines;
}

const ROAD_CLASS_RANK = { roadMajor: 0, roadSecondary: 1, roadMinor: 2 };

function buildRoadNames(ways, nodes) {
  const groups = new Map();
  for (const way of ways) {
    const tags = way.tags ?? {};
    if (!isDisplayRoad(tags)) continue;
    const name = tags.name || tags['name:en'] || tags.ref;
    if (!name) continue;
    const coordinates = wayCoordinates(way, nodes);
    if (coordinates.length < 2) continue;
    if (!groups.has(name)) groups.set(name, { name, ref: tags.ref ?? null, rank: 2, segments: [] });
    const group = groups.get(name);
    group.rank = Math.min(group.rank, ROAD_CLASS_RANK[roadClass(tags)]);
    if (tags.ref && !group.ref) group.ref = tags.ref;
    group.segments.push(coordinates);
  }

  const roads = [];
  for (const group of groups.values()) {
    const stitched = stitchLines(group.segments);
    const lines = [];
    for (const line of stitched) {
      const simplified = simplifyLine(line, 0.00001);
      let length = 0;
      for (let i = 0; i < simplified.length - 1; i += 1) {
        length += Math.hypot(
          (simplified[i + 1][1] - simplified[i][1]) * 111320 * Math.cos(ORIGIN.latitude * Math.PI / 180),
          (simplified[i + 1][2] - simplified[i][2]) * 110574);
      }
      if (length < 40) continue;
      lines.push({ length, coords: simplified.map((p) => [p[1], p[2]]) });
    }
    if (!lines.length) continue;
    lines.sort((a, b) => b.length - a.length);
    roads.push({
      name: group.name,
      ref: group.ref,
      roadClass: ['roadMajor', 'roadSecondary', 'roadMinor'][group.rank],
      lines: lines.map((l) => l.coords)
    });
  }
  roads.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return roads;
}

async function writeTileset(layer, maximumHeight = 1000) {
  const tileset = {
    asset: { version: '1.1', tilesetVersion: DATA_VERSION },
    geometricError: 0,
    root: {
      boundingVolume: { region: regionFromBbox(BBOX, -50, maximumHeight) },
      geometricError: 0,
      refine: 'REPLACE',
      transform: geo.transform,
      content: { uri: 'content.glb' }
    }
  };
  await writeJson(resolve(OUTPUT, layer, 'tileset.json'), tileset);
}

function buildSearchIndex(osm, buildingFeatures, namedRoads) {
  /* Micro-amenities that clutter the search list without being destinations. */
  const EXCLUDE_KINDS = new Set([
    'parking_entrance', 'parking_exit', 'waste_basket', 'bench', 'atm',
    'payment_terminal', 'vending_machine', 'post_box', 'toilets', 'drinking_water',
    'fountain', 'photo_booth', 'parcel_locker', 'recycling', 'car_sharing',
    'charging_station', 'motorcycle_parking', 'bicycle_parking', 'bicycle_rental',
    'car_rental', 'car_pooling', 'boat_rental', 'taxi', 'bbq', 'shelter',
    'picnic_site', 'camp_site', 'bbq;shelter',
  ]);
  /* Reject unit numbers, placeholder notes and symbol-only names so the
     dropdown reads as a place list, not raw OSM tag debris. */
  function cleanName(raw) {
    const n = (raw ?? '').trim();
    if (n.length < 2) return null;
    if (/^[\d\s#%@:;.,\-–—()\/\\'"]+$/.test(n)) return null;
    if (/^\(.*\)$/.test(n)) return null;
    if (/^#\d/.test(n)) return null;
    if (/^[:%@+]/.test(n)) return null;
    if (/^\d+[-–]\d+$/.test(n)) return null;
    if (/^\$\d/.test(n)) return null;
    if (/^\d+[A-Za-z]?\s*\([^)]*\)$/.test(n)) return null;
    if (/working title|formerly|closed for renovation/i.test(n)) return null;
    return n;
  }
  const KIND_SCORE = { road: 3, building: 2 };
  const byName = new Map();
  function offer(entry) {
    const name = cleanName(entry.name);
    if (!name || EXCLUDE_KINDS.has(entry.kind)) return;
    const score = KIND_SCORE[entry.kind] ?? 1;
    const prev = byName.get(name);
    if (!prev || score > prev.score) byName.set(name, { entry: { ...entry, name }, score });
  }
  for (const element of osm.elements) {
    if (element.type === 'node' && element.tags?.name) {
      offer({ id: `node/${element.id}`, name: element.tags.name, kind: element.tags.tourism ?? element.tags.amenity ?? 'poi', longitude: element.lon, latitude: element.lat });
    }
  }
  for (const feature of buildingFeatures) {
    if (!feature.tags.name) continue;
    const center = centroid(feature.ring);
    offer({ id: feature.id, name: feature.tags.name, kind: 'building', longitude: center.longitude, latitude: center.latitude });
  }
  for (const road of namedRoads) {
    const longest = road.lines[0];
    const mid = longest[Math.floor(longest.length / 2)];
    offer({ id: `road/${road.name}`, name: road.name, kind: 'road', longitude: mid[0], latitude: mid[1] });
  }
  return [...byName.values()].map((v) => v.entry)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log('[SG-City] Loading Marina Bay OSM snapshot...');
  const { data: osm, rawBytes, rawSha256 } = await loadOsm();
  console.log(`[SG-City] OSM elements: ${osm.elements.length}`);
  console.log('[SG-City] Loading terrain tiles...');
  const terrain = await loadTerrainSampler();
  const field = createHeightField(terrain);
  const index = indexOsm(osm);
  const relationStats = { buildingUnclosedRelations: 0, waterUnclosedRelations: 0 };
  const rawBuildings = collectClosedPolygons(index, (tags) => Boolean(tags.building && tags.building !== 'no'), 'building', relationStats);
  const rawWater = collectClosedPolygons(index, (tags) => tags.natural === 'water' || tags.landuse === 'reservoir' || tags.waterway === 'riverbank', 'water', relationStats);
  const buildings = rawBuildings.map(clipPolygonFeature).filter(Boolean);
  const water = rawWater.map(clipPolygonFeature).filter(Boolean);
  const osmRoads = [...index.ways.values()].filter((way) => way.tags?.highway);
  const lta = await loadLtaRoadSectionLines(resolve(RAW, 'lta/RoadSectionLine_Sep2026'), BBOX);
  const mergedRoads = lta
    ? mergeLtaRoads(osmRoads, index.nodes, lta)
    : { roads: osmRoads, stats: { ltaOfficialWays: 0, ltaMatchedWays: 0, ltaUnmatchedWays: 0, osmSupplementWays: osmRoads.length } };
  const roads = mergedRoads.roads;
  const railColours = buildRailColours(index);
  const rails = [...index.ways.values()].filter((way) => way.tags?.railway);

  console.log(`[SG-City] Buildings: ${buildings.length}; roads: ${roads.length}; rail ways: ${rails.length}; water polygons: ${water.length}`);
  if (lta) console.log(`[SG-City] LTA geometry: ${mergedRoads.stats.ltaOfficialWays} ways; matched attributes: ${mergedRoads.stats.ltaMatchedWays}; OSM supplements: ${mergedRoads.stats.osmSupplementWays}`);
  console.log('[SG-City] Extracting land blocks from OSM road graph (kept stable for parcels)...');
  const blockResult = buildBlocks(osmRoads, index.nodes, terrain, water);
  console.log(`[SG-City] Blocks: ${blockResult.blocks.length} of ${blockResult.faces} faces (small:${blockResult.skippedSmall} water:${blockResult.skippedWater} tri:${blockResult.skippedTriangulation})`);
  const terrainResult = await buildTerrain(field, blockResult.blocks);
  const waterResult = await buildWater(water, field);
  const roadsResult = await buildRoads(roads, index.nodes, field);
  const proposalResult = await buildProposalConnections(field);
  const railResult = await buildRail(rails, index.nodes, railColours, field);
  const buildingsResult = await buildBuildings(buildings, field);
  for (const layer of ['terrain', 'water', 'roads', 'proposals', 'rail', 'buildings']) await writeTileset(layer);
  const namedRoads = buildRoadNames(roads, index.nodes);
  await writeJson(resolve(OUTPUT, 'road-names.json'), namedRoads);
  console.log(`[SG-City] Named roads: ${namedRoads.length}`);
  const search = buildSearchIndex(osm, buildings, namedRoads);
  await writeJson(resolve(OUTPUT, 'search.json'), search);

  const manifest = {
    schemaVersion: '1.0',
    dataVersion: DATA_VERSION,
    generatedAt: new Date().toISOString(),
    startedAt,
    offline: true,
    origin: ORIGIN,
    bbox: BBOX,
    crs: { geographic: 'EPSG:4326', officialRoadInput: 'EPSG:3414 SVY21', rendering: 'WGS84 ECEF with local ENU tile transforms' },
    verticalDatum: 'Mapzen source elevation; display-grade P0, not survey-grade',
    buildingHeightDisplayScale: BUILDING_HEIGHT_SCALE,
    roadGeometry: lta ? {
      source: 'LTA Road Section Line Sep2026',
      role: 'Official horizontal road geometry; OSM supplies supplementary roads and nearest-match attributes',
      displayFilter: 'Complete road network; no access or construction filtering',
      ...mergedRoads.stats,
    } : { source: 'OpenStreetMap only', role: 'LTA input unavailable' },
    layers: ['terrain', 'water', 'roads', 'proposals', 'rail', 'buildings'].map((id) => ({ id, entry: `${id}/tileset.json`, visible: true })),
    sources: lta ? ['lta-road-section-line', 'osm-overpass', 'mapzen-terrain-tiles'] : ['osm-overpass', 'mapzen-terrain-tiles'],
    limitations: [
      'Scheme-comparison base only; not survey-controlled and not for setting out, construction or acceptance.',
      'LTA supplies horizontal road geometry; names, widths and bridge/tunnel attributes are nearest-match OSM estimates unless separately surveyed.',
      'The complete road network is shown to preserve connectivity; private and construction attributes require engineering interpretation.',
      'The Rhu Cross A-B dashed orange connector is a user-approved scheme placeholder, not an existing road or surveyed alignment.',
      'Single-resolution P0 tiles; hierarchical LOD is a full-city pipeline task.',
      'Building heights without OSM height or levels are deterministic estimates.',
      `All building heights are multiplied by ${BUILDING_HEIGHT_SCALE} for display; sourceHeight retains the unscaled value.`,
      'Bridge heights and terrain are display approximations, not engineering elevations.',
      'Land blocks are generated visual faces, not cadastral parcels.',
      'Complex inner rings, 3D Tiles feature metadata and hand-authored landmarks are not yet implemented.'
    ]
  };
  await writeJson(resolve(OUTPUT, 'manifest.json'), manifest);
  const quality = {
    dataVersion: DATA_VERSION,
    rawOsm: { bytes: rawBytes, sha256: rawSha256, elements: osm.elements.length },
    rawLta: lta ? {
      dataset: 'LTA Road Section Line Sep2026',
      sourceCrs: 'EPSG:3414 SVY21',
      records: lta.records,
      bytes: lta.bytes,
      shpSha256: lta.shpSha256,
      dbfSha256: lta.dbfSha256,
    } : null,
    terrainTiles: terrain.provenance,
    counts: {
      buildingFeatures: buildings.length,
      roadWays: roads.length,
      displayRoadWays: roadsResult.streetWays,
      filteredNonPublicRoadWays: roads.length - roadsResult.streetWays,
      proposalConnections: proposalResult.connections,
      osmRoadWays: osmRoads.length,
      ...mergedRoads.stats,
      railWays: rails.length,
      waterFeatures: water.length,
      searchEntries: search.length,
      landBlocks: blockResult.blocks.length,
      namedRoads: namedRoads.length,
      ...relationStats
    },
    meshes: { terrain: terrainResult, water: waterResult, roads: roadsResult, proposals: proposalResult, rail: railResult, buildings: buildingsResult },
    checks: {
      externalRuntimeUrls: 0,
      localLayerCount: manifest.layers.length,
      generatedGlbFiles: 6,
      requiresUnrealVisualValidation: true
    }
  };
  await writeJson(resolve(OUTPUT, 'quality-report.json'), quality);
  const attribution = `SG-City P0 data attribution\n\nRoad geometry: Land Transport Authority, Road Section Line (Sep 2026), SVY21 / EPSG:3414.\nSource: https://datamall.lta.gov.sg/content/dam/datamall/datasets/Geospatial/RoadSectionLine_Sep2026.zip\nSingapore Open Data Licence: https://data.gov.sg/open-data-licence\nLTA geometry is converted to WGS84 without visual shifting. Road names, widths and bridge/tunnel attributes are supplemented from nearby OSM ways and are not surveyed attributes.\nThe complete road network is shown to preserve connectivity; private and construction attributes require engineering interpretation.\n\nSupplementary roads, buildings, water and place names: Map data © OpenStreetMap contributors, ODbL 1.0\nhttps://www.openstreetmap.org/copyright\n\nTerrain Tiles was accessed on 2026-11-02 from https://registry.opendata.aws/terrain-tiles.\nTerrain Tiles by Mapzen/Tilezen. Underlying source attributions:\nhttps://github.com/tilezen/joerd/blob/master/docs/attribution.md\nSRTM terrain data courtesy of the U.S. Geological Survey where applicable.\n\nThe Rhu Cross A-B dashed orange connector is a user-approved scheme placeholder without LTA kerb evidence. It is not an existing road or surveyed alignment.\n\nThis dataset supports scheme comparison and spatial coordination only. It is not survey-controlled and must not be used for construction setting out or acceptance. Estimated building heights, road widths and bridge elevations are not authoritative.\n`;
  await writeFile(resolve(OUTPUT, 'ATTRIBUTION.txt'), attribution, 'utf8');

  const checksumFiles = ['manifest.json', 'search.json', 'road-names.json', 'proposal-connections.json', 'building-heights.json', 'quality-report.json', 'ATTRIBUTION.txt'];
  for (const layer of ['terrain', 'water', 'roads', 'proposals', 'rail', 'buildings']) {
    checksumFiles.push(`${layer}/tileset.json`, `${layer}/content.glb`);
  }
  const checksums = {};
  for (const file of checksumFiles) checksums[file] = sha256(await readFile(resolve(OUTPUT, file)));
  await writeJson(resolve(OUTPUT, 'checksums.json'), checksums);
  console.log(`[SG-City] P0 data written: ${OUTPUT}`);
  console.log(JSON.stringify(quality.counts, null, 2));
}

main().catch((error) => {
  console.error(`[SG-City] Build failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
