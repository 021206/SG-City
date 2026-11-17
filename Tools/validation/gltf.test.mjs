import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MeshBuilder } from '../data_pipeline/gltf.mjs';

test('GLB writer emits a structurally valid single triangle', async () => {
  const mesh = new MeshBuilder({ ground: { baseColor: [0, 0, 0, 1] } });
  mesh.addTriangle([[0, 0, 0], [1, 0, 0], [0, 1, 0]], 'ground', [0, 0, 1]);
  const path = resolve('LocalData/interim/test-triangle.glb');
  await mesh.writeGlb(path);
  const data = await readFile(path);
  assert.equal(data.readUInt32LE(0), 0x46546c67);
  assert.equal(data.readUInt32LE(4), 2);
  assert.equal(data.readUInt32LE(8), data.length);
  const jsonLength = data.readUInt32LE(12);
  const gltf = JSON.parse(data.toString('utf8', 20, 20 + jsonLength));
  assert.equal(gltf.asset.version, '2.0');
  assert.equal(gltf.accessors[gltf.meshes[0].primitives[0].indices].count, 3);
});
