/**
 * 固定 seed 的 PRNG（mulberry32）。
 *
 * 所有 benchmark 場景的程序化內容都必須來自這裡：同一個 seed 在任何機器、
 * 任何瀏覽器上都必須產生完全相同的場景。用 Math.random() 會讓每次執行的
 * 幾何分布不同，數字就失去可比較性。
 */
export interface Rng {
  next(): number;
  range(min: number, max: number): number;
  int(minInclusive: number, maxExclusive: number): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (minInclusive, maxExclusive) =>
      minInclusive + Math.floor(next() * (maxExclusive - minInclusive)),
  };
}

export const DEFAULT_SEED = 0x5eed_1234;
