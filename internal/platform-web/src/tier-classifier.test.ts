import { QualityTier, type CapabilityProfile } from '@ww/core';
import { describe, expect, it } from 'vitest';
import type { MicroBenchmarkResult } from './micro-benchmark.ts';
import {
  AUTO_MAX_TIER,
  UNMEASURED_TIER,
  buildCacheKey,
  classifyTier,
  evaluateGates,
  scoreToTier,
} from './tier-classifier.ts';

function profile(overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return {
    backend: 'webgpu',
    compute: true,
    indirectDraw: true,
    storageTextures: true,
    timestampQueries: true,
    textureCompression: ['bc'],
    maxTextureSize: 16384,
    maxStorageBufferSize: 2 * 1024 * 1024 * 1024,
    maxBindGroups: 4,
    outputHDR: false,
    multiview: false,
    adapter: {
      vendor: 'nvidia',
      architecture: 'ada',
      device: '',
      description: '',
      isFallbackAdapter: false,
    },
    features: ['timestamp-query', 'texture-compression-bc'],
    limits: { maxTextureDimension2D: 16384 },
    failureReason: null,
    ...overrides,
  };
}

function micro(compositeScore: number, reliable = true): MicroBenchmarkResult {
  return {
    computeScore: compositeScore,
    fillScore: compositeScore,
    compositeScore,
    setupMs: 80,
    measuredMs: 120,
    durationMs: 200,
    reliable,
    notes: reliable ? [] : ['測試用的不可靠結果'],
  };
}

describe('scoreToTier', () => {
  it('maps the documented score bands', () => {
    expect(scoreToTier(0.05)).toBe(QualityTier.Compatibility);
    expect(scoreToTier(0.3)).toBe(QualityTier.Entry);
    expect(scoreToTier(0.7)).toBe(QualityTier.DesktopMedium);
    expect(scoreToTier(2.0)).toBe(QualityTier.DesktopHigh);
  });

  it('never auto-selects the experimental tier', () => {
    expect(scoreToTier(1000)).toBe(AUTO_MAX_TIER);
    expect(AUTO_MAX_TIER).toBeLessThan(QualityTier.ExperimentalUltra);
  });

  it('treats garbage scores as the lowest tier', () => {
    expect(scoreToTier(Number.NaN)).toBe(QualityTier.Compatibility);
    expect(scoreToTier(-1)).toBe(QualityTier.Compatibility);
    expect(scoreToTier(0)).toBe(QualityTier.Compatibility);
  });
});

describe('evaluateGates', () => {
  it('allows the auto maximum for a fully capable adapter', () => {
    const gate = evaluateGates(profile());
    expect(gate.maxTier).toBe(AUTO_MAX_TIER);
    expect(gate.caps).toHaveLength(0);
    expect(gate.warnings).toHaveLength(0);
  });

  it('forces Tier 0 for a software adapter', () => {
    const gate = evaluateGates(
      profile({
        adapter: { ...profile().adapter, isFallbackAdapter: true, device: 'SwiftShader' },
      }),
    );
    expect(gate.maxTier).toBe(QualityTier.Compatibility);
  });

  it('forces Tier 0 for the WebGL2 fallback path', () => {
    const gate = evaluateGates(
      profile({
        backend: 'webgl2',
        compute: false,
        indirectDraw: false,
        storageTextures: false,
        maxStorageBufferSize: 0,
      }),
    );
    expect(gate.maxTier).toBe(QualityTier.Compatibility);
    expect(gate.caps.some((c) => c.reason.includes('WebGL2'))).toBe(true);
  });

  it('forces Tier 0 when compute is missing', () => {
    expect(evaluateGates(profile({ compute: false })).maxTier).toBe(QualityTier.Compatibility);
  });

  it('caps at Tier 1 when no texture compression family is available', () => {
    const gate = evaluateGates(profile({ textureCompression: [] }));
    expect(gate.maxTier).toBe(QualityTier.Entry);
  });

  it('caps at Tier 1 for a small maximum texture size', () => {
    expect(evaluateGates(profile({ maxTextureSize: 4096 })).maxTier).toBe(QualityTier.Entry);
  });

  it('caps at Tier 2 for a small storage buffer limit', () => {
    const gate = evaluateGates(profile({ maxStorageBufferSize: 64 * 1024 * 1024 }));
    expect(gate.maxTier).toBe(QualityTier.DesktopMedium);
  });

  it('treats a missing timestamp query as a warning, not a quality cap', () => {
    // 量測能力不該扣畫質 —— 但 Adaptive Quality Manager 會少一個輸入，必須被告知
    const gate = evaluateGates(profile({ timestampQueries: false }));
    expect(gate.maxTier).toBe(AUTO_MAX_TIER);
    expect(gate.caps).toHaveLength(0);
    expect(gate.warnings.some((w) => w.includes('timestamp-query'))).toBe(true);
  });

  it('reports every triggered cap, sorted strictest first', () => {
    const gate = evaluateGates(
      profile({ compute: false, textureCompression: [], maxTextureSize: 2048 }),
    );
    expect(gate.caps.length).toBeGreaterThan(1);
    expect(gate.caps[0]!.tier).toBe(QualityTier.Compatibility);
    expect(gate.maxTier).toBe(QualityTier.Compatibility);
  });
});

describe('classifyTier', () => {
  const engineVersion = '0.0.0-test';

  it('takes the minimum of the capability gate and the measured score', () => {
    const decision = classifyTier({ profile: profile(), micro: micro(2.0), engineVersion });
    expect(decision.tier).toBe(QualityTier.DesktopHigh);
    expect(decision.gateTier).toBe(AUTO_MAX_TIER);
    expect(decision.scoreTier).toBe(QualityTier.DesktopHigh);
  });

  it('lets a slow score pull a capable machine down', () => {
    const decision = classifyTier({ profile: profile(), micro: micro(0.2), engineVersion });
    expect(decision.tier).toBe(QualityTier.Entry);
    expect(decision.gateTier).toBe(AUTO_MAX_TIER);
  });

  it('lets a capability gate override a fast score', () => {
    // 這是最重要的一條：軟體 adapter 就算跑分很快也不能升級，
    // 因為它的數字根本不代表真實硬體。
    const decision = classifyTier({
      profile: profile({ adapter: { ...profile().adapter, isFallbackAdapter: true } }),
      micro: micro(5.0),
      engineVersion,
    });
    expect(decision.tier).toBe(QualityTier.Compatibility);
    expect(decision.scoreTier).toBe(QualityTier.DesktopHigh);
  });

  it('falls back to the conservative tier when no measurement exists', () => {
    const decision = classifyTier({ profile: profile(), micro: null, engineVersion });
    expect(decision.tier).toBe(UNMEASURED_TIER);
    expect(decision.scoreTier).toBeNull();
    expect(decision.reasons.some((r) => r.includes('未執行'))).toBe(true);
  });

  it('ignores an unreliable measurement rather than trusting noise', () => {
    const decision = classifyTier({ profile: profile(), micro: micro(9.0, false), engineVersion });
    expect(decision.tier).toBe(UNMEASURED_TIER);
    expect(decision.scoreTier).toBeNull();
  });

  it('still applies gates when the measurement is unusable', () => {
    const decision = classifyTier({
      profile: profile({ compute: false }),
      micro: null,
      engineVersion,
    });
    expect(decision.tier).toBe(QualityTier.Compatibility);
  });

  it('explains itself well enough to show in the overlay', () => {
    const decision = classifyTier({ profile: profile(), micro: micro(0.2), engineVersion });
    expect(decision.reasons.join('\n')).toContain('最終 Tier');
  });
});

describe('buildCacheKey', () => {
  const v = '1.0.0';

  it('is stable for an identical profile', () => {
    expect(buildCacheKey(profile(), v)).toBe(buildCacheKey(profile(), v));
  });

  it('changes when the engine version changes', () => {
    expect(buildCacheKey(profile(), v)).not.toBe(buildCacheKey(profile(), '1.0.1'));
  });

  it('changes when the adapter changes', () => {
    const other = profile({ adapter: { ...profile().adapter, device: 'other-gpu' } });
    expect(buildCacheKey(profile(), v)).not.toBe(buildCacheKey(other, v));
  });

  it('changes when a driver update alters a limit', () => {
    const other = profile({ limits: { maxTextureDimension2D: 8192 } });
    expect(buildCacheKey(profile(), v)).not.toBe(buildCacheKey(other, v));
  });

  it('changes when the available features change', () => {
    const other = profile({ features: ['texture-compression-bc'] });
    expect(buildCacheKey(profile(), v)).not.toBe(buildCacheKey(other, v));
  });
});
