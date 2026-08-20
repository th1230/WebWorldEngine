import {
  KHR_DF_PRIMARIES_BT709,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_TRANSFER_SRGB,
  VK_FORMAT_BC1_RGB_SRGB_BLOCK,
  VK_FORMAT_BC1_RGB_UNORM_BLOCK,
  VK_FORMAT_BC4_UNORM_BLOCK,
  VK_FORMAT_BC5_UNORM_BLOCK,
  write,
  type KTX2Container,
  type VKFormat,
} from 'ktx-parse';
import { blocksFor, encodeBc1, encodeBc4, encodeBc5 } from './bc.ts';
import { encodeBc7 } from './bc7.ts';
import { generateMipChain, renormalizeNormals, type ColorSpace, type Image } from './image.ts';

/**
 * KTX2 容器寫入。
 *
 * 容器格式用 `ktx-parse`（Khronos 對齊的序列化器），**壓縮編碼自己寫**
 * （見 bc.ts）。分界點很清楚：容器已經有正確且經過驗證的實作，
 * 沒有理由重寫；編碼器則是 npm 上真的沒有純 JS 版本的那一塊。
 */

/**
 * Data Format Descriptor 的 colorModel。
 *
 * `ktx-parse` 只匯出 ETC/ASTC 系列的常數，BC 系列沒有匯出，因此在這裡定義。
 * 數值來自 Khronos Data Format Specification 1.3 §D.4。
 */
const KHR_DF_MODEL_BC1A = 128;
const KHR_DF_MODEL_BC4 = 131;
const KHR_DF_MODEL_BC5 = 132;

/**
 * BC7 的 Vulkan format enum 與 DFD colorModel。
 *
 * `ktx-parse` 沒有匯出這幾個；數值分別來自 Vulkan 規格的 `VkFormat`
 * 與 Khronos Data Format Specification 1.3 §D.4。
 */
const VK_FORMAT_BC7_UNORM_BLOCK = 145;
const VK_FORMAT_BC7_SRGB_BLOCK = 146;
const KHR_DF_MODEL_BC7 = 134;

export type TextureKind = 'albedo' | 'normal' | 'roughness-ao' | 'data';

export interface EncodedTexture {
  bytes: Uint8Array;
  vkFormat: VKFormat;
  width: number;
  height: number;
  levelCount: number;
  /** 未壓縮 RGBA8（含 mip）的位元組數，用來報告壓縮率。 */
  uncompressedBytes: number;
}

interface FormatSpec {
  vkFormat: VKFormat;
  colorModel: number;
  transferFunction: number;
  /** 每個 4×4 區塊的位元組數。 */
  blockBytes: 8 | 16;
  colorSpace: ColorSpace;
  encode: (pixels: Uint8Array, width: number, height: number) => Uint8Array;
}

/**
 * albedo 的品質檔次。
 *
 * BC1 是 4 bpp、BC7 是 8 bpp —— 一倍的空間換明顯更好的畫質。實測在
 * `texture-conformance` 的測試圖上，BC1 對原圖平均誤差 7.81、BC7 為 6.46，
 * 而在漸層上差距更大（BC1 1.938、BC7 0.651）。
 *
 * 預設 `compact`（BC1）：貼圖記憶體是 streaming 的主要壓力來源，而多數
 * 表面材質看不出差別。真正需要 `high` 的是漸層明顯、或需要 alpha 的內容
 * （BC1 完全沒有 alpha）。
 */
export type TextureQuality = 'compact' | 'high';

function specFor(kind: TextureKind, srgb: boolean, quality: TextureQuality): FormatSpec {
  switch (kind) {
    case 'albedo':
      if (quality === 'high') {
        return {
          vkFormat: (srgb ? VK_FORMAT_BC7_SRGB_BLOCK : VK_FORMAT_BC7_UNORM_BLOCK) as VKFormat,
          colorModel: KHR_DF_MODEL_BC7,
          transferFunction: srgb ? KHR_DF_TRANSFER_SRGB : KHR_DF_TRANSFER_LINEAR,
          blockBytes: 16,
          colorSpace: srgb ? 'srgb' : 'linear',
          encode: encodeBc7,
        };
      }
      return {
        vkFormat: srgb ? VK_FORMAT_BC1_RGB_SRGB_BLOCK : VK_FORMAT_BC1_RGB_UNORM_BLOCK,
        colorModel: KHR_DF_MODEL_BC1A,
        transferFunction: srgb ? KHR_DF_TRANSFER_SRGB : KHR_DF_TRANSFER_LINEAR,
        blockBytes: 8,
        colorSpace: srgb ? 'srgb' : 'linear',
        encode: encodeBc1,
      };
    case 'normal':
      // 法線用 BC5：只存 XY，Z 在 shader 重建。比把三通道塞進 BC1 精確得多。
      return {
        vkFormat: VK_FORMAT_BC5_UNORM_BLOCK,
        colorModel: KHR_DF_MODEL_BC5,
        transferFunction: KHR_DF_TRANSFER_LINEAR,
        blockBytes: 16,
        colorSpace: 'linear',
        encode: encodeBc5,
      };
    case 'roughness-ao':
      // 與法線同樣用 BC5：兩個獨立通道，各自保有接近 8 位元的精度。
      // roughness 的量化階梯在光滑表面上會直接變成可見的亮度分帶，
      // 所以不能為了省空間塞進 BC1 的其中一個通道。
      return {
        vkFormat: VK_FORMAT_BC5_UNORM_BLOCK,
        colorModel: KHR_DF_MODEL_BC5,
        transferFunction: KHR_DF_TRANSFER_LINEAR,
        blockBytes: 16,
        colorSpace: 'linear',
        encode: encodeBc5,
      };
    case 'data':
      return {
        vkFormat: VK_FORMAT_BC4_UNORM_BLOCK,
        colorModel: KHR_DF_MODEL_BC4,
        transferFunction: KHR_DF_TRANSFER_LINEAR,
        blockBytes: 8,
        colorSpace: 'linear',
        encode: encodeBc4,
      };
  }
}

/**
 * 建立 Data Format Descriptor。
 *
 * DFD 對我們自己的 runtime 不是必要的（我們讀 vkFormat 就夠），但少了它
 * 產出的就不是合法的 KTX2 檔 —— 任何外部工具（KTX-Software、Blender、
 * gltf-transform）都會拒絕。既然要做就做對。
 */
function buildDfd(spec: FormatSpec): KTX2Container['dataFormatDescriptor'][number] {
  const bits = spec.blockBytes * 8;
  return {
    vendorId: 0,
    descriptorType: 0,
    versionNumber: 2,
    colorModel: spec.colorModel,
    colorPrimaries: KHR_DF_PRIMARIES_BT709,
    transferFunction: spec.transferFunction,
    flags: 0,
    // texelBlockDimension 存的是「尺寸 − 1」，所以 4×4 是 [3, 3, 0, 0]
    texelBlockDimension: [3, 3, 0, 0],
    bytesPlane: [spec.blockBytes, 0, 0, 0, 0, 0, 0, 0],
    samples: [
      {
        bitOffset: 0,
        bitLength: bits - 1,
        channelType: 0,
        samplePosition: [0, 0, 0, 0],
        sampleLower: 0,
        sampleUpper: 0xffffffff,
      },
    ],
  };
}

/**
 * 把一張影像壓成帶 mip 鏈的 KTX2。
 *
 * 尺寸必須是 4 的倍數。BC 是 4×4 區塊格式，非倍數尺寸雖然可以用鉗制邊界
 * 處理，但 mip 鏈降到 2×2、1×1 時整個區塊只有少數有效像素，品質很差 ——
 * 與其產生看起來正常實則模糊的結果，不如直接擋下來。
 */
export function encodeTexture(
  image: Image,
  kind: TextureKind,
  srgb = kind === 'albedo',
  quality: TextureQuality = 'compact',
): EncodedTexture {
  if (image.width % 4 !== 0 || image.height % 4 !== 0) {
    throw new Error(
      `WW.cook: 貼圖尺寸 ${image.width}×${image.height} 不是 4 的倍數，BC 需要 4×4 區塊`,
    );
  }

  const spec = specFor(kind, srgb, quality);
  const chain = generateMipChain(image, spec.colorSpace);

  // 法線的 mip 是平均值，長度不再是 1；不重新正規化會讓遠處逐漸變暗
  if (kind === 'normal') {
    for (const level of chain.slice(1)) renormalizeNormals(level);
  }

  // BC 需要至少 4×4，比這更小的 mip 沒有意義
  const usable = chain.filter((level) => level.width >= 4 && level.height >= 4);

  let uncompressedBytes = 0;
  const levels = usable.map((level) => {
    uncompressedBytes += level.width * level.height * 4;
    const levelData = spec.encode(level.pixels, level.width, level.height);
    return { levelData, uncompressedByteLength: levelData.byteLength };
  });

  const container: KTX2Container = {
    vkFormat: spec.vkFormat,
    typeSize: 1,
    pixelWidth: image.width,
    pixelHeight: image.height,
    pixelDepth: 0,
    layerCount: 0,
    faceCount: 1,
    supercompressionScheme: 0,
    levelCount: levels.length,
    levels,
    dataFormatDescriptor: [buildDfd(spec)],
    keyValue: {},
    globalData: null,
  };

  return {
    bytes: write(container),
    vkFormat: spec.vkFormat,
    width: image.width,
    height: image.height,
    levelCount: levels.length,
    uncompressedBytes,
  };
}

/** 一個 mip level 的壓縮後大小，供預算估算。 */
export function compressedLevelBytes(width: number, height: number, blockBytes: number): number {
  const blocks = blocksFor(width, height);
  return blocks.x * blocks.y * blockBytes;
}
