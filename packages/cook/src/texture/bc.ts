/**
 * BC（Block Compression）編碼器。
 *
 * ## 為什麼自己寫
 *
 * npm 上沒有可用的純 JavaScript GPU 貼圖壓縮編碼器。Basis Universal 與
 * Khronos 的 `toktx` 都是原生執行檔，把它們列為建置相依會讓「clone 之後
 * pnpm install 就能跑」這件事不成立，CI 也得額外裝東西。
 *
 * 而 BC1/BC4/BC5 的格式本身是公開且相對簡單的區塊編碼 —— 每個 4×4 區塊
 * 獨立壓縮成 8 或 16 位元組。與其把整條貼圖管線標成「未實作」，不如把
 * 這幾百行寫出來。BC7 與 ASTC 複雜得多，那才是真的該用現成編碼器的地方。
 *
 * ## 涵蓋範圍
 *
 * | 格式 | 用途 | 每像素位元 | 對 RGBA8 |
 * | --- | --- | ---: | ---: |
 * | BC1 | 不透明色彩（albedo） | 4 | 8:1 |
 * | BC4 | 單通道（roughness、AO、height） | 4 | 8:1 |
 * | BC5 | 雙通道（法線的 XY，Z 在 shader 重建） | 8 | 4:1 |
 *
 * 常見的「BC1 是 6:1」指的是對 RGB8（24 bpp）而非 RGBA8（32 bpp）。
 *
 * 這三個加上 BC7（見 bc7.ts）覆蓋桌機的全部需求。本引擎**只支援桌機**，
 * 行動裝置的 ETC2/ASTC 不在範圍內，理由見 specs/roadmap.md。
 */

/** 一個 4×4 區塊有 16 個像素。 */
const BLOCK_PIXELS = 16;

/**
 * 感知加權的色彩距離。
 *
 * 綠色權重最高、藍色最低，因為人眼對綠色的亮度變化最敏感。
 * 用等權重會讓藍色的誤差吃掉綠色的預算，在天空與皮膚上特別明顯。
 */
const WEIGHT_R = 3;
const WEIGHT_G = 4;
const WEIGHT_B = 2;

/**
 * 把 8 位元通道量化成 n 位元，取「展開回 8 位元後最接近原值」的那一個。
 *
 * **不能用位元截斷**（`v >> 3`）。展開是位元複製而非補零，所以截斷不等於
 * 最近值：200 截斷成 5 位元是 25，展開回來是 206（差 6）；但 24 展開回來
 * 是 198，只差 2。截斷在整條值域上系統性偏低，純色區塊尤其明顯。
 *
 * > 這是被 ETC2 的純色測試抓到的（誤差 4.33，超出預期）。BC1 的 `to565`
 * > 原本有完全相同的寫法，一併修正。
 */
export function quantiseChannel(value: number, bits: number): number {
  const levels = (1 << bits) - 1;
  return Math.round((value * levels) / 255);
}

function to565(r: number, g: number, b: number): number {
  return (quantiseChannel(r, 5) << 11) | (quantiseChannel(g, 6) << 5) | quantiseChannel(b, 5);
}

/** 從 565 還原成 8-bit，用位元複製補低位（而非補 0，那會讓白色變成 248）。 */
function from565(value: number, out: Uint8Array, offset: number): void {
  const r5 = (value >> 11) & 0x1f;
  const g6 = (value >> 5) & 0x3f;
  const b5 = value & 0x1f;
  out[offset] = (r5 << 3) | (r5 >> 2);
  out[offset + 1] = (g6 << 2) | (g6 >> 4);
  out[offset + 2] = (b5 << 3) | (b5 >> 2);
}

/**
 * 以包圍盒決定端點，並向內縮一點。
 *
 * 內縮是標準做法：包圍盒的角落通常只有一兩個像素會用到，把端點稍微拉進來
 * 能讓中間兩個內插色更貼近像素的實際分布，整體誤差反而下降。
 */
function fitEndpoints(
  block: Uint8Array,
  minOut: Uint8Array,
  maxOut: Uint8Array,
  applyInset: boolean,
): void {
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;

  for (let i = 0; i < BLOCK_PIXELS; i++) {
    const r = block[i * 4]!;
    const g = block[i * 4 + 1]!;
    const b = block[i * 4 + 2]!;
    if (r < minR) minR = r;
    if (g < minG) minG = g;
    if (b < minB) minB = b;
    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;
  }

  const lo = [minR, minG, minB];
  const hi = [maxR, maxG, maxB];
  selectDiagonal(block, 3, lo, hi);

  for (let c = 0; c < 3; c++) {
    // 對角線可能被反轉，range 因此可能是負的；除法取整保留正負號，
    // 兩端才會各自往「對方」的方向縮
    const inset = applyInset ? (hi[c]! - lo[c]!) / 16 : 0;
    const step = inset < 0 ? Math.ceil(inset) : Math.floor(inset);
    minOut[c] = Math.max(0, Math.min(255, lo[c]! + step));
    maxOut[c] = Math.max(0, Math.min(255, hi[c]! - step));
  }
}

/**
 * 校正端點的對角線方向。
 *
 * 包圍盒給出的是 `(minR, minG, minB) → (maxR, maxG, maxB)` 這條對角線，
 * 但區塊裡的顏色不必然沿著這個方向分布。最典型的反例是「紅升綠降」的
 * 漸層：資料其實躺在另一條對角線上，硬用包圍盒對角線會讓**每一個**
 * 內插點都偏離，而不只是端點不準。
 *
 * 做法是取分布最廣的通道當參考軸，其餘通道與它算共變異數；為負代表
 * 反相關，把該通道的 lo/hi 對調。這是 stb_dxt 的 `SelectDiagonal` 手法。
 *
 * > 這個修正是被 BC7 的漸層測試抓出來的 —— 原本 BC7 在「紅升綠降」漸層上的
 * > 平均誤差是 2.65/255，加上對角線校正之後降到 0.651/255。BC1 有完全相同的
 * > 弱點，因此一併修。**兩個編碼器的輸出都因此改變**（cook 雜湊會變）。
 */
export function selectDiagonal(
  block: Uint8Array,
  channels: number,
  lo: number[],
  hi: number[],
): void {
  let axis = 0;
  let widest = -1;
  for (let c = 0; c < channels; c++) {
    const spread = hi[c]! - lo[c]!;
    if (spread > widest) {
      widest = spread;
      axis = c;
    }
  }
  if (widest <= 0) return; // 單色區塊，沒有方向可言

  const centre: number[] = [];
  for (let c = 0; c < channels; c++) centre.push((lo[c]! + hi[c]!) / 2);

  for (let c = 0; c < channels; c++) {
    if (c === axis) continue;
    let covariance = 0;
    for (let i = 0; i < BLOCK_PIXELS; i++) {
      covariance += (block[i * 4 + c]! - centre[c]!) * (block[i * 4 + axis]! - centre[axis]!);
    }
    if (covariance < 0) {
      const swap = lo[c]!;
      lo[c] = hi[c]!;
      hi[c] = swap;
    }
  }
}

const scratchMin = new Uint8Array(3);
const scratchMax = new Uint8Array(3);
const scratchPalette = new Uint8Array(4 * 3);

/**
 * 編碼一個 BC1 區塊（8 位元組）。
 *
 * 佈局：`color0(u16) color1(u16) indices(u32)`，全部小端序。
 * `color0 > color1` 時是四色模式（兩個端點 + 兩個 1/3、2/3 內插）。
 */
/**
 * 給定一對端點，建立調色盤、指派索引，回傳總誤差。
 *
 * 端點是引數而非固定值，因為編碼器要比較多組候選（見 encodeBc1Block）。
 */
function evaluateEndpoints(
  block: Uint8Array,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
): { c0: number; c1: number; indices: number; error: number } {
  let c0 = to565(hi[0]!, hi[1]!, hi[2]!);
  let c1 = to565(lo[0]!, lo[1]!, lo[2]!);

  // 四色模式需要 c0 > c1。相等時整個區塊是單色，索引全 0 即可。
  if (c0 < c1) {
    const swap = c0;
    c0 = c1;
    c1 = swap;
  }

  from565(c0, scratchPalette, 0);
  from565(c1, scratchPalette, 3);
  for (let channel = 0; channel < 3; channel++) {
    const a = scratchPalette[channel]!;
    const b = scratchPalette[3 + channel]!;
    // 2/3 a + 1/3 b 與 1/3 a + 2/3 b
    scratchPalette[6 + channel] = (a * 2 + b) / 3;
    scratchPalette[9 + channel] = (a + b * 2) / 3;
  }

  let indices = 0;
  let total = 0;
  for (let i = 0; i < BLOCK_PIXELS; i++) {
    const r = block[i * 4]!;
    const g = block[i * 4 + 1]!;
    const b = block[i * 4 + 2]!;

    let best = 0;
    let bestError = Infinity;
    for (let p = 0; p < 4; p++) {
      const dr = r - scratchPalette[p * 3]!;
      const dg = g - scratchPalette[p * 3 + 1]!;
      const db = b - scratchPalette[p * 3 + 2]!;
      const error = dr * dr * WEIGHT_R + dg * dg * WEIGHT_G + db * db * WEIGHT_B;
      if (error < bestError) {
        bestError = error;
        best = p;
      }
    }
    indices |= best << (i * 2);
    total += bestError;
  }
  return { c0, c1, indices, error: total };
}

export function encodeBc1Block(block: Uint8Array, out: Uint8Array, outOffset: number): void {
  // 內縮與不內縮都試，取誤差較低的那組。
  //
  // 內縮對「顏色連續分布」的區塊是對的（角落只有一兩個像素用得到），
  // 但對「只有兩種極端顏色」的區塊是災難：純黑白邊緣的端點被往內拉 15，
  // 每個像素就固定差 15。這種區塊在 UI、文字、遮罩上非常常見。
  //
  // 成本只是多一次索引搜尋，而且兩個候選共用同一組誤差度量，
  // 所以「挑誤差較小的」在定義上不會比單獨用任一個差。
  fitEndpoints(block, scratchMin, scratchMax, true);
  const inset = evaluateEndpoints(block, scratchMin, scratchMax);
  fitEndpoints(block, scratchMin, scratchMax, false);
  const plain = evaluateEndpoints(block, scratchMin, scratchMax);
  const { c0, c1, indices } = inset.error <= plain.error ? inset : plain;

  out[outOffset] = c0 & 0xff;
  out[outOffset + 1] = (c0 >> 8) & 0xff;
  out[outOffset + 2] = c1 & 0xff;
  out[outOffset + 3] = (c1 >> 8) & 0xff;
  out[outOffset + 4] = indices & 0xff;
  out[outOffset + 5] = (indices >>> 8) & 0xff;
  out[outOffset + 6] = (indices >>> 16) & 0xff;
  out[outOffset + 7] = (indices >>> 24) & 0xff;
}

const scratchAlpha = new Uint8Array(8);

/**
 * 編碼一個 BC4 區塊（8 位元組，單通道）。
 *
 * 佈局：`r0(u8) r1(u8) indices(48 bits)`。
 * `r0 > r1` 時是八值模式（兩個端點 + 六個內插）；否則是六值模式並保留 0 與 255。
 * 這裡一律用八值模式：精度較高，而我們不需要保留純黑純白。
 */
export function encodeBc4Block(
  block: Uint8Array,
  channelOffset: number,
  stride: number,
  out: Uint8Array,
  outOffset: number,
): void {
  let min = 255;
  let max = 0;
  for (let i = 0; i < BLOCK_PIXELS; i++) {
    const value = block[i * stride + channelOffset]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  // 八值模式要求 r0 > r1；整個區塊同值時退化成單一顏色，索引全 0
  const r0 = max;
  const r1 = min;

  scratchAlpha[0] = r0;
  scratchAlpha[1] = r1;
  if (r0 > r1) {
    for (let i = 1; i < 7; i++) scratchAlpha[i + 1] = ((7 - i) * r0 + i * r1) / 7;
  } else {
    for (let i = 1; i < 5; i++) scratchAlpha[i + 1] = ((5 - i) * r0 + i * r1) / 5;
    scratchAlpha[6] = 0;
    scratchAlpha[7] = 255;
  }

  out[outOffset] = r0;
  out[outOffset + 1] = r1;

  // 16 個 3-bit 索引 = 48 bits，分兩組 24 bits 寫入
  let low = 0;
  let high = 0;
  for (let i = 0; i < BLOCK_PIXELS; i++) {
    const value = block[i * stride + channelOffset]!;
    let best = 0;
    let bestError = Infinity;
    for (let p = 0; p < 8; p++) {
      const error = Math.abs(value - scratchAlpha[p]!);
      if (error < bestError) {
        bestError = error;
        best = p;
      }
    }
    if (i < 8) low |= best << (i * 3);
    else high |= best << ((i - 8) * 3);
  }

  out[outOffset + 2] = low & 0xff;
  out[outOffset + 3] = (low >>> 8) & 0xff;
  out[outOffset + 4] = (low >>> 16) & 0xff;
  out[outOffset + 5] = high & 0xff;
  out[outOffset + 6] = (high >>> 8) & 0xff;
  out[outOffset + 7] = (high >>> 16) & 0xff;
}

/** 從 RGBA 影像取出一個 4×4 區塊，邊界不足時鉗制座標（不補黑）。 */
export function gatherBlock(
  pixels: Uint8Array,
  width: number,
  height: number,
  blockX: number,
  blockY: number,
  out: Uint8Array,
): void {
  for (let y = 0; y < 4; y++) {
    // 鉗制而非補零：補零會在非 4 倍數尺寸的邊緣產生黑邊
    const sy = Math.min(blockY * 4 + y, height - 1);
    for (let x = 0; x < 4; x++) {
      const sx = Math.min(blockX * 4 + x, width - 1);
      const src = (sy * width + sx) * 4;
      const dst = (y * 4 + x) * 4;
      out[dst] = pixels[src]!;
      out[dst + 1] = pixels[src + 1]!;
      out[dst + 2] = pixels[src + 2]!;
      out[dst + 3] = pixels[src + 3]!;
    }
  }
}

export function blocksFor(width: number, height: number): { x: number; y: number } {
  return { x: Math.max(1, Math.ceil(width / 4)), y: Math.max(1, Math.ceil(height / 4)) };
}

/** 整張影像編碼成 BC1。輸入為 RGBA8。 */
export function encodeBc1(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const blocks = blocksFor(width, height);
  const out = new Uint8Array(blocks.x * blocks.y * 8);
  const block = new Uint8Array(BLOCK_PIXELS * 4);

  let offset = 0;
  for (let by = 0; by < blocks.y; by++) {
    for (let bx = 0; bx < blocks.x; bx++) {
      gatherBlock(pixels, width, height, bx, by, block);
      encodeBc1Block(block, out, offset);
      offset += 8;
    }
  }
  return out;
}

/**
 * 整張影像編碼成 BC5（兩個 BC4 區塊：R 與 G）。
 *
 * 法線貼圖用這個格式：只存 X 與 Y，Z 在 shader 用
 * `z = sqrt(1 - x² - y²)` 重建。比起把三個通道塞進 BC1，
 * 這樣的精度高得多，而且不會有 BC1 對綠色通道的偏誤。
 */
export function encodeBc5(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const blocks = blocksFor(width, height);
  const out = new Uint8Array(blocks.x * blocks.y * 16);
  const block = new Uint8Array(BLOCK_PIXELS * 4);

  let offset = 0;
  for (let by = 0; by < blocks.y; by++) {
    for (let bx = 0; bx < blocks.x; bx++) {
      gatherBlock(pixels, width, height, bx, by, block);
      encodeBc4Block(block, 0, 4, out, offset); // R → X
      encodeBc4Block(block, 1, 4, out, offset + 8); // G → Y
      offset += 16;
    }
  }
  return out;
}

/** 整張影像編碼成 BC4（單通道，取 R）。 */
export function encodeBc4(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const blocks = blocksFor(width, height);
  const out = new Uint8Array(blocks.x * blocks.y * 8);
  const block = new Uint8Array(BLOCK_PIXELS * 4);

  let offset = 0;
  for (let by = 0; by < blocks.y; by++) {
    for (let bx = 0; bx < blocks.x; bx++) {
      gatherBlock(pixels, width, height, bx, by, block);
      encodeBc4Block(block, 0, 4, out, offset);
      offset += 8;
    }
  }
  return out;
}

// ── 解碼（僅供測試驗證編碼正確性，runtime 由 GPU 解） ──

/**
 * 解碼 BC1 回 RGBA。
 *
 * **runtime 不會用到這個** —— GPU 直接讀壓縮格式。它存在的唯一目的是讓
 * 測試能驗證「編碼後解碼」與原圖的誤差在合理範圍，否則編碼器寫錯了
 * 只會表現成「材質看起來怪怪的」，那種問題極難定位。
 */
export function decodeBc1(data: Uint8Array, width: number, height: number): Uint8Array {
  const blocks = blocksFor(width, height);
  const out = new Uint8Array(width * height * 4);
  const palette = new Uint8Array(4 * 3);

  let offset = 0;
  for (let by = 0; by < blocks.y; by++) {
    for (let bx = 0; bx < blocks.x; bx++) {
      const c0 = data[offset]! | (data[offset + 1]! << 8);
      const c1 = data[offset + 2]! | (data[offset + 3]! << 8);
      const indices =
        data[offset + 4]! |
        (data[offset + 5]! << 8) |
        (data[offset + 6]! << 16) |
        (data[offset + 7]! << 24);

      from565(c0, palette, 0);
      from565(c1, palette, 3);
      for (let channel = 0; channel < 3; channel++) {
        const a = palette[channel]!;
        const b = palette[3 + channel]!;
        if (c0 > c1) {
          palette[6 + channel] = (a * 2 + b) / 3;
          palette[9 + channel] = (a + b * 2) / 3;
        } else {
          palette[6 + channel] = (a + b) / 2;
          palette[9 + channel] = 0;
        }
      }

      for (let i = 0; i < BLOCK_PIXELS; i++) {
        const x = bx * 4 + (i % 4);
        const y = by * 4 + Math.floor(i / 4);
        if (x >= width || y >= height) continue;
        const index = (indices >>> (i * 2)) & 3;
        const dst = (y * width + x) * 4;
        out[dst] = palette[index * 3]!;
        out[dst + 1] = palette[index * 3 + 1]!;
        out[dst + 2] = palette[index * 3 + 2]!;
        out[dst + 3] = 255;
      }
      offset += 8;
    }
  }
  return out;
}

/** 解碼一個 BC4 區塊平面，僅供測試。 */
export function decodeBc4(
  data: Uint8Array,
  width: number,
  height: number,
  blockStride = 8,
  blockOffset = 0,
): Uint8Array {
  const blocks = blocksFor(width, height);
  const out = new Uint8Array(width * height);
  const values = new Uint8Array(8);

  for (let by = 0; by < blocks.y; by++) {
    for (let bx = 0; bx < blocks.x; bx++) {
      const base = (by * blocks.x + bx) * blockStride + blockOffset;
      const r0 = data[base]!;
      const r1 = data[base + 1]!;
      values[0] = r0;
      values[1] = r1;
      if (r0 > r1) {
        for (let i = 1; i < 7; i++) values[i + 1] = ((7 - i) * r0 + i * r1) / 7;
      } else {
        for (let i = 1; i < 5; i++) values[i + 1] = ((5 - i) * r0 + i * r1) / 5;
        values[6] = 0;
        values[7] = 255;
      }

      const low = data[base + 2]! | (data[base + 3]! << 8) | (data[base + 4]! << 16);
      const high = data[base + 5]! | (data[base + 6]! << 8) | (data[base + 7]! << 16);

      for (let i = 0; i < BLOCK_PIXELS; i++) {
        const x = bx * 4 + (i % 4);
        const y = by * 4 + Math.floor(i / 4);
        if (x >= width || y >= height) continue;
        const index = i < 8 ? (low >>> (i * 3)) & 7 : (high >>> ((i - 8) * 3)) & 7;
        out[y * width + x] = values[index]!;
      }
    }
  }
  return out;
}
