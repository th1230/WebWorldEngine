import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNS, PROFILES, runsForProfile, type SceneRun } from './run.ts';

const hardware = PROFILES['hardware']!;
const smoke = PROFILES['smoke']!;

const runs: SceneRun[] = [
  {
    id: 'instancing',
    warmup: 120,
    frames: 600,
    params: { count: '200000', spread: '600' },
    smoke: { warmup: 10, frames: 40, params: { count: '2000' } },
  },
  { id: 'plain', warmup: 60, frames: 300 },
];

describe('runsForProfile', () => {
  it('leaves the hardware profile untouched', () => {
    const result = runsForProfile(runs, hardware);
    expect(result[0]).toMatchObject({ warmup: 120, frames: 600, params: { count: '200000' } });
  });

  it('does not hand back the caller’s objects', () => {
    // runner 會在每次執行時改寫這些物件；共用參考會讓第二次執行拿到污染的設定
    const result = runsForProfile(runs, hardware);
    expect(result[0]).not.toBe(runs[0]);
  });

  it('scales the workload down for the smoke profile', () => {
    const result = runsForProfile(runs, smoke);
    expect(result[0]).toMatchObject({ warmup: 10, frames: 40 });
  });

  it('merges smoke params over the defaults instead of replacing them', () => {
    // count 被覆寫，但沒被覆寫的 spread 必須保留
    const result = runsForProfile(runs, smoke);
    expect(result[0]!.params).toEqual({ count: '2000', spread: '600' });
  });

  it('keeps the original values for scenes with no smoke override', () => {
    const result = runsForProfile(runs, smoke);
    expect(result[1]).toMatchObject({ warmup: 60, frames: 300 });
  });
});

describe('DEFAULT_RUNS', () => {
  it('gives every scene that runs in smoke a smoke override', () => {
    // 少一個就會在 CI 上用硬體規模的工作量跑軟體 adapter，然後逾時。
    // 用 profiles 排除在 smoke 之外的場景不受此限 —— 它們根本不會執行。
    for (const run of DEFAULT_RUNS) {
      if (run.profiles !== undefined && !run.profiles.includes('smoke')) continue;
      expect(run.smoke, `${run.label ?? run.id} 缺少 smoke 設定`).toBeDefined();
    }
  });

  it('only excludes a scene from smoke when it cannot run there at all', () => {
    // profiles 是逃生門，很容易被拿來繞過「smoke 跑不過」的場景。
    // 每一筆的理由都必須是**在那個 profile 上無法執行**，不是比較慢或
    // 比較容易失敗。新增之前先分清楚那到底是哪一種。
    //
    // - texture-conformance：SwiftShader 拿不到 WebGPU adapter，
    //   沒有硬體解碼器就沒有裁判。
    // - ab-native-real / ab-ww-real / occlusion-sponza：需要 cook 過的
    //   真實資產，而二進位美術檔不進版控 —— CI 的檔案系統上那些資產
    //   根本不存在。
    const excluded = DEFAULT_RUNS.filter(
      (run) => run.profiles !== undefined && !run.profiles.includes('smoke'),
    ).map((run) => run.label ?? run.id);
    expect(excluded).toEqual([
      'ab-native-real',
      'ab-ww-real',
      'occlusion-sponza',
      'texture-conformance',
    ]);
  });

  it('makes every smoke run cheaper than the hardware run', () => {
    for (const run of DEFAULT_RUNS) {
      const smokeFrames = run.smoke?.frames ?? run.frames;
      expect(smokeFrames, `${run.label ?? run.id}`).toBeLessThanOrEqual(run.frames);
    }
  });

  it('keeps scene labels unique so reports do not collide', () => {
    // shader-compile 跑兩次不同參數，靠 label 區分；重複的 key 會在比對時互相覆蓋
    const labels = DEFAULT_RUNS.map((r) => r.label ?? r.id);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('never lets shader-compile warm up', () => {
    // 這個場景量的就是啟動成本，暖機會把它整個抹掉
    for (const run of DEFAULT_RUNS.filter((r) => r.id === 'shader-compile')) {
      expect(run.warmup).toBe(0);
    }
  });
});

describe('PROFILES', () => {
  it('marks only the hardware profile as a valid performance source', () => {
    expect(hardware.performanceMeaningful).toBe(true);
    expect(smoke.performanceMeaningful).toBe(false);
  });

  it('disables the GPU shader cache on both profiles', () => {
    // 驅動的 shader 磁碟快取會讓「第一次編譯」一輩子只發生一次，
    // 造成同一個場景在不同機器狀態下量到十倍差異
    for (const profile of [hardware, smoke]) {
      expect(profile.args, profile.id).toContain('--disable-gpu-shader-disk-cache');
    }
  });
});
