/**
 * repo 根目錄的絕對路徑。
 *
 * ## 為什麼需要一個模組放一行程式碼
 *
 * `import.meta.url` 在 Windows 上是 `file:///D:/…`，而 `new URL(...).pathname`
 * 會留下開頭那個斜線 —— `/D:/script_learn/…`。那個路徑 `readFile` 吃不下。
 *
 * 這一行原本被複製在 **42 個關卡檔**裡。複製本身不是問題，問題是它們的
 * 相對深度不一樣（`tools/gpu-check/x.mjs` 是 `../..`，`tools/lib/x.mjs` 也是
 * `../..`，但將來有人多開一層就不是了），而算錯的症狀是「檔案讀不到」——
 * 看起來像產物沒建，不像路徑算錯。
 *
 * 放一個地方之後，深度只有這裡要對。
 */
export const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
