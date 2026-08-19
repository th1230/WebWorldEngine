import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDistFresh, distFreshness, newest } from './dist-fresh.mjs';

const made = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ww-dist-fresh-'));
  made.push(root);
  return root;
}

/** 寫一個檔案並把 mtime 訂死 —— 相對時間比對不能靠「執行得夠慢」。 */
function write(root, relative, content, secondsFromEpoch) {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, secondsFromEpoch, secondsFromEpoch);
  return path;
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('產物有沒有過期', () => {
  it('產物比原始碼新 —— 沒過期', () => {
    const root = fixture();
    write(root, 'apps/example/src/a.ts', 'x', 1000);
    write(root, 'apps/example/dist/app.js', 'x', 2000);
    const state = distFreshness(root, ['apps/example/src']);
    expect(state.stale).toBe(false);
  });

  it('原始碼比產物新 —— 過期', () => {
    const root = fixture();
    write(root, 'apps/example/src/a.ts', 'x', 3000);
    write(root, 'apps/example/dist/app.js', 'x', 2000);
    const state = distFreshness(root, ['apps/example/src']);
    expect(state.stale).toBe(true);
    expect(state.source.path).toContain('a.ts');
  });

  it('產物不存在 —— 也算過期', () => {
    const root = fixture();
    write(root, 'apps/example/src/a.ts', 'x', 1000);
    expect(distFreshness(root, ['apps/example/src']).stale).toBe(true);
  });

  it('看的是所有來源目錄裡最新的那一個', () => {
    // 只看第一個目錄的話，改 packages 底下的東西就漏掉了 —— 而這個套件
    // 大部分的改動正好都在那裡。
    const root = fixture();
    write(root, 'apps/example/src/a.ts', 'x', 1000);
    write(root, 'packages/three/src/b.ts', 'x', 5000);
    write(root, 'apps/example/dist/app.js', 'x', 2000);
    const state = distFreshness(root, ['apps/example/src', 'packages/three/src']);
    expect(state.stale).toBe(true);
    expect(state.source.path).toContain('b.ts');
  });

  it('跳過 node_modules —— 不然安裝一次依賴就永遠算過期', () => {
    const root = fixture();
    write(root, 'apps/example/src/a.ts', 'x', 1000);
    write(root, 'apps/example/src/node_modules/junk.js', 'x', 9000);
    write(root, 'apps/example/dist/app.js', 'x', 2000);
    expect(distFreshness(root, ['apps/example/src']).stale).toBe(false);
  });

  it('過期時丟的例外要說出是哪個檔案', () => {
    const root = fixture();
    write(root, 'apps/example/src/a.ts', 'x', 3000);
    write(root, 'apps/example/dist/app.js', 'x', 2000);
    expect(() => assertDistFresh(root, ['apps/example/src'])).toThrow(/a\.ts/);
    expect(() => assertDistFresh(root, ['apps/example/src'])).toThrow(/build/);
  });

  it('沒過期時不丟，而且把比對的兩個檔案回傳出去', () => {
    const root = fixture();
    write(root, 'apps/example/src/a.ts', 'x', 1000);
    write(root, 'apps/example/dist/app.js', 'x', 2000);
    const state = assertDistFresh(root, ['apps/example/src']);
    expect(state.stale).toBe(false);
    expect(state.dist.path).toContain('app.js');
  });

  it('newest 走進子目錄，回傳最新的那一個', () => {
    const root = fixture();
    write(root, 'a/one.txt', 'x', 1000);
    write(root, 'a/b/two.txt', 'x', 4000);
    write(root, 'a/b/c/three.txt', 'x', 2000);
    expect(newest(join(root, 'a')).path).toContain('two.txt');
  });

  it('空目錄回 null，不是丟例外', () => {
    const root = fixture();
    mkdirSync(join(root, 'empty'), { recursive: true });
    expect(newest(join(root, 'empty'))).toBe(null);
    expect(newest(join(root, 'does-not-exist'))).toBe(null);
  });
});
