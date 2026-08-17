import { describe, expect, it } from 'vitest';
import { DEFAULT_FIXED_TIMESTEP, FixedTimestepAccumulator } from './time.ts';

const STEP = 1 / 60;

describe('FixedTimestepAccumulator', () => {
  it('validates its configuration', () => {
    expect(() => new FixedTimestepAccumulator({ ...DEFAULT_FIXED_TIMESTEP, stepSeconds: 0 })).toThrow();
    expect(
      () => new FixedTimestepAccumulator({ ...DEFAULT_FIXED_TIMESTEP, maxStepsPerFrame: 0 }),
    ).toThrow();
    // maxFrameSeconds 小於一步會讓 simulation 永遠跑不動，這是設定錯誤而非可容忍狀態
    expect(
      () => new FixedTimestepAccumulator({ ...DEFAULT_FIXED_TIMESTEP, maxFrameSeconds: STEP / 2 }),
    ).toThrow();
  });

  it('runs exactly one step when the frame matches the step', () => {
    const acc = new FixedTimestepAccumulator();
    expect(acc.advance(STEP)).toBe(1);
    expect(acc.alpha).toBeCloseTo(0, 10);
  });

  it('accumulates sub-step frames instead of dropping them', () => {
    const acc = new FixedTimestepAccumulator();
    expect(acc.advance(STEP / 2)).toBe(0);
    expect(acc.alpha).toBeCloseTo(0.5, 10);
    expect(acc.advance(STEP / 2)).toBe(1);
    expect(acc.alpha).toBeCloseTo(0, 10);
  });

  it('runs multiple steps to catch up on a slow frame', () => {
    const acc = new FixedTimestepAccumulator();
    expect(acc.advance(STEP * 3)).toBe(3);
    expect(acc.droppedSteps).toBe(0);
  });

  it('caps steps per frame and drops the excess rather than spiralling', () => {
    const acc = new FixedTimestepAccumulator({
      stepSeconds: STEP,
      maxStepsPerFrame: 5,
      maxFrameSeconds: 0.25,
    });

    // 10 秒的暫停：先被 maxFrameSeconds 截成 0.25s（15 步），再被 maxStepsPerFrame 截成 5 步
    const steps = acc.advance(10);
    expect(steps).toBe(5);
    expect(acc.clampedFrames).toBe(1);
    expect(acc.droppedSteps).toBe(10);
    // 關鍵：剩餘時間必須被丟棄，不能留在 accumulator 裡讓下一幀更慢
    expect(acc.alpha).toBeLessThan(1);
  });

  it('does not spiral when every frame is over budget', () => {
    const acc = new FixedTimestepAccumulator({
      stepSeconds: STEP,
      maxStepsPerFrame: 5,
      maxFrameSeconds: 0.25,
    });
    for (let i = 0; i < 1000; i++) {
      expect(acc.advance(0.2)).toBeLessThanOrEqual(5);
    }
    // accumulator 必須維持有界，不得單調成長
    expect(acc.alpha).toBeLessThan(1);
    expect(acc.droppedSteps).toBeGreaterThan(0);
  });

  it('treats negative, NaN and infinite deltas as zero', () => {
    // 這些值代表呼叫端有 bug，不代表「真的過了無限久」。
    // 吞掉它們比讓 NaN 傳染進 accumulator 好 —— NaN 一旦進去就再也出不來。
    const acc = new FixedTimestepAccumulator();
    expect(acc.advance(-1)).toBe(0);
    expect(acc.advance(Number.NaN)).toBe(0);
    expect(acc.advance(Number.POSITIVE_INFINITY)).toBe(0);
    expect(acc.alpha).toBe(0);
    expect(acc.alpha).not.toBeNaN();

    // 壞掉的一幀不該讓後續的正常幀失效
    expect(acc.advance(STEP)).toBe(1);
  });

  it('reset() clears pending time so a teleport does not replay the gap', () => {
    const acc = new FixedTimestepAccumulator();
    acc.advance(STEP * 0.9);
    expect(acc.alpha).toBeGreaterThan(0.5);
    acc.reset();
    expect(acc.alpha).toBe(0);
  });

  it('tracks total steps for budget reporting', () => {
    const acc = new FixedTimestepAccumulator();
    for (let i = 0; i < 60; i++) acc.advance(STEP);
    expect(acc.totalSteps).toBe(60);
    acc.resetStats();
    expect(acc.totalSteps).toBe(0);
  });
});
