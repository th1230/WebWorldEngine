/**
 * Vite 的 `?worker&inline` 匯入。
 *
 * 產出的 worker 原始碼被內嵌成 blob，**完全不需要路徑解析** —— 那是這個
 * 套件唯一能在任何打包工具下都正確運作的形式。
 */
declare module '*?worker&inline' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
