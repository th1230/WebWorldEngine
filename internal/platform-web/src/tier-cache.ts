import type { MicroBenchmarkResult } from './micro-benchmark.ts';

const STORAGE_KEY = 'ww.platform-profile.v1';

/**
 * 快取的是**量測結果**，不是分級決定。
 *
 * 這樣分類邏輯改版時不需要處理陳舊的決策 —— 下次啟動會用快取的量測值
 * 重新跑一次分類，自動套用新邏輯，同時省下 200ms 的重測。
 */
export interface CachedMeasurement {
  cacheKey: string;
  micro: MicroBenchmarkResult | null;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // 無痕模式下存取本身就可能丟例外
    localStorage.getItem(STORAGE_KEY);
    return localStorage;
  } catch {
    return null;
  }
}

export function loadCachedMeasurement(cacheKey: string): CachedMeasurement | null {
  const store = storage();
  if (store === null) return null;

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<CachedMeasurement>;
    if (parsed.cacheKey !== cacheKey) return null;
    if (typeof parsed.savedAt !== 'number') return null;
    return { cacheKey, micro: parsed.micro ?? null, savedAt: parsed.savedAt };
  } catch {
    // 內容損毀就當作沒有快取，不要讓啟動流程因此失敗
    return null;
  }
}

export function saveCachedMeasurement(record: CachedMeasurement): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // 配額用盡或被封鎖；快取只是最佳化，失敗不影響正確性
  }
}

export function clearCachedMeasurement(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
}
