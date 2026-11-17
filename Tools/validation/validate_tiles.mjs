import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = resolve(ROOT, 'LocalData/SGCityData');
const errors = [];
const warnings = [];
let glbCount = 0;
let triangleCount = 0;

function check(condition, message) {
  if (!condition) errors.push(message);
}

async function validateGlb(filePath) {
  const data = await readFile(filePath);
  check(data.length >= 20, `${filePath}: GLB too small`);
  check(data.readUInt32LE(0) === 0x46546c67, `${filePath}: invalid GLB magic`);
  check(data.readUInt32LE(4) === 2, `${filePath}: unsupported GLB version`);
  check(data.readUInt32LE(8) === data.length, `${filePath}: GLB length mismatch`);
  const jsonLength = data.readUInt32LE(12);
  check(data.readUInt32LE(16) === 0x4e4f534a, `${filePath}: missing JSON chunk`);
  const gltf = JSON.parse(data.toString('utf8', 20, 20 + jsonLength));
  check(gltf.asset?.version === '2.0', `${filePath}: glTF asset version must be 2.0`);
  check(gltf.meshes?.[0]?.primitives?.length > 0, `${filePath}: no mesh primitives`);
  for (const primitive of gltf.meshes?.[0]?.primitives ?? []) {
    const position = gltf.accessors[primitive.attributes.POSITION];
    const normal = gltf.accessors[primitive.attributes.NORMAL];
    const indices = gltf.accessors[primitive.indices];
    check(position?.type === 'VEC3', `${filePath}: POSITION must be VEC3`);
    check(normal?.type === 'VEC3', `${filePath}: NORMAL must be VEC3`);
    check(indices?.count % 3 === 0, `${filePath}: triangle index count is not divisible by 3`);
    check(position?.min?.every(Number.isFinite) && position?.max?.every(Number.isFinite), `${filePath}: invalid position bounds`);
    triangleCount += indices?.count / 3 || 0;
  }
  glbCount += 1;
}

async function main() {
  const manifestPath = resolve(DATA, 'manifest.json');
  check(existsSync(manifestPath), `Missing manifest: ${manifestPath}`);
  if (errors.length) throw new Error(errors.join('\n'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  check(manifest.offline === true, 'Manifest is not marked offline');
  check(Array.isArray(manifest.layers) && manifest.layers.length >= 4, 'Expected at least four layers');
  check(Number.isFinite(manifest.origin?.longitude) && Number.isFinite(manifest.origin?.latitude), 'Invalid origin');

  const serialized = JSON.stringify(manifest);
  check(!/https?:\/\//i.test(serialized), 'Manifest contains an external runtime URL');
  for (const layer of manifest.layers) {
    check(!/^[a-z]:/i.test(layer.entry) && !layer.entry.startsWith('/'), `${layer.id}: entry must be relative`);
    const tilesetPath = resolve(DATA, layer.entry);
    check(existsSync(tilesetPath), `${layer.id}: missing tileset.json`);
    if (!existsSync(tilesetPath)) continue;
    const tileset = JSON.parse(await readFile(tilesetPath, 'utf8'));
    check(tileset.asset?.version === '1.1', `${layer.id}: expected 3D Tiles 1.1`);
    check(tileset.root?.transform?.length === 16, `${layer.id}: invalid root transform`);
    check(tileset.root?.transform?.every(Number.isFinite), `${layer.id}: non-finite root transform`);
    check(tileset.root?.boundingVolume?.region?.length === 6, `${layer.id}: invalid bounding region`);
    const uri = tileset.root?.content?.uri;
    check(uri === 'content.glb', `${layer.id}: expected local content.glb`);
    if (uri) await validateGlb(resolve(dirname(tilesetPath), uri));
  }

  const checksumsPath = resolve(DATA, 'checksums.json');
  if (existsSync(checksumsPath)) {
    const checksums = JSON.parse(await readFile(checksumsPath, 'utf8'));
    for (const [file, expected] of Object.entries(checksums)) {
      const data = await readFile(resolve(DATA, file));
      const actual = createHash('sha256').update(data).digest('hex');
      check(actual === expected, `${file}: checksum mismatch`);
    }
  } else {
    warnings.push('checksums.json is missing');
  }

  const search = JSON.parse(await readFile(resolve(DATA, 'search.json'), 'utf8'));
  check(Array.isArray(search), 'search.json must be an array');
  for (const entry of search) {
    check(Boolean(entry.id && entry.name), 'Search entry missing id or name');
    check(Number.isFinite(entry.longitude) && Number.isFinite(entry.latitude), `Invalid search coordinate: ${entry.id}`);
  }

  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({
    status: 'passed',
    layers: manifest.layers.length,
    glbFiles: glbCount,
    triangles: triangleCount,
    searchEntries: search.length,
    checksums: 'passed',
    note: 'Structural validation only; Unreal rendering and offline packaged tests still require UE 5.7.'
  }, null, 2));
}

main().catch((error) => {
  console.error(`Validation failed:\n${error.message}`);
  process.exitCode = 1;
});
