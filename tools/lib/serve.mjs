/**
 * 關卡用的靜態檔案伺服器。**一份實作，一張 mime 表。**
 *
 * ## 為什麼要收起來
 *
 * 這二十行原本被複製在 38 個關卡檔裡，而複製之後它們**各自漂走了**：
 *
 * | | 幾個檔 |
 * | --- | ---: |
 * | 有 `.wasm` 的 mime | 15 |
 * | 沒有 `.wasm` 的 | 22 |
 * | 會擋 `/favicon.ico` 的 | 一部分 |
 * | 支援第二個根目錄（`/cooked`）的 | 一部分 |
 *
 * 少了 `.wasm` 的那 22 個，一旦場景動到 Rapier 就會 404 —— 而症狀是「物理
 * 沒反應」，不是「檔案讀不到」。那不是有人決定過的差異，是複製之後沒有人
 * 再看第二眼。
 *
 * 收成一份之後，那張表只有一個地方要維護，而且新開的關卡自動拿到完整的。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { listenSafe } from './listen-safe.mjs';

/**
 * 副檔名 → content-type。
 *
 * 只列這幾個是因為關卡只 serve 得到這幾種。**不在表上的回
 * `application/octet-stream`**，而不是 404 —— 瀏覽器對未知型別的處理比對
 * 缺檔的處理寬鬆得多，猜錯型別至少查得出來。
 */
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'application/octet-stream',
  '.wwm': 'application/octet-stream',
};

/**
 * `file` 在 `base` 底下嗎。
 *
 * 匯出是為了測得到 —— 這一條是安全性判斷，而安全性判斷最該有紅過的證據。
 */
export function within(file, base) {
  const resolvedFile = resolve(file);
  const resolvedBase = resolve(base);
  return resolvedFile === resolvedBase || resolvedFile.startsWith(resolvedBase + sep);
}

/**
 * 開一個伺服器，回傳 `{ url, close }`。
 *
 * @param {string} root 網站根目錄。`/` 會給 `index.html`。
 * @param {{ mounts?: Record<string, string> }} [options]
 *   `mounts` 是額外的前綴 → 目錄。例如 `{ '/cooked': COOKED }` 會讓
 *   `/cooked/a.wwm` 去讀 `COOKED/cooked/a.wwm`。前綴照宣告順序比對。
 *
 * `url` 結尾**帶斜線**（`http://localhost:1234/`）。原本 38 個複製裡有的帶
 * 有的不帶，於是接查詢字串時有的寫 `${base}/?x=1` 有的寫 `${base}?x=1` ——
 * 統一成帶，接的時候一律 `${url}?x=1`。
 */
export async function serveDist(root, options = {}) {
  const mounts = Object.entries(options.mounts ?? {});
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
    // favicon 一律 204。不擋的話每一頁都會留下一筆 404，而關卡常常在驗
    // 「有沒有主控台錯誤」—— 那筆雜訊會蓋掉真的問題。
    if (path === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const mount = mounts.find(([prefix]) => path.startsWith(prefix));
    const base = mount ? mount[1] : root;
    const file = mount ? join(base, path) : join(base, path === '/' ? 'index.html' : path);
    // ## 出不了根目錄
    //
    // `join` 會把 `..` 化簡掉，所以 `/../../secrets` 解出來是根目錄外面的
    // 真實路徑。38 個複製版本裡只有 `package-check` 那一份擋了 —— 它擋是
    // 因為它就是在模擬「部署出去的網站」，`node_modules` 必須碰不到。
    //
    // 其餘 37 個沒擋，而它們 serve 的是 repo 裡的目錄。收成一份的順帶好處
    // 就是這個：一個地方擋了，全部都擋了。
    //
    // 比對時要**帶上分隔符**。純 `startsWith` 會讓根目錄 `/a/site` 放行
    // `/a/site-other/x` —— 那種「幾乎對」的防護比明著沒有更糟，因為它讓人
    // 停止懷疑。
    if (!within(file, base)) {
      response.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (bytes) => {
        response.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        });
        response.end(bytes);
      },
      () => response.writeHead(404).end(),
    );
  });
  await listenSafe(server);
  const origin = `http://localhost:${server.address().port}`;
  return {
    /** 結尾帶斜線。接查詢字串時 `${site.url}?x=1`。 */
    url: `${origin}/`,
    /** 結尾不帶斜線。接路徑時 `${site.origin}/webgpu.html?x=1`。 */
    origin,
    close: () => server.close(),
  };
}
