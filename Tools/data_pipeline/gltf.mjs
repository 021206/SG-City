import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(value) {
  const length = Math.hypot(...value) || 1;
  return value.map((component) => component / length);
}

export class MeshBuilder {
  constructor(materials) {
    this.materials = materials;
    this.primitives = new Map();
    for (const name of Object.keys(materials)) {
      this.primitives.set(name, { positions: [], normals: [], indices: [] });
    }
    this.triangleCount = 0;
  }

  addTriangle(vertices, materialName, normalHint = null) {
    const primitive = this.primitives.get(materialName);
    if (!primitive) throw new Error(`Unknown material: ${materialName}`);
    let [a, b, c] = vertices;
    let normal = normalize(cross(subtract(b, a), subtract(c, a)));
    if (normalHint && dot(normal, normalHint) < 0) {
      [b, c] = [c, b];
      normal = normal.map((value) => -value);
    }
    if (![...a, ...b, ...c, ...normal].every(Number.isFinite)) {
      throw new Error('Non-finite vertex generated');
    }
    const base = primitive.positions.length / 3;
    primitive.positions.push(...a, ...b, ...c);
    primitive.normals.push(...normal, ...normal, ...normal);
    primitive.indices.push(base, base + 1, base + 2);
    this.triangleCount += 1;
  }

  addQuad(vertices, materialName, normalHint = null) {
    this.addTriangle([vertices[0], vertices[1], vertices[2]], materialName, normalHint);
    this.addTriangle([vertices[0], vertices[2], vertices[3]], materialName, normalHint);
  }

  async writeGlb(filePath) {
    const json = {
      asset: { version: '2.0', generator: 'SG-City offline data pipeline 0.1.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: 'SG-City P0' }],
      meshes: [{ primitives: [] }],
      materials: [],
      buffers: [],
      bufferViews: [],
      accessors: []
    };
    const binaryParts = [];
    let byteOffset = 0;
    const materialIndices = new Map();
    let usesEmissiveStrength = false;

    for (const [name, material] of Object.entries(this.materials)) {
      const index = json.materials.length;
      materialIndices.set(name, index);
      const emissiveStrength = material.emissiveStrength ?? 1;
      const output = {
        name,
        pbrMetallicRoughness: {
          baseColorFactor: material.baseColor,
          metallicFactor: material.metallic ?? 0,
          roughnessFactor: material.roughness ?? 0.85
        },
        emissiveFactor: material.emissive ?? [0, 0, 0],
        doubleSided: material.doubleSided ?? false
      };
      if (emissiveStrength > 1) {
        output.extensions = { KHR_materials_emissive_strength: { emissiveStrength } };
        usesEmissiveStrength = true;
      }
      json.materials.push(output);
    }

    const appendBuffer = (data, target) => {
      const padding = (4 - byteOffset % 4) % 4;
      if (padding) {
        binaryParts.push(Buffer.alloc(padding));
        byteOffset += padding;
      }
      const viewIndex = json.bufferViews.length;
      json.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length, target });
      binaryParts.push(data);
      byteOffset += data.length;
      return viewIndex;
    };

    for (const [name, primitive] of this.primitives) {
      if (primitive.indices.length === 0) continue;
      const positions = new Float32Array(primitive.positions);
      const normals = new Float32Array(primitive.normals);
      const indices = new Uint32Array(primitive.indices);
      const positionView = appendBuffer(Buffer.from(positions.buffer), 34962);
      const normalView = appendBuffer(Buffer.from(normals.buffer), 34962);
      const indexView = appendBuffer(Buffer.from(indices.buffer), 34963);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let index = 0; index < positions.length; index += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], positions[index + axis]);
          max[axis] = Math.max(max[axis], positions[index + axis]);
        }
      }
      const positionAccessor = json.accessors.push({ bufferView: positionView, componentType: 5126, count: positions.length / 3, type: 'VEC3', min, max }) - 1;
      const normalAccessor = json.accessors.push({ bufferView: normalView, componentType: 5126, count: normals.length / 3, type: 'VEC3' }) - 1;
      const indexAccessor = json.accessors.push({ bufferView: indexView, componentType: 5125, count: indices.length, type: 'SCALAR' }) - 1;
      json.meshes[0].primitives.push({
        attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
        indices: indexAccessor,
        material: materialIndices.get(name),
        mode: 4
      });
    }

    if (usesEmissiveStrength) {
      json.extensionsUsed = ['KHR_materials_emissive_strength'];
    }
    json.buffers.push({ byteLength: byteOffset });

    let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const jsonPadding = (4 - jsonBuffer.length % 4) % 4;
    if (jsonPadding) jsonBuffer = Buffer.concat([jsonBuffer, Buffer.alloc(jsonPadding, 0x20)]);
    const binaryBuffer = Buffer.concat(binaryParts);
    const binaryPadding = (4 - binaryBuffer.length % 4) % 4;
    const paddedBinary = binaryPadding ? Buffer.concat([binaryBuffer, Buffer.alloc(binaryPadding)]) : binaryBuffer;
    const totalLength = 12 + 8 + jsonBuffer.length + 8 + paddedBinary.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(totalLength, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonBuffer.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binaryHeader = Buffer.alloc(8);
    binaryHeader.writeUInt32LE(paddedBinary.length, 0);
    binaryHeader.writeUInt32LE(0x004e4942, 4);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.concat([header, jsonHeader, jsonBuffer, binaryHeader, paddedBinary]));
    return { bytes: totalLength, triangles: this.triangleCount, primitives: json.meshes[0].primitives.length };
  }
}
