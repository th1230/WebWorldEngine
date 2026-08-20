import { VERTEX_FLOATS } from '@web-world-engine/format';
import { describe, expect, it } from 'vitest';
import {
  computeBounds,
  generateCollision,
  generateLods,
  recomputeNormals,
  triangleCount,
  vertexCount,
  weld,
  type RawMesh,
} from './geometry.ts';
import { packMesh } from './pack.ts';
import { cookAll, cookMesh, validateMesh } from './pipeline.ts';
import { icosphere, readSourceGltf, rock, writeSourceGltf } from './source-assets.ts';

/**
 * `from` 的每個頂點到 `to` **曲面**的距離，取最大值。
 *
 * 刻意用點到三角形而不是點到頂點：一個被移除的頂點可能離所有存活的頂點
 * 都很遠，卻幾乎就落在存活的曲面上（平坦區域中間的頂點正是這樣）。
 * 用點到頂點會系統性地高估，然後這個檢查就得靠一個沒有根據的容忍係數。
 */
function oneSidedHausdorff(from: RawMesh, to: RawMesh): number {
  let worst = 0;
  for (let v = 0; v < vertexCount(from); v++) {
    const b = v * VERTEX_FLOATS;
    const px = from.vertices[b]!;
    const py = from.vertices[b + 1]!;
    const pz = from.vertices[b + 2]!;

    let nearest = Infinity;
    for (let t = 0; t < to.indices.length; t += 3) {
      const d = pointTriangleDistanceSq(px, py, pz, to, t);
      if (d < nearest) nearest = d;
      if (nearest === 0) break;
    }
    if (nearest > worst) worst = nearest;
  }
  return Math.sqrt(worst);
}

/** 點到三角形的最短距離平方（Ericson, Real-Time Collision Detection §5.1.5）。 */
function pointTriangleDistanceSq(
  px: number,
  py: number,
  pz: number,
  mesh: RawMesh,
  at: number,
): number {
  const a = mesh.indices[at]! * VERTEX_FLOATS;
  const b = mesh.indices[at + 1]! * VERTEX_FLOATS;
  const c = mesh.indices[at + 2]! * VERTEX_FLOATS;
  const v = mesh.vertices;

  const ax = v[a]!;
  const ay = v[a + 1]!;
  const az = v[a + 2]!;
  const abx = v[b]! - ax;
  const aby = v[b + 1]! - ay;
  const abz = v[b + 2]! - az;
  const acx = v[c]! - ax;
  const acy = v[c + 1]! - ay;
  const acz = v[c + 2]! - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - v[b]!;
  const bpy = py - v[b + 1]!;
  const bpz = pz - v[b + 2]!;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const cpx = px - v[c]!;
  const cpy = py - v[c + 1]!;
  const cpz = pz - v[c + 2]!;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const closest = (s: number, t: number): number => {
    const qx = ax + abx * s + acx * t - px;
    const qy = ay + aby * s + acy * t - py;
    const qz = az + abz * s + acz * t - pz;
    return qx * qx + qy * qy + qz * qz;
  };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return closest(d1 / (d1 - d3), 0);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return closest(0, d2 / (d2 - d6));

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return closest(1 - w, w);
  }

  const denom = 1 / (va + vb + vc);
  return closest(vb * denom, vc * denom);
}

/** 三個頂點完全重複的四面體，用來驗證焊接。 */
function unweldedQuad(): RawMesh {
  const positions = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  const vertices = new Float32Array(positions.length * VERTEX_FLOATS);
  for (const [i, p] of positions.entries()) {
    vertices[i * VERTEX_FLOATS] = p[0]!;
    vertices[i * VERTEX_FLOATS + 1] = p[1]!;
    vertices[i * VERTEX_FLOATS + 2] = p[2]!;
  }
  return { vertices, indices: new Uint32Array([0, 1, 2, 3, 4, 5]) };
}

describe('validateMesh', () => {
  it('accepts a well-formed mesh', () => {
    expect(validateMesh('ok', icosphere(1))).toEqual([]);
  });

  it('detects out-of-range indices', () => {
    const mesh = icosphere(0);
    mesh.indices[0] = 99999;
    expect(validateMesh('bad', mesh).join()).toContain('越界');
  });

  it('detects degenerate triangles', () => {
    const mesh = icosphere(0);
    mesh.indices[1] = mesh.indices[0]!;
    expect(validateMesh('bad', mesh).join()).toContain('退化');
  });

  it('detects NaN in vertex data', () => {
    const mesh = icosphere(0);
    mesh.vertices[0] = Number.NaN;
    expect(validateMesh('bad', mesh).join()).toContain('NaN');
  });

  it('detects an index count that is not a multiple of three', () => {
    const mesh = icosphere(0);
    expect(validateMesh('bad', { ...mesh, indices: mesh.indices.slice(0, 4) }).join()).toContain(
      '3 的倍數',
    );
  });
});

describe('weld', () => {
  it('merges identical vertices', () => {
    const welded = weld(unweldedQuad());
    expect(vertexCount(welded)).toBe(4);
    expect(triangleCount(welded)).toBe(2);
  });

  it('keeps the surface intact after welding', () => {
    const original = unweldedQuad();
    const welded = weld(original);
    // 索引重新對應之後，三角形涵蓋的位置必須不變
    const positionsOf = (m: RawMesh): string[] =>
      Array.from(m.indices).map((i) =>
        [m.vertices[i * VERTEX_FLOATS], m.vertices[i * VERTEX_FLOATS + 1]].join(','),
      );
    expect(positionsOf(welded)).toEqual(positionsOf(original));
  });

  it('is a no-op on an already-welded mesh', () => {
    const sphere = icosphere(2);
    expect(vertexCount(weld(sphere))).toBe(vertexCount(sphere));
  });
});

describe('recomputeNormals', () => {
  it('points normals outward on a sphere', () => {
    const sphere = recomputeNormals(weld(icosphere(2)));
    // 球心在原點，所以法線應該與位置同向
    for (let v = 0; v < vertexCount(sphere); v++) {
      const base = v * VERTEX_FLOATS;
      const dot =
        sphere.vertices[base]! * sphere.vertices[base + 3]! +
        sphere.vertices[base + 1]! * sphere.vertices[base + 4]! +
        sphere.vertices[base + 2]! * sphere.vertices[base + 5]!;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('produces unit-length normals', () => {
    const sphere = recomputeNormals(weld(icosphere(1)));
    for (let v = 0; v < vertexCount(sphere); v++) {
      const base = v * VERTEX_FLOATS + 3;
      const length = Math.hypot(
        sphere.vertices[base]!,
        sphere.vertices[base + 1]!,
        sphere.vertices[base + 2]!,
      );
      expect(length).toBeCloseTo(1, 5);
    }
  });
});

describe('computeBounds', () => {
  it('uses the farthest vertex for the radius, not the AABB diagonal', () => {
    // 細長物件：AABB 對角線會嚴重高估半徑，影響 culling 的保守程度
    const mesh = icosphere(1);
    for (let v = 0; v < vertexCount(mesh); v++) {
      mesh.vertices[v * VERTEX_FLOATS] = mesh.vertices[v * VERTEX_FLOATS]! * 10;
    }
    const bounds = computeBounds(mesh);
    const diagonalHalf =
      Math.hypot(
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ) / 2;
    expect(bounds.radius).toBeLessThan(diagonalHalf);
  });

  it('handles an empty mesh without producing NaN', () => {
    const bounds = computeBounds({ vertices: new Float32Array(0), indices: new Uint32Array(0) });
    expect(bounds.radius).toBe(0);
    expect(bounds.center.every(Number.isFinite)).toBe(true);
  });
});

describe('generateLods', () => {
  it('produces a decreasing chain of triangle counts', async () => {
    const lods = await generateLods(recomputeNormals(weld(icosphere(4))));
    expect(lods.length).toBeGreaterThan(1);
    for (let i = 1; i < lods.length; i++) {
      expect(triangleCount(lods[i]!.mesh)).toBeLessThan(triangleCount(lods[i - 1]!.mesh));
    }
  });

  it('reports LOD0 with zero error', async () => {
    const lods = await generateLods(recomputeNormals(weld(icosphere(3))));
    expect(lods[0]!.error).toBe(0);
  });

  it('reports increasing error down the chain', async () => {
    // 嚴格遞增：「更粗 = 更不準」是所有下游都在假設的性質，而簡化器
    // 不保證它（每個目標各做一次貪婪選擇），所以被支配的階會被丟掉。
    const lods = await generateLods(recomputeNormals(weld(icosphere(4))));
    for (let i = 2; i < lods.length; i++) {
      expect(lods[i]!.error).toBeGreaterThan(lods[i - 1]!.error);
      expect(triangleCount(lods[i]!.mesh)).toBeLessThan(triangleCount(lods[i - 1]!.mesh));
    }
  });

  it('回報的誤差與獨立量到的幾何偏差在同一個量級', async () => {
    // 品質契約的地基是「幾何誤差投影到螢幕 ≤ 2 像素」，所以 `error` 的
    // **單位與量級**必須是對的。這裡獨立量一次來對照：LOD0 的每個頂點到
    // 該階**曲面**的距離取最大值（單向 Hausdorff），與 meshopt 的二次型
    // 誤差是兩套完全不同的算法。
    //
    // ## 這個檢查抓不到什麼（要講清楚，否則它會被當成保證）
    //
    // 它抓得到：漏掉 `* scale`（回報相對值）、單位搞錯、把誤差算成別的東西。
    // 它**抓不到** 20% 等級的偏差 —— 例如「每一階從上一階簡化」與「每一階
    // 從 LOD0 簡化」的差別。實測 icosphere(3) 上兩者最多差 23%，而兩套算法
    // 本身的差距就比那個大。那件事只能靠讀程式碼保證。
    const lods = await generateLods(recomputeNormals(weld(icosphere(3))));
    const base = lods[0]!.mesh;

    let previous = 0;
    for (let level = 1; level < lods.length; level++) {
      const measured = oneSidedHausdorff(base, lods[level]!.mesh);
      const reported = lods[level]!.error;

      expect(reported).toBeGreaterThan(measured * 0.5);
      expect(reported).toBeLessThan(measured * 3);
      expect(measured).toBeGreaterThan(previous);
      previous = measured;
    }
  });

  it('shares one vertex buffer across every LOD', async () => {
    // 這是格式的核心假設：切 LOD 只換 index buffer，不重新上傳頂點
    const lods = await generateLods(recomputeNormals(weld(icosphere(3))));
    for (const lod of lods) expect(lod.mesh.vertices).toBe(lods[0]!.mesh.vertices);
  });

  it('stops instead of emitting a useless LOD for a tiny mesh', async () => {
    const lods = await generateLods(recomputeNormals(weld(icosphere(0))));
    expect(lods.length).toBeGreaterThanOrEqual(1);
  });
});

describe('generateCollision', () => {
  it('is substantially simpler than the visual mesh', async () => {
    const visual = recomputeNormals(weld(icosphere(4)));
    const collision = await generateCollision(visual);
    expect(triangleCount(collision)).toBeLessThan(triangleCount(visual) / 2);
  });

  it('reuses the visual vertex buffer', async () => {
    const visual = recomputeNormals(weld(icosphere(3)));
    expect((await generateCollision(visual)).vertices).toBe(visual.vertices);
  });
});

describe('packMesh', () => {
  it('aligns every block to four bytes', async () => {
    const mesh = recomputeNormals(weld(icosphere(3)));
    const packed = packMesh(await generateLods(mesh), null);
    for (const lod of packed.lods) {
      expect(lod.vertices.offset % 4).toBe(0);
      expect(lod.indices.offset % 4).toBe(0);
    }
  });

  it('uses 16-bit indices when the vertex count allows', async () => {
    const packed = packMesh(await generateLods(recomputeNormals(weld(icosphere(3)))), null);
    expect(packed.lods[0]!.indexBytes).toBe(2);
  });

  it('points every LOD at the same vertex block', async () => {
    const packed = packMesh(await generateLods(recomputeNormals(weld(icosphere(3)))), null);
    for (const lod of packed.lods) {
      expect(lod.vertices.offset).toBe(packed.lods[0]!.vertices.offset);
    }
  });

  it('never overlaps index blocks', async () => {
    const packed = packMesh(await generateLods(recomputeNormals(weld(icosphere(4)))), null);
    const sorted = [...packed.lods].sort((a, b) => a.indices.offset - b.indices.offset);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!;
      expect(sorted[i]!.indices.offset).toBeGreaterThanOrEqual(
        previous.indices.offset + previous.indices.length,
      );
    }
  });
});

describe('glTF round-trip', () => {
  it('preserves geometry through write and read', async () => {
    const source = icosphere(2);
    const restored = await readSourceGltf(
      await writeSourceGltf({ material: 'material:rock', id: 'test', mesh: source }),
    );

    expect(vertexCount(restored)).toBe(vertexCount(source));
    expect(triangleCount(restored)).toBe(triangleCount(source));
    expect(restored.vertices[0]).toBeCloseTo(source.vertices[0]!, 5);
  });
});

describe('cook reproducibility', () => {
  it('gives the same hash for the same input', async () => {
    const mesh = rock(3, 0xabcd);
    const a = await cookMesh('mesh:test', mesh);
    const b = await cookMesh('mesh:test', mesh);
    expect(b.asset.entry.contentHash).toBe(a.asset.entry.contentHash);
  });

  it('gives a different hash when the geometry changes', async () => {
    const a = await cookMesh('mesh:test', rock(3, 0xabcd));
    const b = await cookMesh('mesh:test', rock(3, 0x1234));
    expect(b.asset.entry.contentHash).not.toBe(a.asset.entry.contentHash);
  });

  it('produces an identical manifest hash across full cooks', async () => {
    // cook 必須可重現。第一次跑這個檢查就抓到 stats.durationMs 被算進雜湊。
    const a = await cookAll({ builtins: true });
    const b = await cookAll({ builtins: true });
    expect(b.manifest.contentHash).toBe(a.manifest.contentHash);
  });

  it('produces byte-identical files across full cooks', async () => {
    const a = await cookAll({ builtins: true });
    const b = await cookAll({ builtins: true });
    for (const [name, bytes] of a.files) {
      expect(Array.from(b.files.get(name)!)).toEqual(Array.from(bytes));
    }
  });

  it('records the LOD chain in stats', async () => {
    const { manifest } = await cookAll({ builtins: true });
    const stats = manifest.stats['mesh:rock-large'];
    expect(stats?.lodTriangles.length).toBeGreaterThan(1);
    expect(stats!.lodTriangles[0]).toBeGreaterThan(stats!.lodTriangles.at(-1)!);
  });

  it('emits KTX2 textures alongside the meshes', async () => {
    const { manifest, files } = await cookAll({ textureSize: 64 });
    const textures = Object.values(manifest.textures);

    expect(textures.length).toBeGreaterThan(0);
    for (const texture of textures) {
      expect(files.has(texture.file)).toBe(true);
      expect(texture.levelCount).toBeGreaterThan(1);
      // BC1 對 RGBA8 是 8:1，BC5 是 4:1；混合平均應該遠大於 1
      expect(texture.uncompressedBytes / texture.byteLength).toBeGreaterThan(3);
    }
  });

  it('links materials to their cooked textures', async () => {
    const { manifest } = await cookAll({ textureSize: 64 });
    const rock = manifest.materials['material:rock'];

    expect(rock?.baseColorTexture).toBe('texture:rock-albedo');
    expect(rock?.normalTexture).toBe('texture:rock-normal');
    expect(rock?.roughnessAoTexture).toBe('texture:rock-orm');
    expect(manifest.textures[rock!.roughnessAoTexture!]).toBeDefined();
    // AO/roughness 走 BC5：兩個獨立通道各保有接近 8 位元精度。
    // 塞進 BC1 的話 roughness 的量化階梯會在光滑表面變成可見的亮度分帶。
    expect(manifest.textures[rock!.roughnessAoTexture!]!.vkFormat).toBe(141);
    // 引用的貼圖必須真的存在於 manifest，否則 runtime 會在載入時才炸
    expect(manifest.textures[rock!.baseColorTexture!]).toBeDefined();
    expect(manifest.textures[rock!.normalTexture!]).toBeDefined();
  });

  it('states the desktop-only scope rather than silently implying coverage', async () => {
    // 只出 BC 是**刻意的範圍決定**，不是遺漏。cook 的輸出必須說出這件事，
    // 否則拿去手機上跑的人只會看到一個無上下文的 GPU 上傳失敗。
    const { manifest } = await cookAll({ textureSize: 64 });
    expect(manifest.warnings.join()).toContain('不在範圍內');
  });

  it('can cook albedo as BC7 when high quality is requested', async () => {
    const compact = await cookAll({ textureSize: 64 });
    const high = await cookAll({ textureSize: 64, textureQuality: 'high' });
    const a = compact.manifest.textures['texture:rock-albedo']!;
    const b = high.manifest.textures['texture:rock-albedo']!;

    expect(a.vkFormat).toBe(132); // VK_FORMAT_BC1_RGB_SRGB_BLOCK
    expect(b.vkFormat).toBe(146); // VK_FORMAT_BC7_SRGB_BLOCK
    // BC7 是 8 bpp、BC1 是 4 bpp，所以**區塊資料**剛好一倍。但整個檔案不會
    // ——KTX2 的 header、DFD、level index 是固定開銷，不隨區塊資料放大。
    // 實測 3008 → 5744（開銷 272 位元組）。
    const ratio = b.byteLength / a.byteLength;
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.0);
    // 法線不受影響：BC5 沒有更高檔次的替代
    expect(high.manifest.textures['texture:rock-normal']!.vkFormat).toBe(141);
  });
});
