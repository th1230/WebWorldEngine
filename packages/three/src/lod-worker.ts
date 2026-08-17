import {
  generateLodLevels,
  transferablesOf,
  type GeometryData,
  type LodGenerationOptions,
} from './lod-generation.ts';

/**
 * LOD 產生的 worker 端。
 *
 * 這支檔案是獨立的 chunk：打包工具看到 `new Worker(new URL(…))` 會把它與
 * 它的相依（meshoptimizer，含內嵌的 WASM，約 55 KB）切出去。**沒用到自動
 * LOD 的專案不會下載它** —— 那正是「用了更好，不用也能動」在下載量上的
 * 具體樣子。
 */

export interface LodRequest {
  id: number;
  source: GeometryData;
  options: LodGenerationOptions;
}

export type LodResponse =
  | {
      id: number;
      ok: true;
      levels: Awaited<ReturnType<typeof generateLodLevels>>;
      /** 在 worker 這一側花掉的時間。主執行緒要能回答「這段時間是誰花的」。 */
      elapsedMs: number;
    }
  | { id: number; ok: false; error: string };

/** worker 啟動後的第一則訊息。見 `lod-service.ts` 為什麼要有它。 */
export interface LodReady {
  ready: true;
}

// **先報到，再收工作。** 主執行緒在收到這則訊息之前不會把幾何送過來 ——
// 送出去的緩衝區是轉移的，一旦 worker 是死的，資料就跟著沒了，連退回
// 主執行緒重算都做不到。
(self as unknown as Worker).postMessage({ ready: true } satisfies LodReady);

self.addEventListener('message', (event: MessageEvent<LodRequest>) => {
  const { id, source, options } = event.data;
  const started = performance.now();
  generateLodLevels(source, options).then(
    (levels) => {
      const response: LodResponse = {
        id,
        ok: true,
        levels,
        elapsedMs: performance.now() - started,
      };
      // 轉移而不是複製：這些緩衝區在 worker 這一側之後不再用到。
      (self as unknown as Worker).postMessage(response, transferablesOf(levels));
    },
    (error: unknown) => {
      // 靜默失敗會讓使用者以為自己在用強化版。把原因帶回去給主執行緒喊。
      const response: LodResponse = {
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      (self as unknown as Worker).postMessage(response);
    },
  );
});
