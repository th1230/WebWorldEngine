/**
 * 兩個後端都走得通的讀回。
 *
 * ## 為什麼要一支共用的
 *
 * WebGL 與 WebGPU 的 `readRenderTargetPixelsAsync` **簽章不一樣**：
 *
 * | | 第 6 個參數 | 資料從哪來 |
 * | --- | --- | --- |
 * | WebGL | 要填的緩衝區 | 填進那個緩衝區 |
 * | WebGPU | `textureIndex` | **回傳** |
 *
 * 把緩衝區丟給 WebGPU 的話它會拿去當索引，`renderTarget.textures[…]` 變成
 * undefined，然後在 backend 深處丟「Invalid value used as weak map key」——
 * 那個訊息完全看不出是參數用錯了。
 *
 * 這**不只是測試工具**：`bakeIrradiance` 就要把 cubemap 的六個面讀回 CPU 做
 * SH 投影，而那條路踩到下面每一個坑 —— 16×16 的半精度面每列 128 位元組，
 * 剛好被補到 256，於是有四分之三的資料是填充；列的順序又是反的，於是每一面
 * 上下顛倒。症狀是「WebGPU 上的間接光跟 WebGL 不一樣」，而那被當成「兩邊都
 * 有間接光」放過去了（實測 R−B：WebGL 57.2、WebGPU 85.8）。
 *
 * 順帶：WebGPU **沒有**同步的 `readRenderTargetPixels`，所以跨後端的量測
 * 一律是非同步的。那不是可以繞過去的。
 */

export interface ReadableTarget {
  width: number;
  height: number;
}

interface ReadbackRenderer {
  isWebGPURenderer?: boolean;
  readRenderTargetPixelsAsync: (...args: unknown[]) => Promise<unknown>;
}

/**
 * 讀一塊像素。回傳的東西是那個 render target 的原生格式（8 位元是
 * `Uint8Array`，半精度是 `Uint16Array`，單精度是 `Float32Array`）——
 * 解碼由呼叫端做，因為只有它知道自己配的是哪一種。
 *
 * @param face cube target 才用得到。
 */
export async function readPixelsAsync(
  renderer: unknown,
  target: ReadableTarget,
  x: number,
  y: number,
  width: number,
  height: number,
  makeBuffer: (length: number) => ArrayLike<number>,
  face = 0,
  /**
   * 把列的順序與 y 的原點調成與 WebGL 一致。**cube 的面要給 false。**
   *
   * 實測出來的不對稱，兩邊各驗過：
   *
   * | 讀什麼 | WebGPU 的列順序 |
   * | --- | --- |
   * | 2D render target | 與 WebGL **相反** |
   * | cube 的一個面 | 與 WebGL **相同** |
   *
   * 給錯的症狀不是壞掉，是**上下顛倒**：接觸陰影會把地面判成天空；SH 投影
   * 會讓垂直方向的分量整個反過來（實測朝上的法線差 126%，而水平的兩個只差
   * 5%）。兩個都不會報錯。
   */
  matchWebGLRows = true,
): Promise<ArrayLike<number>> {
  const api = renderer as ReadbackRenderer;
  if (api.isWebGPURenderer === true) {
    // ## y 的原點是相反的
    //
    // WebGL 的 `readRenderTargetPixels` 從**左下**算 y，WebGPU 的
    // `copyTextureToBuffer` 從**左上**算。所以同一個 y 在兩邊指的是不同的列。
    //
    // 實測（900×600 的遮罩，接觸點在 (393, 243)）：
    //
    // | 讀哪一列 | WebGL | WebGPU |
    // | --- | ---: | ---: |
    // | 243 | 0.098 | 1.000 |
    // | 356（= 599 − 243） | 1.000 | **0.098** |
    //
    // 這個很容易被誤判成「沒問題」：均勻的表面上兩個位置讀到的值一樣，
    // 而我一開始正是拿兩個均勻表面的點驗的，逐位元吻合，於是排除了讀回。
    const flippedY = matchWebGLRows ? target.height - y - height : y;
    const raw = (await api.readRenderTargetPixelsAsync(
      target,
      x,
      flippedY,
      width,
      height,
      0,
      face,
    )) as never;
    return unpad(raw, width, height, matchWebGLRows);
  }
  const buffer = makeBuffer(width * height * 4);
  await api.readRenderTargetPixelsAsync(target, x, y, width, height, buffer, face);
  return buffer;
}

/**
 * 去掉 WebGPU 讀回的**列填充**。
 *
 * WebGPU 的緩衝區複製要求每列的位元組數是 256 的倍數，而 Three 把對齊過的
 * 緩衝區**原樣回傳**（見 `WebGPUTextureUtils.copyTextureToBuffer`：
 * `bytesPerRow = Math.ceil( bytesPerRow / 256 ) * 256`，然後 `return new
 * typedArrayType( buffer )`）。
 *
 * 所以一張 450 寬的 RGBA8 貼圖，每列實際佔 2048 位元組而不是 1800。照
 * `(y * width + x) * 4` 去索引的話每列偏移 248 個位元組 —— 讀出來是**斜的
 * 條紋**。
 *
 * ## 為什麼這個特別難發現
 *
 * **讀單一個 texel 完全正確**（width = 1，沒有第二列）。所以點取樣的比對
 * 逐位元吻合，而整張圖的比對完全對不上 —— 那個組合看起來像「渲染在某些
 * 地方不一樣」，而不像「讀法錯了」。
 *
 * 實測就是這樣被騙的：接觸陰影的兩個取樣點在兩個後端一模一樣，而遮罩的
 * 縮圖完全不同。
 *
 * ## 而且列的順序是反的
 *
 * 同一次量測還發現第二件事：整張讀回來的**列順序與 WebGL 相反**。
 *
 * 兩件事湊在一起會互相抵銷，所以點取樣完全正確：render target 的內容在
 * WebGPU 上本來就是上下顛倒存的，而讀回的原點也是顛倒的 —— 讀同一個 (x, y)
 * 拿到的是同一個 texel。只有整張讀回來時，回傳的順序才是儲存順序。
 *
 * 去掉填充之後把列倒過來，兩個後端的整張圖就逐格吻合。
 */
function unpad(
  raw: { length: number; BYTES_PER_ELEMENT: number; constructor: unknown },
  width: number,
  height: number,
  matchWebGLRows: boolean,
): ArrayLike<number> {
  const bytesPerTexel = raw.BYTES_PER_ELEMENT * 4;
  const bytesPerRow = Math.ceil((width * bytesPerTexel) / 256) * 256;
  const stride = bytesPerRow / raw.BYTES_PER_ELEMENT;
  const tight = width * 4;
  // 單列的讀回沒有第二列，兩個問題都不會發生。
  if (height <= 1) return raw as unknown as ArrayLike<number>;
  const source = raw as unknown as { subarray: (a: number, b: number) => ArrayLike<number> };
  const out = new (raw.constructor as unknown as new (n: number) => {
    set: (v: ArrayLike<number>, at: number) => void;
  })(width * height * 4) as unknown as { set: (v: ArrayLike<number>, at: number) => void };
  for (let row = 0; row < height; row++) {
    // 順便把列順序倒過來 —— 見下面「而且列的順序是反的」。
    const to = matchWebGLRows ? height - 1 - row : row;
    out.set(source.subarray(row * stride, row * stride + tight), to * tight);
  }
  return out as unknown as ArrayLike<number>;
}