import { describe, expect, it } from 'vitest';
import { baselinePath, machineIdOf, writeBaseline, type ResultFile } from './storage.ts';

function resultFile(overrides: Partial<ResultFile> = {}): ResultFile {
  return {
    schemaVersion: 1,
    profile: 'hardware',
    performanceMeaningful: true,
    capturedAt: '2026-08-15T00:00:00.000Z',
    machineId: 'abc12345',
    reports: [],
    failures: [],
    ...overrides,
  };
}

describe('machineIdOf', () => {
  it('takes the id from the first report', () => {
    const reports = [{ machineId: 'm1' }, { machineId: 'm1' }] as ResultFile['reports'];
    expect(machineIdOf(reports)).toBe('m1');
  });

  it('returns null when there are no reports', () => {
    expect(machineIdOf([])).toBeNull();
  });
});

describe('writeBaseline guards', () => {
  it('refuses to write a software-adapter run as a baseline', () => {
    // SwiftShader 的數字當基準會讓之後每次比對都毫無意義
    expect(() =>
      writeBaseline(resultFile({ profile: 'smoke', performanceMeaningful: false })),
    ).toThrow(/不可作為基準/);
  });

  it('refuses to write without a machineId', () => {
    // 沒有 machineId 就無從對應回這台機器，寫了也找不回來
    expect(() => writeBaseline(resultFile({ machineId: null }))).toThrow(/machineId/);
  });
});

describe('baselinePath', () => {
  it('derives the filename from the machine id', () => {
    // 跨機器數字不可比較，所以基準必須依機器分檔
    expect(baselinePath('abc12345')).toMatch(/abc12345\.json$/);
    expect(baselinePath('abc12345')).not.toBe(baselinePath('def67890'));
  });
});
