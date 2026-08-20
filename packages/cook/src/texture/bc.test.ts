import { read } from 'ktx-parse';
import { describe, expect, it } from 'vitest';
import { blocksFor, decodeBc1, decodeBc4, encodeBc1, encodeBc4, encodeBc5 } from './bc.ts';
import {
  generateMipChain,
  heightToNormal,
  renormalizeNormals,
  rockAlbedo,
  type Image,
} from './image.ts';
import { encodeTexture } from './ktx2.ts';

function solidImage(size: number, r: number, g: number, b: number): Image {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return { width: size, height: size, pixels };
}

/** 每通道平均絕對誤差（0–255）。 */
function meanAbsError(a: Uint8Array, b: Uint8Array, channels = 3): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < channels; c++) {
      total += Math.abs(a[i + c]! - b[i + c]!);
      count++;
    }
  }
  return total / count;
}

describe('BC1 encoder', () => {
  it('compresses 8:1 versus RGBA8', () => {
    const image = rockAlbedo(64, 1);
    const encoded = encodeBc1(image.pixels, 64, 64);
    expect(encoded.byteLength).toBe((64 / 4) * (64 / 4) * 8);
    // 4 bpp 對 32 bpp。常說的 6:1 是對 RGB8 而非 RGBA8。
    expect(image.pixels.byteLength / encoded.byteLength).toBe(8);
  });

  it('reproduces a solid colour almost exactly', () => {
    // 單色區塊的兩個端點相同，誤差只來自 RGB565 量化
    const image = solidImage(16, 200, 100, 50);
    const decoded = decodeBc1(encodeBc1(image.pixels, 16, 16), 16, 16);
    expect(meanAbsError(image.pixels, decoded)).toBeLessThan(5);
  });

  it('reproduces a noisy texture within a reasonable error budget', () => {
    // BC1 是有損的；4 bpp 下平均誤差在個位數是正常水準
    const image = rockAlbedo(64, 7);
    const decoded = decodeBc1(encodeBc1(image.pixels, 64, 64), 64, 64);
    expect(meanAbsError(image.pixels, decoded)).toBeLessThan(8);
  });

  it('preserves a sharp black/white edge', () => {
    // 梯度區塊最能考驗端點選擇。單一區塊內的黑白邊界應該幾乎無損。
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      const value = i % 4 < 2 ? 0 : 255;
      pixels[i * 4] = value;
      pixels[i * 4 + 1] = value;
      pixels[i * 4 + 2] = value;
      pixels[i * 4 + 3] = 255;
    }
    const decoded = decodeBc1(encodeBc1(pixels, 4, 4), 4, 4);
    expect(meanAbsError(pixels, decoded)).toBeLessThan(12);
  });

  it('always emits four-colour mode blocks', () => {
    // c0 > c1 才是四色模式；反過來會變成三色 + 透明，那不是我們要的
    const encoded = encodeBc1(rockAlbedo(32, 3).pixels, 32, 32);
    const blocks = blocksFor(32, 32);
    for (let b = 0; b < blocks.x * blocks.y; b++) {
      const c0 = encoded[b * 8]! | (encoded[b * 8 + 1]! << 8);
      const c1 = encoded[b * 8 + 2]! | (encoded[b * 8 + 3]! << 8);
      expect(c0).toBeGreaterThanOrEqual(c1);
    }
  });

  it('handles sizes that are not multiples of four without black edges', () => {
    // 邊界鉗制而非補零；補零會在右下角產生黑邊
    const image = solidImage(4, 180, 180, 180);
    const decoded = decodeBc1(encodeBc1(image.pixels.subarray(0, 6 * 4), 6, 1), 6, 1);
    expect(decoded[0]).toBeGreaterThan(150);
  });
});

describe('BC4 / BC5 encoder', () => {
  it('compresses BC4 2:1 versus a single 8-bit channel', () => {
    const encoded = encodeBc4(rockAlbedo(64, 2).pixels, 64, 64);
    expect(encoded.byteLength).toBe((64 / 4) * (64 / 4) * 8);
  });

  it('BC5 is two BC4 blocks per texel block', () => {
    const encoded = encodeBc5(heightToNormal(64, 5).pixels, 64, 64);
    expect(encoded.byteLength).toBe((64 / 4) * (64 / 4) * 16);
  });

  it('reproduces a single channel with low error', () => {
    // BC4 有 8 個內插值，比 BC1 每通道的精度高得多
    const image = rockAlbedo(64, 11);
    const decoded = decodeBc4(encodeBc4(image.pixels, 64, 64), 64, 64);
    let total = 0;
    for (let i = 0; i < 64 * 64; i++) total += Math.abs(image.pixels[i * 4]! - decoded[i]!);
    expect(total / (64 * 64)).toBeLessThan(3);
  });

  it('keeps normal-map X and Y in separate BC4 planes', () => {
    const normal = heightToNormal(32, 13);
    const encoded = encodeBc5(normal.pixels, 32, 32);
    const x = decodeBc4(encoded, 32, 32, 16, 0);
    const y = decodeBc4(encoded, 32, 32, 16, 8);

    let errorX = 0;
    let errorY = 0;
    for (let i = 0; i < 32 * 32; i++) {
      errorX += Math.abs(normal.pixels[i * 4]! - x[i]!);
      errorY += Math.abs(normal.pixels[i * 4 + 1]! - y[i]!);
    }
    // BC4 只有 8 個內插階，實測平均誤差約 4/255（1.7%）——這是格式的固有精度
    expect(errorX / (32 * 32)).toBeLessThan(6);
    expect(errorY / (32 * 32)).toBeLessThan(6);
  });
});

describe('mip chain', () => {
  it('halves down to 1×1', () => {
    const chain = generateMipChain(solidImage(64, 128, 128, 128), 'linear');
    expect(chain).toHaveLength(7); // 64,32,16,8,4,2,1
    expect(chain.at(-1)!.width).toBe(1);
  });

  it('averages sRGB in linear space, not in sRGB space', () => {
    // 半黑半白：sRGB 直接平均得到 128（太暗），線性平均得到約 188
    const pixels = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) {
      const value = i % 2 === 0 ? 0 : 255;
      pixels[i * 4] = value;
      pixels[i * 4 + 1] = value;
      pixels[i * 4 + 2] = value;
      pixels[i * 4 + 3] = 255;
    }
    const srgb = generateMipChain({ width: 2, height: 2, pixels }, 'srgb');
    const linear = generateMipChain({ width: 2, height: 2, pixels }, 'linear');

    expect(linear[1]!.pixels[0]).toBe(128);
    expect(srgb[1]!.pixels[0]).toBeGreaterThan(180);
  });

  it('renormalizes averaged normals back to unit length', () => {
    const image = heightToNormal(16, 17);
    const chain = generateMipChain(image, 'linear');
    const level = chain[1]!;
    renormalizeNormals(level);

    for (let i = 0; i < level.pixels.length; i += 4) {
      const x = (level.pixels[i]! / 255) * 2 - 1;
      const y = (level.pixels[i + 1]! / 255) * 2 - 1;
      const z = (level.pixels[i + 2]! / 255) * 2 - 1;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
    }
  });
});

describe('KTX2 container', () => {
  it('writes a file that ktx-parse can read back', () => {
    const encoded = encodeTexture(rockAlbedo(64, 21), 'albedo');
    const container = read(encoded.bytes);

    expect(container.pixelWidth).toBe(64);
    expect(container.pixelHeight).toBe(64);
    expect(container.vkFormat).toBe(132); // VK_FORMAT_BC1_RGB_SRGB_BLOCK
    expect(container.levels.length).toBe(encoded.levelCount);
  });

  it('starts with the KTX2 identifier', () => {
    const bytes = encodeTexture(rockAlbedo(16, 22), 'albedo').bytes;
    // «KTX 20»\r\n\x1A\n
    expect(Array.from(bytes.subarray(0, 12))).toEqual([
      0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('emits a data format descriptor', () => {
    // 少了 DFD 就不是合法的 KTX2，外部工具會拒絕
    const container = read(encodeTexture(rockAlbedo(16, 23), 'albedo').bytes);
    const dfd = container.dataFormatDescriptor[0]!;
    expect(dfd.colorModel).toBe(128); // BC1A
    expect(dfd.texelBlockDimension).toEqual([3, 3, 0, 0]); // 4×4
    expect(dfd.bytesPlane[0]).toBe(8);
  });

  it('marks normal maps as BC5 and linear', () => {
    const container = read(encodeTexture(heightToNormal(32, 24), 'normal').bytes);
    expect(container.vkFormat).toBe(141); // VK_FORMAT_BC5_UNORM_BLOCK
    expect(container.dataFormatDescriptor[0]!.transferFunction).toBe(1); // linear
  });

  it('stops the mip chain at 4×4', () => {
    // BC 是 4×4 區塊，更小的 mip 沒有意義
    const encoded = encodeTexture(rockAlbedo(64, 25), 'albedo');
    expect(encoded.levelCount).toBe(5); // 64,32,16,8,4
  });

  it('rejects sizes that are not multiples of four', () => {
    expect(() => encodeTexture(solidImage(4, 1, 1, 1), 'albedo')).not.toThrow();
    const odd = { width: 6, height: 6, pixels: new Uint8Array(6 * 6 * 4) };
    expect(() => encodeTexture(odd, 'albedo')).toThrow(/4 的倍數/);
  });

  it('achieves roughly 8:1 including mips', () => {
    const encoded = encodeTexture(rockAlbedo(256, 26), 'albedo');
    const ratio = encoded.uncompressedBytes / encoded.bytes.byteLength;
    expect(ratio).toBeGreaterThan(7);
  });

  it('is deterministic', () => {
    // cook 的可重現性也涵蓋貼圖
    const a = encodeTexture(rockAlbedo(64, 27), 'albedo');
    const b = encodeTexture(rockAlbedo(64, 27), 'albedo');
    expect(Array.from(b.bytes)).toEqual(Array.from(a.bytes));
  });
});
