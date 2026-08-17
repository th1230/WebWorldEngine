import {
  ASSET_SCHEMA_VERSION,
  MESH_HEADER_BYTES,
  MESH_MAGIC,
  VERTEX_FLOATS,
  VERTEX_STRIDE_BYTES,
  type AssetManifest,
  type MeshEntry,
} from '@webworld/format';
import { MeshBasicMaterial } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstancedMesh } from './instanced-mesh.ts';
import { load } from './load.ts';
import { clearAssetCache } from './manifest.ts';

/**
 * 這一組刻意**手工組出 `.wwm` 的位元組**，不透過 cooker。
 *
 * 兩個理由：`@ww/three` 不該為了測試把離線工具鏈拖進來；而且手寫一次
 * 就等於把格式的假設寫在測試裡 —— 格式一改，這裡就會紅。
 */

/** 一個四面體：4 個頂點、4 個面，加上兩階簡化。 */
function buildAsset(): { manifest: AssetManifest; bytes: Uint8Array } {
  const positions = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const vertices = new Float32Array(positions.length * VERTEX_FLOATS);
  positions.forEach((p, v) => {
    const base = v * VERTEX_FLOATS;
    vertices[base] = p[0]!;
    vertices[base + 1] = p[1]!;
    vertices[base + 2] = p[2]!;
    vertices[base + 4] = 1; // normal.y
    vertices[base + 6] = v / 4; // uv.x
    vertices[base + 8] = 1; // tangent.x
    vertices[base + 11] = 1; // tangent.w
  });

  // 第 0 階用到全部四個頂點；第 1 階只用到三個 —— 壓縮要看得出差別。
  const lod0 = new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]);
  const lod1 = new Uint16Array([0, 1, 2]);

  const vertexBytes = vertices.byteLength;
  const lod0Offset = MESH_HEADER_BYTES + vertexBytes;
  const lod1Offset = lod0Offset + lod0.byteLength;
  const total = lod1Offset + lod1.byteLength;

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MESH_MAGIC, true);
  view.setUint32(4, ASSET_SCHEMA_VERSION, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, VERTEX_STRIDE_BYTES, true);
  bytes.set(new Uint8Array(vertices.buffer), MESH_HEADER_BYTES);
  bytes.set(new Uint8Array(lod0.buffer), lod0Offset);
  bytes.set(new Uint8Array(lod1.buffer), lod1Offset);

  const entry: MeshEntry = {
    id: 'mesh:tetra' as MeshEntry['id'],
    contentHash: 'test',
    file: 'mesh_tetra.wwm',
    byteLength: total,
    bounds: { center: [0, 0, 0], radius: 1, min: [0, 0, 0], max: [1, 1, 1] },
    lods: [
      {
        level: 0,
        error: 0,
        vertexCount: 4,
        indexCount: lod0.length,
        indexBytes: 2,
        vertices: { offset: MESH_HEADER_BYTES, length: vertexBytes },
        indices: { offset: lod0Offset, length: lod0.byteLength },
      },
      {
        level: 1,
        error: 0.25,
        vertexCount: 4,
        indexCount: lod1.length,
        indexBytes: 2,
        vertices: { offset: MESH_HEADER_BYTES, length: vertexBytes },
        indices: { offset: lod1Offset, length: lod1.byteLength },
      },
    ],
    collision: null,
    material: null,
  };

  return {
    bytes,
    manifest: {
      schemaVersion: ASSET_SCHEMA_VERSION,
      cookerVersion: 'test',
      contentHash: 'test',
      meshes: { 'mesh:tetra': entry },
      materials: {},
      textures: {},
      warnings: [],
      stats: {},
    },
  };
}

const MANIFEST_URL = 'http://localhost/cooked/assets.manifest.json';

describe('WW.load', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let asset: ReturnType<typeof buildAsset>;

  beforeEach(() => {
    clearAssetCache();
    asset = buildAsset();
    fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('.json')) {
        return { ok: true, json: async () => asset.manifest } as Response;
      }
      if (url.endsWith('.wwm')) {
        return {
          ok: true,
          arrayBuffer: async () => asset.bytes.buffer.slice(0),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAssetCache();
  });

  it('回傳一條可以直接餵給 InstancedMesh 的 LOD 鏈', async () => {
    const chain = await load(MANIFEST_URL, 'mesh:tetra');

    expect(chain.lods.length).toBe(2);
    expect(Array.from(chain.errors)).toEqual([0, 0.25]);

    const mesh = new InstancedMesh(chain, new MeshBasicMaterial(), 4);
    expect(mesh.levelCount).toBe(2);
  });

  it('.wwm 的路徑是相對 manifest 解出來的', async () => {
    await load(MANIFEST_URL, 'mesh:tetra');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://localhost/cooked/mesh_tetra.wwm');
  });

  it('每一階只帶自己用得到的頂點', async () => {
    // cook 過的格式是所有階共用一份頂點，但 BatchedMesh 是逐幾何複製的 ——
    // 不壓縮的話七階就是七份完整頂點。
    const chain = await load(MANIFEST_URL, 'mesh:tetra');

    expect(chain.lods[0]!.getAttribute('position').count).toBe(4);
    expect(chain.lods[1]!.getAttribute('position').count).toBe(3);
  });

  it('索引被重新編號到壓縮後的範圍', async () => {
    const chain = await load(MANIFEST_URL, 'mesh:tetra');
    const level1 = chain.lods[1]!;
    const vertices = level1.getAttribute('position').count;

    for (const index of level1.getIndex()!.array) {
      expect(index).toBeLessThan(vertices);
    }
  });

  it('法線、UV、切線都帶過來，而且對得上原本的頂點', async () => {
    const chain = await load(MANIFEST_URL, 'mesh:tetra');
    const level0 = chain.lods[0]!;

    expect(level0.getAttribute('normal').getY(0)).toBe(1);
    expect(level0.getAttribute('tangent').getW(0)).toBe(1);
    // 第 0 階的第一個索引是頂點 0，uv.x = 0/4
    expect(level0.getAttribute('uv').getX(0)).toBeCloseTo(0);
  });

  it('manifest 只抓一次，同一個網格也只解一次', async () => {
    const first = await load(MANIFEST_URL, 'mesh:tetra');
    const second = await load(MANIFEST_URL, 'mesh:tetra');

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2); // manifest + wwm
  });

  it('找不到 mesh 時列出有哪些', async () => {
    await expect(load(MANIFEST_URL, 'mesh:nope')).rejects.toThrow(/mesh:tetra/);
  });

  it('manifest 抓不到就講 HTTP 狀態，不是丟一個看不懂的解析錯誤', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as Response),
    );
    await expect(load(MANIFEST_URL, 'mesh:tetra')).rejects.toThrow(/HTTP 404/);
  });

  it('檔案不是 .wwm 時明確失敗，而不是把亂資料送進 GPU', async () => {
    const broken = new Uint8Array(asset.bytes);
    new DataView(broken.buffer).setUint32(0, 0xdeadbeef, true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('.json')
          ? ({ ok: true, json: async () => asset.manifest }) as Response
          : ({ ok: true, arrayBuffer: async () => broken.buffer.slice(0) }) as Response,
      ),
    );

    await expect(load(MANIFEST_URL, 'mesh:tetra')).rejects.toThrow(/magic/);
  });
});
