import { ASSET_SCHEMA_VERSION, VERTEX_FLOATS, type AssetManifest, type CookStats, type MaterialEntry, type MeshEntry, type TextureEntry, asAssetId } from '@webworld/format';
import { hashObject, hashString } from '@ww/core';
import {
  DEFAULT_LOD_OPTIONS,
  computeBounds,
  generateCollision,
  generateLods,
  generateTangents,
  optimizeLodChain,
  recomputeNormals,
  triangleCount,
  vertexCount,
  weld,
  type LodOptions,
  type RawMesh,
} from './geometry.ts';
import { importGltf, type ImportedPrimitive, type ImportedTexture } from './gltf-import.ts';
import { decodeTexture, packOrm } from './texture-import.ts';
import { packMesh } from './pack.ts';
import { readSourceGltf, standardSourceAssets, writeSourceGltf } from './source-assets.ts';
import { heightToNormal, rockAlbedo, roughnessAo, type Image } from './texture/image.ts';
import { encodeTexture, type TextureKind, type TextureQuality } from './texture/ktx2.ts';

export const COOKER_VERSION = '0.1.0-m2';

export interface CookOptions {
  lod?: LodOptions;
  /**
   * 一併產生內建的程序化資產（石頭、球、樹幹）。預設 **false**。
   *
   * 它們是這個 repo 的量測固定物 —— 別人的專案不會想在自己的 manifest
   * 裡看到 `mesh:rock-large`。
   */
  builtins?: boolean;
  /** 產生碰撞網格。關掉可加快只看視覺的迭代。 */
  collision?: boolean;
  /** 目前只有一組固定材質。 */
  materials?: MaterialEntry[];
  /** 程序化貼圖的邊長。必須是 4 的倍數（BC 區塊尺寸）。 */
  textureSize?: number;
  /** albedo 的壓縮檔次：`compact` 為 BC1（4 bpp），`high` 為 BC7（8 bpp）。 */
  textureQuality?: TextureQuality;
  /**
   * 要一併 cook 的真實 `.glb` 檔案。
   *
   * 傳入位元組而非路徑：cooker 本身不碰檔案系統，這樣它同樣能在瀏覽器或
   * 測試裡執行。掃描目錄是 CLI 的責任。
   *
   * repo 裡刻意不放二進位美術檔（見 08-asset-pipeline.md），所以預設是空的 ——
   * 程序化資產仍然保留，作為「管線本身是否正常」與「真實資料是否正常」的
   * 區分依據。
   */
  sourceFiles?: ReadonlyArray<{
    name: string;
    bytes: Uint8Array;
    /**
     * .gltf 的外部資源（URI → 位元組）。.glb 不需要。
     *
     * 分離形式是真實匯出流程的常態，而 Sponza 與 Bistro 這兩個圖學界最常用的
     * 測試場景都只有 .gltf 版本 —— 不支援等於把它們排除在驗證之外。
     */
    resources?: ReadonlyMap<string, Uint8Array>;
  }>;
}

export interface CookedAsset {
  entry: MeshEntry;
  bytes: Uint8Array;
  stats: CookStats;
}

export interface CookResult {
  manifest: AssetManifest;
  files: Map<string, Uint8Array>;
}

/**
 * 驗證來源網格。
 *
 * 在最前面擋掉壞資料，而不是讓它一路流到 GPU 才變成看不懂的畫面。
 * 回傳警告清單而非直接丟例外 —— 有些問題（例如退化三角形）可以修，
 * 有些（索引越界）不行；呼叫端需要知道差別。
 */
export function validateMesh(id: string, mesh: RawMesh): string[] {
  const problems: string[] = [];
  const count = vertexCount(mesh);

  if (count === 0) problems.push(`${id}: 沒有頂點`);
  if (mesh.indices.length === 0) problems.push(`${id}: 沒有索引`);
  if (mesh.indices.length % 3 !== 0) {
    problems.push(`${id}: 索引數 ${mesh.indices.length} 不是 3 的倍數`);
  }

  let outOfRange = 0;
  let degenerate = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]!;
    const b = mesh.indices[i + 1]!;
    const c = mesh.indices[i + 2]!;
    if (a >= count || b >= count || c >= count) outOfRange++;
    else if (a === b || b === c || a === c) degenerate++;
  }
  if (outOfRange > 0) problems.push(`${id}: ${outOfRange} 個三角形的索引越界`);
  if (degenerate > 0) problems.push(`${id}: ${degenerate} 個退化三角形`);

  for (let v = 0; v < count * VERTEX_FLOATS; v++) {
    if (!Number.isFinite(mesh.vertices[v]!)) {
      problems.push(`${id}: 頂點資料含 NaN 或 Infinity`);
      break;
    }
  }

  return problems;
}

/**
 * 單一網格的完整 cook 流程。
 *
 * ```text
 * 驗證 → 焊接 → 重算法線 → 產生切線 → 產生 LOD → 產生碰撞
 *   → 計算包圍體 → 打包 → 內容雜湊
 * ```
 *
 * 順序有講究，每一條都對應一種會壞掉的方式：
 *
 * - **焊接在 LOD 之前** —— 未焊接的網格每個三角形都有獨立頂點，
 *   simplifier 找不到可塌陷的邊
 * - **法線在焊接之後** —— 焊接會合併頂點
 * - **切線在法線之後** —— MikkTSpace 吃法線當輸入
 * - **切線在 LOD 之前** —— 所有 LOD 共用同一份頂點，切線只該算一次
 */
export async function cookMesh(
  id: string,
  source: RawMesh,
  options: CookOptions = {},
  /** 這個網格要用的材質 id。程序化資產由呼叫端指定，真實資產來自 primitive。 */
  materialId: string | null = null,
): Promise<{ asset: CookedAsset; warnings: string[] }> {
  const started = Date.now();
  const warnings = validateMesh(id, source);
  const sourceTriangles = triangleCount(source);

  const welded = weld(source);

  // 來源自己帶的法線／切線**優先於重算**。
  //
  // 美術會刻意用自訂法線做硬邊或圓角著色，切線則是與該資產的法線貼圖
  // 配套烘焙的。無條件重算會把這些意圖抹掉，而且抹掉之後看起來「也很正常」，
  // 只是不是他們要的樣子 —— 那種問題回報時的說法會是「引擎裡看起來怪怪的」。
  //
  // glTF 規格也是這麼要求的：TANGENT 存在時應該使用它。
  const authoredNormals = source.hasNormals === true;
  // 切線的意義完全依附在法線上。法線被重算了，配套的切線就不再對應，
  // 必須一起重算 —— 留著只會得到一組指向錯誤方向的基底。
  const authoredTangents = source.hasTangents === true && authoredNormals;
  if (source.hasTangents === true && !authoredNormals) {
    warnings.push(`${id}: 來源有切線但沒有法線；法線重算後切線不再對應，兩者都重新產生`);
  }

  const withNormals = authoredNormals ? welded : recomputeNormals(welded);
  // 切線必須在法線之後（MikkTSpace 吃法線當輸入）、LOD 之前（所有 LOD
  // 共用同一份頂點，切線只該算一次）。它內部會拆開再焊回來，因此
  // UV 接縫兩側會正確地保持分離。
  const withTangents = authoredTangents ? withNormals : generateTangents(withNormals);
  const rawLods = await generateLods(withTangents, options.lod ?? DEFAULT_LOD_OPTIONS);
  // 為 GPU 重排頂點與三角形順序。零畫質成本、零 runtime 成本，
  // 而實測這類內容是三角形吞吐受限的 —— 頂點端的節省直接反映在幀時間。
  const lods = await optimizeLodChain(rawLods);
  const optimized = lods[0]!.mesh;
  // 碰撞與包圍體必須用**重排後**的網格：頂點順序變了，用舊的會產生
  // 指向錯誤頂點的索引，症狀是碰撞形狀與畫面對不上。
  const collision = options.collision === false ? null : await generateCollision(optimized);

  const bounds = computeBounds(optimized);
  const packed = packMesh(lods, collision);

  // 內容雜湊涵蓋**二進位內容與所有描述性資料**。
  // 只雜湊 bytes 會漏掉 bounds 或 LOD 誤差的變化；只雜湊 metadata 會漏掉幾何變化。
  const contentHash = hashObject({
    bytes: hashString(bytesToKey(packed.bytes)),
    bounds,
    lods: packed.lods,
    collision: packed.collision,
    cookerVersion: COOKER_VERSION,
  });

  const entry: MeshEntry = {
    id: asAssetId(id),
    contentHash,
    file: `${fileNameFor(id)}.wwm`,
    byteLength: packed.bytes.byteLength,
    bounds,
    lods: packed.lods,
    collision: packed.collision,
    material: materialId,
  };

  const stats: CookStats = {
    sourceTriangles,
    cookedTriangles: triangleCount(lods[0]!.mesh),
    lodTriangles: lods.map((lod) => triangleCount(lod.mesh)),
    durationMs: Date.now() - started,
  };

  return { asset: { entry, bytes: packed.bytes, stats }, warnings };
}

/**
 * 把位元組轉成可雜湊的字串。
 *
 * 用 latin1 逐位元組轉換而非 base64：不需要相依、不需要 padding，
 * 而且對 hashString 來說只要是**確定性**的表示就夠了。
 */
function bytesToKey(bytes: Uint8Array): string {
  let out = '';
  // 分塊避免超過 String.fromCharCode 的參數上限
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

/** 依貼圖用途挑對應的程序化產生器。 */
function imageFor(kind: TextureKind, size: number, seed: number): Image {
  switch (kind) {
    case 'albedo':
      return rockAlbedo(size, seed);
    case 'normal':
      return heightToNormal(size, seed);
    case 'roughness-ao':
      return roughnessAo(size, seed);
    case 'data':
      // 單通道資料貼圖目前沒有來源。真的需要時（例如 height、mask）
      // 應該有自己的產生器，而不是拿 albedo 充數。
      throw new Error('data 貼圖尚無程序化來源');
  }
}

function fileNameFor(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

const DEFAULT_MATERIALS: MaterialEntry[] = [
  {
    id: asAssetId('material:rock'),
    contentHash: '',
    baseColor: [0.55, 0.53, 0.5, 1],
    roughness: 0.85,
    metalness: 0.0,
    baseColorTexture: 'texture:rock-albedo',
    normalTexture: 'texture:rock-normal',
    roughnessAoTexture: 'texture:rock-orm',
  },
  {
    id: asAssetId('material:bark'),
    contentHash: '',
    baseColor: [0.36, 0.26, 0.18, 1],
    roughness: 0.9,
    metalness: 0.0,
    baseColorTexture: 'texture:bark-albedo',
    normalTexture: 'texture:bark-normal',
    roughnessAoTexture: 'texture:bark-orm',
  },
];

/**
 * Cook 一整批資產並產生 manifest。
 *
 * `cookAll` 走的是完整路徑：程序化來源 → 寫成 glTF → 讀回來 → cook。
 * 中間繞經 glTF 不是多餘的，那讓「讀檔與解析」這一段也被實際執行到。
 */
export async function cookAll(options: CookOptions = {}): Promise<CookResult> {
  const meshes: Record<string, MeshEntry> = {};
  const stats: Record<string, CookStats> = {};
  const files = new Map<string, Uint8Array>();
  const warnings: string[] = [];

  for (const source of options.builtins === true ? standardSourceAssets() : []) {
    const gltf = await writeSourceGltf(source);
    const imported = await readSourceGltf(gltf);

    const { asset, warnings: meshWarnings } = await cookMesh(
      source.id,
      imported,
      options,
      source.material,
    );
    meshes[source.id] = asset.entry;
    stats[source.id] = asset.stats;
    files.set(asset.entry.file, asset.bytes);
    warnings.push(...meshWarnings);
  }

  // ── 真實 .glb 來源 ──
  //
  // 每個 **primitive** 各自成為一個 cooked mesh，而不是把多 primitive 塞進
  // 單一 entry。繪製單位本來就是 primitive（不同材質必然是不同 draw），
  // 包成一個只是讓 runtime 多拆一次。
  const importedMaterials: MaterialEntry[] = [];
  const importedTextures = new ImportedTextureSet();
  for (const { name, bytes, resources } of options.sourceFiles ?? []) {
    let primitives: ImportedPrimitive[];
    try {
      const imported = await importGltf(bytes, name, resources);
      primitives = imported.primitives;
      // 匯入器丟掉的東西必須浮到 cook 的輸出。實測 10 個 Khronos 官方
      // 測試資產全部烘焙成功、零警告，而骨骼、morph target、頂點色與
      // 所有材質貼圖都被靜默丟棄 —— manifest 看起來完全正常。
      for (const w of imported.warnings) {
        warnings.push(`${w.source}: 丟棄 ${w.dropped} —— ${w.effect}`);
      }
    } catch (error) {
      // 一個檔案壞掉不該讓整輪 cook 失敗，但**絕不能靜默跳過** ——
      // 那會表現成「某個模型就是不出現」而沒有任何線索。
      warnings.push(`${name} 匯入失敗：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const primitive of primitives) {
      const id = `mesh:${primitive.name}`;
      // AssetId 帶上檔名：兩個檔案都有 Material.001 時不能互相覆蓋。
      const materialId =
        primitive.material === null ? null : `material:${name}:${primitive.material.key}`;

      const { asset, warnings: meshWarnings } = await cookMesh(
        id,
        primitive.mesh,
        options,
        materialId,
      );
      meshes[id] = asset.entry;
      stats[id] = asset.stats;
      files.set(asset.entry.file, asset.bytes);
      warnings.push(...meshWarnings);

      if (primitive.material !== null && materialId !== null) {
        if (!importedMaterials.some((m) => m.id === materialId)) {
          const source = primitive.material.textures;
          importedMaterials.push({
            id: asAssetId(materialId),
            contentHash: '',
            baseColor: primitive.material.baseColor,
            roughness: primitive.material.roughness,
            metalness: primitive.material.metalness,
            // 貼圖在下面統一解碼與編碼；這裡只登記引用。
            baseColorTexture: importedTextures.request(source.baseColor, 'albedo', materialId),
            normalTexture: importedTextures.request(source.normal, 'normal', materialId),
            roughnessAoTexture: importedTextures.requestOrm(
              source.metallicRoughness,
              source.occlusion,
              materialId,
            ),
          });
        }
      }
    }
  }

  const materials: Record<string, MaterialEntry> = {};
  for (const material of importedMaterials) {
    const { contentHash: _ignored, ...rest } = material;
    materials[material.id] = { ...material, contentHash: hashObject(rest) };
  }
  for (const material of options.materials ?? DEFAULT_MATERIALS) {
    const { contentHash: _ignored, ...rest } = material;
    materials[material.id] = { ...material, contentHash: hashObject(rest) };
  }

  // ── 貼圖 ──
  const textures: Record<string, TextureEntry> = {};
  const size = options.textureSize ?? 256;
  const sources: Array<{ id: string; kind: TextureKind; seed: number }> = [
    { id: 'texture:rock-albedo', kind: 'albedo', seed: 0x51a1 },
    { id: 'texture:rock-normal', kind: 'normal', seed: 0x51a2 },
    { id: 'texture:rock-orm', kind: 'roughness-ao', seed: 0x51a3 },
    { id: 'texture:bark-albedo', kind: 'albedo', seed: 0xba21 },
    { id: 'texture:bark-normal', kind: 'normal', seed: 0xba22 },
    { id: 'texture:bark-orm', kind: 'roughness-ao', seed: 0xba23 },
  ];

  const quality = options.textureQuality ?? 'compact';

  for (const source of sources) {
    const image = imageFor(source.kind, size, source.seed);
    const encoded = encodeTexture(image, source.kind, source.kind === 'albedo', quality);
    const file = `${fileNameFor(source.id)}.ktx2`;

    textures[source.id] = {
      id: asAssetId(source.id),
      contentHash: hashObject({
        bytes: hashString(bytesToKey(encoded.bytes)),
        vkFormat: encoded.vkFormat,
        cookerVersion: COOKER_VERSION,
      }),
      file,
      vkFormat: encoded.vkFormat,
      width: encoded.width,
      height: encoded.height,
      levelCount: encoded.levelCount,
      byteLength: encoded.bytes.byteLength,
      uncompressedBytes: encoded.uncompressedBytes,
    };
    files.set(file, encoded.bytes);
  }

  /**
   * 真實資產帶進來的貼圖。
   *
   * 與程序化貼圖走**同一條** BC 編碼路徑 —— 差別只在來源是解碼後的 PNG／JPEG
   * 而不是程序產生的像素。分成兩條路徑的話，格式選擇、mip 產生、sRGB 處理
   * 都會有兩份實作，而其中一份必然會落後。
   */
  for (const entry of importedTextures.entries) {
    try {
      const decoded =
        entry.kind === 'roughness-ao'
          ? await decodeOrm(entry.metallicRoughness, entry.occlusion, entry.id)
          : (await decodeTexture(entry.metallicRoughness!.bytes, entry.id)).image;
      if (decoded === null) continue;

      const encoded = encodeTexture(decoded, entry.kind, entry.srgb, quality);
      const file = `${fileNameFor(entry.id)}.ktx2`;
      textures[entry.id] = {
        id: asAssetId(entry.id),
        contentHash: hashObject({
          bytes: hashString(bytesToKey(encoded.bytes)),
          vkFormat: encoded.vkFormat,
          cookerVersion: COOKER_VERSION,
        }),
        file,
        vkFormat: encoded.vkFormat,
        width: encoded.width,
        height: encoded.height,
        levelCount: encoded.levelCount,
        byteLength: encoded.bytes.byteLength,
        uncompressedBytes: encoded.uncompressedBytes,
      };
      files.set(file, encoded.bytes);
    } catch (error) {
      // 一張貼圖解不開不該讓整輪 cook 失敗，但材質會少一張圖 ——
      // 那在畫面上是「這個東西沒有紋理」，必須說出來。
      warnings.push(
        `${entry.id} 貼圖處理失敗：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // 範圍限制要明說，不能靜默跳過
  warnings.push(
    `貼圖只產生 BC 系列（桌機）。本引擎的目標平台是桌機 WebGPU；` +
      `行動裝置的 ETC2/ASTC 不在範圍內，見 specs/roadmap.md 的範圍宣告。`,
  );

  const manifest: AssetManifest = {
    schemaVersion: ASSET_SCHEMA_VERSION,
    cookerVersion: COOKER_VERSION,
    contentHash: '',
    meshes,
    materials,
    textures,
    warnings,
    stats,
  };
  // Manifest 的雜湊只涵蓋**內容**，不含衍生資料。
  //
  // 第一次跑 `--verify` 就抓到了：原本把整個 manifest 丟進去雜湊，
  // 其中 `stats.durationMs` 是 wall-clock 時間，兩次烘焙必然不同 ——
  // 於是「相同輸入產生相同雜湊」永遠不成立。
  //
  // stats 是遙測、warnings 可能隨環境變動，兩者都不該影響內容識別。
  manifest.contentHash = hashObject({
    schemaVersion: manifest.schemaVersion,
    cookerVersion: manifest.cookerVersion,
    meshes: manifest.meshes,
    materials: manifest.materials,
    textures: manifest.textures,
  });

  return { manifest, files };
}

/**
 * 匯入貼圖的收集與去重。
 *
 * ## 為什麼要去重
 *
 * 同一張貼圖被多個材質引用是常態 —— 一個模型的所有部位共用一張 atlas。
 * 實測 Khronos 語料的 118 個檔案有 10,745 個材質；不去重的話同一張 2K
 * 貼圖會被解碼與 BC 編碼十幾次，而 BC7 編碼是整條 cook 裡最貴的一步。
 *
 * ## 為什麼 ORM 要另外處理
 *
 * 引擎的 `roughnessAoTexture` 是 R=AO、G=roughness，而 glTF 把它們分成
 * **兩張不同的貼圖**（metallicRoughness 的 G/B，occlusion 的 R）。所以
 * ORM 的去重鍵是「兩張來源的組合」而不是單一貼圖。
 */
class ImportedTextureSet {
  private readonly byKey = new Map<string, string>();
  private readonly pending: Array<{
    id: string;
    kind: TextureKind;
    srgb: boolean;
    metallicRoughness: ImportedTexture | null;
    occlusion: ImportedTexture | null;
  }> = [];

  /** 登記一張直接使用的貼圖，回傳它的 AssetId（沒有貼圖時回傳 null）。 */
  request(texture: ImportedTexture | null, kind: TextureKind, owner: string): string | null {
    if (texture === null) return null;
    const existing = this.byKey.get(texture.key);
    if (existing !== undefined) return existing;

    const id = `texture:${fileNameFor(owner)}-${kind}`;
    this.byKey.set(texture.key, id);
    this.pending.push({
      id,
      kind,
      // 只有 albedo 是 sRGB。法線與 ORM 是**資料**，當成 sRGB 解碼會讓
      // 數值整個歪掉 —— 那不會報錯，只會讓光照看起來「怪怪的」。
      srgb: kind === 'albedo',
      metallicRoughness: texture,
      occlusion: null,
    });
    return id;
  }

  /** 登記一組 ORM（metallicRoughness + occlusion 合併）。 */
  requestOrm(
    metallicRoughness: ImportedTexture | null,
    occlusion: ImportedTexture | null,
    owner: string,
  ): string | null {
    if (metallicRoughness === null && occlusion === null) return null;
    const key = `orm:${metallicRoughness?.key ?? '-'}|${occlusion?.key ?? '-'}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;

    const id = `texture:${fileNameFor(owner)}-orm`;
    this.byKey.set(key, id);
    this.pending.push({ id, kind: 'roughness-ao', srgb: false, metallicRoughness, occlusion });
    return id;
  }

  get entries(): readonly {
    id: string;
    kind: TextureKind;
    srgb: boolean;
    metallicRoughness: ImportedTexture | null;
    occlusion: ImportedTexture | null;
  }[] {
    return this.pending;
  }
}

/**
 * 解出 ORM：glTF 的 metallicRoughness 與 occlusion 合併成引擎的佈局。
 *
 * 兩張來源可以是不同尺寸，也可以只有其中一張。細節與「為什麼不能直接
 * 拿 metallicRoughness 當 ORM 用」見 `texture-import.ts` 的 `packOrm`。
 */
async function decodeOrm(
  metallicRoughness: ImportedTexture | null,
  occlusion: ImportedTexture | null,
  label: string,
): Promise<Image | null> {
  const mr = metallicRoughness === null ? null : (await decodeTexture(metallicRoughness.bytes, label)).image;
  const ao = occlusion === null ? null : (await decodeTexture(occlusion.bytes, label)).image;
  return packOrm(mr, ao);
}
