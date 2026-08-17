import {
  MESH_HEADER_BYTES,
  MESH_MAGIC,
  ASSET_SCHEMA_VERSION,
  VERTEX_FLOATS,
  type LodEntry,
  type MeshEntry,
} from '@webworld/format';

/**
 * Cooked mesh 的解碼。
 *
 * **這個模組刻意不碰任何 DOM 或 renderer API**，因此可以原封不動地在
 * Web Worker 裡執行。解碼大型網格會佔用主執行緒數十毫秒，而那正是
 * profiler 會記成 long task 的東西。
 */

export interface DecodedLod {
  level: number;
  /** 交錯排列：position(3) + normal(3) + uv(2)。所有 LOD 共用同一份。 */
  vertices: Float32Array;
  indices: Uint16Array | Uint32Array;
  /** 世界單位的簡化誤差。LOD 選擇要用它，不是距離。 */
  error: number;
}

export class AssetFormatError extends Error {
  override readonly name = 'AssetFormatError';
}

/**
 * 檢查檔頭。
 *
 * 格式錯誤要在這裡失敗，而不是讓亂資料流進 GPU buffer ——
 * 那會產生看起來像圖形 bug 的問題，但根因在檔案格式，極難追查。
 */
export function readMeshHeader(bytes: Uint8Array): { lodCount: number; vertexStride: number } {
  if (bytes.byteLength < MESH_HEADER_BYTES) {
    throw new AssetFormatError(`檔案只有 ${bytes.byteLength} 位元組，不足一個檔頭`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== MESH_MAGIC) {
    throw new AssetFormatError(
      `magic 不符：${magic.toString(16)}，預期 ${MESH_MAGIC.toString(16)}（檔案不是 .wwm 或已損毀）`,
    );
  }

  const version = view.getUint32(4, true);
  if (version !== ASSET_SCHEMA_VERSION) {
    throw new AssetFormatError(
      `資產 schema v${version} 與 runtime 的 v${ASSET_SCHEMA_VERSION} 不符，請重新執行 pnpm cook`,
    );
  }

  return { lodCount: view.getUint32(8, true), vertexStride: view.getUint32(12, true) };
}

function sliceIndices(bytes: Uint8Array, entry: LodEntry): Uint16Array | Uint32Array {
  const { offset, length } = entry.indices;
  if (offset + length > bytes.byteLength) {
    throw new AssetFormatError(`LOD ${entry.level} 的索引區塊超出檔案範圍`);
  }
  // 直接建立視圖，不複製。cook 時已對齊到 4 位元組。
  const base = bytes.byteOffset + offset;
  return entry.indexBytes === 2
    ? new Uint16Array(bytes.buffer, base, entry.indexCount)
    : new Uint32Array(bytes.buffer, base, entry.indexCount);
}

/**
 * 解出所有 LOD。
 *
 * 頂點只被解出一次並由所有 LOD 共用 —— 這是 cook 時的設計（見 pack.ts）。
 * 因此切換 LOD 只需要換 index buffer，不必重新上傳頂點。
 */
export function decodeMesh(bytes: Uint8Array, entry: MeshEntry): DecodedLod[] {
  readMeshHeader(bytes);

  const first = entry.lods[0];
  if (first === undefined) throw new AssetFormatError(`${entry.id} 沒有任何 LOD`);

  const { offset, length } = first.vertices;
  if (offset + length > bytes.byteLength) {
    throw new AssetFormatError(`${entry.id} 的頂點區塊超出檔案範圍`);
  }
  const vertices = new Float32Array(bytes.buffer, bytes.byteOffset + offset, length / 4);

  if (vertices.length % VERTEX_FLOATS !== 0) {
    throw new AssetFormatError(
      `${entry.id} 的頂點資料長度 ${vertices.length} 不是 ${VERTEX_FLOATS} 的倍數`,
    );
  }

  return entry.lods.map((lod) => ({
    level: lod.level,
    vertices,
    indices: sliceIndices(bytes, lod),
    error: lod.error,
  }));
}

/**
 * 依螢幕空間誤差選 LOD。
 *
 * **不是依距離。** 同樣距離下，一座山和一顆石頭需要的細節完全不同；
 * 決定因素是幾何誤差投影到螢幕上有多少像素。
 *
 * @param errorPixels 可接受的誤差像素數
 * @param distance 到相機的距離（世界單位）
 * @param pixelsPerUnitAtOne 距離 1 時每世界單位對應的像素數
 */
export function selectLod(
  lods: readonly DecodedLod[],
  distance: number,
  pixelsPerUnitAtOne: number,
  errorPixels = 1,
): number {
  // 由粗到細找出第一個誤差夠小的；找不到就用最細的
  for (let i = lods.length - 1; i > 0; i--) {
    const projected = (lods[i]!.error / Math.max(distance, 1e-6)) * pixelsPerUnitAtOne;
    if (projected <= errorPixels) return i;
  }
  return 0;
}

/** 相機參數轉成 `selectLod` 需要的投影係數。 */
export function pixelsPerUnitAtOneMetre(viewportHeight: number, fovYRadians: number): number {
  return viewportHeight / (2 * Math.tan(fovYRadians / 2));
}
