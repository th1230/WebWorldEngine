/**
 * 讀回的雙後端差異全部在套件裡處理（`bakeIrradiance` 自己也要用）。
 *
 * 這裡只是轉出去 —— 場景檔案不必知道它從哪裡來，而且**只有一份實作**。
 */
export { readPixelsAsync, type ReadableTarget } from '@webworld/three';
