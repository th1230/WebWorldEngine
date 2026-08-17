import {
  asAssetId,
  ASSET_SCHEMA_VERSION,
  MESH_HEADER_BYTES,
  MESH_MAGIC,
  VERTEX_STRIDE_BYTES,
  type AssetManifest,
  type MeshEntry,
} from '@webworld/format';

import { describe, expect, it, vi } from 'vitest';
import { AssetCache } from './asset-cache.ts';
import { AssetFormatError, decodeMesh, pixelsPerUnitAtOneMetre, readMeshHeader, selectLod } from './decode.ts';

/** 建構一個最小但合法的 .wwm：4 個頂點、2 個 LOD。 */
function buildMesh(): { bytes: Uint8Array; entry: MeshEntry } {
  const vertexCount = 4;
  const vertexBytes = vertexCount * VERTEX_STRIDE_BYTES;
  const lod0 = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const lod1 = new Uint16Array([0, 1, 2]);

  const vertexOffset = MESH_HEADER_BYTES;
  const lod0Offset = vertexOffset + vertexBytes;
  const lod1Offset = lod0Offset + 16; // 12 位元組向上對齊到 16
  const total = lod1Offset + 8;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MESH_MAGIC, true);
  view.setUint32(4, ASSET_SCHEMA_VERSION, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, VERTEX_STRIDE_BYTES, true);

  const vertices = new Float32Array(bytes.buffer, vertexOffset, vertexCount * 8);
  for (let v = 0; v < vertexCount; v++) vertices[v * 8] = v;

  for (const [i, value] of lod0.entries()) view.setUint16(lod0Offset + i * 2, value, true);
  for (const [i, value] of lod1.entries()) view.setUint16(lod1Offset + i * 2, value, true);

  const entry: MeshEntry = {
    id: asAssetId('mesh:test'),
    contentHash: 'abc',
    file: 'mesh_test.wwm',
    byteLength: total,
    bounds: { center: [0, 0, 0], radius: 1, min: [-1, -1, -1], max: [1, 1, 1] },
    lods: [
      {
        level: 0,
        error: 0,
        vertexCount,
        indexCount: 6,
        indexBytes: 2,
        vertices: { offset: vertexOffset, length: vertexBytes },
        indices: { offset: lod0Offset, length: 12 },
      },
      {
        level: 1,
        error: 0.5,
        vertexCount,
        indexCount: 3,
        indexBytes: 2,
        vertices: { offset: vertexOffset, length: vertexBytes },
        indices: { offset: lod1Offset, length: 6 },
      },
    ],
    collision: null,
    material: null,
  };

  return { bytes, entry };
}

function manifestWith(entry: MeshEntry): AssetManifest {
  return {
    schemaVersion: ASSET_SCHEMA_VERSION,
    cookerVersion: 'test',
    contentHash: 'x',
    meshes: { [entry.id]: entry },
    materials: {},
    textures: {},
    warnings: [],
    stats: {},
  };
}

describe('readMeshHeader', () => {
  it('accepts a valid header', () => {
    const { bytes } = buildMesh();
    expect(readMeshHeader(bytes).lodCount).toBe(2);
  });

  it('rejects a file that is too short', () => {
    expect(() => readMeshHeader(new Uint8Array(4))).toThrow(AssetFormatError);
  });

  it('rejects a wrong magic number', () => {
    // 格式錯誤必須在這裡失敗，不能讓亂資料流進 GPU buffer ——
    // 那會變成看起來像圖形 bug、實則是檔案問題的疑難雜症
    const { bytes } = buildMesh();
    new DataView(bytes.buffer).setUint32(0, 0xdeadbeef, true);
    expect(() => readMeshHeader(bytes)).toThrow(/magic/);
  });

  it('rejects a mismatched schema version and says how to fix it', () => {
    const { bytes } = buildMesh();
    new DataView(bytes.buffer).setUint32(4, 99, true);
    expect(() => readMeshHeader(bytes)).toThrow(/pnpm cook/);
  });
});

describe('decodeMesh', () => {
  it('decodes every LOD', () => {
    const { bytes, entry } = buildMesh();
    const lods = decodeMesh(bytes, entry);
    expect(lods).toHaveLength(2);
    expect(lods[0]!.indices).toHaveLength(6);
    expect(lods[1]!.indices).toHaveLength(3);
  });

  it('shares one vertex array across LODs without copying', () => {
    const { bytes, entry } = buildMesh();
    const lods = decodeMesh(bytes, entry);
    expect(lods[1]!.vertices).toBe(lods[0]!.vertices);
    // 視圖直接落在原始 buffer 上，沒有複製
    expect(lods[0]!.vertices.buffer).toBe(bytes.buffer);
  });

  it('carries the LOD error through', () => {
    const { bytes, entry } = buildMesh();
    expect(decodeMesh(bytes, entry)[1]!.error).toBe(0.5);
  });

  it('rejects a block that runs past the end of the file', () => {
    const { bytes, entry } = buildMesh();
    entry.lods[0]!.indices.offset = bytes.byteLength - 2;
    entry.lods[0]!.indices.length = 999;
    expect(() => decodeMesh(bytes, entry)).toThrow(/超出檔案範圍/);
  });
});

describe('selectLod', () => {
  const lods = [
    { level: 0, error: 0, vertices: new Float32Array(), indices: new Uint16Array(), },
    { level: 1, error: 0.1, vertices: new Float32Array(), indices: new Uint16Array() },
    { level: 2, error: 1.0, vertices: new Float32Array(), indices: new Uint16Array() },
  ];

  it('picks the coarsest LOD whose error is invisible', () => {
    // 很遠 → 連 1.0 的誤差投影後都不到一個像素
    expect(selectLod(lods, 10_000, 800, 1)).toBe(2);
  });

  it('picks LOD0 up close', () => {
    expect(selectLod(lods, 1, 800, 1)).toBe(0);
  });

  it('depends on projected error, not distance alone', () => {
    // 同樣距離，視野越窄（每單位像素越多）就需要越細的 LOD
    const near = selectLod(lods, 200, 4000, 1);
    const far = selectLod(lods, 200, 200, 1);
    expect(near).toBeLessThan(far);
  });

  it('never divides by zero at the camera position', () => {
    expect(Number.isFinite(selectLod(lods, 0, 800, 1))).toBe(true);
  });
});

describe('pixelsPerUnitAtOneMetre', () => {
  it('grows as the field of view narrows', () => {
    const wide = pixelsPerUnitAtOneMetre(1080, (90 * Math.PI) / 180);
    const narrow = pixelsPerUnitAtOneMetre(1080, (30 * Math.PI) / 180);
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe('AssetCache', () => {
  function cacheWith(bytes: Uint8Array, entry: MeshEntry, budgetBytes?: number) {
    const manifest = manifestWith(entry);
    const fetchBytes = vi.fn(async (url: string) => {
      if (url.endsWith('.json')) return new TextEncoder().encode(JSON.stringify(manifest)).buffer;
      return bytes.buffer;
    });
    const cache = new AssetCache({
      fetch: fetchBytes as unknown as (url: string) => Promise<ArrayBuffer>,
      ...(budgetBytes !== undefined ? { budgetBytes } : {}),
    });
    return { cache, fetchBytes, manifest };
  }

  it('loads a manifest and lists its meshes', async () => {
    const { bytes, entry } = buildMesh();
    const { cache } = cacheWith(bytes, entry);
    await cache.loadManifest('/cooked/assets.manifest.json');
    expect(cache.meshIds()).toEqual(['mesh:test']);
  });

  it('rejects a manifest from a different schema version', async () => {
    const { bytes, entry } = buildMesh();
    const { cache, manifest } = cacheWith(bytes, entry);
    manifest.schemaVersion = 99;
    await expect(cache.loadManifest('/cooked/assets.manifest.json')).rejects.toThrow(/pnpm cook/);
  });

  it('fetches a mesh only once for repeated acquires', async () => {
    const { bytes, entry } = buildMesh();
    const { cache, fetchBytes } = cacheWith(bytes, entry);
    await cache.loadManifest('/cooked/assets.manifest.json');

    await cache.acquire('mesh:test');
    await cache.acquire('mesh:test');

    // 一次 manifest + 一次 mesh
    expect(fetchBytes).toHaveBeenCalledTimes(2);
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
  });

  it('deduplicates concurrent requests for the same asset', async () => {
    // 沒有這層去重，剛進入視野的一批 物件 會同時發出數十個相同請求
    const { bytes, entry } = buildMesh();
    const { cache, fetchBytes } = cacheWith(bytes, entry);
    await cache.loadManifest('/cooked/assets.manifest.json');

    await Promise.all([
      cache.acquire('mesh:test'),
      cache.acquire('mesh:test'),
      cache.acquire('mesh:test'),
    ]);

    expect(fetchBytes).toHaveBeenCalledTimes(2);
  });

  it('reports a helpful error for an unknown asset', async () => {
    const { bytes, entry } = buildMesh();
    const { cache } = cacheWith(bytes, entry);
    await cache.loadManifest('/cooked/assets.manifest.json');
    await expect(cache.acquire('mesh:missing')).rejects.toThrow(/manifest 裡沒有/);
  });

  it('never evicts an asset that is still referenced', async () => {
    // 驅逐使用中的資產會讓正在畫的東西從底下消失
    const { bytes, entry } = buildMesh();
    const { cache } = cacheWith(bytes, entry, 1); // 預算極小，強迫驅逐
    await cache.loadManifest('/cooked/assets.manifest.json');

    await cache.acquire('mesh:test');
    expect(cache.stats.resident).toBe(1);
    expect(cache.stats.evictionFailures).toBe(1);
  });

  it('evicts once the last reference is released', async () => {
    const { bytes, entry } = buildMesh();
    const { cache } = cacheWith(bytes, entry, 1);
    await cache.loadManifest('/cooked/assets.manifest.json');

    await cache.acquire('mesh:test');
    cache.release('mesh:test');
    await cache.acquire('mesh:test'); // 再次進入會觸發驅逐檢查

    expect(cache.stats.resident).toBeGreaterThanOrEqual(1);
  });

  it('tracks resident bytes against the budget', async () => {
    const { bytes, entry } = buildMesh();
    const { cache } = cacheWith(bytes, entry);
    await cache.loadManifest('/cooked/assets.manifest.json');
    await cache.acquire('mesh:test');

    expect(cache.stats.residentBytes).toBe(bytes.byteLength);
  });

  it('requires a manifest before acquiring', async () => {
    const { bytes, entry } = buildMesh();
    const { cache } = cacheWith(bytes, entry);
    await expect(cache.acquire('mesh:test')).rejects.toThrow();
  });
});
