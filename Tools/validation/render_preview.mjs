import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clipLineToBbox, clipRingToBbox } from '../data_pipeline/geometry.mjs';
import { createGeoContext, polygonArea } from '../data_pipeline/geo.mjs';

const ROOT = resolve(process.cwd());
const RAW = resolve(ROOT, 'LocalData/raw/marina-bay-osm.json');
const OUTPUT = resolve(ROOT, 'LocalData/interim/p0-preview.svg');
const BBOX = { south: 1.270, west: 103.845, north: 1.300, east: 103.880 };
const ORIGIN = { longitude: 103.8625, latitude: 1.285, height: 0 };
const WIDTH = 1200;
const HEIGHT = 1000;
const geo = createGeoContext(ORIGIN);

function localPoint(point) {
  const local = geo.project(point[1], point[2]);
  return [local[0], local[1]];
}

function toSvg(point) {
  const x = (point[0] + 2000) / 4000 * WIDTH;
  const y = HEIGHT - (point[1] + 1700) / 3400 * HEIGHT;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

function renderRing(ring, fill, stroke, opacity = 1) {
  const clipped = clipRingToBbox(ring, BBOX);
  if (clipped.length < 4) return '';
  const points = clipped.map(localPoint).map(toSvg).join(' ');
  return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" fill-opacity="${opacity}" />`;
}

async function main() {
  const data = JSON.parse(await readFile(RAW, 'utf8'));
  const nodes = new Map();
  const ways = new Map();
  for (const element of data.elements) {
    if (element.type === 'node') nodes.set(element.id, element);
    if (element.type === 'way') ways.set(element.id, element);
  }
  const coordinates = (way) => (way.nodes ?? []).map((id) => {
    const node = nodes.get(id);
    return node ? [id, node.lon, node.lat] : null;
  }).filter(Boolean);

  const parts = [];
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#031E22"/>`);
  for (const way of ways.values()) {
    const ring = coordinates(way);
    if (ring.length >= 4 && ring[0][0] === ring.at(-1)[0]) {
      if (way.tags?.natural === 'water' || way.tags?.landuse === 'reservoir' || way.tags?.waterway === 'riverbank') {
        parts.push(renderRing(ring, '#0A5F6B', '#0A5F6B', 0.85));
      }
    }
  }
  for (const way of ways.values()) {
    if (!way.tags?.highway || way.tags.area === 'yes') continue;
    const points = coordinates(way);
    for (let index = 0; index < points.length - 1; index += 1) {
      const clipped = clipLineToBbox(points[index], points[index + 1], BBOX);
      if (!clipped) continue;
      const start = toSvg(localPoint(clipped[0]));
      const end = toSvg(localPoint(clipped[1]));
      const major = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
      const isMajor = major.some((value) => (way.tags.highway ?? '').startsWith(value));
      parts.push(`<line x1="${start.split(',')[0]}" y1="${start.split(',')[1]}" x2="${end.split(',')[0]}" y2="${end.split(',')[1]}" stroke="${isMajor ? '#00E6B0' : '#0B8F75'}" stroke-opacity="${isMajor ? 0.85 : 0.45}" stroke-width="${isMajor ? 2.5 : 1.2}" />`);
    }
  }
  for (const way of ways.values()) {
    const ring = coordinates(way);
    if (!way.tags?.building || way.tags.building === 'no') continue;
    if (ring.length < 4 || ring[0][0] !== ring.at(-1)[0]) continue;
    const clipped = clipRingToBbox(ring, BBOX);
    if (clipped.length < 4) continue;
    const area = polygonArea(clipped.map(localPoint));
    if (area < 8) continue;
    const height = Number.parseFloat(way.tags.height ?? '') || Number.parseFloat(way.tags['building:levels'] ?? '') * 3.2 || 12;
    const alpha = Math.min(0.95, 0.35 + height / 260);
    parts.push(renderRing(ring, height > 120 ? '#32F5C8' : '#0B2428', '#0B2428', alpha));
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">\n${parts.join('\n')}\n</svg>\n`;
  await writeFile(OUTPUT, svg, 'utf8');
  console.log(`Preview written: ${OUTPUT}`);
}

main().catch((error) => {
  console.error(`Preview failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
