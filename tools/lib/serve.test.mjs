import { afterAll, describe, expect, it } from 'vitest';
import { get } from 'node:http';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { serveDist, within } from './serve.mjs';

/**
 * 關卡共用的那台伺服器。
 *
 * 這裡驗的兩件事都是「38 份複製各自漂走」的產物：路徑穿越只有 1 份擋了，
 * `.wasm` 只有 15 份認得。收成一份之後這兩條有了唯一的實作 —— 那就是它們
 * 值得被測的理由。
 */

describe('within', () => {
  it('自己與底下的都算', () => {
    expect(within('/a/site', '/a/site')).toBe(true);
    expect(within('/a/site/x.js', '/a/site')).toBe(true);
    expect(within('/a/site/deep/x.js', '/a/site')).toBe(true);
  });

  it('`..` 化簡之後跑出去的不算', () => {
    expect(within('/a/site/../secrets', '/a/site')).toBe(false);
    expect(within('/a', '/a/site')).toBe(false);
  });

  it('**只是前綴一樣**的不算', () => {
    // 這一條是純 `startsWith` 會放行的那個 —— 根目錄 `/a/site`，
    // 而 `/a/site-other` 是完全不同的目錄。
    expect(within('/a/site-other/x', '/a/site')).toBe(false);
  });
});

/** 起一台伺服器、問一個路徑、關掉。 */
async function ask(root, path) {
  const site = await serveDist(root);
  try {
    return await new Promise((resolve) => {
      get(site.origin + path, (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            type: response.headers['content-type'],
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
    });
  } finally {
    site.close();
  }
}

/**
 * 送一個**未正規化**的請求行，回傳狀態碼。
 *
 * `http.get` 會先幫你把 `..` 化簡掉，於是送不出穿越路徑。這裡直接寫 socket。
 */
async function raw(root, target) {
  const site = await serveDist(root);
  const port = Number(site.origin.split(':').pop());
  try {
    return await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      });
      let text = '';
      socket.on('data', (c) => (text += c.toString('utf8')));
      socket.on('end', () => resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(text)?.[1])));
      socket.on('error', reject);
    });
  } finally {
    site.close();
  }
}

describe('serveDist', () => {
  const root = mkdtempSync(join(tmpdir(), 'ww-serve-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html>hello');
  writeFileSync(join(root, 'sub', 'a.wasm'), 'not-really-wasm');
  writeFileSync(join(root, 'sub', 'b.wwm'), 'not-really-wwm');

  it('`/` 給 index.html', async () => {
    const out = await ask(root, '/');
    expect(out.status).toBe(200);
    expect(out.body).toContain('hello');
    expect(out.type).toBe('text/html');
  });

  it('`.wasm` 的 content-type 是對的', async () => {
    // 22 份複製沒有這一條，而症狀是「物理沒反應」—— Rapier 是 wasm。
    const out = await ask(root, '/sub/a.wasm');
    expect(out.status).toBe(200);
    expect(out.type).toBe('application/wasm');
  });

  it('沒在表上的副檔名回 octet-stream，不是 404', async () => {
    const out = await ask(root, '/sub/b.wwm');
    expect(out.status).toBe(200);
    expect(out.type).toBe('application/octet-stream');
  });

  it('favicon 回 204，不留一筆 404 的雜訊', async () => {
    expect((await ask(root, '/favicon.ico')).status).toBe(204);
  });

  it('跑出根目錄的回 403', async () => {
    // ## 為什麼要自己寫 socket
    //
    // 第一版用 `http.get('/../../etc/passwd')` —— 它回 404，看起來像擋住了。
    // 實際上**那個守衛根本沒被走到**：客戶端在送出之前就把 `..` 正規化掉了，
    // 到伺服器手上的是 `/etc/passwd`，然後因為檔案不在根目錄底下而 404。
    //
    // 也就是說那個測試量到的是「Node 的 http 客戶端會正規化」，不是
    // 「這台伺服器擋得住穿越」。兩個原因給同一個結果，測試分不出來 ——
    // doctrine 第 27 條。
    //
    // 真正的攻擊不會用 Node 的客戶端。原始的請求行送得出未正規化的路徑，
    // 而伺服器的 `req.url` 拿到的就是原始那一串。
    expect(await raw(root, '/../../etc/passwd')).toBe(403);
    expect(await raw(root, '/%2e%2e/%2e%2e/etc/passwd')).toBe(403);
  });

  it('名字剛好是根目錄延伸的鄰居也要擋', async () => {
    // 這一條要**踩得到**那個差別才算數：鄰居的路徑必須以根目錄的路徑開頭。
    // 隨手寫一個 `/../other/x.js` 是測不到的 —— 它本來就不以根目錄開頭，
    // 純 startsWith 也會擋，於是這條斷言對強弱兩版都是綠的。
    const sibling = `${root}-extra`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'x.js'), 'leaked');
    try {
      expect(await raw(root, `/../${basename(sibling)}/x.js`)).toBe(403);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('不存在的回 404', async () => {
    expect((await ask(root, '/nope.js')).status).toBe(404);
  });

  it('url 帶斜線、origin 不帶', async () => {
    const site = await serveDist(root);
    try {
      expect(site.url.endsWith('/')).toBe(true);
      expect(site.origin.endsWith('/')).toBe(false);
      expect(site.url).toBe(`${site.origin}/`);
    } finally {
      site.close();
    }
  });

  // describe 的 body 在**收集階段**就跑完了，所以清理一定要掛在 afterAll ——
  // 直接寫在這裡的話目錄會在任何一個測試開始之前就被刪掉。
  afterAll(() => rmSync(root, { recursive: true, force: true }));
});
