const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;

export function lonLatToEcef(longitude, latitude, height = 0) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (n + height) * cosLat * Math.cos(lon),
    (n + height) * cosLat * Math.sin(lon),
    (n * (1 - WGS84_E2) + height) * sinLat
  ];
}

export function createGeoContext(origin) {
  const lon = origin.longitude * Math.PI / 180;
  const lat = origin.latitude * Math.PI / 180;
  const center = lonLatToEcef(origin.longitude, origin.latitude, origin.height);
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  return {
    origin,
    project(longitude, latitude, height = origin.height) {
      const point = lonLatToEcef(longitude, latitude, height);
      const delta = point.map((value, index) => value - center[index]);
      return [dot(delta, east), dot(delta, north), dot(delta, up)];
    },
    toGltf(point) {
      return [point[0], point[2], -point[1]];
    },
    transform: [
      ...east, 0,
      ...north, 0,
      ...up, 0,
      ...center, 1
    ]
  };
}

export function regionFromBbox(bbox, minimumHeight = -20, maximumHeight = 1000) {
  return [
    bbox.west * Math.PI / 180,
    bbox.south * Math.PI / 180,
    bbox.east * Math.PI / 180,
    bbox.north * Math.PI / 180,
    minimumHeight,
    maximumHeight
  ];
}

export function longitudeToTileX(longitude, zoom) {
  return (longitude + 180) / 360 * 2 ** zoom;
}

export function latitudeToTileY(latitude, zoom) {
  const lat = latitude * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * 2 ** zoom;
}

export function tileXToLongitude(x, zoom) {
  return x / 2 ** zoom * 360 - 180;
}

export function tileYToLatitude(y, zoom) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** zoom;
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function signedArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

export function polygonArea(ring) {
  return Math.abs(signedArea(ring));
}

export function stitchRings(ways) {
  const remaining = ways.filter((way) => way.length >= 2).map((way) => [...way]);
  const rings = [];

  while (remaining.length > 0) {
    const ring = remaining.shift();
    let extended = true;
    while (extended && ring[0][0] !== ring.at(-1)[0] || extended && ring[0][1] !== ring.at(-1)[1]) {
      extended = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const last = ring.at(-1);
        if (candidate[0][0] === last[0] && candidate[0][1] === last[1]) {
          ring.push(...candidate.slice(1));
        } else if (candidate.at(-1)[0] === last[0] && candidate.at(-1)[1] === last[1]) {
          ring.push(...candidate.slice(0, -1).reverse());
        } else {
          continue;
        }
        remaining.splice(index, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) {
      rings.push(ring);
    }
  }
  return rings;
}
