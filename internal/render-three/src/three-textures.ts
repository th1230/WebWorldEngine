import type { CompressedFormat, DecodedTexture } from '@ww/assets-runtime';
import {
  CompressedTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  NoColorSpace,
  RED_GREEN_RGTC2_Format,
  RED_RGTC1_Format,
  RGB_S3TC_DXT1_Format,
  RGBA_BPTC_Format,
  RepeatWrapping,
  SRGBColorSpace,
  type CompressedTextureMipmap,
} from 'three/webgpu';

/**
 * 引擎中立的壓縮格式 → Three.js 常數。
 *
 * 這張表是 adapter 的職責所在：`@ww/assets-runtime` 只知道「這是 BC5」，
 * 不知道 Three.js 把它叫做 `RED_GREEN_RGTC2_Format`。換 backend 時
 * 換掉的只有這張表。
 */
const FORMAT_MAP: Record<CompressedFormat, number> = {
  'bc1-rgb': RGB_S3TC_DXT1_Format,
  'bc1-rgb-srgb': RGB_S3TC_DXT1_Format,
  'bc4-r': RED_RGTC1_Format,
  'bc5-rg': RED_GREEN_RGTC2_Format,
  'bc7-rgba': RGBA_BPTC_Format,
  'bc7-rgba-srgb': RGBA_BPTC_Format,
};

export class UnsupportedTextureFormatError extends Error {
  override readonly name = 'UnsupportedTextureFormatError';
}

/**
 * 由 cooked 貼圖建立 GPU 貼圖。
 *
 * **不做任何解壓縮** —— 壓縮資料直接上傳，由 GPU 的紋理單元在取樣時解碼。
 * 這正是 BC 格式的意義：VRAM 佔用少 4–8 倍，而且解碼在硬體裡免費。
 * 若在 CPU 解開再上傳，等於白做整條壓縮管線。
 *
 * mip 鏈也直接來自 cooked 資料，不呼叫 `generateMipmaps` —— 壓縮貼圖
 * 本來就無法在執行期產生 mip，而且 cook 時的 sRGB 正確降採樣品質更好。
 */
export function createCompressedTexture(decoded: DecodedTexture): CompressedTexture {
  const format = FORMAT_MAP[decoded.format];
  if (format === undefined) {
    throw new UnsupportedTextureFormatError(`不支援的壓縮格式 ${decoded.format}`);
  }

  const mipmaps: CompressedTextureMipmap[] = decoded.levels.map((level) => ({
    data: level.data,
    width: level.width,
    height: level.height,
  }));

  const texture = new CompressedTexture(
    mipmaps,
    decoded.width,
    decoded.height,
    format as CompressedTexture['format'],
  );

  // 色彩貼圖要標成 sRGB 讓 renderer 正確轉線性；法線與資料貼圖不能轉
  texture.colorSpace = decoded.srgb ? SRGBColorSpace : NoColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  // 有 mip 才用 trilinear；只有一階時用它會取樣到不存在的層級
  texture.minFilter = mipmaps.length > 1 ? LinearMipmapLinearFilter : LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return texture;
}

/**
 * 檢查 backend 是否支援這個格式。
 *
 * BC 系列需要 `texture-compression-bc`。在只支援 ETC2/ASTC 的裝置上
 * 建立 BC 貼圖會在上傳時失敗 —— 那時候的錯誤訊息不會告訴你根因是
 * 資產格式與硬體不匹配。
 */
export function supportsCompressedFormat(
  families: readonly string[],
  format: CompressedFormat,
): boolean {
  if (format.startsWith('bc')) return families.includes('bc');
  return false;
}

/** three 對 sRGB 的常數在不同版本間換過名稱，這裡集中一處方便追蹤。 */
export const LINEAR_COLOR_SPACE = LinearSRGBColorSpace;
