/**
 * 打包出來的形狀：只用 WebGL 的人不該下載 WebGPU 那一半。
 *
 * ## 這道關卡守的是一句被講了十幾次、卻從來沒被量過的話
 *
 * `three/tsl` 與 `three/webgpu` 只有 node 材質那條路用得到。套件裡每一個
 * node 實作都寫著「所以這裡用動態 import」——`sky.ts`、`water-surface.ts`、
 * `irradiance.ts`、`lod-fade-node.ts`…… 十幾處，理由都一樣。
 *
 * 而那句話**沒有任何東西守著**。哪天有人把其中一個改成靜態 import，每一個
 * 只用 WebGL 的使用者都會多下載一整包 TSL —— 而 typecheck、lint、八百多個
 * 單元測試、十七道畫面關卡沒有一個看得到，因為畫面完全正確。
 *
 * 那正是這個專案最怕的形狀：**壞掉的東西不會報錯，只會變慢變胖**。
 *
 * ## 判準
 *
 * | 主張 | 怎麼量 |
 * | --- | --- |
 * | 進入點只靜態依賴 `three` | 讀 `dist/index.js` 的 import，只能有 `three` |
 * | node 那條路是分開的檔案 | `three/tsl` 只出現在被動態 import 的 chunk 裡 |
 * | 分包沒有整包失效 | `three/tsl` 在產物裡仍然是動態 import，沒有被內聯 |
 *
 * 第三條是為了擋「動態 import 還在、但打包器把它 inline 回去了」——
 * 那種情況前兩條都還是綠的（tsl 變成沒有 import 的內聯程式碼）。
 *
 * 第一版的第三條問的是「進入點佔總體積的比例」，門檻 70% —— 那個數字是
 * **猜的**，而量出來是 79%：進入點本來就裝著整個 WebGL 實作，佔多數是
 * 對的。問錯了問題，所以換成直接問那些 chunk 在不在。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertDistFresh } from '../lib/dist-fresh.mjs';
import { startReport } from '../lib/report.mjs';
import { ROOT } from '../lib/repo-root.mjs';

const dist = join(ROOT, 'packages/three/dist');

// 這道關卡吃的是 `packages/three/dist`，不是 example 的產物。
assertDistFresh(ROOT, ['packages/three/src'], 'packages/three/dist');

const { check, finish } = startReport('打包的形狀：WebGL 那條路不該拖到 WebGPU 的東西');

/** 一個檔案靜態 import 了哪些外部模組（相對路徑不算）。 */
function staticImports(file) {
  const source = readFileSync(file, 'utf8');
  const found = new Set();
  for (const match of source.matchAll(
    /(?:^|[;}\s])(?:import|export)[^;]*?from\s*["']([^"']+)["']/g,
  )) {
    if (!match[1].startsWith('.')) found.add(match[1]);
  }
  // 沒有 from 的那種：`import "x"`
  for (const match of source.matchAll(/(?:^|[;}\s])import\s*["']([^"']+)["']/g)) {
    if (!match[1].startsWith('.')) found.add(match[1]);
  }
  return found;
}

const entry = join(dist, 'index.js');
const entryImports = [...staticImports(entry)].sort();
console.log(`  進入點靜態 import：${entryImports.join('、') || '（無）'}`);
check(
  entryImports.length === 1 && entryImports[0] === 'three',
  `進入點只依賴 three —— 多出來的是 ${entryImports.filter((x) => x !== 'three').join('、') || '沒有'}`,
);

// ## `three/tsl` 只能出現在動態載入的 chunk 裡
//
// 進入點乾淨還不夠：它可能靜態 import 了一個 chunk，而那個 chunk 才拉 tsl。
// 所以從進入點沿著相對 import 走一遍，看得到的全部都算「一定會下載」。
function reachable(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(
    /(?:^|[;}\s])(?:import|export)[^;]*?from\s*["'](\.[^"']+)["']/g,
  )) {
    const next = join(dist, match[1]);
    try {
      if (statSync(next).isFile()) reachable(next, seen);
    } catch {
      // 走不到就算了 —— 那是打包器自己的檔名，下一條會抓到真正的問題。
    }
  }
  return seen;
}

const allJs = readdirSync(dist)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(dist, f));
const eager = reachable(entry);
const eagerNames = [...eager].map((f) => f.slice(dist.length + 1));
console.log(`  一定會下載的 chunk：${eagerNames.length} 個`);

const webgpuOnly = ['three/tsl', 'three/webgpu'];
const leaked = [];
for (const file of eager) {
  for (const one of staticImports(file)) {
    if (webgpuOnly.includes(one)) leaked.push(`${file.slice(dist.length + 1)} → ${one}`);
  }
}
check(leaked.length === 0, `WebGL 那條路上沒有 WebGPU 的東西 —— ${leaked.join('、') || '乾淨'}`);

// ## `three/tsl` 還是「動態」的，沒有被整包內聯
//
// 上面兩條問的是**靜態** import。而打包器如果把 tsl 整包內聯進來，靜態
// import 也會消失 —— 兩條都還是綠的，而每個使用者都多背了一包。
//
// 動態 import 留著就證明它沒有被內聯：那一行在產物裡仍然是
// `import("three/tsl")`，瀏覽器要跑到才會去抓。
//
// 進入點自己有動態 import 是**正常的**（那幾支 node 材質的載入器就在那裡），
// 所以這裡不分 eager／lazy，只問它在不在。
const dynamic = new Set();
for (const file of allJs) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    if (webgpuOnly.includes(match[1])) dynamic.add(match[1]);
  }
}
console.log(`  動態載入的：${[...dynamic].join('、') || '（無）'}`);
check(
  webgpuOnly.every((one) => dynamic.has(one)),
  `WebGPU 那一半還是動態載入的 —— 少了 ${webgpuOnly.filter((o) => !dynamic.has(o)).join('、') || '沒有'}`,
);

// 順帶把分包的樣子印出來 —— 數字本身不是判準，是查問題時的起點。
const lazy = allJs.filter((f) => !eager.has(f));
const sizeOf = (files) => files.reduce((sum, f) => sum + statSync(f).size, 0);
console.log(
  `  一定下載 ${(sizeOf([...eager]) / 1024).toFixed(0)} kB（${eager.size} 個檔）、` +
    `延後 ${(sizeOf(lazy) / 1024).toFixed(0)} kB（${lazy.length} 個檔）`,
);

finish('打包形狀關卡');
