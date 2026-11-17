import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeoContext, regionFromBbox, stitchRings } from '../data_pipeline/geo.mjs';
import { clipLineToBbox, clipRingToBbox, triangulate } from '../data_pipeline/geometry.mjs';

test('origin projects to local zero', () => {
  const geo = createGeoContext({ longitude: 103.8625, latitude: 1.285, height: 0 });
  const point = geo.project(103.8625, 1.285, 0);
  assert.ok(Math.hypot(...point) < 1e-6);
  assert.equal(geo.transform.length, 16);
});

test('region uses radians and preserves heights', () => {
  const region = regionFromBbox({ west: 103, south: 1, east: 104, north: 2 }, -5, 100);
  assert.equal(region.length, 6);
  assert.ok(Math.abs(region[0] - 103 * Math.PI / 180) < 1e-12);
  assert.deepEqual(region.slice(4), [-5, 100]);
});

test('square triangulation produces two triangles', () => {
  const indices = triangulate([0, 0, 10, 0, 10, 10, 0, 10, 0, 0]);
  assert.equal(indices.length, 6);
});

test('way stitching closes an outer ring', () => {
  const rings = stitchRings([
    [[1, 103, 1], [2, 104, 1]],
    [[3, 104, 2], [4, 103, 2]],
    [[2, 104, 1], [3, 104, 2]],
    [[4, 103, 2], [1, 103, 1]]
  ]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
});

test('bbox clipping bounds polygons and lines', () => {
  const bbox = { west: 103.8, south: 1.2, east: 103.9, north: 1.3 };
  const ring = clipRingToBbox([
    [1, 103.7, 1.1], [2, 104.0, 1.1], [3, 104.0, 1.4], [4, 103.7, 1.4], [1, 103.7, 1.1]
  ], bbox);
  assert.ok(ring.length >= 4);
  assert.ok(ring.every((point) => point[1] >= bbox.west && point[1] <= bbox.east && point[2] >= bbox.south && point[2] <= bbox.north));

  const line = clipLineToBbox([1, 103.7, 1.25], [2, 103.95, 1.25], bbox);
  assert.ok(line);
  assert.equal(line[0][1], bbox.west);
  assert.equal(line[1][1], bbox.east);
});
