import { createServer } from 'node:http';
import { chromium } from 'playwright';
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>x</title>'); });
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;
const A = ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'];
for (const [label, opts] of [
  ['system chrome, headless + swiftshader', { channel: 'chrome', headless: true, args: A }],
  ['system chrome, headed + flag', { channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] }],
]) {
  const browser = await chromium.launch(opts);
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  const r = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return 'navigator.gpu 不存在';
    const a = await navigator.gpu.requestAdapter();
    if (a === null) return 'requestAdapter → null';
    const d = await a.requestDevice();
    return d ? 'OK 拿到 device' : '失敗';
  });
  console.log(`${label.padEnd(38)} → ${r}`);
  await browser.close();
}
server.close();
