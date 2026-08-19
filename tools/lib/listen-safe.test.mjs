import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { isBrowserSafePort, listenSafe } from './listen-safe.mjs';

/** 一個假的 server，照劇本回報埠號 —— 真的要到那些埠沒辦法點菜。 */
function fakeServer(ports) {
  let i = 0;
  let current = null;
  return {
    closed: 0,
    once() {},
    removeListener() {},
    listen(_port, cb) {
      current = ports[i++];
      cb();
    },
    address() {
      return { port: current };
    },
    close(cb) {
      this.closed++;
      cb();
    },
  };
}

describe('挑一個瀏覽器連得上的埠', () => {
  it('Chrome 擋掉的埠認得出來', () => {
    // 1720 是 H.323。真的拿到過，而整個 impostor 關卡就那樣紅了。
    expect(isBrowserSafePort(1720)).toBe(false);
    expect(isBrowserSafePort(6667)).toBe(false);
    expect(isBrowserSafePort(3000)).toBe(true);
    expect(isBrowserSafePort(54321)).toBe(true);
  });

  it('拿到擋掉的埠會換一個，而且把上一個關掉', () => {
    // 不關的話每重試一次就漏一個 listener，跑一整輪關卡會累積起來。
    const server = fakeServer([1720, 6667, 45123]);
    return listenSafe(server).then((port) => {
      expect(port).toBe(45123);
      expect(server.closed).toBe(2);
    });
  });

  it('第一次就拿到好的埠就不重試', () => {
    const server = fakeServer([45123]);
    return listenSafe(server).then((port) => {
      expect(port).toBe(45123);
      expect(server.closed).toBe(0);
    });
  });

  it('一直拿到壞埠會講清楚，不是無限迴圈', () => {
    const server = fakeServer(new Array(30).fill(1720));
    return expect(listenSafe(server, 5)).rejects.toThrow('Chrome 擋掉的埠');
  });

  it('真的開得起來，而且開出來的埠是安全的', async () => {
    // 上面全是假的 server —— 這一條確認真的 http server 也走得通。
    const server = createServer(() => {});
    const port = await listenSafe(server);
    expect(isBrowserSafePort(port)).toBe(true);
    expect(server.address().port).toBe(port);
    await new Promise((resolve) => server.close(resolve));
  });
});
