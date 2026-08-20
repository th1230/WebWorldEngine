import {
  MESH_HEADER_BYTES,
  MESH_MAGIC,
  VERTEX_STRIDE_BYTES,
  ASSET_SCHEMA_VERSION,
  type CollisionEntry,
  type LodEntry,
} from '@webworld/format';
import type { LodResult, RawMesh } from './geometry.ts';

export interface PackedMesh {
  bytes: Uint8Array;
  lods: LodEntry[];
  collision: CollisionEntry | null;
}

function indexBytesFor(vertexCount: number): 2 | 4 {
  return vertexCount < 65536 ? 2 : 4;
}

function writeIndices(view: DataView, offset: number, indices: Uint32Array, width: 2 | 4): void {
  if (width === 2) {
    for (let i = 0; i < indices.length; i++) view.setUint16(offset + i * 2, indices[i]!, true);
  } else {
    for (let i = 0; i < indices.length; i++) view.setUint32(offset + i * 4, indices[i]!, true);
  }
}

/** 4 位元組對齊。未對齊的 TypedArray 視圖在某些平台會拋錯，也會拖慢存取。 */
function align4(value: number): number {
  return (value + 3) & ~3;
}

/**
 * 把 LOD 鏈與碰撞網格打包成單一二進位檔。
 *
 * **所有 LOD 共用同一份頂點資料**，只有索引不同 —— 這是 meshoptimizer 的
 * 簡化模型：粗 LOD 只是不再參照某些頂點。好處是切換 LOD 不必重新上傳頂點，
 * 只要換 index buffer，這對串流與 LOD 切換都很關鍵。
 *
 * 佈局（小端序）：
 * ```text
 * [header 16B][vertices][lod0 indices][lod1 indices]…[collision verts][collision indices]
 * ```
 */
export function packMesh(lods: readonly LodResult[], collision: RawMesh | null): PackedMesh {
  const base = lods[0];
  if (base === undefined) throw new Error('WW.cook: 至少需要一個 LOD');

  const vertexBytes = base.mesh.vertices.byteLength;
  const vertexCount = base.mesh.vertices.length / (VERTEX_STRIDE_BYTES / 4);
  const indexWidth = indexBytesFor(vertexCount);

  // 先算佈局再配置，避免多次複製
  let offset = MESH_HEADER_BYTES;
  const vertexOffset = offset;
  offset = align4(offset + vertexBytes);

  const lodEntries: LodEntry[] = [];
  for (const [level, lod] of lods.entries()) {
    const length = lod.mesh.indices.length * indexWidth;
    lodEntries.push({
      level,
      error: lod.error,
      vertexCount,
      indexCount: lod.mesh.indices.length,
      indexBytes: indexWidth,
      vertices: { offset: vertexOffset, length: vertexBytes },
      indices: { offset, length },
    });
    offset = align4(offset + length);
  }

  let collisionEntry: CollisionEntry | null = null;
  if (collision !== null) {
    const collisionVertexCount = collision.vertices.length / (VERTEX_STRIDE_BYTES / 4);
    const collisionIndexWidth = indexBytesFor(collisionVertexCount);
    const collisionVertexOffset = vertexOffset; // 與視覺網格共用頂點
    const indicesLength = collision.indices.length * collisionIndexWidth;
    collisionEntry = {
      kind: 'mesh',
      vertexCount: collisionVertexCount,
      indexCount: collision.indices.length,
      indexBytes: collisionIndexWidth,
      vertices: { offset: collisionVertexOffset, length: vertexBytes },
      indices: { offset, length: indicesLength },
    };
    offset = align4(offset + indicesLength);
  }

  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, MESH_MAGIC, true);
  view.setUint32(4, ASSET_SCHEMA_VERSION, true);
  view.setUint32(8, lods.length, true);
  view.setUint32(12, VERTEX_STRIDE_BYTES, true);

  bytes.set(
    new Uint8Array(base.mesh.vertices.buffer, base.mesh.vertices.byteOffset, vertexBytes),
    vertexOffset,
  );

  for (const [level, lod] of lods.entries()) {
    writeIndices(view, lodEntries[level]!.indices.offset, lod.mesh.indices, indexWidth);
  }

  if (collision !== null && collisionEntry !== null) {
    writeIndices(view, collisionEntry.indices.offset, collision.indices, collisionEntry.indexBytes);
  }

  return { bytes, lods: lodEntries, collision: collisionEntry };
}
