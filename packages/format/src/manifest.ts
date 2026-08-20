declare const BRAND: unique symbol;

/**
 * 資產識別字。
 *
 * 刻意在這裡自己定義而不是從內部套件匯入 —— 這個套件是 `@web-world-engine/three`
 * 與 `@web-world-engine/cook` 之間的**契約**，契約裡的每一個型別都必須是使用者
 * 裝得到的東西。
 */
export type AssetId = string & { readonly [BRAND]: 'AssetId' };

export const asAssetId = (value: string): AssetId => value as AssetId;

/** 位元組數。 */
export type Bytes = number;

/**
 * Cooked 資產的格式定義。
 *
 * 這個 package 同時被 Node 端的 cooker 與瀏覽器端的 runtime 依賴，因此
 * **只放型別與常數，不放任何實作**。格式的定義必須是雙方唯一的共同語言 ——
 * 一邊改了另一邊沒改，是資產管線最常見也最難查的錯誤來源。
 */

/**
 * 格式版本。任何欄位或二進位佈局改變都必須遞增。
 *
 * 版本 3：MeshEntry 加上 material，網格與材質之間有了明確連結。
 * 版本 2：頂點佈局加入切線，stride 從 32 變成 48 bytes。
 *
 * 舊的 `.wwm` 配新 runtime 不會壞在明顯的地方 —— 它會用錯誤的 stride 讀，
 * 於是位置、法線、UV 全部錯位，畫面變成一團看不出所以然的幾何。
 * 在解碼時就擋掉，錯誤訊息才說得出「請重新執行 pnpm cook」。
 */
export const ASSET_SCHEMA_VERSION = 3;

/** 二進位檔的魔術數字：'WWM1'（WebWorld Mesh v1）。 */
export const MESH_MAGIC = 0x314d5757;

export interface Bounds {
  center: [number, number, number];
  radius: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface BlockRef {
  offset: Bytes;
  length: Bytes;
}

/**
 * 一個 LOD 層級。
 *
 * `error` 是**世界單位**的幾何誤差，不是百分比。選 LOD 時要看的是這個誤差
 * 投影到螢幕上有多少像素，而不是距離 —— 同樣距離下，大山和小石頭需要的
 * 細節完全不同。
 */
export interface LodEntry {
  level: number;
  /** 相對 LOD0 的簡化誤差，世界單位。LOD0 為 0。 */
  error: number;
  vertexCount: number;
  indexCount: number;
  /**
   * 索引的位元組寬度。頂點數少於 65536 時是 2，否則是 4。
   *
   * 這正是 cooker 存在的理由之一：runtime 沒有能力知道「這個網格其實
   * 只需要 16-bit 索引」，但 cook 時一眼就看得出來，直接省一半空間。
   */
  indexBytes: 2 | 4;
  vertices: BlockRef;
  indices: BlockRef;
}

export interface CollisionEntry {
  /** 目前只有 'mesh'（簡化三角網格）。convex hull 等留待物理整合時再做。 */
  kind: 'mesh';
  vertexCount: number;
  indexCount: number;
  /**
   * 索引的位元組寬度。頂點數少於 65536 時是 2，否則是 4。
   *
   * 這正是 cooker 存在的理由之一：runtime 沒有能力知道「這個網格其實
   * 只需要 16-bit 索引」，但 cook 時一眼就看得出來，直接省一半空間。
   */
  indexBytes: 2 | 4;
  vertices: BlockRef;
  indices: BlockRef;
}

export interface MeshEntry {
  id: AssetId;
  /** 內容雜湊。相同輸入必須得到相同的值 —— cook 的可重現性靠它驗證。 */
  contentHash: string;
  /** 相對於 manifest 的檔案路徑。 */
  file: string;
  /** 未壓縮的位元組數，供 streaming 預算估算。 */
  byteLength: Bytes;
  bounds: Bounds;
  lods: LodEntry[];
  collision: CollisionEntry | null;
  /**
   * 這個網格該用哪個材質（`materials` 裡的 key），沒有材質時為 null。
   *
   * 每個 primitive 各自成為一個 mesh 資產，而 primitive 的定義就是「一份
   * 幾何加一個材質」—— 少了這個欄位，載入端只能從 id 字串去猜是哪一個，
   * 而字串是 cooker 的內部命名，隨時可能變。
   */
  material: string | null;
}

/**
 * 一張 cooked 貼圖。
 *
 * **只有一種編碼，沒有格式變體。** 本引擎只支援桌機，而桌機一律是
 * `texture-compression-bc` —— 一個格式家族就涵蓋全部目標裝置，
 * 多變體的機制是純粹的複雜度。理由見 specs/roadmap.md 的範圍宣告。
 */
export interface TextureEntry {
  id: AssetId;
  contentHash: string;
  file: string;
  /** Vulkan format enum，對應 KTX2 的 vkFormat。 */
  vkFormat: number;
  width: number;
  height: number;
  levelCount: number;
  byteLength: Bytes;
  /** 未壓縮 RGBA8（含 mip）的位元組數，用來報告壓縮率。 */
  uncompressedBytes: Bytes;
}

export interface MaterialEntry {
  id: AssetId;
  contentHash: string;
  /** 只支援最基本的 PBR 參數，沒有 material graph。 */
  baseColor: [number, number, number, number];
  roughness: number;
  metalness: number;
  baseColorTexture: string | null;
  normalTexture: string | null;
  /**
   * AO + roughness 的雙通道貼圖：**R = AO、G = roughness**。
   *
   * 沿用 glTF 的 ORM 通道順序，Three.js 的 `aoMap`/`roughnessMap` 剛好
   * 各取 `.r`/`.g`，同一張貼圖可以直接餵給兩者。metalness 沒有進來 ——
   * 這批材質都是非金屬，為一個到處都是 0 的通道多付頻寬沒有意義。
   */
  roughnessAoTexture: string | null;
}

export interface CookStats {
  sourceTriangles: number;
  cookedTriangles: number;
  /** 各 LOD 的三角形數，含 LOD0。 */
  lodTriangles: number[];
  durationMs: number;
}

export interface AssetManifest {
  schemaVersion: number;
  cookerVersion: string;
  /** 整份 manifest 的雜湊，不含此欄位本身。改一個 mesh 就會變。 */
  contentHash: string;
  meshes: Record<string, MeshEntry>;
  materials: Record<string, MaterialEntry>;
  textures: Record<string, TextureEntry>;
  /** cook 過程中的警告。空陣列代表沒有降級。 */
  warnings: string[];
  stats: Record<string, CookStats>;
}

/**
 * Mesh 二進位檔的標頭佈局（小端序）。
 *
 * ```text
 * offset  size  欄位
 * 0       4     magic (MESH_MAGIC)
 * 4       4     schemaVersion
 * 8       4     lodCount
 * 12      4     vertexStride（位元組）
 * 16      -     LOD 與 collision 的資料區塊
 * ```
 *
 * 區塊位置由 manifest 的 BlockRef 指定，不重複記在檔頭裡：
 * 兩份真相遲早會不一致。
 */
export const MESH_HEADER_BYTES = 16;

/**
 * 頂點佈局：position(3) + normal(3) + uv(2) + tangent(4)，共 48 bytes。
 *
 * ## 為什麼切線要存在檔案裡
 *
 * 法線貼圖的每個像素都是「相對於某個切線基底」的方向。烘焙貼圖的工具
 * （Blender、Substance、Marmoset）用的是 **MikkTSpace**；runtime 若用別的
 * 方式推導切線，算出來的基底與烘焙時不同，**整張貼圖的光照都會偏**。
 * 那種錯誤不會讓畫面壞掉，只會讓它「看起來就是差一點」，而且極難歸因。
 *
 * 常見的替代做法是在 fragment shader 用螢幕空間導數即時推導切線。那能跑，
 * 但在 UV 接縫與高曲率處會有明顯瑕疵，而且每個 fragment 都要算一次 ——
 * 這正是 cooker 該接手的事：算一次，存起來。
 *
 * `tangent.w` 是**手性符號**（+1 / −1），bitangent = `cross(normal, tangent.xyz) * w`。
 * 這是 glTF 的慣例，鏡像 UV 的區域需要它才不會把法線翻面。
 *
 * ## 代價
 *
 * 頂點從 32 bytes 變成 48（+50%）。刻意**不做量化**：位置量化成 16-bit
 * 需要把 scale/offset 折進物件變換，會與 instancing 路徑互相干擾
 * （每個 instance 的矩陣已經是 camera-relative）。切線可以壓成八面體編碼 + 符號，
 * 但幾何壓縮的收益在 meshlet streaming 才顯著，到那時再連同 page
 * 格式一起設計比較合理。
 */
export const VERTEX_STRIDE_BYTES = 48;
export const VERTEX_FLOATS = 12;

export const POSITION_OFFSET = 0;
export const NORMAL_OFFSET = 3;
export const UV_OFFSET = 6;
export const TANGENT_OFFSET = 8;
