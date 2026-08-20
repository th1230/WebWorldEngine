import { Document, NodeIO } from '@gltf-transform/core';
import { VERTEX_FLOATS } from '@web-world-engine/format';
import type { RawMesh } from './geometry.ts';

/**
 * 程序化產生的來源資產。
 *
 * repo 裡刻意**不放二進位美術檔**：
 *
 * - cook 的可重現性可以被完整驗證（相同種子 → 相同 glTF → 相同 hash）
 * - 不必為了跑 benchmark 去下載幾百 MB 的模型
 * - 資產管線的每一階段都有確定的輸入
 *
 * 真實資產進來之後這些程序化模型仍然保留，作為
 * 「管線本身是否正常」與「真實資料是否正常」的區分依據。
 */

/** 固定種子的 PRNG，與 apps/benchmark 的實作相同（mulberry32）。 */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeMesh(positions: number[], indices: number[]): RawMesh {
  const count = positions.length / 3;
  const vertices = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) {
    const dst = v * VERTEX_FLOATS;
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    vertices[dst] = x;
    vertices[dst + 1] = y;
    vertices[dst + 2] = z;
    // 法線稍後由 recomputeNormals 重算；UV 用球面投影
    const length = Math.hypot(x, y, z) || 1;
    vertices[dst + 6] = 0.5 + Math.atan2(z, x) / (2 * Math.PI);
    vertices[dst + 7] = 0.5 - Math.asin(y / length) / Math.PI;
  }
  return { vertices, indices: new Uint32Array(indices) };
}

/**
 * 細分後的二十面體（icosphere）。
 *
 * 用它而非 UV 球：三角形分布均勻得多，因此簡化成 LOD 時不會在兩極
 * 出現退化三角形，量到的簡化行為才有代表性。
 */
export function icosphere(subdivisions: number, radius = 1): RawMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  let positions: number[] = [
    -1,
    t,
    0,
    1,
    t,
    0,
    -1,
    -t,
    0,
    1,
    -t,
    0,
    0,
    -1,
    t,
    0,
    1,
    t,
    0,
    -1,
    -t,
    0,
    1,
    -t,
    t,
    0,
    -1,
    t,
    0,
    1,
    -t,
    0,
    -1,
    -t,
    0,
    1,
  ];
  let indices: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
    8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];

  for (let s = 0; s < subdivisions; s++) {
    const nextIndices: number[] = [];
    const midpoints = new Map<string, number>();

    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cached = midpoints.get(key);
      if (cached !== undefined) return cached;
      const index = positions.length / 3;
      positions.push(
        (positions[a * 3]! + positions[b * 3]!) / 2,
        (positions[a * 3 + 1]! + positions[b * 3 + 1]!) / 2,
        (positions[a * 3 + 2]! + positions[b * 3 + 2]!) / 2,
      );
      midpoints.set(key, index);
      return index;
    };

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]!;
      const b = indices[i + 1]!;
      const c = indices[i + 2]!;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      nextIndices.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    indices = nextIndices;
  }

  // 投影到球面並套用半徑
  const projected: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    const length = Math.hypot(x, y, z) || 1;
    projected.push((x / length) * radius, (y / length) * radius, (z / length) * radius);
  }
  positions = projected;

  return makeMesh(positions, indices);
}

/** 加上程序化位移的石頭。位移量固定，因此每次產生的結果完全相同。 */
export function rock(subdivisions: number, seed: number): RawMesh {
  const base = icosphere(subdivisions, 1);
  const rng = createRng(seed);
  const count = base.vertices.length / VERTEX_FLOATS;
  const vertices = new Float32Array(base.vertices);

  // 先產生固定的雜訊方向，避免逐頂點呼叫 rng 造成順序相依
  const offsets = new Float32Array(count);
  for (let i = 0; i < count; i++) offsets[i] = 0.75 + rng() * 0.5;

  for (let v = 0; v < count; v++) {
    const base_ = v * VERTEX_FLOATS;
    const scale = offsets[v]!;
    vertices[base_] = vertices[base_]! * scale;
    vertices[base_ + 1] = vertices[base_ + 1]! * scale;
    vertices[base_ + 2] = vertices[base_ + 2]! * scale;
  }

  return { vertices, indices: base.indices };
}

/** 圓柱，模擬樹幹之類的細長物件。 */
export function cylinder(segments: number, height: number, radius: number): RawMesh {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let s = 0; s <= segments; s++) {
    const angle = (s / segments) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    positions.push(x, -height / 2, z);
    positions.push(x, height / 2, z);
  }
  for (let s = 0; s < segments; s++) {
    const a = s * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  // 上下封蓋
  const bottomCenter = positions.length / 3;
  positions.push(0, -height / 2, 0);
  const topCenter = positions.length / 3;
  positions.push(0, height / 2, 0);
  for (let s = 0; s < segments; s++) {
    indices.push(bottomCenter, s * 2 + 2, s * 2);
    indices.push(topCenter, s * 2 + 1, s * 2 + 3);
  }

  return makeMesh(positions, indices);
}

export interface SourceAsset {
  id: string;
  mesh: RawMesh;
  /** 這個資產要用的材質 id，對應 DEFAULT_MATERIALS。 */
  material: string;
}

/** 標準的來源資產集合。id 會成為 cooked 資產的 AssetId。 */
export function standardSourceAssets(): SourceAsset[] {
  return [
    { id: 'mesh:rock-large', mesh: rock(4, 0x1234), material: 'material:rock' },
    { id: 'mesh:rock-small', mesh: rock(3, 0x5678), material: 'material:rock' },
    { id: 'mesh:sphere', mesh: icosphere(4, 1), material: 'material:rock' },
    { id: 'mesh:trunk', mesh: cylinder(24, 4, 0.4), material: 'material:bark' },
  ];
}

/**
 * 寫成 glTF Binary。
 *
 * 為什麼要繞這一圈而不直接 cook 記憶體裡的資料：glTF 是規格指定的
 * interchange 格式，讓 cooker 真的走過「讀檔 → 解析 → 驗證」這條路，
 * 才會在格式有問題時發現，而不是等到接真實資產才踩到。
 */
export async function writeSourceGltf(asset: SourceAsset): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const count = asset.mesh.vertices.length / VERTEX_FLOATS;

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const normals = new Float32Array(count * 3);
  const tangents = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    const src = v * VERTEX_FLOATS;
    positions[v * 3] = asset.mesh.vertices[src]!;
    positions[v * 3 + 1] = asset.mesh.vertices[src + 1]!;
    positions[v * 3 + 2] = asset.mesh.vertices[src + 2]!;
    normals[v * 3] = asset.mesh.vertices[src + 3]!;
    normals[v * 3 + 1] = asset.mesh.vertices[src + 4]!;
    normals[v * 3 + 2] = asset.mesh.vertices[src + 5]!;
    uvs[v * 2] = asset.mesh.vertices[src + 6]!;
    uvs[v * 2 + 1] = asset.mesh.vertices[src + 7]!;
    for (let c = 0; c < 4; c++) tangents[v * 4 + c] = asset.mesh.vertices[src + 8 + c]!;
  }

  const primitive = document
    .createPrimitive()
    .setAttribute(
      'POSITION',
      document.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer),
    )
    .setAttribute(
      'TEXCOORD_0',
      document.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer),
    )
    .setIndices(
      document
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Uint32Array(asset.mesh.indices))
        .setBuffer(buffer),
    );

  // 只在來源真的有的時候才寫出去。全零的 NORMAL/TANGENT 比沒有更糟 ——
  // 讀回來的一方會以為「有了」而略過重算，得到一整份零向量。
  if (asset.mesh.hasNormals === true) {
    primitive.setAttribute(
      'NORMAL',
      document.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer),
    );
  }
  if (asset.mesh.hasTangents === true) {
    primitive.setAttribute(
      'TANGENT',
      document.createAccessor().setType('VEC4').setArray(tangents).setBuffer(buffer),
    );
  }

  const mesh = document.createMesh(asset.id).addPrimitive(primitive);
  document.createScene().addChild(document.createNode(asset.id).setMesh(mesh));

  return new NodeIO().writeBinary(document);
}

const IDENTITY_MATRIX: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** 取 4×4 的線性部分（左上 3×3），欄優先。 */
function upper3x3(m: readonly number[]): number[] {
  return [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!];
}

function determinant3x3(m: readonly number[]): number {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[3]! * (m[1]! * m[8]! - m[2]! * m[7]!) +
    m[6]! * (m[1]! * m[5]! - m[2]! * m[4]!)
  );
}

/** 位置：套用完整的 4×4（含位移）。 */
function transformPoint(
  v: readonly number[],
  m: readonly number[],
  out: Float32Array,
  at: number,
): void {
  const x = v[0]!;
  const y = v[1]!;
  const z = v[2]!;
  out[at] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out[at + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out[at + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
}

/** 方向：只套用線性部分，並重新正規化。 */
function transformDirection(
  v: readonly number[],
  m: readonly number[],
  out: Float32Array,
  at: number,
): void {
  const x = v[0]!;
  const y = v[1]!;
  const z = v[2]!;
  const nx = m[0]! * x + m[3]! * y + m[6]! * z;
  const ny = m[1]! * x + m[4]! * y + m[7]! * z;
  const nz = m[2]! * x + m[5]! * y + m[8]! * z;
  const length = Math.hypot(nx, ny, nz) || 1;
  out[at] = nx / length;
  out[at + 1] = ny / length;
  out[at + 2] = nz / length;
}

/** 從 glTF Binary 讀回第一個 primitive。 */
export async function readSourceGltf(bytes: Uint8Array): Promise<RawMesh> {
  const document = await new NodeIO().readBinary(bytes);
  const meshes = document.getRoot().listMeshes();
  const mesh = meshes[0];
  if (mesh === undefined) throw new Error('WW.cook: glTF 沒有任何 mesh');

  const primitives = mesh.listPrimitives();
  const primitive = primitives[0];
  if (primitive === undefined) throw new Error('WW.cook: mesh 沒有任何 primitive');

  // 多 mesh / 多 primitive **明確拒絕，不靜默取第一個**。
  //
  // 真實 .glb 幾乎一定是多 primitive（每個材質一個）。靜默只匯入第一個
  // 的症狀是「模型少了一半」，而使用者會先去懷疑匯出設定、UV、材質，
  // 就是不會懷疑「匯入器只讀了第一塊」。
  //
  // 支援多 primitive 需要先有「一個資產對應多個 material slot」的模型。
  // 在那之前，講清楚做不到，比假裝做得到好。
  //
  // 注意這條路只走程序化來源（cookAll 會把它們寫成 glTF 再讀回來）。
  // 真實檔案走 gltf-import.ts，那一支**支援**多 primitive —— 每個各自
  // 成為一個 cooked mesh。
  if (meshes.length > 1 || primitives.length > 1) {
    throw new Error(
      `WW.cook: 尚未支援多 mesh / 多 primitive 的 glTF（找到 ${meshes.length} 個 mesh、` +
        `第一個 mesh 有 ${primitives.length} 個 primitive）。` +
        `程序化來源一個資產只對應一個 material slot。`,
    );
  }

  const position = primitive.getAttribute('POSITION');
  const indices = primitive.getIndices();
  if (position === null) throw new Error('WW.cook: primitive 缺少 POSITION');
  if (indices === null) throw new Error('WW.cook: primitive 缺少索引（未支援非索引幾何）');

  const uv = primitive.getAttribute('TEXCOORD_0');
  const normal = primitive.getAttribute('NORMAL');
  const tangent = primitive.getAttribute('TANGENT');
  const count = position.getCount();

  // 節點的世界矩陣必須套用到頂點上。
  //
  // 忽略它的症狀是「模型位置/大小/朝向完全不對」，而且**不會有任何錯誤**。
  // Blender 匯出幾乎一定帶節點變換，量化過的 glTF（KHR_mesh_quantization、
  // 也就是 gltfpack 的預設輸出）更是把反量化的 scale/offset **就存在節點
  // TRS 裡** —— 不套用的話位置會大上 32767 倍。
  const node = document
    .getRoot()
    .listNodes()
    .find((candidate) => candidate.getMesh() === mesh);
  const world = node?.getWorldMatrix() ?? IDENTITY_MATRIX;
  const linear = upper3x3(world);
  const determinant = determinant3x3(linear);

  // 單位矩陣時完全不套用變換。
  //
  // 不是為了速度，是為了**精確**：矩陣乘法加上重新正規化會讓已經是單位
  // 長度的法線產生最後幾位的漂移，於是「來源帶了法線就原封不動沿用」
  // 這個保證變成「幾乎沿用」。而「幾乎」正是這類 bug 最難查的形態。
  const identity = world.every((value, i) => value === IDENTITY_MATRIX[i]);

  const vertices = new Float32Array(count * VERTEX_FLOATS);
  const element = [0, 0, 0, 0];

  for (let v = 0; v < count; v++) {
    const dst = v * VERTEX_FLOATS;

    // 用 getElement 而不是 getArray：前者會處理 `normalized` 的反量化，
    // 後者回傳的是原始儲存格式（Int16 之類），直接當浮點數讀就是垃圾。
    position.getElement(v, element);
    if (identity) {
      vertices[dst] = element[0]!;
      vertices[dst + 1] = element[1]!;
      vertices[dst + 2] = element[2]!;
    } else {
      transformPoint(element, world, vertices, dst);
    }

    if (normal !== null) {
      normal.getElement(v, element);
      if (identity) {
        vertices[dst + 3] = element[0]!;
        vertices[dst + 4] = element[1]!;
        vertices[dst + 5] = element[2]!;
      } else {
        // 法線用線性部分變換後重新正規化。非等比縮放嚴格說要用反轉置矩陣。
        transformDirection(element, linear, vertices, dst + 3);
      }
    }
    if (uv !== null) {
      uv.getElement(v, element);
      vertices[dst + 6] = element[0]!;
      vertices[dst + 7] = element[1]!;
    }
    if (tangent !== null) {
      tangent.getElement(v, element);
      const w = element[3]!;
      if (identity) {
        vertices[dst + 8] = element[0]!;
        vertices[dst + 9] = element[1]!;
        vertices[dst + 10] = element[2]!;
      } else {
        transformDirection(element, linear, vertices, dst + 8);
      }
      // 鏡像變換（行列式為負）會翻轉手性，w 必須跟著翻，否則法線貼圖
      // 在被鏡像的部位會凹凸相反
      vertices[dst + 11] = determinant < 0 ? -w : w;
    }
  }

  return {
    vertices,
    // 索引可能是 Uint8/Uint16/Uint32，一律加寬成 Uint32。
    // `getArray()` 在這裡是對的：索引沒有 normalized 的概念。
    indices: new Uint32Array(indices.getArray() as ArrayLike<number>),
    hasNormals: normal !== null,
    hasTangents: tangent !== null,
  };
}
