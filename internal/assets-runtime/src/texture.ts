import type { TextureEntry } from '@webworld/format';
import { read } from 'ktx-parse';
import { AssetFormatError } from './decode.ts';

/**
 * KTX2 貼圖的解析。
 *
 * 與 mesh 解碼一樣，**這裡不碰任何 renderer API** —— 它只把 KTX2 拆成
 * 「格式 + 各 mip 的位元組」，由 render adapter 決定要建立什麼樣的 GPU 物件。
 * 這條界線讓貼圖載入可以搬進 Web Worker，也讓換 backend 不必改這一層。
 */

/**
 * 引擎中立的壓縮格式標識。render adapter 負責映射到具體 API 的常數。
 *
 * 只有 BC 系列：本引擎只支援桌機，而桌機一律回報 `texture-compression-bc`。
 */
export type CompressedFormat =
  | 'bc1-rgb'
  | 'bc1-rgb-srgb'
  | 'bc4-r'
  | 'bc5-rg'
  | 'bc7-rgba'
  | 'bc7-rgba-srgb';

export interface TextureLevel {
  level: number;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface DecodedTexture {
  format: CompressedFormat;
  /** 色彩資料為 true；法線與 roughness 這類資料貼圖為 false。 */
  srgb: boolean;
  width: number;
  height: number;
  levels: TextureLevel[];
}

/** Vulkan format enum → 引擎中立標識。 */
const VK_FORMAT_MAP: Record<number, { format: CompressedFormat; srgb: boolean }> = {
  131: { format: 'bc1-rgb', srgb: false }, // VK_FORMAT_BC1_RGB_UNORM_BLOCK
  132: { format: 'bc1-rgb-srgb', srgb: true }, // VK_FORMAT_BC1_RGB_SRGB_BLOCK
  139: { format: 'bc4-r', srgb: false }, // VK_FORMAT_BC4_UNORM_BLOCK
  141: { format: 'bc5-rg', srgb: false }, // VK_FORMAT_BC5_UNORM_BLOCK
  145: { format: 'bc7-rgba', srgb: false }, // VK_FORMAT_BC7_UNORM_BLOCK
  146: { format: 'bc7-rgba-srgb', srgb: true }, // VK_FORMAT_BC7_SRGB_BLOCK
};

/** 每個 4×4 區塊的位元組數。 */
const BLOCK_BYTES: Record<CompressedFormat, number> = {
  'bc1-rgb': 8,
  'bc1-rgb-srgb': 8,
  'bc4-r': 8,
  'bc5-rg': 16,
  'bc7-rgba': 16,
  'bc7-rgba-srgb': 16,
};

export function blockBytesFor(format: CompressedFormat): number {
  return BLOCK_BYTES[format];
}

/**
 * 解析 cooked 的 .ktx2。
 *
 * 只支援我們自己 cook 出來的格式（BC 系列、無 supercompression）。
 * 遇到 Basis 壓縮的檔案會明確拒絕而不是嘗試處理 —— 那需要 transcoder，
 * 而我們的管線不產生那種檔案。
 */
export function decodeTexture(bytes: Uint8Array, entry: TextureEntry): DecodedTexture {
  const container = read(bytes);

  if (container.supercompressionScheme !== 0) {
    throw new AssetFormatError(
      `${entry.id} 使用 supercompression ${container.supercompressionScheme}，需要 transcoder；本管線只產生未超壓縮的 BC 格式`,
    );
  }

  const mapped = VK_FORMAT_MAP[container.vkFormat];
  if (mapped === undefined) {
    throw new AssetFormatError(
      `${entry.id} 的 vkFormat ${container.vkFormat} 不受支援（目前只有 BC1/BC4/BC5/BC7）`,
    );
  }

  const levels: TextureLevel[] = container.levels.map((level, index) => ({
    level: index,
    width: Math.max(1, container.pixelWidth >> index),
    height: Math.max(1, container.pixelHeight >> index),
    data: level.levelData,
  }));

  return {
    format: mapped.format,
    srgb: mapped.srgb,
    width: container.pixelWidth,
    height: container.pixelHeight,
    levels,
  };
}

/**
 * 驗證各 mip 的資料長度符合格式。
 *
 * 長度不符時 GPU 上傳會失敗或讀到垃圾。在這裡檢查，錯誤訊息才說得清楚
 * 是哪一張貼圖、哪一個 mip —— 讓 GPU 去發現只會得到一句無上下文的
 * validation error。
 */
export function validateTexture(texture: DecodedTexture, id: string): string[] {
  const problems: string[] = [];
  const blockBytes = blockBytesFor(texture.format);

  for (const level of texture.levels) {
    const blocksX = Math.max(1, Math.ceil(level.width / 4));
    const blocksY = Math.max(1, Math.ceil(level.height / 4));
    const expected = blocksX * blocksY * blockBytes;
    if (level.data.byteLength !== expected) {
      problems.push(
        `${id} mip ${level.level}（${level.width}×${level.height}）應為 ${expected} 位元組，實際 ${level.data.byteLength}`,
      );
    }
  }
  return problems;
}
