import { DEFAULT_THRESHOLD_PCT, compareReports, formatComparison } from './compare.ts';
import { DEFAULT_RUNS, PROFILES, runBenchmarks, type RunProfile, type SceneRun } from './run.ts';
import {
  RESULT_SCHEMA_VERSION,
  machineIdOf,
  readBaseline,
  readComparableResults,
  readLatestResults,
  writeBaseline,
  writeResults,
  type ResultFile,
} from './storage.ts';
import { analyzeVariance, formatVariance } from './variance.ts';

/**
 * 預設每個場景重複 3 次取中位數。
 *
 * run 與 baseline 必須用**相同**的重複次數，否則等於拿一次雜訊很大的量測去比
 * 一個穩定的中位數，比出來的差異多半來自方法而不是程式碼。
 * 快速迭代時可用 `--repeat 1`，但那樣的結果不該拿來當回歸判定。
 */
const DEFAULT_REPEAT = 3;

const USAGE = `
WebWorld Engine — benchmark runner

  pnpm bench                   在真實 GPU 上跑完所有場景（有頭 Chrome）
  pnpm bench:smoke             SwiftShader 煙霧測試（只驗證不壞掉，效能數字無意義）
  pnpm bench:baseline          跑一次並存成這台機器的基準
  pnpm bench:compare           拿最近一次結果與基準比對，退步就以非零離開
  pnpm bench:variance          從歷次執行推導雜訊水準與建議門檻

選項
  --profile <hardware|smoke>   執行 profile（預設 hardware）
  --threshold <percent>        回歸門檻百分比（預設 ${DEFAULT_THRESHOLD_PCT}，由 bench:variance 推導）
  --scene <id[,id]>            只跑指定的場景（逗號分隔，順序仍照 DEFAULT_RUNS）
  --param <k=v[,k=v]>          覆寫場景的 URL 參數（臨時實驗用，不寫進 baseline 的意圖）
  --repeat <n>                 每個場景重複 n 次取中位數（預設 ${DEFAULT_REPEAT}）
                               --repeat 1 適合快速迭代，但不該用來判定回歸
`;

interface Args {
  command: string;
  profile: string;
  threshold: number;
  scene: string | null;
  params: Record<string, string>;
  repeat: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: argv[0] ?? 'run',
    profile: 'hardware',
    threshold: DEFAULT_THRESHOLD_PCT,
    scene: null,
    params: {},
    repeat: 0, // 0 = 未指定，由指令自行決定預設
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--profile' && value !== undefined) {
      args.profile = value;
      i++;
    } else if (flag === '--threshold' && value !== undefined) {
      args.threshold = Number(value);
      i++;
    } else if (flag === '--param' && value !== undefined) {
      for (const pair of value.split(',')) {
        const eq = pair.indexOf('=');
        if (eq <= 0) throw new Error(`--param 需要 k=v 的形式，收到 "${pair}"`);
        args.params[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      i++;
    } else if (flag === '--scene' && value !== undefined) {
      args.scene = value;
      i++;
    } else if (flag === '--repeat' && value !== undefined) {
      args.repeat = Number(value);
      i++;
    }
  }
  return args;
}

function resolveProfile(id: string): RunProfile {
  const profile = PROFILES[id];
  if (profile === undefined) {
    throw new Error(`未知 profile "${id}"。可用：${Object.keys(PROFILES).join(', ')}`);
  }
  return profile;
}

async function doRun(args: Args, defaultRepeat: number): Promise<ResultFile> {
  const profile = resolveProfile(args.profile);
  console.log(`profile: ${profile.id} — ${profile.description}\n`);

  if (!profile.performanceMeaningful) {
    console.log('⚠ 這個 profile 使用軟體 adapter。結果只用於判斷「有沒有壞掉」，不可當效能基準。\n');
  }

  // --scene 只是篩選，不是另一組設定：沿用該場景既有的幀數與 smoke 縮放，
  // 否則單跑一個場景得到的數字會和整輪跑出來的對不起來。
  //
  // 接受逗號分隔的多個場景，**而且保持 DEFAULT_RUNS 的相對順序** ——
  // A/B 對照必須交錯執行，而交錯是由「每一輪都照同一個順序跑一遍」達成的。
  // 若照使用者打字的順序排，`--scene b,a` 就會把配對的兩個拆開。
  let selected: readonly SceneRun[] | null = null;
  if (args.scene !== null) {
    const wanted = args.scene.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const matches = DEFAULT_RUNS.filter(
      (run) => wanted.includes(run.label ?? run.id) || wanted.includes(run.id),
    );
    const unmatched = wanted.filter(
      (name) => !DEFAULT_RUNS.some((run) => (run.label ?? run.id) === name || run.id === name),
    );
    if (unmatched.length > 0) {
      throw new Error(
        `未知場景 "${unmatched.join('", "')}"。可用：${DEFAULT_RUNS.map((r) => r.label ?? r.id).join(', ')}`,
      );
    }
    selected = matches;
  }

  // 覆寫參數是**臨時實驗**用的。它會改變場景的行為，所以帶著它跑出來的
  // 結果不該被當成基準 —— 明確警告，而不是讓人事後才發現數字對不起來。
  if (Object.keys(args.params).length > 0) {
    const applied = Object.entries(args.params).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`⚠ 覆寫參數：${applied}。這組數字與 baseline 不可比較。
`);
    const source = selected ?? DEFAULT_RUNS;
    selected = source.map((run) => ({ ...run, params: { ...run.params, ...args.params } }));
  }

  const outcome = await runBenchmarks({
    profile,
    repeat: args.repeat > 0 ? args.repeat : defaultRepeat,
    ...(selected !== null ? { runs: selected } : {}),
  });

  const file: ResultFile = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    profile: profile.id,
    performanceMeaningful: profile.performanceMeaningful,
    capturedAt: new Date().toISOString(),
    machineId: machineIdOf(outcome.reports),
    reports: outcome.reports,
    failures: outcome.failures,
  };

  const { jsonPath, csvPath } = writeResults(file);
  console.log(`\n結果：${jsonPath}`);
  console.log(`CSV ：${csvPath}`);

  if (outcome.failures.length > 0) {
    console.log(`\n${outcome.failures.length} 個場景失敗：`);
    for (const failure of outcome.failures) console.log(`  - ${failure.scene}: ${failure.error}`);
  }

  return file;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'run': {
      const file = await doRun(args, DEFAULT_REPEAT);
      return file.failures.length > 0 ? 1 : 0;
    }

    case 'baseline': {
      const file = await doRun(args, DEFAULT_REPEAT);
      if (file.failures.length > 0) {
        console.error('\n有場景失敗，不寫入基準 —— 不完整的基準比沒有基準更危險。');
        return 1;
      }
      const target = writeBaseline(file);
      console.log(`\n基準已寫入：${target}`);
      console.log('請把它加入版本控制，之後的 bench:compare 會以它為準。');
      return 0;
    }

    case 'compare': {
      const current = readLatestResults(args.profile);
      if (current === null) {
        console.error(`找不到 profile "${args.profile}" 的結果。請先執行 pnpm bench。`);
        return 1;
      }
      if (current.machineId === null) {
        console.error('結果沒有 machineId，無法對應基準。');
        return 1;
      }

      const baseline = readBaseline(current.machineId);
      if (baseline === null) {
        console.error(
          `這台機器（${current.machineId}）還沒有基準。先執行 pnpm bench:baseline 建立。`,
        );
        return 1;
      }

      const result = compareReports(baseline.reports, current.reports, {
        thresholdPct: args.threshold,
      });
      console.log(formatComparison(result, args.threshold));
      return result.passed ? 0 : 1;
    }

    case 'variance': {
      const latest = readLatestResults(args.profile);
      if (latest?.machineId == null) {
        console.error(`找不到 profile "${args.profile}" 的結果。請先執行 pnpm bench。`);
        return 1;
      }

      const files = readComparableResults(args.profile, latest.machineId);
      const report = analyzeVariance(files.map((f) => f.reports));
      console.log(formatVariance(report, args.threshold));

      // 這是分析工具，不是門檻本身；即使建議值與現值不同也不該讓 CI 失敗
      return 0;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;

    default:
      console.error(`未知指令 "${args.command}"`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
