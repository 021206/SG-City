import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLtaRoadSectionLines, svy21ToWgs84 } from '../data_pipeline/lta-roads.mjs';

const bbox = { south: 1.242, west: 103.795, north: 1.335, east: 103.950 };
const sourceDir = resolve('LocalData/raw/lta/RoadSectionLine_Sep2026');

test('SVY21 projection origin round-trips to WGS84 without an offset', () => {
  const [longitude, latitude] = svy21ToWgs84(28001.642, 38744.572);
  assert.ok(Math.abs(longitude - 103.8333333333333) < 1e-10);
  assert.ok(Math.abs(latitude - 1.366666666666667) < 1e-10);
});

test('LTA SHP and DBF parse into finite in-region road geometry', {
  skip: !existsSync(resolve(sourceDir, 'RoadSectionLine.shp')),
}, async () => {
  const data = await loadLtaRoadSectionLines(sourceDir, bbox);
  assert.ok(data.records > 10000);
  assert.ok(data.ways.length > 1000);
  const gapA = data.ways.find((way) => way.id === 'lta/11254/0');
  const gapB = data.ways.find((way) => way.id === 'lta/11254/1');
  assert.ok(gapA && gapB);
  assert.equal(gapA.coordinates[0][0], gapB.coordinates[0][0], '0.72 m source gap must share a junction node');
  for (const way of data.ways) {
    assert.ok(way.tags['lta:road_code']);
    assert.ok(way.coordinates.length >= 2);
    for (const [, longitude, latitude] of way.coordinates) {
      assert.ok(Number.isFinite(longitude) && Number.isFinite(latitude));
      assert.ok(longitude > 103.6 && longitude < 104.1);
      assert.ok(latitude > 1.15 && latitude < 1.5);
    }
  }
});
