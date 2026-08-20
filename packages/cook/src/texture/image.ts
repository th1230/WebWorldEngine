/**
 * 影像處理：mip 鏈產生與程序化來源貼圖。
 */

export interface Image {
  width: number;
  height: number;
  /** RGBA8，緊密排列。 */
  pixels: Uint8Array;
}

/** sRGB → 線性的查表。逐像素做 pow() 在 2048² 的貼圖上會慢到無法接受。 */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

export type ColorSpace = 'srgb' | 'linear';

/**
 * 產生 mip 鏈，一路降到 1×1。
 *
 * ## sRGB 必須先轉線性再平均
 *
 * sRGB 是非線性編碼。直接對 sRGB 位元組取平均，等於對「感知亮度」取平均，
 * 結果會**比正確答案暗**。半黑半白的區域用錯誤做法得到 128（中灰），
 * 正確做法得到約 188 —— 差異在遠處的樹葉、柵欄這類高頻內容上非常明顯，
 * 遠看會整片發黑。
 *
 * 法線與資料貼圖（roughness、AO）本來就是線性的，不能做這個轉換。
 */
export function generateMipChain(image: Image, colorSpace: ColorSpace): Image[] {
  const chain: Image[] = [image];
  let current = image;

  while (current.width > 1 || current.height > 1) {
    const width = Math.max(1, current.width >> 1);
    const height = Math.max(1, current.height >> 1);
    const pixels = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 2×2 box filter，來源座標鉗制以處理奇數尺寸
        const x0 = Math.min(x * 2, current.width - 1);
        const x1 = Math.min(x * 2 + 1, current.width - 1);
        const y0 = Math.min(y * 2, current.height - 1);
        const y1 = Math.min(y * 2 + 1, current.height - 1);

        const sources = [
          (y0 * current.width + x0) * 4,
          (y0 * current.width + x1) * 4,
          (y1 * current.width + x0) * 4,
          (y1 * current.width + x1) * 4,
        ];
        const dst = (y * width + x) * 4;

        for (let channel = 0; channel < 3; channel++) {
          if (colorSpace === 'srgb') {
            let sum = 0;
            for (const source of sources) sum += SRGB_TO_LINEAR[current.pixels[source + channel]!]!;
            pixels[dst + channel] = linearToSrgb(sum / 4);
          } else {
            let sum = 0;
            for (const source of sources) sum += current.pixels[source + channel]!;
            pixels[dst + channel] = Math.round(sum / 4);
          }
        }
        // alpha 一律線性平均：它是覆蓋率，不是感知亮度
        let alpha = 0;
        for (const source of sources) alpha += current.pixels[source + 3]!;
        pixels[dst + 3] = Math.round(alpha / 4);
      }
    }

    current = { width, height, pixels };
    chain.push(current);
  }

  return chain;
}

/**
 * 重新正規化法線貼圖的每個像素。
 *
 * 縮小後的法線是平均值，長度不再是 1。不重新正規化的話，遠處的光照會
 * 逐漸變暗 —— 那看起來像「LOD 一換就變色」，但根因在 mip 產生。
 */
export function renormalizeNormals(image: Image): void {
  for (let i = 0; i < image.pixels.length; i += 4) {
    const x = (image.pixels[i]! / 255) * 2 - 1;
    const y = (image.pixels[i + 1]! / 255) * 2 - 1;
    const z = (image.pixels[i + 2]! / 255) * 2 - 1;
    const length = Math.hypot(x, y, z) || 1;
    image.pixels[i] = Math.round(((x / length) * 0.5 + 0.5) * 255);
    image.pixels[i + 1] = Math.round(((y / length) * 0.5 + 0.5) * 255);
    image.pixels[i + 2] = Math.round(((z / length) * 0.5 + 0.5) * 255);
  }
}

// ── 程序化來源貼圖 ──

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 以固定種子產生的值雜訊，雙線性內插後可平鋪。 */
function valueNoise(size: number, frequency: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const grid = new Float32Array(frequency * frequency);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();

  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * frequency;
      const fy = (y / size) * frequency;
      const x0 = Math.floor(fx) % frequency;
      const y0 = Math.floor(fy) % frequency;
      const x1 = (x0 + 1) % frequency;
      const y1 = (y0 + 1) % frequency;
      const tx = fx - Math.floor(fx);
      const ty = fy - Math.floor(fy);
      // smoothstep，避免雙線性內插的方格感
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);

      const top = grid[y0 * frequency + x0]! * (1 - sx) + grid[y0 * frequency + x1]! * sx;
      const bottom = grid[y1 * frequency + x0]! * (1 - sx) + grid[y1 * frequency + x1]! * sx;
      out[y * size + x] = top * (1 - sy) + bottom * sy;
    }
  }
  return out;
}

/** 多層疊加的碎形雜訊。 */
function fbm(size: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const noise = valueNoise(size, 4 << octave, seed + octave * 977);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + noise[i]! * amplitude;
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
}

/** 石頭的 albedo：帶雜訊的灰褐色。 */
export function rockAlbedo(size: number, seed: number): Image {
  const noise = fbm(size, 5, seed);
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const n = noise[i]!;
    pixels[i * 4] = Math.round((0.38 + n * 0.34) * 255);
    pixels[i * 4 + 1] = Math.round((0.36 + n * 0.32) * 255);
    pixels[i * 4 + 2] = Math.round((0.33 + n * 0.29) * 255);
    pixels[i * 4 + 3] = 255;
  }
  return { width: size, height: size, pixels };
}

/**
 * 產生 AO + roughness 的雙通道資料貼圖。
 *
 * ## 通道配置：R = AO、G = roughness
 *
 * 這是 glTF 的 ORM 慣例（occlusion / roughness / metallic 依序放 R/G/B），
 * 也是 Three.js 讀取的方式：`aoMap` 取 `.r`、`roughnessMap` 取 `.g`。
 * **沿用慣例而不自創**，同一張貼圖才能直接餵給兩個 map 而不必額外設定。
 *
 * metalness 沒有進來：這批材質都是非金屬（常數 0），為一個到處都是 0 的
 * 通道多付 4 bpp 沒有意義。真的需要時再擴成三通道。
 *
 * 用 BC5（雙通道、各 8 bpp 等效精度）而不是把三個通道塞進 BC1：
 * roughness 的量化階梯在光滑表面上會直接變成可見的亮度分帶。
 */
export function roughnessAo(size: number, seed: number): Image {
  // 兩個獨立的雜訊場：AO 來自大尺度遮蔽，roughness 來自細部表面變化。
  // 用同一個場會讓「凹處剛好都比較粗糙」，看起來很假。
  const occlusion = fbm(size, 3, seed);
  const rough = fbm(size, 5, seed ^ 0x5bf03635);
  const pixels = new Uint8Array(size * size * 4);

  for (let i = 0; i < size * size; i++) {
    // AO 只在凹處變暗，整體偏亮 —— 把 AO 當成一般貼圖來乘會讓場景整片變暗
    pixels[i * 4] = Math.round((0.65 + occlusion[i]! * 0.35) * 255);
    pixels[i * 4 + 1] = Math.round((0.62 + rough[i]! * 0.33) * 255);
    pixels[i * 4 + 2] = 0;
    pixels[i * 4 + 3] = 255;
  }
  return { width: size, height: size, pixels };
}

/**
 * 由高度場產生切線空間法線貼圖。
 *
 * 用 Sobel 取梯度而非中央差分：Sobel 同時做了輕微平滑，
 * 對雜訊高度場產生的法線比較不會有階梯感。
 */
export function heightToNormal(size: number, seed: number, strength = 3): Image {
  const height = fbm(size, 5, seed);
  const pixels = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)]!;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));

      const nx = -dx * strength;
      const ny = -dy * strength;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz);

      const i = (y * size + x) * 4;
      pixels[i] = Math.round(((nx / length) * 0.5 + 0.5) * 255);
      pixels[i + 1] = Math.round(((ny / length) * 0.5 + 0.5) * 255);
      pixels[i + 2] = Math.round(((nz / length) * 0.5 + 0.5) * 255);
      pixels[i + 3] = 255;
    }
  }
  return { width: size, height: size, pixels };
}
