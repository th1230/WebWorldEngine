import type { BenchmarkReport } from '@ww/diagnostics';
import { COMPARED_METRICS, padDisplay } from './compare.ts';

/**
 * 從多次獨立執行推導回歸門檻。
 *
 * 門檻不該用猜的。猜太鬆會漏掉真的退步，猜太緊會天天誤報然後被所有人忽略 ——
 * 後者比沒有門檻更糟，因為它會訓練大家忽略紅燈。
 *
 * 正確的做法是量「同樣的程式碼跑兩次會差多少」，再把門檻設在那之上。
 */

export interface VarianceRow {
  scene: string;
  metric: string;
  samples: number;
  median: number;
  /** 所有樣本相對於中位數的最大偏離百分比。 */
  maxDeviationPct: number;
  /**
   * 執行序與數值的 Spearman 等級相關係數，範圍 [-1, 1]。
   * 接近 ±1 代表數值隨時間單調變化，也就是**漂移**而非雜訊。
   */
  trend: number;
  /** true 代表這一項是系統性漂移，不該拿來推導門檻。 */
  drifting: boolean;
  /** 依時間排序（舊 → 新）的樣本值。 */
  values: number[];
}

export interface VarianceReport {
  runs: number;
  rows: VarianceRow[];
  /** 漂移項目，需要修根因而不是調門檻。 */
  drifting: VarianceRow[];
  /** 真正的隨機散布中最差的一項。 */
  worst: VarianceRow | null;
  /** 建議門檻：最差**非漂移**偏離 × 2，向上取整到 5 的倍數。 */
  suggestedThresholdPct: number;
  warnings: string[];
}

const SAFETY_FACTOR = 2;
const MIN_THRESHOLD_PCT = 10;

/**
 * |ρ| 超過這個值就視為漂移。
 *
 * n=5 時完全單調的序列 ρ = ±1.0；0.9 允許一個相鄰的小逆序。
 */
const DRIFT_RHO = 0.9;

/**
 * Spearman 等級相關係數：執行序與數值之間的單調關聯。
 *
 * 為什麼需要這個：原本的實作只算「相對中位數的最大偏離」，那個數字無法區分
 * 「上下亂跳 30%」與「一路單調爬升 30%」。兩者的意義完全不同 ——
 * 前者是量測雜訊，調整門檻是合理的；後者是**環境在變**（散熱、快取累積），
 * 放寬門檻只會把問題藏起來，而且漂移遲早會走出任何固定門檻。
 */
export function spearmanTrend(values: readonly number[]): number {
  const n = values.length;
  if (n < 3) return 0;

  const ranked = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(n);
  for (let i = 0; i < n;) {
    // 相同數值取平均等級，否則並列會讓 ρ 失真
    let j = i;
    while (j + 1 < n && ranked[j + 1]!.value === ranked[i]!.value) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[ranked[k]!.index] = averageRank;
    i = j + 1;
  }

  const meanRank = (n + 1) / 2;
  let numerator = 0;
  let denomIndex = 0;
  let denomRank = 0;
  for (let i = 0; i < n; i++) {
    const di = i + 1 - meanRank;
    const dr = ranks[i]! - meanRank;
    numerator += di * dr;
    denomIndex += di * di;
    denomRank += dr * dr;
  }
  const denominator = Math.sqrt(denomIndex * denomRank);
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * @param runs 每個元素是一次完整執行的所有場景報告。
 */
export function analyzeVariance(runs: readonly (readonly BenchmarkReport[])[]): VarianceReport {
  const warnings: string[] = [];
  if (runs.length < 2) {
    return {
      runs: runs.length,
      rows: [],
      drifting: [],
      worst: null,
      suggestedThresholdPct: MIN_THRESHOLD_PCT,
      warnings: ['至少需要兩次執行才能推導門檻'],
    };
  }
  if (runs.length < 4) {
    warnings.push(`只有 ${runs.length} 次執行，推導出的門檻信心有限；建議累積 5 次以上`);
  }

  const scenes = [...new Set(runs.flatMap((run) => run.map((r) => r.scene)))].sort();
  const rows: VarianceRow[] = [];

  for (const scene of scenes) {
    for (const metric of COMPARED_METRICS) {
      const values: number[] = [];
      for (const run of runs) {
        const report = run.find((r) => r.scene === scene);
        if (report === undefined) continue;
        const value = metric.get(report);
        if (value !== null && Number.isFinite(value)) values.push(value);
      }
      if (values.length < 2) continue;

      const median = medianOf(values);
      // 低於噪音下限的指標不參與推導：它們的百分比只是計時器量化誤差
      if (median < metric.minAbsolute) continue;

      const maxDeviationPct = (Math.max(...values.map((v) => Math.abs(v - median))) / median) * 100;
      const trend = spearmanTrend(values);
      // 只有夠大的偏離才值得標成漂移；1% 的單調變化沒有實務意義
      const drifting = Math.abs(trend) >= DRIFT_RHO && maxDeviationPct >= 5;

      rows.push({
        scene,
        metric: metric.name,
        samples: values.length,
        median,
        maxDeviationPct,
        trend,
        drifting,
        values,
      });
    }
  }

  rows.sort((a, b) => b.maxDeviationPct - a.maxDeviationPct);
  const drifting = rows.filter((row) => row.drifting);
  // 門檻只能由真正的隨機散布推導。漂移項目要修根因，任何固定門檻遲早都會被走出去。
  const scatter = rows.filter((row) => !row.drifting);
  const worst = scatter[0] ?? null;
  const suggested =
    worst === null
      ? MIN_THRESHOLD_PCT
      : Math.max(MIN_THRESHOLD_PCT, Math.ceil((worst.maxDeviationPct * SAFETY_FACTOR) / 5) * 5);

  if (drifting.length > 0) {
    warnings.push(
      `${drifting.length} 項指標呈現單調漂移，代表量測環境本身在變（散熱、快取累積），已排除在門檻推導之外`,
    );
  }

  return { runs: runs.length, rows, drifting, worst, suggestedThresholdPct: suggested, warnings };
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export function formatVariance(report: VarianceReport, currentThresholdPct: number): string {
  const lines: string[] = [];

  if (report.rows.length === 0) {
    return [`可用執行次數：${report.runs}`, ...report.warnings.map((w) => `注意：${w}`)].join('\n');
  }

  lines.push(`依 ${report.runs} 次獨立執行推導（同一台機器、相同設定，樣本由舊到新）`);

  if (report.drifting.length > 0) {
    lines.push('');
    lines.push('■ 系統性漂移 —— 數值隨時間單調變化，不是雜訊');
    lines.push(
      padDisplay('場景', 30) +
        padDisplay('指標', 20) +
        padDisplay('變化', 10) +
        '樣本值（舊 → 新）',
    );
    lines.push('-'.repeat(94));
    for (const row of report.drifting) {
      const direction = row.trend > 0 ? '↑' : '↓';
      lines.push(
        padDisplay(row.scene, 30) +
          padDisplay(row.metric, 20) +
          padDisplay(`${direction}${row.maxDeviationPct.toFixed(1)}%`, 10) +
          row.values.map((v) => v.toFixed(1)).join(' → '),
      );
    }
    lines.push('');
    lines.push('  這類項目**無法用門檻處理**：漂移遲早會走出任何固定值。');
    lines.push('  常見成因：散熱累積、驅動快取跨執行殘留、背景負載變化。');
  }

  lines.push('');
  lines.push('■ 隨機散布 —— 可用來推導門檻');
  lines.push(padDisplay('場景', 30) + padDisplay('指標', 20) + padDisplay('偏離', 10) + '樣本值');
  lines.push('-'.repeat(94));

  // 只列出雜訊較大的；其餘都在門檻附近沒有參考價值
  const scatter = report.rows.filter((r) => !r.drifting);
  const notable = scatter.filter((r) => r.maxDeviationPct >= 1).slice(0, 12);
  for (const row of notable) {
    lines.push(
      padDisplay(row.scene, 30) +
        padDisplay(row.metric, 20) +
        padDisplay(`${row.maxDeviationPct.toFixed(1)}%`, 10) +
        row.values.map((v) => v.toFixed(1)).join(', '),
    );
  }
  if (scatter.length > notable.length) {
    lines.push(`… 另有 ${scatter.length - notable.length} 項偏離低於 1%`);
  }

  lines.push('');
  if (report.worst !== null) {
    lines.push(
      `最差散布：${report.worst.maxDeviationPct.toFixed(1)}%（${report.worst.scene} ${report.worst.metric}）`,
    );
  }
  lines.push(`建議門檻：${report.suggestedThresholdPct}%（最差偏離 × ${SAFETY_FACTOR}，取整到 5）`);
  lines.push(`目前門檻：${currentThresholdPct}%`);

  if (report.suggestedThresholdPct > currentThresholdPct) {
    lines.push('');
    lines.push('→ 目前門檻低於雜訊水準，會產生誤報。應調高門檻，或先降低變異。');
  } else if (report.suggestedThresholdPct < currentThresholdPct) {
    lines.push('');
    lines.push('→ 變異已經比門檻小得多，可以把門檻收緊以抓到更小的退步。');
  }

  for (const warning of report.warnings) lines.push(`注意：${warning}`);

  return lines.join('\n');
}
