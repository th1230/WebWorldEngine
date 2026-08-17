/**
 * `draco3d` 沒有自帶型別，`@types/draco3d` 也不存在。
 *
 * 只宣告我們真正用到的那一個工廠函式，而不是 `declare module 'draco3d'`
 * 配一個 `any` —— 後者會讓任何拼錯的呼叫都通過型別檢查，而這個模組的
 * 失敗方式已經夠隱晦了（漏了解碼器時的錯誤訊息是
 * `Cannot read properties of undefined (reading 'DT_FLOAT32')`，
 * 完全看不出跟 Draco 有關）。
 */
declare module 'draco3d' {
  /** 回傳 gltf-transform 的 `draco3d.decoder` 依賴所需的解碼器模組。 */
  export function createDecoderModule(options?: object): Promise<unknown>;
  export function createEncoderModule(options?: object): Promise<unknown>;
}
