/**
 * BC7 編碼器（只用 mode 6）。
 *
 * ## 為什麼只做 mode 6
 *
 * BC7 有 8 個 mode，差別在於「把 4×4 切成幾個 subset」「端點幾位元」
 * 「索引幾位元」。完整編碼器要對每個區塊試遍 8 個 mode × 64 種 partition，
 * 那是 rgbcx / ISPC 那個等級的工程。
 *
 * mode 6 是其中唯一的「單 subset、RGBA 全通道、最高精度」模式：
 * 端點 7+1 位元、索引 4 位元。單獨使用它就已經明顯優於 BC1
 * （BC1 是 565 端點 + 2 位元索引），而且原生支援 alpha。
 * 對「平滑漸層」與「單一色彩方向」的區塊，mode 6 幾乎就是最佳解；
 * 它會輸的是「一個區塊裡有兩群完全不同的顏色」，那要靠 partition。
 *
 * 只做 mode 6 是**刻意的品質/工程量取捨**，不是遺漏 —— 產出的仍是
 * 完全合法的 BC7，任何解碼器都讀得懂。
 *
 * ## 區塊佈局（mode 6，共 128 位元，LSB-first）
 *
 * ```text
 * [0..6]    mode           7 位元，值為 0b1000000
 * [7..62]   端點           R0 R1 G0 G1 B0 B1 A0 A1，各 7 位元（通道優先）
 * [63..64]  P-bit          每個端點一個，補成 8 位元端點的最低位
 * [65..67]  index[0]       3 位元（anchor，最高位隱含為 0）
 * [68..127] index[1..15]   各 4 位元
 * ```
 */

import { blocksFor, gatherBlock, selectDiagonal } from './bc.ts';
import { BitReader, BitWriter } from './bits.ts';

const BLOCK_PIXELS = 16;

/** 與 bc.ts 相同的感知權重；alpha 用與綠色相同的權重（cutout 邊緣很敏感）。 */
const CHANNEL_WEIGHT = [3, 4, 2, 4];

/**
 * 4 位元索引的內插權重（BC7 規格的 aWeight4）。
 *
 * 注意它**不是**線性的 0/64*i —— 規格選了這組值讓量化誤差更平均。
 * 照抄規格，不要「順手改成線性」。
 */
const WEIGHTS4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

function interpolate(e0: number, e1: number, weight: number): number {
  return ((64 - weight) * e0 + weight * e1 + 32) >> 6;
}

/**
 * 把 8 位元目標值量化成「7 位元 + 指定的 P-bit」。
 *
 * 重建值是 `(v7 << 1) | p`，所以 P-bit 決定了重建值的奇偶。P-bit 是
 * **整個端點共用一個**（不是每通道一個），因此要對 p=0 與 p=1 各算一次
 * 總誤差再挑，不能各通道獨立決定。
 */
function quantize7(value: number, p: number): number {
  const v7 = Math.round((value - p) / 2);
  return v7 < 0 ? 0 : v7 > 127 ? 127 : v7;
}

interface Endpoints {
  /** 兩個端點各 4 通道的 7 位元值。 */
  q: [number[], number[]];
  /** 兩個端點的 P-bit。 */
  p: [number, number];
  /** 重建後的 8 位元端點值。 */
  e: [number[], number[]];
}

function quantizeEndpoints(lo: number[], hi: number[], p0: number, p1: number): Endpoints {
  const q0: number[] = [];
  const q1: number[] = [];
  const e0: number[] = [];
  const e1: number[] = [];
  for (let c = 0; c < 4; c++) {
    const a = quantize7(lo[c]!, p0);
    const b = quantize7(hi[c]!, p1);
    q0.push(a);
    q1.push(b);
    e0.push((a << 1) | p0);
    e1.push((b << 1) | p1);
  }
  return { q: [q0, q1], p: [p0, p1], e: [e0, e1] };
}

/** 建立 16 個調色盤項目（4 通道）。 */
function buildPalette(e0: number[], e1: number[], out: Uint8Array): void {
  for (let i = 0; i < 16; i++) {
    const w = WEIGHTS4[i]!;
    for (let c = 0; c < 4; c++) out[i * 4 + c] = interpolate(e0[c]!, e1[c]!, w);
  }
}

/**
 * 對每個像素挑最接近的調色盤項目，回傳總誤差。
 *
 * 用窮舉而非「投影到端點連線」：16 個項目 × 16 像素只有 256 次比較，
 * 但投影法在權重非線性（WEIGHTS4）時會挑錯項目。這個成本買到的是
 * 「不必為了效能而犧牲正確性」。
 */
function assignIndices(block: Uint8Array, palette: Uint8Array, indices: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < BLOCK_PIXELS; i++) {
    let bestError = Infinity;
    let bestIndex = 0;
    for (let k = 0; k < 16; k++) {
      let error = 0;
      for (let c = 0; c < 4; c++) {
        const d = block[i * 4 + c]! - palette[k * 4 + c]!;
        error += d * d * CHANNEL_WEIGHT[c]!;
      }
      if (error < bestError) {
        bestError = error;
        bestIndex = k;
      }
    }
    indices[i] = bestIndex;
    total += bestError;
  }
  return total;
}

export function encodeBc7Block(block: Uint8Array, out: Uint8Array, outOffset: number): void {
  const lo = [255, 255, 255, 255];
  const hi = [0, 0, 0, 0];
  for (let i = 0; i < BLOCK_PIXELS; i++) {
    for (let c = 0; c < 4; c++) {
      const v = block[i * 4 + c]!;
      if (v < lo[c]!) lo[c] = v;
      if (v > hi[c]!) hi[c] = v;
    }
  }

  // 包圍盒的對角線方向未必是資料的方向（紅升綠降的漸層就會反）
  selectDiagonal(block, 4, lo, hi);

  const palette = new Uint8Array(16 * 4);
  const indices = new Uint8Array(BLOCK_PIXELS);
  const bestIndices = new Uint8Array(BLOCK_PIXELS);
  let bestError = Infinity;
  let best: Endpoints | null = null;

  // 與 BC1 相同：內縮對連續分布的區塊有益，對「只有兩種極端顏色」的區塊
  // 有害，所以兩個都算再挑。加上 4 種 P-bit 組合共 8 次索引搜尋。
  for (const applyInset of [true, false]) {
    const a: number[] = [];
    const b: number[] = [];
    for (let c = 0; c < 4; c++) {
      const inset = applyInset ? (hi[c]! - lo[c]!) / 16 : 0;
      const step = inset < 0 ? Math.ceil(inset) : Math.floor(inset);
      a.push(lo[c]! + step);
      b.push(hi[c]! - step);
    }

    // P-bit 影響重建端點的奇偶，只有 4 種組合，全試
    for (let p0 = 0; p0 < 2; p0++) {
      for (let p1 = 0; p1 < 2; p1++) {
        const ep = quantizeEndpoints(a, b, p0, p1);
        buildPalette(ep.e[0], ep.e[1], palette);
        const error = assignIndices(block, palette, indices);
        if (error < bestError) {
          bestError = error;
          best = ep;
          bestIndices.set(indices);
        }
      }
    }
  }
  if (best === null) throw new Error('BC7：找不到端點');

  // anchor 規則：index[0] 的最高位隱含為 0，所以必須 ≤ 7。
  // 超過就把兩個端點對調並反轉所有索引 —— 調色盤剛好整個反向，
  // 因此 15 − index 是精確等價，不是近似。
  let q = best.q;
  let p = best.p;
  if (bestIndices[0]! > 7) {
    q = [q[1], q[0]];
    p = [p[1], p[0]];
    for (let i = 0; i < BLOCK_PIXELS; i++) bestIndices[i] = 15 - bestIndices[i]!;
  }

  const writer = new BitWriter(out, outOffset);
  writer.write(0b1000000, 7); // mode 6
  for (let c = 0; c < 4; c++) {
    writer.write(q[0]![c]!, 7);
    writer.write(q[1]![c]!, 7);
  }
  writer.write(p[0]!, 1);
  writer.write(p[1]!, 1);
  writer.write(bestIndices[0]!, 3);
  for (let i = 1; i < BLOCK_PIXELS; i++) writer.write(bestIndices[i]!, 4);
}

/** 整張影像編碼成 BC7。輸入為 RGBA8。 */
export function encodeBc7(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const blocks = blocksFor(width, height);
  const out = new Uint8Array(blocks.x * blocks.y * 16);
  const block = new Uint8Array(BLOCK_PIXELS * 4);

  let offset = 0;
  for (let by = 0; by < blocks.y; by++) {
    for (let bx = 0; bx < blocks.x; bx++) {
      gatherBlock(pixels, width, height, bx, by, block);
      encodeBc7Block(block, out, offset);
      offset += 16;
    }
  }
  return out;
}

/**
 * 解碼 BC7 回 RGBA，**僅供測試**（runtime 由 GPU 解）。
 *
 * 只認得 mode 6 —— 我們的編碼器只產生這一種。遇到其他 mode 會丟錯，
 * 而不是回傳看似合理的垃圾：測試若拿到靜默的錯誤資料，就完全失去意義。
 */
export function decodeBc7(data: Uint8Array, width: number, height: number): Uint8Array {
  const blocks = blocksFor(width, height);
  const out = new Uint8Array(width * height * 4);
  const palette = new Uint8Array(16 * 4);
  const indices = new Uint8Array(BLOCK_PIXELS);

  for (let by = 0; by < blocks.y; by++) {
    for (let bx = 0; bx < blocks.x; bx++) {
      const reader = new BitReader(data, (by * blocks.x + bx) * 16);
      const mode = reader.read(7);
      if (mode !== 0b1000000) {
        throw new Error(`BC7 解碼器只支援 mode 6，區塊 (${bx}, ${by}) 的 mode 位元為 ${mode}`);
      }

      const q: number[][] = [[], []];
      for (let c = 0; c < 4; c++) {
        q[0]!.push(reader.read(7));
        q[1]!.push(reader.read(7));
      }
      const p0 = reader.read(1);
      const p1 = reader.read(1);
      const e0 = q[0]!.map((v) => (v << 1) | p0);
      const e1 = q[1]!.map((v) => (v << 1) | p1);
      buildPalette(e0, e1, palette);

      indices[0] = reader.read(3);
      for (let i = 1; i < BLOCK_PIXELS; i++) indices[i] = reader.read(4);

      for (let i = 0; i < BLOCK_PIXELS; i++) {
        const x = bx * 4 + (i % 4);
        const y = by * 4 + Math.floor(i / 4);
        if (x >= width || y >= height) continue;
        const dst = (y * width + x) * 4;
        const src = indices[i]! * 4;
        out[dst] = palette[src]!;
        out[dst + 1] = palette[src + 1]!;
        out[dst + 2] = palette[src + 2]!;
        out[dst + 3] = palette[src + 3]!;
      }
    }
  }
  return out;
}
