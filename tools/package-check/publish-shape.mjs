/**
 * 發布出去的形狀對不對 —— **用生態系自己的尺量，不用我們的判斷**。
 *
 * ## 為什麼要引外面的工具
 *
 * `metadata.mjs` 守的是「欄位在不在」，那是我們自己想得到的規則。而
 * 「`exports` 的條件順序對不對」「宣告檔在四種解析模式下找不找得到」
 * 「tarball 裡有沒有指向不存在的檔案」這一類，規則多、細、而且**會隨著
 * Node 與 TypeScript 改版而變**。自己寫一份等於自己維護一份會過期的規格。
 *
 * `publint` 與 `@arethetypeswrong/cli` 是這個生態系公認的那兩把尺。
 *
 * ## 它們第一次跑就抓到兩個上線中的 bug
 *
 * 兩個都在 `@web-world-engine/cook`，而這個 repo 裡沒有任何東西看得見：
 *
 * | | 症狀 |
 * | --- | --- |
 * | `dist/pipeline.d.ts` 引用 `./texture/ktx2.js`，那個目錄被 build 刪了 | 主進入點的型別在使用者那邊解析失敗 |
 * | `publishConfig` 宣告的 `dist/texture.d.ts` 從來沒被產生過 | `@web-world-engine/cook/texture` 完全沒有型別 |
 *
 * 型別檢查過、lint 過、818 個測試過、25 道畫面關卡過、`package-check`
 * 也過（它驗的是「裝得起來、跑得動」，不是「型別找不找得到」）。
 *
 * ## 一個刻意忽略的規則
 *
 * `cjs-resolves-to-esm`：這三個套件是**純 ESM**。CommonJS 的使用者要用
 * 動態 import。那是決定，不是疏漏 —— 見 `type: module` 與 README 的範圍那節。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../lib/repo-root.mjs';
import { startReport } from '../lib/report.mjs';

const PACKAGES = ['format', 'three', 'cook'];

/** 純 ESM 是決定，不是疏漏。 */
const IGNORED = ['cjs-resolves-to-esm'];

const { check, note, finish } = startReport('發布出去的形狀：publint 與 are-the-types-wrong');

const run = (cmd, args, cwd) => {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      }),
    };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

/** 把 ANSI 顏色與多餘空白剝掉，訊息才讀得懂。 */
const plain = (text) =>
  text
    // eslint-disable-next-line no-control-regex -- 就是要剝掉控制字元
    .replace(/\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ｜ ');

const work = mkdtempSync(join(tmpdir(), 'ww-publish-'));
try {
  for (const name of PACKAGES) {
    const dir = join(ROOT, 'packages', name);

    const lint = run('pnpm', ['exec', 'publint', dir], ROOT);
    check(
      lint.ok,
      `@web-world-engine/${name} 的 package.json 與 tarball（publint）`,
      lint.ok ? undefined : plain(lint.out).slice(0, 400),
    );

    // attw 吃的是打包好的 tarball —— 那才是使用者真正拿到的東西。
    const packed = run('pnpm', ['pack', '--pack-destination', work], dir);
    if (!packed.ok) {
      check(false, `@web-world-engine/${name} 打包得起來`, plain(packed.out).slice(0, 200));
      continue;
    }
    const tarball = readdirSync(work).find((f) => f.includes(name) && f.endsWith('.tgz'));
    if (tarball === undefined) {
      check(false, `@web-world-engine/${name} 的 tarball 找得到`);
      continue;
    }
    const types = run(
      'pnpm',
      ['exec', 'attw', join(work, tarball), '--ignore-rules', ...IGNORED],
      ROOT,
    );
    check(
      types.ok,
      `@web-world-engine/${name} 的型別在四種解析模式下都找得到（attw）`,
      types.ok ? undefined : plain(types.out).slice(0, 400),
    );
  }
  note(`刻意忽略的規則：${IGNORED.join('、')}（純 ESM 是決定）`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

finish('發布形狀關卡');
