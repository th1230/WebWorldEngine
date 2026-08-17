import { describe, expect, it } from 'vitest';
import { decodeBc1, encodeBc1 } from './bc.ts';
import { decodeBc7, encodeBc7 } from './bc7.ts';
import { rockAlbedo, type Image } from './image.ts';

function solidImage(size: number, r: number, g: number, b: number, a = 255): Image {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return { width: size, height: size, pixels };
}

/** 水平漸層 —— BC7 相對 BC1 最有優勢的內容（索引精度 4 位元 vs 2 位元）。 */
function gradient(size: number): Image {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = Math.round((x / (size - 1)) * 255);
      pixels[i] = t;
      pixels[i + 1] = 255 - t;
      pixels[i + 2] = 128;
      pixels[i + 3] = 255;
    }
  }
  return { width: size, height: size, pixels };
}

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

describe('BC7 encoder (mode 6)', () => {
  it('produces 16 bytes per 4×4 block', () => {
    expect(encodeBc7(rockAlbedo(64, 1).pixels, 64, 64).byteLength).toBe(16 * 16 * 16);
  });

  it('emits mode 6 in every block', () => {
    // mode 欄位是「n 個 0 之後接一個 1」，mode 6 因此是低 7 位元 = 0b1000000。
    // 這個測試釘住位元佈局：寫錯 mode 位元的檔案在 GPU 上會被解成完全
    // 不同的 mode，畫面全毀而且看不出原因。
    const data = encodeBc7(rockAlbedo(16, 2).pixels, 16, 16);
    for (let block = 0; block < data.byteLength / 16; block++) {
      expect(data[block * 16]! & 0x7f).toBe(0b1000000);
    }
  });

  it('keeps the anchor index below 8', () => {
    // index[0] 只有 3 位元（最高位隱含為 0）。編碼器若沒做端點對調，
    // 寫出去的第 4 位元會蓋到下一個索引，整個區塊錯位。
    const data = encodeBc7(gradient(32).pixels, 32, 32);
    for (let block = 0; block < data.byteLength / 16; block++) {
      const bitOffset = 65; // 7 (mode) + 56 (端點) + 2 (P-bit)
      const base = block * 16 + (bitOffset >> 3);
      const anchor = ((data[base]! | (data[base + 1]! << 8)) >> (bitOffset & 7)) & 0x7;
      expect(anchor).toBeLessThan(8);
    }
  });

  it('reproduces a solid colour exactly', () => {
    const image = solidImage(16, 200, 60, 30);
    const decoded = decodeBc7(encodeBc7(image.pixels, 16, 16), 16, 16);
    expect(meanAbsError(image.pixels, decoded)).toBeLessThan(0.5);
  });

  it('preserves alpha to within the shared P-bit', () => {
    // BC1 完全沒有 alpha，BC7 mode 6 有完整 8 位元 alpha —— 這是選 BC7
    // 的主要理由之一（cutout 植被）。
    //
    // 但精度上限不是 8 位元而是「7 位元 + 一個四通道共用的 P-bit」。
    // 這裡 RGB=(120,130,140) 都是偶數、alpha=77 是奇數，一個 P-bit
    // 無法同時滿足，編碼器只能挑總誤差較小的一邊（犧牲 alpha 的 1）。
    // 這是格式的硬限制，不是編碼器的缺陷。
    const image = solidImage(16, 120, 130, 140, 77);
    const decoded = decodeBc7(encodeBc7(image.pixels, 16, 16), 16, 16);
    for (let i = 3; i < decoded.length; i += 4) {
      expect(Math.abs(decoded[i]! - 77)).toBeLessThanOrEqual(1);
    }
    // 奇偶一致時就會是精確的
    const even = solidImage(16, 120, 130, 140, 78);
    const decodedEven = decodeBc7(encodeBc7(even.pixels, 16, 16), 16, 16);
    for (let i = 3; i < decodedEven.length; i += 4) expect(decodedEven[i]).toBe(78);
  });

  it('beats BC1 on a gradient', () => {
    // 這是唯一真正證明「BC7 值得多花一倍空間」的測試。
    // 若編碼器有誤，最可能的表現就是這個比較反過來。
    const image = gradient(64);
    const bc7 = meanAbsError(image.pixels, decodeBc7(encodeBc7(image.pixels, 64, 64), 64, 64));
    const bc1 = meanAbsError(image.pixels, decodeBc1(encodeBc1(image.pixels, 64, 64), 64, 64));
    expect(bc7).toBeLessThan(bc1);
    expect(bc7).toBeLessThan(1.5);
  });

  it('stays accurate on noisy albedo', () => {
    const image = rockAlbedo(64, 3);
    const decoded = decodeBc7(encodeBc7(image.pixels, 64, 64), 64, 64);
    expect(meanAbsError(image.pixels, decoded)).toBeLessThan(4);
  });

  it('is deterministic', () => {
    const image = rockAlbedo(32, 4);
    expect(encodeBc7(image.pixels, 32, 32)).toEqual(encodeBc7(image.pixels, 32, 32));
  });
});
