import {
  NORMAL_OFFSET,
  POSITION_OFFSET,
  TANGENT_OFFSET,
  UV_OFFSET,
  VERTEX_FLOATS,
  type MeshEntry,
} from '@webworld/format';
import { decodeMesh, type DecodedLod } from '@ww/assets-runtime';
import { BufferAttribute, BufferGeometry } from 'three';
import type { LodChain } from './lod-chain.ts';
import { loadManifest, onClearAssetCache, pick, resolveAssetUrl } from './manifest.ts';

/**
 * 載入 cook 過的網格，回傳一條可以直接交給 `WW.InstancedMesh` 的 LOD 鏈。
 *
 * ```js
 * const rock = await WW.load('/cooked/assets.manifest.json', 'mesh:rock-large');
 * scene.add(new WW.InstancedMesh(rock, material, 10000));
 * ```
 *
 * ## 這是加速，不是門檻
 *
 * 同一個物件不 cook 也能用（見 `InstancedMesh` 的自動 LOD）。cook 過的差別是：
 *
 * - **零產生成本**：LOD 鏈是 build 時算好的，runtime 一次簡化都不做
 * - **更小的下載量**：索引在頂點數 < 65536 時是 16-bit，而且沒有多餘的頂點
 * - **更好的誤差**：cook 時可以用更貴的簡化參數與更多階
 *
 * 「用了更好，不用也能動」在資產這一層就是這個意思。
 *
 * ## 為什麼要兩個參數
 *
 * `.wwm` 檔案本身**不是自描述的** —— 各 LOD 的區塊位置記在 manifest 裡，
 * 不重複記在檔頭（兩份真相遲早會不一致）。所以載入一定要先有 manifest。
 *
 * manifest 依 URL 快取，所以載十個網格只會抓一次。
 */
export async function load(manifestUrl: string, meshId: string): Promise<LodChain> {
  const manifest = await loadManifest(resolveAssetUrl(manifestUrl));
  const entry = pick(manifest.meshes, meshId, ' mesh ', manifestUrl);

  const url = resolveAssetUrl(entry.file, resolveAssetUrl(manifestUrl));
  const cached = meshes.get(url);
  if (cached !== undefined) return cached;

  const pending = fetchMesh(url, entry);
  meshes.set(url, pending);
  return pending;
}

const meshes = new Map<string, Promise<LodChain>>();
onClearAssetCache(() => meshes.clear());

async function fetchMesh(url: string, entry: MeshEntry): Promise<LodChain> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WW.load: 抓不到 ${url}（HTTP ${response.status}）`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decoded = decodeMesh(bytes, entry);

  return {
    lods: decoded.map(toGeometry),
    errors: decoded.map((lod) => lod.error),
  };
}

/**
 * 一階 → 一份 `BufferGeometry`，只帶它自己用得到的頂點。
 *
 * ## 為什麼要壓縮
 *
 * cook 過的格式裡**所有 LOD 共用同一份頂點**，切階只換 index buffer ——
 * 那對「自己管 GPU buffer」的引擎是最好的設計。
 *
 * 但 `THREE.BatchedMesh` 沒有「共用頂點範圍」的公開介面，`addGeometry` 是
 * 逐幾何複製的。直接把共用的頂點陣列交給每一階，七階就是**七份完整的
 * 頂點資料**（實測 rock-large：2,662 個頂點 × 7 = 18,634，而壓縮後是 5,072）。
 *
 * 這是「畫進使用者的 scene」那個決定的代價之一：我們只能透過 Three.js 的
 * 介面溝通，拿不到它內部的 buffer 配置。用一部分掌控權換完整相容性。
 */
function toGeometry(lod: DecodedLod): BufferGeometry {
  const { vertices, indices } = lod;
  const sourceCount = vertices.length / VERTEX_FLOATS;

  const remap = new Int32Array(sourceCount).fill(-1);
  const used = new Uint32Array(indices.length);
  const packed = new Uint32Array(indices.length);
  let next = 0;
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i]!;
    let mapped = remap[vertex]!;
    if (mapped < 0) {
      mapped = next++;
      remap[vertex] = mapped;
      used[mapped] = vertex;
    }
    packed[i] = mapped;
  }

  const position = new Float32Array(next * 3);
  const normal = new Float32Array(next * 3);
  const uv = new Float32Array(next * 2);
  const tangent = new Float32Array(next * 4);
  for (let v = 0; v < next; v++) {
    const src = used[v]! * VERTEX_FLOATS;
    position[v * 3] = vertices[src + POSITION_OFFSET]!;
    position[v * 3 + 1] = vertices[src + POSITION_OFFSET + 1]!;
    position[v * 3 + 2] = vertices[src + POSITION_OFFSET + 2]!;
    normal[v * 3] = vertices[src + NORMAL_OFFSET]!;
    normal[v * 3 + 1] = vertices[src + NORMAL_OFFSET + 1]!;
    normal[v * 3 + 2] = vertices[src + NORMAL_OFFSET + 2]!;
    uv[v * 2] = vertices[src + UV_OFFSET]!;
    uv[v * 2 + 1] = vertices[src + UV_OFFSET + 1]!;
    tangent[v * 4] = vertices[src + TANGENT_OFFSET]!;
    tangent[v * 4 + 1] = vertices[src + TANGENT_OFFSET + 1]!;
    tangent[v * 4 + 2] = vertices[src + TANGENT_OFFSET + 2]!;
    tangent[v * 4 + 3] = vertices[src + TANGENT_OFFSET + 3]!;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  // 切線是 cook 時用 MikkTSpace 算的，與法線貼圖配套。丟掉它會讓每一張
  // 外部烘焙的法線貼圖都有微妙的偏差 —— 畫面不壞，只是「就是差一點」。
  geometry.setAttribute('tangent', new BufferAttribute(tangent, 4));
  geometry.setIndex(new BufferAttribute(packed, 1));
  return geometry;
}
