import { BufferAttribute, BufferGeometry } from 'three';

/**
 * 把一群 instance 的同一份幾何**烘成一份**。
 *
 * ## 為什麼要有這個
 *
 * 遠處的 instance 幾乎不花三角形，卻各自付一次完整的繪製成本。實測
 * （`ab-ww-real`，Avocado、60,000 個）：28,522 個遠景 instance 每個只有
 * 4 個三角形，繪製呼叫佔那一幀 GPU 時間的 **73%**，三角形只佔 4% ——
 * 送出去的錢比畫的東西貴 19 倍。
 *
 * 把一個 cell 的遠景烘成一份幾何，那個 cell 就從幾千次繪製變成一次。
 *
 * ## 為什麼相對 cell 中心而不是絕對座標
 *
 * 世界可以很大，而 `Float32Array` 只有 24 位有效位數。在原點外 10,000 單位
 * 處，float32 的間距已經接近 1e-3 —— 直接烘絕對座標會讓遠處的模型頂點
 * 開始互相塌陷，而症狀是「遠方的東西看起來髒髒的」，不是報錯。
 *
 * 所以烘的是相對中心的座標，中心交給 instance 矩陣去平移。
 *
 * ## 代價
 *
 * 記憶體。合併幾何等於把最粗階複製 N 份，所以只有在最粗階夠小的時候
 * 才划算 —— 呼叫端負責算預算，這裡只負責烘。
 */

/** 一份合併幾何，以及它相對世界的位置。 */
export interface MergedGeometry {
  geometry: BufferGeometry;
  /** 烘焙時扣掉的中心。instance 矩陣要平移到這裡。 */
  center: [number, number, number];
  /** 相對中心的包圍球半徑。選階與剔除都要用它。 */
  radius: number;
  /**
   * 這一批 instance 裡最大的縮放。
   *
   * **選階必須用它。** 逐一判斷時的螢幕誤差是「縮放 ÷ 距離」，合併之後
   * 若只用「1 ÷ 距離」，等於把物件當成小了 `scale` 倍 —— 於是太早合併，
   * 而症狀是遠處提早變粗，畫面看起來完全正常。
   *
   * 取最大值是保守的方向：這一格裡最需要細節的那個決定整格。
   */
  maxScale: number;
}

/**
 * 一份與 `source` 屬性佈局相同、但沒有頂點的幾何。
 *
 * `BatchedMesh` 要求同一批的幾何屬性完全一致（有無索引也算），所以先保留
 * 空間再換內容時，佔位的那一份不能是空的 `BufferGeometry` —— 那會在
 * `addGeometry` 當場被拒絕，訊息是「missing position」。
 */
export function placeholderLike(source: BufferGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    geometry.setAttribute(name, new BufferAttribute(new Float32Array(0), attribute.itemSize));
  }
  if (source.getIndex() !== null) {
    geometry.setIndex(new BufferAttribute(new Uint16Array(0), 1));
  }
  return geometry;
}

/** 合併一份幾何要多少頂點與索引。呼叫端用它算預算。 */
export function mergedSize(
  source: BufferGeometry,
  instances: number,
): { vertices: number; indices: number; bytesPerVertex: number } {
  const vertices = source.getAttribute('position')?.count ?? 0;
  // 非索引時每個頂點就是一個索引。
  const indices = source.getIndex()?.count ?? vertices;
  return {
    vertices: vertices * instances,
    indices: indices * instances,
    bytesPerVertex: bytesPerVertex(source),
  };
}

/**
 * 一個頂點在批次緩衝裡實際佔幾個位元組。
 *
 * **要把每一個屬性都算進去，不只 position。** 只算位置（3 × 4 = 12 B）會把
 * 一份帶法線、UV、tangent 的幾何低估三到四倍 —— 而低估記憶體估算的後果是
 * 預算「看起來還很寬」，於是配下去的量是預算的好幾倍。那個錯誤犯過：
 * `apps/example` 的 JS heap 曾經到 **1,005 MB**，而預算以為自己花得很省。
 */
function bytesPerVertex(source: BufferGeometry): number {
  let bytes = 0;
  for (const attribute of Object.values(source.attributes)) {
    bytes += attribute.itemSize * attribute.array.BYTES_PER_ELEMENT;
  }
  return bytes;
}

/**
 * 把 `source` 依 `matrices` 裡選出的那幾個 instance 烘成一份幾何。
 *
 * `ids` 是要合併的 instance 編號，`matrices` 是 16 個 float 一組的矩陣陣列
 * （與 `BatchedMesh` 的 `_matricesTexture` 同一份佈局）。
 */
export function mergeInstances(
  source: BufferGeometry,
  matrices: Float32Array,
  ids: Uint32Array,
  from: number,
  to: number,
): MergedGeometry | null {
  const count = to - from;
  if (count <= 0) return null;

  // Three 的 getAttribute 缺屬性時回傳 undefined，型別上卻寫 BufferAttribute。
  // 不轉成 null 的話下面的 === null 判斷全部失效，而失效的樣子是在
  // 第一個沒有切線的幾何上直接爆掉。
  const position = source.getAttribute('position') ?? null;
  if (position === null) return null;
  // 非索引幾何是合法的輸入（`IcosahedronGeometry` 出廠就是）。
  // 這裡不能直接放棄 —— 那會讓遠景合併在那些內容上**靜靜地不生效**。
  const index = source.getIndex();

  const normal = source.getAttribute('normal') ?? null;
  const uv = source.getAttribute('uv') ?? null;
  const tangent = source.getAttribute('tangent') ?? null;

  const vertexCount = position.count;
  const indexCount = index === null ? vertexCount : index.count;
  const total = vertexCount * count;

  // 中心取這批 instance 位置的平均。用包圍盒中點也可以，但平均對
  // 「一群散開的小物件」比較穩 —— 一個離群值不會把整批推走。
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = from; i < to; i++) {
    const b = ids[i]! * 16;
    cx += matrices[b + 12]!;
    cy += matrices[b + 13]!;
    cz += matrices[b + 14]!;
  }
  cx /= count;
  cy /= count;
  cz /= count;

  const outPosition = new Float32Array(total * 3);
  const outNormal = normal === null ? null : new Float32Array(total * 3);
  const outUv = uv === null ? null : new Float32Array(total * 2);
  const outTangent = tangent === null ? null : new Float32Array(total * 4);
  // 合併後的頂點數可能超過 65535，那時 16-bit 索引會靜靜地繞回去 ——
  // 症狀是幾何變成一團亂線。
  const outIndex =
    index === null
      ? new Uint32Array(0)
      : total > 65535
        ? new Uint32Array(indexCount * count)
        : new Uint16Array(indexCount * count);

  let radiusSq = 0;
  let maxScaleSq = 0;
  for (let slot = 0; slot < count; slot++) {
    const b = ids[from + slot]! * 16;
    const m0 = matrices[b]!;
    const m1 = matrices[b + 1]!;
    const m2 = matrices[b + 2]!;
    const m4 = matrices[b + 4]!;
    const m5 = matrices[b + 5]!;
    const m6 = matrices[b + 6]!;
    const m8 = matrices[b + 8]!;
    const m9 = matrices[b + 9]!;
    const m10 = matrices[b + 10]!;
    const tx = matrices[b + 12]! - cx;
    const ty = matrices[b + 13]! - cy;
    const tz = matrices[b + 14]! - cz;

    // 法線要用逆轉置。非等比縮放下直接乘上 3×3 會讓法線偏離表面，
    // 而畫面上那是「光照就是怪怪的」。等比縮放時兩者只差一個常數，
    // 正規化之後相同 —— 所以先判斷，省掉絕大多數情況的反矩陣。
    const sx2 = m0 * m0 + m1 * m1 + m2 * m2;
    const sy2 = m4 * m4 + m5 * m5 + m6 * m6;
    const sz2 = m8 * m8 + m9 * m9 + m10 * m10;
    const largest = sx2 > sy2 ? (sx2 > sz2 ? sx2 : sz2) : sy2 > sz2 ? sy2 : sz2;
    if (largest > maxScaleSq) maxScaleSq = largest;
    const uniform = Math.abs(sx2 - sy2) < 1e-6 * sx2 && Math.abs(sx2 - sz2) < 1e-6 * sx2;
    const n = uniform ? null : inverseTranspose3(m0, m1, m2, m4, m5, m6, m8, m9, m10);

    const vertexBase = slot * vertexCount;
    for (let v = 0; v < vertexCount; v++) {
      const px = position.getX(v);
      const py = position.getY(v);
      const pz = position.getZ(v);
      const wx = m0 * px + m4 * py + m8 * pz + tx;
      const wy = m1 * px + m5 * py + m9 * pz + ty;
      const wz = m2 * px + m6 * py + m10 * pz + tz;
      const o3 = (vertexBase + v) * 3;
      outPosition[o3] = wx;
      outPosition[o3 + 1] = wy;
      outPosition[o3 + 2] = wz;

      const d = wx * wx + wy * wy + wz * wz;
      if (d > radiusSq) radiusSq = d;

      if (outNormal !== null && normal !== null) {
        const nx = normal.getX(v);
        const ny = normal.getY(v);
        const nz = normal.getZ(v);
        const rx = n === null ? m0 * nx + m4 * ny + m8 * nz : n[0]! * nx + n[3]! * ny + n[6]! * nz;
        const ry = n === null ? m1 * nx + m5 * ny + m9 * nz : n[1]! * nx + n[4]! * ny + n[7]! * nz;
        const rz = n === null ? m2 * nx + m6 * ny + m10 * nz : n[2]! * nx + n[5]! * ny + n[8]! * nz;
        const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
        outNormal[o3] = rx / len;
        outNormal[o3 + 1] = ry / len;
        outNormal[o3 + 2] = rz / len;
      }

      if (outUv !== null && uv !== null) {
        const o2 = (vertexBase + v) * 2;
        outUv[o2] = uv.getX(v);
        outUv[o2 + 1] = uv.getY(v);
      }

      if (outTangent !== null && tangent !== null) {
        // 切線是**方向**，走 3×3 就好；`w` 是手性符號，原樣搬過去。
        // 鏡像（行列式為負）的 instance 要把手性翻過來，否則法線貼圖
        // 在那些物件上會整片反過來。
        const gx = tangent.getX(v);
        const gy = tangent.getY(v);
        const gz = tangent.getZ(v);
        const rx = m0 * gx + m4 * gy + m8 * gz;
        const ry = m1 * gx + m5 * gy + m9 * gz;
        const rz = m2 * gx + m6 * gy + m10 * gz;
        const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
        const o4 = (vertexBase + v) * 4;
        outTangent[o4] = rx / len;
        outTangent[o4 + 1] = ry / len;
        outTangent[o4 + 2] = rz / len;
        outTangent[o4 + 3] =
          tangent.getW(v) * (determinant3(m0, m1, m2, m4, m5, m6, m8, m9, m10) < 0 ? -1 : 1);
      }
    }

    if (index !== null) {
      const indexBase = slot * indexCount;
      for (let i = 0; i < indexCount; i++) {
        outIndex[indexBase + i] = vertexBase + index.getX(i);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(outPosition, 3));
  if (outNormal !== null) geometry.setAttribute('normal', new BufferAttribute(outNormal, 3));
  if (outUv !== null) geometry.setAttribute('uv', new BufferAttribute(outUv, 2));
  if (outTangent !== null) geometry.setAttribute('tangent', new BufferAttribute(outTangent, 4));
  // 來源沒有索引時**不能**補一個上去：BatchedMesh 要求同一批的幾何
  // 有無索引必須一致，不一致會在 addGeometry 當場拒絕。
  if (index !== null) geometry.setIndex(new BufferAttribute(outIndex, 1));

  return {
    geometry,
    center: [cx, cy, cz],
    radius: Math.sqrt(radiusSq),
    maxScale: Math.sqrt(maxScaleSq),
  };
}

/** 3×3 的逆轉置，用來變換法線。回傳 column-major 的九個值。 */
function inverseTranspose3(
  m0: number,
  m1: number,
  m2: number,
  m4: number,
  m5: number,
  m6: number,
  m8: number,
  m9: number,
  m10: number,
): Float64Array {
  const c00 = m5 * m10 - m6 * m9;
  const c01 = m6 * m8 - m4 * m10;
  const c02 = m4 * m9 - m5 * m8;
  const det = m0 * c00 + m1 * c01 + m2 * c02;
  const out = new Float64Array(9);
  // 退化矩陣（縮放為 0）沒有逆矩陣。回傳原矩陣是安全的方向：法線會錯，
  // 但那個 instance 本來就被壓成一個平面了。
  if (Math.abs(det) < 1e-20) {
    out.set([m0, m1, m2, m4, m5, m6, m8, m9, m10]);
    return out;
  }
  const inv = 1 / det;
  out[0] = c00 * inv;
  out[1] = c01 * inv;
  out[2] = c02 * inv;
  out[3] = (m2 * m9 - m1 * m10) * inv;
  out[4] = (m0 * m10 - m2 * m8) * inv;
  out[5] = (m1 * m8 - m0 * m9) * inv;
  out[6] = (m1 * m6 - m2 * m5) * inv;
  out[7] = (m2 * m4 - m0 * m6) * inv;
  out[8] = (m0 * m5 - m1 * m4) * inv;
  return out;
}

function determinant3(
  m0: number,
  m1: number,
  m2: number,
  m4: number,
  m5: number,
  m6: number,
  m8: number,
  m9: number,
  m10: number,
): number {
  return m0 * (m5 * m10 - m6 * m9) + m1 * (m6 * m8 - m4 * m10) + m2 * (m4 * m9 - m5 * m8);
}
