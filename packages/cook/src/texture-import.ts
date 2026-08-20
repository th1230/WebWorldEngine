import type { Image } from './texture/image.ts';

/**
 * glTF 內嵌影像 → `Image`（RGBA8）。
 *
 * ## 為什麼需要這一層
 *
 * `.glb` 裡的貼圖是 **PNG 或 JPEG 的編碼位元組**，而 BC 編碼器要的是
 * RGBA8 的平面像素。中間必須解碼。
 *
 * 沒有這一層的時候，匯入器把材質貼圖全部丟掉 —— 實測 Khronos 語料 118 個
 * 檔案裡有 91 個帶 baseColorTexture、52 個帶 metallicRoughnessTexture。
 * 也就是說**真實資產進來之後會用場景自己指定的材質渲染**，而 cook 不會報錯。
 *
 * ## 尺寸必須是 4 的倍數
 *
 * BC 是 4×4 區塊壓縮。真實資產的貼圖多半是 2 的冪，但不保證 ——
 * `BoxTexturedNonPowerOfTwo` 就是官方拿來測這件事的。不對齊時往下取整到
 * 最近的 4 的倍數，而不是拒絕或往上補：
 *
 * - 拒絕 → 整個材質沒有貼圖，畫面上是明顯的錯誤
 * - 往上補 → 補出來的邊緣像素會被取樣到，UV 落在 [0,1] 的內容被壓縮
 * - 往下取整 → 最多丟掉邊緣 3 個像素，而 mip 鏈本來就會抹掉那個尺度
 */
export interface DecodedTexture {
  image: Image;
  /** 原始尺寸，供警告使用。與 `image` 不同就代表被調整過。 */
  sourceWidth: number;
  sourceHeight: number;
}

/** BC 需要 4×4 區塊，所以邊長必須是 4 的倍數。 */
function alignDown(value: number): number {
  return Math.max(4, value - (value % 4));
}

/**
 * 匯入貼圖的邊長上限。
 *
 * 真實資產常常是 2K 甚至 4K。實測 10 個道具（Khronos 語料）的貼圖 cook
 * 出來是 **128 MB**（壓縮後），而 runtime 的 `AssetCache` 預算是 64 MB ——
 * 也就是說「照原尺寸全收」在這個引擎裡根本裝不下。
 *
 * 貼圖預算是每個引擎都有的 cook 時決策，不是妥協。散佈在世界裡的道具
 * 在螢幕上很少超過幾百像素，4K 貼圖的細節永遠取樣不到。
 *
 * 1024 是預設而不是硬限制：英雄物件或需要近距離觀察的資產可以個別調高。
 */
export const DEFAULT_MAX_TEXTURE_SIZE = 1024;

export async function decodeTexture(
  bytes: Uint8Array,
  label: string,
  maxSize = DEFAULT_MAX_TEXTURE_SIZE,
): Promise<DecodedTexture> {
  // 動態載入：sharp 是原生模組，只有 cook 需要它。放在頂層 import 會讓
  // 任何 import 這個套件的地方（包含測試）都得付出載入成本。
  const sharp = (await import('sharp')).default;

  const probe = sharp(Buffer.from(bytes));
  const meta = await probe.metadata();
  const sourceWidth = meta.width ?? 0;
  const sourceHeight = meta.height ?? 0;
  if (sourceWidth === 0 || sourceHeight === 0) {
    throw new Error(`WW.cook: ${label} 的影像尺寸讀不到（格式可能不支援）`);
  }

  // 先套上限，再對齊到 4 的倍數。順序反過來的話，縮放會把對齊破壞掉。
  const scale = Math.min(1, maxSize / Math.max(sourceWidth, sourceHeight));
  const width = alignDown(Math.round(sourceWidth * scale));
  const height = alignDown(Math.round(sourceHeight * scale));

  // ensureAlpha：glTF 的貼圖可能是 RGB 或灰階，而 BC 編碼器一律吃 RGBA8。
  // 少了它，三通道的 PNG 會讓 pixels 陣列長度對不上而靜默錯位。
  const pipeline =
    width === sourceWidth && height === sourceHeight
      ? sharp(Buffer.from(bytes))
      : sharp(Buffer.from(bytes)).resize(width, height, { fit: 'fill' });

  const { data } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  return {
    image: { width, height, pixels: new Uint8Array(data) },
    sourceWidth,
    sourceHeight,
  };
}

/**
 * 把 glTF 的 metallicRoughness 與 occlusion 併成引擎的 ORM 佈局。
 *
 * 引擎的 `roughnessAoTexture` 是 **R = AO、G = roughness**（見 manifest.ts）。
 * glTF 的 metallicRoughnessTexture 是 **G = roughness、B = metalness**，
 * occlusion 則是**另一張貼圖的 R**。
 *
 * 兩者常常是同一張圖（glTF 規格明確允許 occlusion 與 metallicRoughness
 * 共用），但不保證。直接把 metallicRoughness 當成 ORM 用會讓 AO 取到
 * metallicRoughness 的 R 通道 —— 那個通道在 glTF 裡是**未定義的**，
 * 內容可能是任何東西。實測就是這樣：整個模型會蓋上一層隨機的暗斑。
 */
export function packOrm(metallicRoughness: Image | null, occlusion: Image | null): Image | null {
  const reference = metallicRoughness ?? occlusion;
  if (reference === null) return null;

  const { width, height } = reference;
  const pixels = new Uint8Array(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    // R = AO。沒有 occlusion 貼圖時用 255（完全不遮蔽），
    // 而不是 0 —— 後者會讓整個模型全黑。
    pixels[o] = occlusion === null ? 255 : sample(occlusion, reference, i, 0);
    // G = roughness，來自 glTF metallicRoughness 的 G
    pixels[o + 1] = metallicRoughness === null ? 255 : sample(metallicRoughness, reference, i, 1);
    // B 保留 metalness，雖然引擎目前只讀 R 與 G
    pixels[o + 2] = metallicRoughness === null ? 0 : sample(metallicRoughness, reference, i, 2);
    pixels[o + 3] = 255;
  }

  return { width, height, pixels };
}

/**
 * 從 `source` 取第 `index` 個像素的第 `channel` 通道，尺寸不同時做最近取樣。
 *
 * occlusion 與 metallicRoughness 可以是不同尺寸的貼圖。假設它們一樣大會
 * 讓較小的那張讀出界 —— typed array 越界回傳 undefined，寫進 Uint8Array
 * 變成 0，於是 AO 全黑。
 */
function sample(source: Image, reference: Image, index: number, channel: number): number {
  if (source.width === reference.width && source.height === reference.height) {
    return source.pixels[index * 4 + channel] ?? 0;
  }
  const x = index % reference.width;
  const y = (index / reference.width) | 0;
  const sx = Math.min(source.width - 1, ((x * source.width) / reference.width) | 0);
  const sy = Math.min(source.height - 1, ((y * source.height) / reference.height) | 0);
  return source.pixels[(sy * source.width + sx) * 4 + channel] ?? 0;
}
