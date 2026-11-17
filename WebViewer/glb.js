/* Minimal glTF binary (GLB) parser for the SG-City P0 offline data.
 * Works in the browser (window.SGCityGLB) and in Node.js (module.exports).
 * Zero dependencies. */
(function (root) {
  'use strict';

  var COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  var COMPONENT_READERS = {
    5120: 'getInt8',
    5121: 'getUint8',
    5122: 'getInt16',
    5123: 'getUint16',
    5125: 'getUint32',
    5126: 'getFloat32',
  };
  var NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  function readAccessor(json, binary, accessorIndex) {
    var accessor = json.accessors[accessorIndex];
    if (!accessor) throw new Error('Missing accessor ' + accessorIndex);
    var bufferView = json.bufferViews[accessor.bufferView];
    var base = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    var count = accessor.count;
    var numComponents = NUM_COMPONENTS[accessor.type];
    if (!numComponents) throw new Error('Unsupported accessor type ' + accessor.type);
    var bytesPerComponent = COMPONENT_BYTES[accessor.componentType];
    var reader = COMPONENT_READERS[accessor.componentType];
    if (!bytesPerComponent || !reader) {
      throw new Error('Unsupported componentType ' + accessor.componentType);
    }
    var stride = bufferView.byteStride || numComponents * bytesPerComponent;
    var out = new Array(count);
    for (var i = 0; i < count; i++) {
      if (numComponents === 1) {
        out[i] = binary[reader](base + i * stride, true);
      } else {
        var components = new Array(numComponents);
        for (var c = 0; c < numComponents; c++) {
          components[c] = binary[reader](base + i * stride + c * bytesPerComponent, true);
        }
        out[i] = components;
      }
    }
    return out;
  }

  function parseGLB(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) {
      throw new Error('Not a GLB file (bad magic)');
    }
    var offset = 12;
    var jsonLength = dv.getUint32(offset, true);
    var jsonType = dv.getUint32(offset + 4, true);
    if (jsonType !== 0x4e4f534a) {
      throw new Error('GLB first chunk is not JSON');
    }
    var jsonText = new TextDecoder().decode(
      new Uint8Array(arrayBuffer, offset + 8, jsonLength));
    var json = JSON.parse(jsonText);
    offset += 8 + jsonLength;

    var binary = null;
    if (offset + 8 <= arrayBuffer.byteLength) {
      var binLength = dv.getUint32(offset, true);
      var binType = dv.getUint32(offset + 4, true);
      if (binType === 0x004e4942) {
        var available = arrayBuffer.byteLength - (offset + 8);
        binary = new DataView(arrayBuffer, offset + 8, Math.min(binLength, available));
      }
    }
    if (!binary) throw new Error('GLB has no BIN chunk');

    var materials = (json.materials || []).map(function (m) {
      var pbr = m.pbrMetallicRoughness || {};
      var base = pbr.baseColorFactor || [1, 1, 1, 1];
      var emissive = m.emissiveFactor || [0, 0, 0];
      var strength = 1;
      var ext = m.extensions && m.extensions.KHR_materials_emissive_strength;
      if (ext && typeof ext.emissiveStrength === 'number') {
        strength = ext.emissiveStrength;
      }
      return {
        baseColor: [base[0], base[1], base[2]],
        alpha: base[3],
        emissive: [
          emissive[0] * strength,
          emissive[1] * strength,
          emissive[2] * strength,
        ],
        doubleSided: !!m.doubleSided,
        name: m.name || '',
      };
    });

    var primitives = [];
    (json.meshes || []).forEach(function (mesh) {
      (mesh.primitives || []).forEach(function (prim) {
        if (prim.attributes == null || prim.attributes.POSITION == null) return;
        primitives.push({
          positions: readAccessor(json, binary, prim.attributes.POSITION),
          normals: prim.attributes.NORMAL != null
            ? readAccessor(json, binary, prim.attributes.NORMAL)
            : null,
          indices: prim.indices != null
            ? readAccessor(json, binary, prim.indices)
            : null,
          materialIndex: prim.material != null ? prim.material : 0,
        });
      });
    });

    return { materials: materials, primitives: primitives };
  }

  var api = { parseGLB: parseGLB };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.SGCityGLB = api;
})(typeof window !== 'undefined' ? window : globalThis);
