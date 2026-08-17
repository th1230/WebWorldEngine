import type { DeviceLostManager } from '@ww/platform-web';
import type { ThreeRenderBackend } from '@ww/render-three';
import type { BenchmarkAssetRegistry } from '../asset-registry.ts';

/**
 * 場景自我檢查的結果。
 *
 * 有些場景量的不是「多快」，而是「對不對」—— device-loss-soak 要驗證的是
 * 每次遺失都真的恢復了。只回報數字而不下判斷，等於要人每次用眼睛看報告，
 * 那種檢查遲早會被略過。
 */
export interface SceneVerdict {
  ok: boolean;
  detail: string;
}

export interface SceneContext {
  backend: ThreeRenderBackend;
  /** 場景可據此驗證恢復流程實際發生過。 */
  deviceLost: DeviceLostManager;
  /** 引擎場景在這裡註冊 AssetId → Three.js 資源的對應。 */
  assets: BenchmarkAssetRegistry;
  params: URLSearchParams;
  /** 正式量測的幀數。相機路徑會用它來規劃一次完整的巡邏。 */
  measureFrames: number;
  aspect: number;
}

export interface BenchmarkScene {
  /**
   * 每幀更新。**只能依賴 frameIndex，不能依賴 wall-clock**，
   * 否則不同速度的機器會看到不同內容，數字不可比較。
   */
  update(frameIndex: number): void;
  /**
   * 提交這一幀。
   *
   * 由場景自己決定走哪條路：引擎場景推進 kernel 並 `backend.submit(frame)`；
   * renderer 層級的 benchmark 則用 `backend.submitRaw(scene, camera)`
   * 直接繪製自備的場景樹。
   */
  render(backend: ThreeRenderBackend): void;
  /** 量測開始前的預編譯。不需要的場景可省略。 */
  precompile?: ((backend: ThreeRenderBackend) => Promise<void>) | undefined;
  /** 視窗大小改變時更新投影。 */
  resize?: ((width: number, height: number) => void) | undefined;
  /** 寫進報告的場景參數，讓每筆數據都能還原當時的設定。 */
  readonly reportParams: Record<string, string | number | boolean>;
  /**
   * 覆寫暖機幀數。
   *
   * 預設會先跑暖機再量測，把 shader 編譯、首次資源上傳排除在外。但有些場景
   * 要量的**正是**那段成本（shader-compile），此時必須設成 0 從第一幀就開始記錄。
   */
  readonly overrideWarmupFrames?: number | undefined;
  /**
   * 量測結束後自我檢查。回傳 `ok: false` 會讓 runner 把這個場景記為失敗。
   * 不做檢查的場景可以不提供。
   */
  readonly verdict?: (() => SceneVerdict) | undefined;
  /** 執行時的限制或降級說明。任何被縮減的覆蓋範圍都要在這裡說出來。 */
  readonly notes: string[];
  dispose(): void;
}

export interface SceneDefinition {
  id: string;
  title: string;
  /** 這個場景要量的是什麼。 */
  measures: string;
  create(ctx: SceneContext): Promise<BenchmarkScene>;
}

/** 讀取數字參數並夾在合理範圍內，避免 URL 參數造成瀏覽器當掉。 */
export function numberParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.floor(floatParam(params, name, fallback, min, max));
}

/**
 * 同上，但**不取整**。
 *
 * `numberParam` 會 `Math.floor`，那對 entity 數、cell 大小這類參數是對的，
 * 對比例類的參數則是靜默的破壞 —— `hysteresis=1.35` 會變成 1，也就是
 * 「功能整個關掉」，而報告裡看起來一切正常。用哪一個必須在呼叫端講清楚。
 */
export function floatParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function boolParam(params: URLSearchParams, name: string, fallback: boolean): boolean {
  const raw = params.get(name);
  if (raw === null) return fallback;
  return raw === '1' || raw === 'true';
}
