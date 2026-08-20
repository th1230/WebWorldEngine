import { NodeIO, type Document, type Material, type Primitive } from '@gltf-transform/core';
import { VERTEX_FLOATS } from '@web-world-engine/format';
import type { RawMesh } from './geometry.ts';

/**
 * 真實 glTF 的匯入。
 *
 * ## 與 `source-assets.ts` 的分工
 *
 * `source-assets.ts` 處理的是「我們自己產生的程序化資產」—— 單一 mesh、
 * 單一 primitive、沒有材質。那條路徑刻意保持狹窄，因為它的用途是讓
 * cook 管線有一組**完全確定**的輸入。
 *
 * 這個檔案處理真實檔案，它們長得完全不同：
 *
 * - 幾乎一定是**多 primitive**（每個材質一個）
 * - 幾乎一定帶**節點變換**（Blender 匯出的常態）
 * - 常常是**量化過的**（gltfpack 的預設輸出）
 * - 可能自帶法線與切線（必須沿用，不能重算）
 *
 * ## 一個 primitive = 一個 cooked mesh
 *
 * 不把多 primitive 塞進單一 `MeshEntry`。理由是**繪製單位本來就是
 * primitive**：不同 primitive 用不同材質，GPU 上必然是不同的 draw。
 * 硬要包成一個 entry，runtime 還是得把它拆開，只是多一層間接。
 *
 * 代價是「一個物件」會變成多個網格。對靜態世界內容沒有影響
 * （它們的變換相同且不會變）；有階層動畫的角色需要別的處理，那是 。
 */

export interface ImportedPrimitive {
  /** `<檔名>:<mesh 名稱>#<primitive 序號>`，用來組 AssetId。 */
  name: string;
  mesh: RawMesh;
  /** 這個 primitive 用的材質，沒有指定材質時為 null。 */
  material: ImportedMaterial | null;
}

export interface ImportedMaterial {
  /**
   * 這個材質在**這個檔案內**的唯一鍵。
   *
   * **不能用名字。** 真實匯出器常常不寫材質名 —— Sponza 的 25 個材質
   * 全部無名，於是「以名字為鍵」把它們併成 1 個，69 張貼圖只進來 9 張，
   * 而 cook 完全沒有報錯。
   *
   * 用文件內的索引：它一定唯一、一定穩定，而且與同一次 cook 的其他
   * 檔案不會混淆（AssetId 會再加上檔名前綴）。
   */
  key: string;
  name: string;
  baseColor: [number, number, number, number];
  roughness: number;
  metalness: number;
  /**
   * 材質引用的貼圖，**尚未解碼**（PNG／JPEG 的原始位元組）。
   *
   * 解碼要用 sharp（原生模組），而匯入器本身應該只做「讀 glTF」這件事。
   * 把解碼留給 cook 管線也讓同一張貼圖被多個材質引用時只解一次。
   *
   * `null` 代表材質沒有那個槽位。
   */
  textures: {
    baseColor: ImportedTexture | null;
    normal: ImportedTexture | null;
    metallicRoughness: ImportedTexture | null;
    occlusion: ImportedTexture | null;
  };
}

export interface ImportedTexture {
  /** 同一張貼圖在多個材質間共用時的識別碼，用來去重。 */
  key: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * 匯入時被丟棄的東西。
 *
 * ## 為什麼這個型別必須存在
 *
 * 實測把 10 個 Khronos 官方測試資產餵進管線：**全部烘焙成功，零警告**。
 * 而它靜默丟掉了骨骼權重、morph target、頂點色、第二組 UV、以及所有
 * 材質貼圖。`BrainStem` 這個骨骼動畫角色烘成 59 個 primitive，
 * 永遠停在 bind pose —— 而 manifest 看起來完全正常。
 *
 * 這是這個專案反覆遇到的同一種失效：**看起來成功了**。差別在於它發生在
 * 管線層級，症狀要到把資產放進場景、發現角色不會動的時候才出現，
 * 而那時候沒有任何線索指回 cook。
 *
 * 支援這些功能是各自獨立的工作。**但「沒支援」與「沒說」是兩件事**，
 * 後者現在就要修。
 */
export interface ImportWarning {
  /** 哪一個 primitive 或檔案。 */
  source: string;
  /** 丟掉了什麼。 */
  dropped: string;
  /** 這在畫面上會表現成什麼 —— 沒有這句話，警告只是雜訊。 */
  effect: string;
}

export interface ImportResult {
  primitives: ImportedPrimitive[];
  warnings: ImportWarning[];
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

let io: NodeIO | null = null;

/**
 * 註冊**全部**擴充的 IO。
 *
 * 不註冊的話，把擴充列為 required 的檔案會直接**開不了** —— 不是丟資料，
 * 是整個檔案讀不進來。實測 Khronos 官方測試語料 118 個 .glb 裡有 20 個
 * （17%）是這種情況：
 *
 * ```text
 * KHR_texture_transform          5 個
 * KHR_lights_punctual            4
 * KHR_materials_unlit            3
 * KHR_materials_specular         2
 * KHR_draco_mesh_compression     1   ← 真實專案最常見的壓縮格式之一
 * 其他 7 種                      各 1
 * ```
 *
 * 註冊擴充**不代表支援它們** —— 匯入器仍然只讀 POSITION/NORMAL/UV/TANGENT
 * 加材質純量。差別在於檔案打得開，其餘的走 ImportWarning 明確報出來，
 * 而不是「這個資產就是不能用」。
 *
 * IO 快取起來：Draco 解碼器的初始化不便宜，而 cook 會逐檔呼叫。
 */
async function createIO(): Promise<NodeIO> {
  if (io !== null) return io;
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  /**
   * Draco 需要的不只是註冊擴充，還要提供**解碼器實作**。
   *
   * 只註冊擴充的話錯誤訊息是 `Cannot read properties of undefined
   * (reading 'DT_FLOAT32')` —— 完全看不出跟 Draco 有關。
   *
   * Draco 是真實專案最常見的幾何壓縮格式之一（gltfpack 與多數匯出流程的
   * 預設之一），不支援等於整類資產打不開。
   */
  const draco = await import('draco3d');
  io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': await draco.createDecoderModule() });
  return io;
}

/** GLB 容器的魔數：ASCII 的 "glTF"。 */
const GLB_MAGIC = 0x46546c67;

/**
 * 讀出 glTF 文件，自動辨識 `.glb`（單檔）與 `.gltf`（JSON + 外部資源）。
 *
 * ## 為什麼兩種都要支援
 *
 * `.glb` 是單一檔案，方便但不是唯一形式。**真實匯出流程常常產出分離形式**，
 * 而圖學界最常用的兩個測試場景（Sponza、Bistro）都只有 `.gltf` 版本。
 * 只支援 `.glb` 等於把那些資產排除在驗證之外。
 *
 * ## 為什麼傳 Map 而不是路徑
 *
 * cooker 刻意不碰檔案系統 —— 那讓它同樣能在瀏覽器與測試裡執行，
 * 掃描目錄是 CLI 的責任。代價是呼叫端要先把 `.bin` 與貼圖讀進來。
 *
 * 缺資源時 gltf-transform 的錯誤是 `Cannot read properties of undefined`，
 * 完全指不回「少了哪個檔案」。所以這裡先自己檢查一次並列出缺的名字。
 */
async function readDocument(
  bytes: Uint8Array,
  sourceName: string,
  resources?: ReadonlyMap<string, Uint8Array>,
): Promise<Document> {
  const io = await createIO();
  const isBinary =
    bytes.byteLength >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === GLB_MAGIC;
  if (isBinary) return io.readBinary(bytes);

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`WW.cook: ${sourceName} 既不是 GLB 也不是合法的 JSON`, { cause: error });
  }

  /**
   * gltf-transform 要 Uint8Array<ArrayBuffer>，而一般的 Uint8Array 可能
   * backing 在 SharedArrayBuffer 上。實際上不會（我們都是 readFileSync
   * 出來的），但型別上必須明確 —— 用 as never 蓋掉會連真的錯誤一起蓋掉。
   */
  const map: Record<string, Uint8Array<ArrayBuffer>> = {};
  for (const [uri, data] of resources ?? []) {
    map[uri] =
      data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data);
  }

  const missing = referencedUris(json).filter((uri) => map[uri] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `WW.cook: ${sourceName} 缺少 ${missing.length} 個外部資源：${missing.slice(0, 5).join('、')}` +
        `${missing.length > 5 ? ' …' : ''}`,
    );
  }

  return io.readJSON({ json: json as never, resources: map });
}

/** 文件裡所有 `uri` 欄位（buffer 與 image），跳過 data: 內嵌的。 */
function referencedUris(json: unknown): string[] {
  const out: string[] = [];
  const root = json as { buffers?: unknown[]; images?: unknown[] };
  for (const list of [root.buffers ?? [], root.images ?? []]) {
    for (const item of list) {
      const uri = (item as { uri?: unknown }).uri;
      // data: URI 的內容就在字串裡，不需要外部檔案
      if (typeof uri === 'string' && !uri.startsWith('data:')) out.push(decodeURIComponent(uri));
    }
  }
  return out;
}

/** 頂點屬性 → 丟掉它會怎樣。順序決定報告的順序。 */
const DROPPED_ATTRIBUTES: ReadonlyArray<[string, string]> = [
  ['JOINTS_0', '骨骼綁定消失，角色永遠停在 bind pose'],
  ['WEIGHTS_0', '骨骼權重消失，角色永遠停在 bind pose'],
  ['COLOR_0', '頂點色消失，模型會少掉一層著色'],
  ['TEXCOORD_1', '第二組 UV 消失，lightmap 與 AO 貼圖會取樣到錯的位置'],
];

/**
 * 讀出檔案裡**所有** primitive。
 *
 * 與舊的 `readSourceGltf` 最大的差別是它不再拒絕多 primitive ——
 * 那個限制讓匯入器對真實檔案完全無用。
 */
export async function importGltf(
  bytes: Uint8Array,
  sourceName: string,
  resources?: ReadonlyMap<string, Uint8Array>,
): Promise<ImportResult> {
  const document = await readDocument(bytes, sourceName, resources);
  const out: ImportedPrimitive[] = [];
  const warnings: ImportWarning[] = [];
  /** 同一種丟棄只報一次 —— 59 個 primitive 各報一行沒有人會讀。 */
  const reported = new Set<string>();
  const warn = (source: string, dropped: string, effect: string): void => {
    const key = `${dropped}`;
    if (reported.has(key)) return;
    reported.add(key);
    warnings.push({ source, dropped, effect });
  };

  const animations = document.getRoot().listAnimations().length;
  if (animations > 0) {
    warn(sourceName, `${animations} 段動畫`, '匯入的是靜態幾何，動畫資料不會進入 manifest');
  }
  if (document.getRoot().listSkins().length > 0) {
    warn(sourceName, 'skin（骨架）', '骨架階層消失，蒙皮網格會停在 bind pose');
  }

  // 走訪節點而不是 mesh 清單：同一個 mesh 可能被多個節點以不同變換引用
  // （glTF 的實例化方式）。只走 mesh 會漏掉那些副本。
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh === null) continue;
    const world = node.getWorldMatrix();

    for (const [index, primitive] of mesh.listPrimitives().entries()) {
      const name = `${sourceName}:${mesh.getName() || 'mesh'}#${index}`;
      const converted = convert(primitive, world);
      if (converted === null) {
        warn(name, '非索引幾何', 'primitive 被整個跳過，該部位不會出現在畫面上');
        continue;
      }

      for (const [attribute, effect] of DROPPED_ATTRIBUTES) {
        if (primitive.getAttribute(attribute) !== null) warn(name, attribute, effect);
      }
      if (primitive.listTargets().length > 0) {
        warn(name, 'morph target', '變形動畫消失，模型停在基礎形狀');
      }

      const material = primitive.getMaterial();
      if (material !== null) reportMaterialGaps(material, name, warn);

      out.push({
        name,
        mesh: converted,
        material: convertMaterial(
          material,
          material === null ? -1 : materialIndex(document, material),
        ),
      });
    }
  }

  if (out.length === 0) {
    throw new Error(`WW.cook: ${sourceName} 沒有任何可用的 primitive（需要 POSITION 與索引）`);
  }
  return { primitives: out, warnings };
}

/**
 * 材質只匯入純量（baseColor / roughness / metalness）—— **貼圖完全沒有**。
 *
 * 這一項最容易被誤讀成「有支援」：`ImportedMaterial` 這個型別存在，
 * 匯入也確實產出了它，於是看起來材質是通的。實際上 Avocado 烘出來之後
 * 會用場景自己指定的石頭貼圖渲染。
 */
function reportMaterialGaps(
  material: Material,
  source: string,
  warn: (source: string, dropped: string, effect: string) => void,
): void {
  // baseColor / normal / metallicRoughness / occlusion 現在**有匯入**
  // （見 convertMaterial 的 textures），所以不再列在這裡。
  // 剩下的才是真正還沒接的。
  if (material.getEmissiveTexture() !== null) {
    warn(source, 'emissiveTexture', '自發光貼圖消失');
  }

  const emissive = material.getEmissiveFactor();
  if (emissive.some((v) => v > 0)) {
    warn(source, 'emissiveFactor', '自發光強度消失，該部位不會發亮');
  }
  if (material.getAlphaMode() !== 'OPAQUE') {
    warn(source, `alphaMode=${material.getAlphaMode()}`, '一律當成不透明，鏤空與半透明會變成實心');
  }
  if (material.getDoubleSided()) {
    warn(source, 'doubleSided', '背面會被剔除，單面幾何從背面看會消失');
  }
}

function convertMaterial(material: Material | null, index: number): ImportedMaterial | null {
  if (material === null) return null;
  const base = material.getBaseColorFactor();
  const name = material.getName();
  return {
    key: name === '' ? `m${index}` : `${index}_${name}`,
    name: name || `material${index}`,
    baseColor: [base[0] ?? 1, base[1] ?? 1, base[2] ?? 1, base[3] ?? 1],
    roughness: material.getRoughnessFactor(),
    metalness: material.getMetallicFactor(),
    textures: {
      baseColor: pickTexture(material.getBaseColorTexture()),
      normal: pickTexture(material.getNormalTexture()),
      metallicRoughness: pickTexture(material.getMetallicRoughnessTexture()),
      occlusion: pickTexture(material.getOcclusionTexture()),
    },
  };
}

/**
 * glTF Texture → 原始位元組。
 *
 * `key` 用影像內容的長度加上前 16 個位元組組成。用貼圖名稱不行 ——
 * 真實檔案裡貼圖常常沒有名字，或多張同名。用完整內容雜湊則要在這裡
 * 掃過每一個位元組，而同一張 2K 貼圖可能被十幾個材質引用。
 *
 * 這個 key 只用於**同一次 cook 內的去重**，不進 manifest，所以碰撞的
 * 代價只是多編一次；真正的識別碼是 cook 之後算的內容雜湊。
 */
function pickTexture(texture: ReturnType<Material['getBaseColorTexture']>): ImportedTexture | null {
  if (texture === null) return null;
  const image = texture.getImage();
  if (image === null || image.byteLength === 0) return null;

  let prefix = '';
  for (let i = 0; i < Math.min(16, image.length); i++) prefix += image[i]!.toString(16);
  return {
    key: `${image.byteLength}:${prefix}`,
    mimeType: texture.getMimeType(),
    bytes: image,
  };
}

/**
 * 一個 primitive → `RawMesh`。
 *
 * 套用節點世界矩陣、處理反正規化、記錄來源是否自帶法線與切線 ——
 * 三件事都是真實檔案才會遇到的，而且錯了都**不會報錯，只會靜默給出
 * 錯誤的幾何**（見 08-asset-pipeline.md 的實測）。
 */
function convert(primitive: Primitive, world: readonly number[]): RawMesh | null {
  const position = primitive.getAttribute('POSITION');
  if (position === null) return null;

  /**
   * 非索引幾何：自己補上 0,1,2,… 的索引。
   *
   * 這是完全合法的 glTF —— 頂點依序三個一組構成三角形。原本直接回傳 null
   * 跳過，於是 `Fox.glb` 整個檔案匯入失敗（它只有一個 primitive）。
   *
   * 補索引不是勉強支援：cook 後面的每一步（焊接、簡化、頂點快取重排）
   * 本來就要求索引，而「把序號寫出來」與「原本就有序號」對它們沒有差別。
   * 真正的節省是後續的焊接會把重複頂點合併掉。
   */
  const existing = primitive.getIndices();
  const indices =
    existing ??
    (() => {
      const n = position.getCount();
      const generated = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) generated[i] = i;
      return { getArray: () => generated, getCount: () => n };
    })();

  const normal = primitive.getAttribute('NORMAL');
  const uv = primitive.getAttribute('TEXCOORD_0');
  const tangent = primitive.getAttribute('TANGENT');
  const count = position.getCount();

  const linear = [
    world[0]!,
    world[1]!,
    world[2]!,
    world[4]!,
    world[5]!,
    world[6]!,
    world[8]!,
    world[9]!,
    world[10]!,
  ];
  const determinant =
    linear[0]! * (linear[4]! * linear[8]! - linear[5]! * linear[7]!) -
    linear[3]! * (linear[1]! * linear[8]! - linear[2]! * linear[7]!) +
    linear[6]! * (linear[1]! * linear[5]! - linear[2]! * linear[4]!);
  // 單位矩陣時完全不動資料：多餘的乘法與正規化會讓已經是單位長度的法線
  // 產生最後幾位的漂移，於是「來源帶了就沿用」變成「幾乎沿用」。
  const identity = world.every((v, i) => v === IDENTITY[i]);

  const vertices = new Float32Array(count * VERTEX_FLOATS);
  const element = [0, 0, 0, 0];

  for (let v = 0; v < count; v++) {
    const dst = v * VERTEX_FLOATS;

    // getElement 而非 getArray：前者處理 `normalized` 的反正規化，
    // 後者回傳原始儲存格式（Int16 之類），當浮點數讀就是垃圾
    position.getElement(v, element);
    if (identity) {
      vertices[dst] = element[0]!;
      vertices[dst + 1] = element[1]!;
      vertices[dst + 2] = element[2]!;
    } else {
      const x = element[0]!;
      const y = element[1]!;
      const z = element[2]!;
      vertices[dst] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
      vertices[dst + 1] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
      vertices[dst + 2] = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
    }

    if (normal !== null) {
      normal.getElement(v, element);
      writeDirection(element, linear, identity, vertices, dst + 3);
    }
    if (uv !== null) {
      uv.getElement(v, element);
      vertices[dst + 6] = element[0]!;
      vertices[dst + 7] = element[1]!;
    }
    if (tangent !== null) {
      tangent.getElement(v, element);
      const w = element[3]!;
      writeDirection(element, linear, identity, vertices, dst + 8);
      // 鏡像變換會翻轉手性，w 必須跟著翻，否則法線貼圖在被鏡像的部位
      // 凹凸相反
      vertices[dst + 11] = determinant < 0 ? -w : w;
    }
  }

  return {
    vertices,
    indices: new Uint32Array(indices.getArray() as ArrayLike<number>),
    hasNormals: normal !== null,
    hasTangents: tangent !== null,
  };
}

function writeDirection(
  v: readonly number[],
  linear: readonly number[],
  identity: boolean,
  out: Float32Array,
  at: number,
): void {
  if (identity) {
    out[at] = v[0]!;
    out[at + 1] = v[1]!;
    out[at + 2] = v[2]!;
    return;
  }
  const x = v[0]!;
  const y = v[1]!;
  const z = v[2]!;
  const nx = linear[0]! * x + linear[3]! * y + linear[6]! * z;
  const ny = linear[1]! * x + linear[4]! * y + linear[7]! * z;
  const nz = linear[2]! * x + linear[5]! * y + linear[8]! * z;
  const length = Math.hypot(nx, ny, nz) || 1;
  out[at] = nx / length;
  out[at + 1] = ny / length;
  out[at + 2] = nz / length;
}

/** 型別匯出給測試建構用。 */
export type { Document };

/**
 * 材質在文件裡的索引。
 *
 * `listMaterials()` 每次呼叫都重新走訪，所以快取在文件層級 —— 一個
 * 10,000 個 primitive 的檔案否則會做一萬次線性搜尋。
 */
const materialIndexCache = new WeakMap<Document, Map<Material, number>>();

function materialIndex(document: Document, material: Material): number {
  let map = materialIndexCache.get(document);
  if (map === undefined) {
    map = new Map();
    for (const [i, m] of document.getRoot().listMaterials().entries()) map.set(m, i);
    materialIndexCache.set(document, map);
  }
  return map.get(material) ?? -1;
}
