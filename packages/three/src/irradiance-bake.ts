/**
 * 把場景烘進一份 `IrradianceVolume`，**分幀**。
 *
 * ## 為什麼與那個類別分開
 *
 * 量過契約的寬度：這裡只用到 `IrradianceVolume` 的 9 個**公開**成員
 * （`baked`、`probeCount`、`nextToBake`、`probePosition`、`setProbe`、
 * `markProbeDone`、`upload`、`texture`、`dispose`），私有的一個都沒碰。
 *
 * 那個寬度就是分不分得開的判準（doctrine 第 29 條）。`instanced-mesh.ts` 裡的
 * HLOD 要借 36 個，所以留在原地；這裡借 9 個而且全部是公開的，所以分開。
 *
 * 分開之後最實際的好處是**它們的相依不一樣**：烘焙要 `CubeCamera`、
 * `WebGLCubeRenderTarget`、非同步讀回；那個類別只要一塊 `Float32Array`。
 * 只想在 Node 裡驗那些 SH 數學的人，不必再拖一整套 renderer 的型別。
 */
import { CubeCamera, DataUtils, HalfFloatType, Vector3, WebGLCubeRenderTarget } from 'three';
import type { Scene, WebGLRenderer } from 'three';
import { projectCubeToSH, type FacePixels } from './cube-sh.ts';
import { readPixelsAsync } from './readback.ts';
import type { ReflectionProbes } from './reflection-probes.ts';
import { type IrradianceVolume } from './irradiance.ts';

export interface IrradianceBakeOptions {
  /**
   * 這一次呼叫最多花多久，毫秒。預設 8。
   *
   * ## 這個預算管的是「發出去」，不是「等回來」
   *
   * 每顆探針要把場景畫六次（cubemap 的六個面）再讀回來。**畫六次只要
   * 0.3 ms，讀回才是大頭** —— 而讀回是非同步的，等它的時候主執行緒是
   * 空的。
   *
   * 所以這個預算計時的是「排命令」那一段：排到超過預算就停手，然後一次
   * 把這一輪發出去的讀回全部等完。實測一輪塞得下約七顆（12 ms 預算），
   * 平均一顆 2.7 ms。
   *
   * 第一版把它寫成「每幀最多花這麼久」，而那時候一顆探針要 37 ms ——
   * 預設 8 ms 的預算每次超出四倍半，這行說明是假的。修法見 roadmap
   * 「烘探針快了 13.7 倍」那一節。
   *
   * 烘的過程中間接光會**逐漸浮現**，那是可以接受、而且看得懂的行為。
   */
  budgetMs?: number;
  /**
   * cubemap 每個面的邊長。預設 16。
   *
   * 探針記的是**低頻**的間接光（SH L1 只有 4 個係數），所以拍很大張沒有
   * 意義 —— 投影完就丟掉了。16 已經遠超 L1 表達得出來的細節。
   *
   * 調小也**幾乎不會變快**：實測面寬 4 與 32（像素差 64 倍）一顆探針的
   * 時間差不到 10%，因為成本在讀回的同步點上，不在像素數上。
   */
  faceSize?: number;
  /**
   * 順便把同一批像素重取樣成反射探針。
   *
   * ## 一次拍攝，兩個產物
   *
   * 這裡已經把 cubemap 的六個面讀回 CPU 了，而讀回正是整件事最貴的一段
   * （一顆 2.7 ms，其中畫只佔 0.3 ms）。反射探針要的是同一批像素的另一種
   * 投影 —— 分開烘的話那 2.7 ms 要付兩次，換不到任何東西。
   *
   * 代價是兩者共用同一組探針位置與同一份過期清單。那是刻意的，見
   * `ReflectionProbes`。
   */
  reflection?: ReflectionProbes;
  /** 近裁面。預設 0.1。 */
  near?: number;
  /** 遠裁面。預設 1000。 */
  far?: number;
}

/**
 * 烘探針，**分幀**。每幀呼叫一次，直到 `volume.baked === volume.probeCount`。
 *
 * ```js
 * const volume = new WW.IrradianceVolume({ min, size, resolution: [16, 4, 16] });
 * // 每幀：
 * if (volume.baked < volume.probeCount) await WW.bakeIrradiance(renderer, scene, volume);
 * ```
 *
 * ## 烘的時候要把「會被間接光照到的東西」留在場景裡
 *
 * 這裡拍的就是**當下的 scene**。所以烘之前該關掉的是會自己發光又會動的
 * 東西（角色、粒子）—— 它們會被烤進靜態的間接光裡，然後永遠留在那裡。
 *
 * 這件事沒辦法自動判斷（哪些算靜態是內容的意思，不是型別的意思），所以
 * 這裡不猜，由呼叫端決定。
 *
 * @returns 這一次烘了幾顆。
 */
/**
 * 烘用的 render target 與 cube camera，照 renderer 與面寬快取。
 *
 * 每次重開的成本與「畫六次」同一個量級 —— 而這個函式每幀都會被呼叫。
 */
const bakeCaches = new WeakMap<
  object,
  Map<number, { target: WebGLCubeRenderTarget; camera: CubeCamera }>
>();

async function bakeCache(
  renderer: WebGLRenderer,
  faceSize: number,
  options: IrradianceBakeOptions,
): Promise<{ target: WebGLCubeRenderTarget; camera: CubeCamera }> {
  let bySize = bakeCaches.get(renderer);
  if (bySize === undefined) {
    bySize = new Map();
    bakeCaches.set(renderer, bySize);
  }
  const existing = bySize.get(faceSize);
  if (existing !== undefined) return existing;

  const isWebGL = (renderer as { isWebGLRenderer?: boolean }).isWebGLRenderer === true;
  const target = isWebGL
    ? new WebGLCubeRenderTarget(faceSize)
    : new (
        (await import('three/webgpu')) as unknown as {
          CubeRenderTarget: new (size: number) => WebGLCubeRenderTarget;
        }
      ).CubeRenderTarget(faceSize);
  // 事後設得動，兩個後端都是 —— 驗過：改成建構時傳入，關卡一條都不會紅。
  target.texture.type = HalfFloatType;
  const camera = new CubeCamera(options.near ?? 0.1, options.far ?? 1000, target);
  const entry = { target, camera };
  bySize.set(faceSize, entry);
  return entry;
}

/**
 * 放掉某個 renderer 的烘焙暫存。烘完之後不再需要就可以呼叫。
 *
 * 不呼叫也不會漏 —— `WeakMap` 會跟著 renderer 一起走。
 */
export function disposeBakeCache(renderer: WebGLRenderer): void {
  const bySize = bakeCaches.get(renderer);
  if (bySize === undefined) return;
  for (const { target } of bySize.values()) target.dispose();
  bakeCaches.delete(renderer);
}

export async function bakeIrradiance(
  renderer: WebGLRenderer,
  scene: Scene,
  volume: IrradianceVolume,
  options: IrradianceBakeOptions = {},
): Promise<number> {
  if (volume.nextToBake() < 0) return 0;

  const budgetMs = options.budgetMs ?? 8;
  const faceSize = options.faceSize ?? 16;

  // ## render target 與 cube camera 要重複用，而且**讀回要一次等完**
  //
  // 第一版逐顆探針呼叫 addon 的 `fromCubeRenderTarget`，而它在自己的迴圈裡
  // 逐面 await —— 六個面就是六次 GPU→CPU 同步。拆開量：
  //
  // | | 時間 |
  // | --- | ---: |
  // | 把場景畫六次 | **0.3 ms** |
  // | 投影＋讀回 | **36.8 ms** |
  //
  // 而且面寬從 4 開到 32（像素多 64 倍）那 36.8 ms 完全不動 —— 它不是在算，
  // 是在等。
  //
  // 所以這裡改成：先把這一輪所有探針的畫與讀回**全部發出去**，最後一次等完
  // 再投影。`readRenderTargetPixelsAsync` 在呼叫的當下就把 readPixels 排進
  // 命令流（進 PBO）並下 fence，所以後面那顆探針重畫同一張 target **不會**
  // 蓋掉前一顆的資料 —— 命令是照順序執行的。
  const cache = await bakeCache(renderer, faceSize, options);
  const { target, camera } = cache;
  const at = new Vector3();
  const isWebGL = (renderer as { isWebGLRenderer?: boolean }).isWebGLRenderer === true;
  const flip = isWebGL ? -1 : 1;
  const faceTexels = faceSize * faceSize * 4;

  const pending: { index: number; faces: FacePixels[]; waits: Promise<unknown>[] }[] = [];
  const started = performance.now();

  // 先把這一輪要烘的挑出來 —— 挑的時候不能就地標記完成（那要等讀回），
  // 所以用一個本地的集合擋掉重複挑到同一顆。
  const claimed = new Set<number>();
  for (;;) {
    const index = volume.nextToBake(claimed);
    if (index < 0) break;
    claimed.add(index);
    volume.probePosition(index, at);
    camera.position.copy(at);
    camera.updateMatrixWorld(true);
    camera.update(renderer, scene);

    const faces: FacePixels[] = [];
    const waits: Promise<unknown>[] = [];
    for (let face = 0; face < 6; face++) {
      if (isWebGL) {
        // 每一顆探針要自己的緩衝 —— 共用的話還沒等到就被下一顆蓋掉。
        const buffer = new Uint16Array(faceTexels);
        faces.push(buffer);
        // **不 await。** 這一行同步把 readPixels 排進命令流，剩下的是等 fence。
        waits.push(
          (
            renderer as unknown as {
              readRenderTargetPixelsAsync: (...args: unknown[]) => Promise<unknown>;
            }
          ).readRenderTargetPixelsAsync(target, 0, 0, faceSize, faceSize, buffer, face),
        );
      } else {
        // ## WebGPU 的讀回有三個坑，全部交給 `readPixelsAsync`
        //
        // 1. 資料是**回傳**的，不是填進傳進去的緩衝。
        // 2. 每列的位元組數被補到 256 的倍數。16 寬的半精度面是 128 位元組，
        //    補完 256 —— **一半的資料是填充**。
        // 3. 列的順序與 WebGL 相反，所以每一面上下顛倒。
        //
        // 前一版只處理了第 1 點。後果是 WebGPU 上的 SH 係數是拿填充與顛倒的
        // 像素投影出來的 —— 而 GI 關卡只驗「兩邊都有間接光」，於是它綠著
        // 過了很久（實測 R−B：WebGL 57.2、WebGPU 85.8，那個差距就是它）。
        const slot = faces.length;
        faces.push(new Uint16Array(0));
        waits.push(
          readPixelsAsync(
            renderer,
            target as unknown as { width: number; height: number },
            0,
            0,
            faceSize,
            faceSize,
            (length) => new Uint16Array(length),
            face,
            // cube 的面在 WebGPU 上與 WebGL 同序 —— 這裡不能翻。
            false,
          ).then((data) => {
            faces[slot] = data as FacePixels;
          }),
        );
      }
    }
    pending.push({ index, faces, waits });

    // 預算只管**發出去**這一段（一顆約 0.3 ms）。等待那一段是非同步的，
    // 不佔主執行緒 —— 拿它去卡預算的話一顆就爆掉，而那正是第一版的問題。
    if (performance.now() - started >= budgetMs) break;
  }

  // 一次等完。六次同步變成一輪一次。
  await Promise.all(pending.flatMap((entry) => entry.waits));

  // ## 解碼看的是**貼圖的型別**，不是哪個 renderer
  //
  // 第一版寫成「WebGL 用 fromHalfFloat、WebGPU 不解碼」，而兩邊的 target 都是
  // HalfFloat —— 於是 WebGPU 那條路把半精度的位元樣式當成數值用，係數變成
  // 24,178（1.0 的半精度位元樣式是 15360），畫面整片爆白。
  //
  // 兩件事本來就沒有關係：翻轉看座標系，解碼看像素怎麼存。
  const decode =
    target.texture.type === HalfFloatType
      ? DataUtils.fromHalfFloat
      : (value: number): number => value;
  const reflection = options.reflection;
  if (reflection !== undefined && reflection.volume !== volume) {
    // 兩份格子不一樣的話，反射會寫到別顆探針的位置上 —— 而症狀是「反射裡
    // 的世界偏了一格」，不是錯誤。所以這裡直接擋掉。
    throw new Error(
      'WW.bakeIrradiance: reflection 的探針體積與傳進來的不是同一個。' +
        '反射探針刻意共用輻照度探針的格子，見 ReflectionProbes。',
    );
  }
  for (const entry of pending) {
    const sh = projectCubeToSH(entry.faces, { faceSize, flip, decode });
    volume.setProbe(entry.index, sh.coefficients);
    // 反射要在 markProbeDone **之前**寫 —— 標記完成之後這一輪就結束了，
    // 而這批面像素只活到這個迴圈結束。
    reflection?.writeTile(entry.index, entry.faces, { faceSize, flip, decode });
    volume.markProbeDone(entry.index);
  }
  const done = pending.length;
  volume.upload();
  reflection?.upload();
  return done;
}
