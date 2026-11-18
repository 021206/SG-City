import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const E2 = WGS84_F * (2 - WGS84_F);
const EP2 = E2 / (1 - E2);
const DEG = Math.PI / 180;
const SVY21 = {
  falseEasting: 28001.642,
  falseNorthing: 38744.572,
  centralMeridian: 103.8333333333333 * DEG,
  latitudeOfOrigin: 1.366666666666667 * DEG,
  scale: 1,
};

function meridionalArc(latitude) {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  return WGS84_A * (
    (1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * latitude
    - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * latitude)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * latitude)
    - (35 * e6 / 3072) * Math.sin(6 * latitude)
  );
}

/* EPSG:3414 SVY21 -> EPSG:4326, inverse Transverse Mercator on WGS84.
   No local affine fitting or visual nudging is applied. */
export function svy21ToWgs84(easting, northing) {
  const x = easting - SVY21.falseEasting;
  const y = northing - SVY21.falseNorthing;
  const m = meridionalArc(SVY21.latitudeOfOrigin) + y / SVY21.scale;
  const mu = m / (WGS84_A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const e1_2 = e1 * e1;
  const e1_3 = e1_2 * e1;
  const e1_4 = e1_2 * e1_2;
  const foot = mu
    + (3 * e1 / 2 - 27 * e1_3 / 32) * Math.sin(2 * mu)
    + (21 * e1_2 / 16 - 55 * e1_4 / 32) * Math.sin(4 * mu)
    + (151 * e1_3 / 96) * Math.sin(6 * mu)
    + (1097 * e1_4 / 512) * Math.sin(8 * mu);
  const sin = Math.sin(foot);
  const cos = Math.cos(foot);
  const tan = Math.tan(foot);
  const c1 = EP2 * cos * cos;
  const t1 = tan * tan;
  const n1 = WGS84_A / Math.sqrt(1 - E2 * sin * sin);
  const r1 = WGS84_A * (1 - E2) / (1 - E2 * sin * sin) ** 1.5;
  const d = x / (n1 * SVY21.scale);
  const d2 = d * d;
  const latitude = foot - (n1 * tan / r1) * (
    d2 / 2
    - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d2 * d2 / 24
    + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d2 * d2 * d2 / 720
  );
  const longitude = SVY21.centralMeridian + (
    d
    - (1 + 2 * t1 + c1) * d2 * d / 6
    + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d2 * d2 * d / 120
  ) / cos;
  return [longitude / DEG, latitude / DEG];
}

export function parseDbf(buffer) {
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const decoder = new TextDecoder('utf-8');
  const fields = [];
  for (let offset = 32; offset < headerLength - 1 && buffer[offset] !== 0x0d; offset += 32) {
    const rawName = buffer.subarray(offset, offset + 11);
    const name = decoder.decode(rawName).replace(/\0.*$/, '').trim();
    fields.push({ name, length: buffer[offset + 16] });
  }
  const records = [];
  for (let index = 0; index < recordCount; index += 1) {
    const base = headerLength + index * recordLength;
    if (base + recordLength > buffer.length) throw new Error(`DBF record ${index + 1} exceeds file length`);
    if (buffer[base] === 0x2a) { records.push(null); continue; }
    const record = {};
    let cursor = base + 1;
    for (const field of fields) {
      record[field.name] = decoder.decode(buffer.subarray(cursor, cursor + field.length)).trim();
      cursor += field.length;
    }
    records.push(record);
  }
  return records;
}

export function parsePolylineShapefile(buffer) {
  if (buffer.readInt32BE(0) !== 9994) throw new Error('Invalid Shapefile header');
  const records = [];
  let offset = 100;
  while (offset + 8 <= buffer.length) {
    const recordNumber = buffer.readInt32BE(offset);
    const contentLength = buffer.readInt32BE(offset + 4) * 2;
    const content = offset + 8;
    if (content + contentLength > buffer.length) throw new Error(`SHP record ${recordNumber} exceeds file length`);
    const shapeType = buffer.readUInt32LE(content);
    if (shapeType === 0) { records.push(null); offset = content + contentLength; continue; }
    if (![3, 13, 23].includes(shapeType)) throw new Error(`Expected a PolyLine Shapefile, got shape type ${shapeType}`);
    const partCount = buffer.readInt32LE(content + 36);
    const pointCount = buffer.readInt32LE(content + 40);
    const pointsOffset = content + 44 + partCount * 4;
    const parts = [];
    for (let part = 0; part < partCount; part += 1) {
      const first = buffer.readInt32LE(content + 44 + part * 4);
      const last = part + 1 < partCount ? buffer.readInt32LE(content + 44 + (part + 1) * 4) : pointCount;
      const points = [];
      for (let index = first; index < last; index += 1) {
        points.push([
          buffer.readDoubleLE(pointsOffset + index * 16),
          buffer.readDoubleLE(pointsOffset + index * 16 + 8),
        ]);
      }
      parts.push(points);
    }
    records.push({ recordNumber, parts });
    offset = content + contentLength;
  }
  return records;
}

/* Share node ids for junctions whose source endpoints differ only by rounding.
   Actual LTA coordinates are never moved; the ids only drive sealing caps and
   name stitching. A spatial hash avoids fixed-grid boundary artefacts. */
function unifyNearbyNodeIds(ways, toleranceM = 1) {
  const cellSize = 0.00001;
  const grid = new Map();
  let nextId = 0;
  const key = (x, y) => `${x},${y}`;
  for (const way of ways) {
    for (const point of way.coordinates) {
      const longitude = point[1];
      const latitude = point[2];
      const gx = Math.floor(longitude / cellSize);
      const gy = Math.floor(latitude / cellSize);
      let nearest = null;
      for (let x = gx - 1; x <= gx + 1; x += 1) {
        for (let y = gy - 1; y <= gy + 1; y += 1) {
          for (const candidate of grid.get(key(x, y)) ?? []) {
            const dx = (longitude - candidate.longitude) * 111320 * Math.cos(latitude * Math.PI / 180);
            const dy = (latitude - candidate.latitude) * 110574;
            const distance = Math.hypot(dx, dy);
            if (distance <= toleranceM && (!nearest || distance < nearest.distance)) {
              nearest = { candidate, distance };
            }
          }
        }
      }
      if (nearest) {
        point[0] = nearest.candidate.id;
      } else {
        const candidate = { id: `lta-node/${nextId++}`, longitude, latitude };
        const k = key(gx, gy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(candidate);
        point[0] = candidate.id;
      }
    }
  }
}

function intersectsBbox(part, bbox) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [longitude, latitude] of part) {
    west = Math.min(west, longitude); east = Math.max(east, longitude);
    south = Math.min(south, latitude); north = Math.max(north, latitude);
  }
  return east >= bbox.west && west <= bbox.east && north >= bbox.south && south <= bbox.north;
}

export async function loadLtaRoadSectionLines(directory, bbox) {
  const shpPath = resolve(directory, 'RoadSectionLine.shp');
  const dbfPath = resolve(directory, 'RoadSectionLine.dbf');
  if (!existsSync(shpPath) || !existsSync(dbfPath)) return null;
  const [shp, dbf] = await Promise.all([readFile(shpPath), readFile(dbfPath)]);
  const shapes = parsePolylineShapefile(shp);
  const attributes = parseDbf(dbf);
  if (shapes.length !== attributes.length) throw new Error(`LTA SHP/DBF record mismatch: ${shapes.length} vs ${attributes.length}`);
  const ways = [];
  let skippedOutside = 0;
  for (let index = 0; index < shapes.length; index += 1) {
    const shape = shapes[index];
    const properties = attributes[index];
    if (!shape || !properties) continue;
    for (let partIndex = 0; partIndex < shape.parts.length; partIndex += 1) {
      const projected = shape.parts[partIndex].map(([x, y]) => svy21ToWgs84(x, y));
      if (projected.length < 2 || !intersectsBbox(projected, bbox)) { skippedOutside += 1; continue; }
      const id = `lta/${shape.recordNumber}/${partIndex}`;
      const coordinates = [];
      for (const [longitude, latitude] of projected) {
        const previous = coordinates.at(-1);
        if (previous && Math.hypot(previous[1] - longitude, previous[2] - latitude) < 1e-12) continue;
        coordinates.push(['', longitude, latitude]);
      }
      if (coordinates.length < 2) continue;
      ways.push({
        id,
        coordinates,
        tags: {
          ...(properties.RD_CD_DESC ? { name: properties.RD_CD_DESC } : {}),
          'lta:road_code': properties.RD_CD ?? '',
          'lta:category': properties.RD_CATG_NA ?? 'NCAT',
          'lta:source': 'Road Section Line Sep2026',
        },
      });
    }
  }
  unifyNearbyNodeIds(ways);
  return {
    ways,
    records: shapes.length,
    skippedOutside,
    bytes: shp.length + dbf.length,
    shpSha256: createHash('sha256').update(shp).digest('hex'),
    dbfSha256: createHash('sha256').update(dbf).digest('hex'),
  };
}
