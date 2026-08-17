import type { CapabilityProfile } from '@ww/core';
import { probeCapabilities, type ProbeOptions } from './capability-probe.ts';
import { runMicroBenchmark, type MicroBenchmarkResult } from './micro-benchmark.ts';
import { loadCachedMeasurement, saveCachedMeasurement } from './tier-cache.ts';
import { buildCacheKey, classifyTier, type TierDecision } from './tier-classifier.ts';

export interface ResolvePlatformOptions extends ProbeOptions {
  /** 引擎版本。改版會讓分級快取失效。 */
  engineVersion: string;
  useCache?: boolean | undefined;
  /** 關掉可以省下開機的 200ms，代價是只能拿到保守的預設層級。 */
  measure?: boolean | undefined;
  microBudgetMs?: number | undefined;
}

export interface PlatformProfile {
  capabilities: CapabilityProfile;
  decision: TierDecision;
  micro: MicroBenchmarkResult | null;
  /** 微量測是否來自快取（代表這次啟動沒有付出量測成本）。 */
  fromCache: boolean;
  elapsedMs: number;
}

/**
 * 啟動流程：探測 → （快取或量測）→ 分類。
 *
 * 這是 app 唯一需要呼叫的入口。回傳的 PlatformProfile 應該存起來供整個 session 使用，
 * 不要每次要用就重跑一次。
 */
export async function resolvePlatformProfile(
  options: ResolvePlatformOptions,
): Promise<PlatformProfile> {
  const started = performance.now();
  const useCache = options.useCache ?? true;
  const measure = options.measure ?? true;

  const capabilities = await probeCapabilities({
    forceWebGL: options.forceWebGL,
    powerPreference: options.powerPreference,
  });

  const cacheKey = buildCacheKey(capabilities, options.engineVersion);

  let micro: MicroBenchmarkResult | null = null;
  let fromCache = false;

  if (useCache) {
    const cached = loadCachedMeasurement(cacheKey);
    if (cached !== null) {
      micro = cached.micro;
      fromCache = true;
    }
  }

  // 沒有 compute 就沒有必要跑微量測 —— 這種機器一定是 Tier 0，量了也不會改變結果
  if (!fromCache && measure && capabilities.compute) {
    micro = await runMicroBenchmark({
      budgetMs: options.microBudgetMs,
      powerPreference: options.powerPreference,
    });
    if (useCache) {
      saveCachedMeasurement({ cacheKey, micro, savedAt: Date.now() });
    }
  }

  const decision = classifyTier({ profile: capabilities, micro, engineVersion: options.engineVersion });

  return {
    capabilities,
    decision,
    micro,
    fromCache,
    elapsedMs: performance.now() - started,
  };
}
