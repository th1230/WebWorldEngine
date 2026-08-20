import { QualityTier, hashObject, type CapabilityProfile } from '@ww/core';
import type { MicroBenchmarkResult } from './micro-benchmark.ts';

/**
 * Tier 4 (Experimental Ultra) 永遠不會被自動選中 —— 它會啟用尚未穩定的路徑，
 * 必須是使用者或開發者明確開啟的選擇。自動分類的上限是 Tier 3。
 */
export const AUTO_MAX_TIER: QualityTier = QualityTier.DesktopHigh;

/**
 * 無法量測時的保守預設。
 *
 * 量不到就不能宣稱是高階機器。寧可從 Tier 2 起跳，讓執行期的 Adaptive Quality
 * Manager依實測往上調 —— 由高往下掉會被使用者看見，由低往上升不會。
 */
export const UNMEASURED_TIER: QualityTier = QualityTier.DesktopMedium;

const MIN_STORAGE_BUFFER_BYTES = 128 * 1024 * 1024;
const MIN_TEXTURE_SIZE = 8192;

export interface TierCap {
  tier: QualityTier;
  reason: string;
}

export interface GateResult {
  maxTier: QualityTier;
  /** 實際觸發的封頂規則，依嚴格程度排序。 */
  caps: TierCap[];
  /** 不封頂、但會影響其他子系統的注意事項。 */
  warnings: string[];
}

/**
 * 第一段：硬性能力門檻。
 *
 * 這一段完全不看效能，只看「這台機器缺什麼能力」。缺能力是事實，
 * 不是靠跑分能補回來的。
 */
export function evaluateGates(profile: CapabilityProfile): GateResult {
  const caps: TierCap[] = [];
  const warnings: string[] = [];

  if (profile.backend === 'none') {
    caps.push({ tier: QualityTier.Compatibility, reason: '沒有可用的 GPU backend' });
  }

  if (profile.backend === 'webgl2') {
    caps.push({
      tier: QualityTier.Compatibility,
      reason: 'WebGL2 fallback：規格將其定義為功能降級，不承諾完整功能',
    });
  }

  if (profile.adapter.isFallbackAdapter) {
    caps.push({
      tier: QualityTier.Compatibility,
      reason: '軟體 / fallback adapter（如 SwiftShader）：效能數字不可作為基準',
    });
  }

  if (!profile.compute) {
    caps.push({
      tier: QualityTier.Compatibility,
      reason: '缺少 compute：GPU-driven culling 與 meshlet 路徑無法運作',
    });
  }

  if (!profile.indirectDraw) {
    caps.push({ tier: QualityTier.Entry, reason: '缺少 indirect draw：無法做 GPU 端 draw 壓縮' });
  }

  if (profile.textureCompression.length === 0) {
    caps.push({
      tier: QualityTier.Entry,
      reason: '沒有任何 GPU texture 壓縮格式：未壓縮貼圖會吃光 VRAM',
    });
  }

  if (profile.maxTextureSize < MIN_TEXTURE_SIZE) {
    caps.push({
      tier: QualityTier.Entry,
      reason: `maxTextureSize ${profile.maxTextureSize} 小於 ${MIN_TEXTURE_SIZE}`,
    });
  }

  if (profile.compute && profile.maxStorageBufferSize < MIN_STORAGE_BUFFER_BYTES) {
    caps.push({
      tier: QualityTier.DesktopMedium,
      reason: `maxStorageBufferBindingSize ${profile.maxStorageBufferSize} 過小，放不下大型 instance / meshlet buffer`,
    });
  }

  // timestamp-query 是診斷能力，不是畫質能力。缺了它不該扣畫質，
  // 但 Adaptive Quality Manager 會少掉 GPU 時間這個輸入，必須讓呼叫端知道。
  if (!profile.timestampQueries) {
    warnings.push('缺少 timestamp-query：只能量到 CPU 時間，GPU 時間不可得');
  }

  if (!profile.storageTextures && profile.backend === 'webgpu') {
    warnings.push('缺少 storage texture：virtual texture 與部分後處理路徑需另尋替代');
  }

  const maxTier = caps.reduce<QualityTier>(
    (lowest, cap) => (cap.tier < lowest ? cap.tier : lowest),
    AUTO_MAX_TIER,
  );

  caps.sort((a, b) => a.tier - b.tier);

  return { maxTier, caps, warnings };
}

/**
 * 第二段：把微量測的合成分數映射到層級。
 *
 * 這些門檻是**起始估計值**，必須在第一次 `pnpm bench:baseline` 收集到真實數據後
 * 重新校準。見 specs/01-capability-tier.md。
 */
export function scoreToTier(compositeScore: number): QualityTier {
  if (!Number.isFinite(compositeScore) || compositeScore <= 0) return QualityTier.Compatibility;
  if (compositeScore < 0.15) return QualityTier.Compatibility;
  if (compositeScore < 0.45) return QualityTier.Entry;
  if (compositeScore < 1.0) return QualityTier.DesktopMedium;
  return QualityTier.DesktopHigh;
}

export interface TierDecision {
  tier: QualityTier;
  /** 硬性門檻允許的最高層級。 */
  gateTier: QualityTier;
  /** 微量測建議的層級；量不到時為 null。 */
  scoreTier: QualityTier | null;
  caps: TierCap[];
  warnings: string[];
  /** 決策說明，直接顯示在 diagnostics overlay 上。 */
  reasons: string[];
  /** 快取鍵。adapter、能力或引擎版本任一改變就失效。 */
  cacheKey: string;
}

export interface ClassifyInput {
  profile: CapabilityProfile;
  micro?: MicroBenchmarkResult | null | undefined;
  engineVersion: string;
}

/**
 * 第三段：tier = min(門檻上限, 跑分建議)。
 *
 * 兩者取小值，因為它們回答的是不同問題：門檻回答「能不能」，跑分回答「夠不夠快」。
 * 任一個說不行就是不行。
 */
export function classifyTier(input: ClassifyInput): TierDecision {
  const { profile, micro, engineVersion } = input;
  const gate = evaluateGates(profile);
  const reasons: string[] = [];

  let scoreTier: QualityTier | null = null;
  if (micro != null && micro.reliable) {
    scoreTier = scoreToTier(micro.compositeScore);
    reasons.push(
      `微量測合成分數 ${micro.compositeScore.toFixed(3)}（compute ${micro.computeScore.toFixed(
        2,
      )} / fill ${micro.fillScore.toFixed(2)}）→ Tier ${scoreTier}`,
    );
  } else {
    const why = micro == null ? '未執行' : `不可靠（${micro.notes.join('；') || '原因未記錄'}）`;
    reasons.push(`微量測${why}，改用保守預設 Tier ${UNMEASURED_TIER}`);
  }

  const perfTier = scoreTier ?? UNMEASURED_TIER;
  const tier = Math.min(gate.maxTier, perfTier) as QualityTier;

  reasons.push(`硬性門檻上限 Tier ${gate.maxTier}`);
  for (const cap of gate.caps) reasons.push(`封頂 Tier ${cap.tier}：${cap.reason}`);
  reasons.push(`最終 Tier ${tier} = min(門檻 ${gate.maxTier}, 效能 ${perfTier})`);

  return {
    tier,
    gateTier: gate.maxTier,
    scoreTier,
    caps: gate.caps,
    warnings: gate.warnings,
    reasons,
    cacheKey: buildCacheKey(profile, engineVersion),
  };
}

/**
 * 快取鍵涵蓋 adapter 身分、完整能力集與引擎版本。
 * 換顯卡、換瀏覽器、驅動更新導致 limit 改變、或引擎改版，都會讓舊的分級失效。
 */
export function buildCacheKey(profile: CapabilityProfile, engineVersion: string): string {
  return hashObject({
    engineVersion,
    backend: profile.backend,
    adapter: profile.adapter,
    features: profile.features,
    limits: profile.limits,
  });
}
