import type { BenchmarkReport } from '@ww/diagnostics';
import { REPORT_SCHEMA_VERSION, reportsToCsv } from '@ww/diagnostics';
import fs from 'node:fs';
import path from 'node:path';
import { BASELINES_DIR, RESULTS_DIR } from './paths.ts';

/** 結果**檔案**的外層結構版本，與報告內容的 REPORT_SCHEMA_VERSION 各自獨立。 */
export const RESULT_SCHEMA_VERSION = 1;

export interface ResultFile {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  profile: string;
  /** false 代表這是 SwiftShader 煙霧測試，數字不可作為基準。 */
  performanceMeaningful: boolean;
  capturedAt: string;
  machineId: string | null;
  reports: BenchmarkReport[];
  failures: Array<{ scene: string; error: string }>;
}

export function machineIdOf(reports: readonly BenchmarkReport[]): string | null {
  return reports[0]?.machineId ?? null;
}

export function writeResults(file: ResultFile): { jsonPath: string; csvPath: string } {
  const dir = path.join(RESULTS_DIR, file.profile);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = file.capturedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `${stamp}.json`);
  const csvPath = path.join(dir, `${stamp}.csv`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  fs.writeFileSync(csvPath, `${reportsToCsv(file.reports)}\n`, 'utf8');
  // latest.json 讓 bench:compare 不必去猜檔名
  fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(file, null, 2)}\n`, 'utf8');

  return { jsonPath, csvPath };
}

/**
 * 讀取這個 profile 底下所有可互相比較的歷史結果。
 *
 * 「可比較」的條件很嚴：同一台機器、同一個報告 schema、場景數量相同。
 * 混入設定不同的舊執行只會讓推導出的雜訊水準虛高，門檻跟著變鬆 ——
 * 那正是我們要避免的事。
 */
export function readComparableResults(profile: string, machineId: string): ResultFile[] {
  const dir = path.join(RESULTS_DIR, profile);
  if (!fs.existsSync(dir)) return [];

  const out: ResultFile[] = [];
  let sceneCount = -1;

  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json') && name !== 'latest.json')
    .sort()
    .reverse(); // 由新到舊，以最近一次的場景組合為準

  for (const name of names) {
    let file: ResultFile;
    try {
      file = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ResultFile;
    } catch {
      continue; // 損毀的檔案略過，不要讓分析整個失敗
    }
    if (file.machineId !== machineId) continue;
    const first = file.reports[0];
    if (first === undefined || first.schemaVersion !== REPORT_SCHEMA_VERSION) continue;
    if (sceneCount === -1) sceneCount = file.reports.length;
    if (file.reports.length !== sceneCount) continue;
    out.push(file);
  }
  // 上面由新到舊走訪（以最近一次的場景組合為準），但回傳要由舊到新：
  // 趨勢分析需要時間順序才分得出「一路爬升」與「上下亂跳」。
  return out.reverse();
}

export function readLatestResults(profile: string): ResultFile | null {
  const file = path.join(RESULTS_DIR, profile, 'latest.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ResultFile;
}

/**
 * 基準依 machineId 分檔。
 *
 * WebGPU 的效能、記憶體上限與 feature 暴露程度都由硬體、瀏覽器與驅動共同決定，
 * 跨機器的數字沒有可比性。用同一份基準去卡別台機器只會產生假警報。
 */
export function baselinePath(machineId: string): string {
  return path.join(BASELINES_DIR, `${machineId}.json`);
}

export function writeBaseline(file: ResultFile): string {
  if (file.machineId === null) throw new Error('沒有 machineId，無法寫入基準');
  if (!file.performanceMeaningful) {
    throw new Error(
      `profile "${file.profile}" 的數字不可作為基準（軟體 adapter）。請用 pnpm bench:baseline 在真實 GPU 上產生。`,
    );
  }
  fs.mkdirSync(BASELINES_DIR, { recursive: true });
  const target = baselinePath(file.machineId);
  fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return target;
}

export function readBaseline(machineId: string): ResultFile | null {
  const file = baselinePath(machineId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ResultFile;
}
