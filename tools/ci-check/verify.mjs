/**
 * `.github/` 底下那幾份**從來沒被執行過的程式碼**。
 *
 * ## 為什麼這也要一道關卡
 *
 * workflow 是程式碼，而且是**只有推上去才會跑**的那一種。一個縮排錯誤、
 * 一個打錯的 script 名字，在這台機器上完全沒有徵兆 —— 要等到 push 之後
 * 看 Actions 頁面才知道。
 *
 * ## 判準
 *
 * 只驗這裡驗得到的，不假裝驗得了 GitHub 的執行環境：
 *
 * | | 少了會怎樣 |
 * | --- | --- |
 * | YAML 解析得過 | push 之後 workflow 根本不會啟動，Actions 頁面上只有一行紅字 |
 * | 每個 `pnpm <x>` 都對得到一個 script | 跑到一半才失敗，前面的步驟白跑 |
 * | script 不指名沒進版控的路徑 | 開發機上有、runner 上沒有（真的踩過：`assets/source`） |
 * | **職責不重疊**：CI 驗證、release 發布 | 兩邊都宣稱守著同一件事，其中一個會先漂走 |
 * | **職責不缺漏**：CI 真的驗了每一項 | release 現在完全依賴它 |
 * | 同一棵樹不重跑 | PR 測的就是合併後的樹；main 上再跑一次是零資訊 |
 * | 沒有排程 | `--frozen-lockfile` 讓每週跑出同一個結果 |
 * | CI 有最小權限 | 一個只跑測試的 job 不該有寫入權 |
 *
 * **驗不到的**：runner 上有沒有那個瀏覽器、secret 設了沒、action 的版本存
 * 不存在。那些只有真的推上去才知道 —— 所以第一次 push 還是要去看一眼。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { ROOT } from '../lib/repo-root.mjs';
import { startReport } from '../lib/report.mjs';

const { check, note, finish } = startReport('沒被執行過的那幾份：workflow 與 dependabot');

const allScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
const scripts = new Set(Object.keys(allScripts));

/** git 追蹤的頂層項目。乾淨簽出的 repo 上只有這些。 */
const tracked = new Set(
  execFileSync('git', ['ls-files', '--', ':/'], { cwd: ROOT, encoding: 'utf8' })
    .split(String.fromCharCode(10))
    .map((line) => line.split('/')[0])
    .filter(Boolean),
);
note(`package.json 有 ${scripts.size} 個 script`);

const workflowDir = join(ROOT, '.github/workflows');
const files = readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
check(files.length > 0, '找得到 workflow', files.join('、'));

const parsed = new Map();
for (const name of [
  ...files.map((f) => join(workflowDir, f)),
  join(ROOT, '.github/dependabot.yml'),
]) {
  // `ROOT` 結尾帶斜線（它是 `new URL('../..')` 算出來的），所以不能用
  // 字串切 —— 切多一個字元就把開頭那個點吃掉，變成 `github/…`，
  // 而下面用檔名當鍵去查的地方會全部查不到。
  const shown = relative(ROOT, name).split(sep).join('/');
  try {
    parsed.set(shown, parse(readFileSync(name, 'utf8')));
    check(true, `${shown} 解析得過`);
  } catch (error) {
    check(false, `${shown} 解析得過`, String(error).split('\n')[0]);
  }
}

// ## 每個 `pnpm <x>` 都要對得到一個真的 script
//
// 改名一個 script 而忘了改 workflow，在這裡完全沒有徵兆 —— CI 會跑到那一步
// 才失敗，而前面十分鐘的瀏覽器關卡已經白跑了。
const unknown = [];
const used = new Set();
let calls = 0;
for (const [shown, doc] of parsed) {
  if (doc?.jobs === undefined) continue;
  for (const job of Object.values(doc.jobs)) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      for (const hit of step.run.matchAll(/\bpnpm (?:run )?([a-z][a-z0-9:-]*)/g)) {
        const name = hit[1];
        // pnpm 自己的子指令不是 script
        if (['install', 'exec', 'pack', 'publish', 'add', 'dlx', 'run'].includes(name)) continue;
        calls++;
        if (!scripts.has(name)) unknown.push(`${shown} → pnpm ${name}`);
        else used.add(name);
      }
    }
  }
}
note(`workflow 裡呼叫了 ${calls} 次 pnpm script`);
check(unknown.length === 0, '每個 pnpm script 都存在', unknown.join('、') || undefined);

// ## CI 跑的 script 不可以指名沒進版控的路徑
//
// **這一條是被一條真的紅線逼出來的。** 第一次 push 之後 CI 就掛在
// `pnpm cook -- --verify`：那個 script 寫死了 `assets/source`，而那個目錄是
// Khronos 的第三方樣本、在 `.gitignore` 裡。runner 上根本沒有它。
//
// 上面那條「script 存在」是綠的 —— 它存在，只是在乾淨簽出的 repo 上跑不動。
// 而那件事在開發機上永遠看不到，因為開發機上那個目錄是有的。
const missing = [];
for (const name of used) {
  const command = allScripts[name];
  for (const hit of command.matchAll(/(?:^|\s)((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*-]*)/g)) {
    const candidate = hit[1].replace(/\/$/, '');
    // 只看真的存在於磁碟、但 git 不追蹤的 —— 打錯字的路徑兩邊都沒有，
    // 那是另一種錯，會在別的地方紅。
    if (!existsSync(join(ROOT, candidate))) continue;
    if (tracked.has(candidate.split('/')[0])) continue;
    missing.push(`pnpm ${name} → ${candidate}`);
  }
}
check(
  missing.length === 0,
  'CI 跑的 script 沒有指名沒進版控的路徑',
  missing.join('、') || undefined,
);

// ## 職責分開：CI 驗證，release 發布
//
// 兩邊各自宣稱守著同一件事的話，其中一個一定會先漂走 —— 而職責重疊比職責
// 缺漏更難查，因為兩邊看起來都在做事。
//
// 所以這裡守的是「release **不要**做驗證」，而不是「release 也要驗一遍」。
// 驗證那一邊由 CI 守（下面）。
const release = parsed.get('.github/workflows/release.yml');
const releaseRuns = Object.values(release?.jobs ?? {})
  .flatMap((job) => job.steps ?? [])
  .map((step) => step.run ?? '')
  .join('\n');
const VERIFYING = ['pnpm typecheck', 'pnpm lint', 'pnpm test', 'pnpm format:check'];
const leaked = VERIFYING.filter((one) => releaseRuns.includes(one));
check(leaked.length === 0, 'release 不重跑驗證（那是 CI 的事）', leaked.join('、') || undefined);
// 但**建置**是它的：發出去的 dist 要在這裡產生，不能沿用別人跑的結果。
check(releaseRuns.includes('pnpm build:pkg'), 'release 自己建 dist');

// 反過來，CI 必須真的把該驗的都驗了 —— release 現在完全依賴它。
const ciRuns = Object.values(parsed.get('.github/workflows/ci.yml')?.jobs ?? {})
  .flatMap((job) => job.steps ?? [])
  .map((step) => step.run ?? '')
  .join('\n');
const uncovered = [...VERIFYING, 'pnpm publish-check', 'pnpm bundle-check'].filter(
  (one) => !ciRuns.includes(one),
);
check(uncovered.length === 0, 'CI 驗了每一項', uncovered.join('、') || undefined);
check(
  /--tag/.test(releaseRuns),
  '發布有指定 dist-tag',
  'npm publish 沒給 --tag 一律寫進 latest —— 一個 beta 就會變成所有人的預設',
);
// ## 分支模型：`develop` 做事，合併到 `main` 才發布
//
// 觸發是「push 到 main」而不是 tag，所以**每一次合併都會走到發布那一步**。
// 唯一擋著「同一版被發第二次」的，是先問 registry 有沒有這個版本。
//
// 少了那一段，合併十次就會有九次以「不能覆蓋已發布的版本」失敗 —— 而那時
// 紅的是 main 的 CI，看起來像壞了。
const releaseBranches = release?.on?.push?.branches ?? [];
check(
  releaseBranches.includes('main') && !releaseBranches.includes('develop'),
  '發布只由合併到 main 觸發',
  `branches = ${JSON.stringify(releaseBranches)}`,
);
check(
  /npm view/.test(releaseRuns),
  '已經發布過的版本會跳過',
  '觸發是每次合併，所以沒有這一段的話，版本沒動的合併都會紅',
);

const ci = parsed.get('.github/workflows/ci.yml');
const ciBranches = ci?.on?.push?.branches ?? [];

// ## CI 不在 `main` 上重跑
//
// PR 那一次測的就是合併後的樹，而合併之後 `release.yml` 又會從頭驗一遍。
// 掛在 `main` 上等於同一棵樹跑第三次，而且與 release 同時開兩個 job。
check(
  ciBranches.includes('develop') && !ciBranches.includes('main'),
  'CI 在 develop 上跑，不在 main 上重跑',
  `push branches = ${JSON.stringify(ciBranches)}`,
);
check(
  (ci?.on?.pull_request?.branches ?? []).includes('main'),
  '往 main 的 PR 會跑 CI（那才是合併結果被驗到的地方）',
);

// ## 權限：CI 只讀，release 要寫（發完之後打 tag）
check(
  ci?.permissions?.contents === 'read',
  'CI 是最小權限',
  `contents = ${ci?.permissions?.contents ?? '（沒宣告，會拿到 repo 的預設值）'}`,
);
// ## 不該有排程
//
// 排程跑的是 `--frozen-lockfile`：相依全部鎖死，同一份程式碼每週跑出同一
// 個結果。它偵測不到上游動了 —— 那是 Dependabot 的事。
//
// 這一條反過來守：加回去就是又付一次 runner 時間換零資訊。
check(ci?.on?.schedule === undefined, 'CI 沒有排程（鎖死的相依每週跑出同一個結果）');

finish('CI 設定關卡');
