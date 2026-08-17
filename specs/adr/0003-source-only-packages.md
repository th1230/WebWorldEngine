# ADR 0003：內部 package 不做 build step

狀態：已採納（M0）

## 決策

`packages/*` 的 `package.json` 直接把 `exports` 指向原始碼：

```json
{ "exports": { ".": "./src/index.ts" } }
```

沒有 `tsc --build`、沒有 `dist/`、沒有 TS project references。型別檢查由根目錄一次 `tsc -p tsconfig.json --noEmit` 完成，打包交給 Vite。

## 理由

- 少一整層 build 編排與快取失效問題
- 改一行程式碼不必等 5 個 package 依序重建
- IDE 的「跳到定義」直接到原始碼，不是 `.d.ts`
- Vite 與 Vitest 都能直接解析 TypeScript

代價是這些 package 目前不能被外部消費。等真的需要發佈時再加 build step —— 現在加是為了想像中的需求付出真實的複雜度。

## 附帶決定

`tsconfig.base.json` 的 `paths` 明確映射 `@ww/*` 到 `src/index.ts`。pnpm 的 workspace symlink 加上 `moduleResolution: "bundler"` 其實也解析得到，但明確映射比較不容易出意外。

## 嚴格度

刻意開到很嚴：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`noUnusedLocals`、`verbatimModuleSyntax`。

`exactOptionalPropertyTypes` 會讓 options bag 必須寫成 `foo?: T | undefined`。這個摩擦是值得的 —— 它逼你分清楚「沒有這個屬性」和「這個屬性是 undefined」，而那個區別在 capability 與 timing 資料上是有意義的（量不到的數值回報 `null`，不是 `0`）。

## 型別來源注意

three 0.185 **不再隨套件提供 `.d.ts`**，型別來自 `@types/three`（本專案用 `^0.185.4`）。同時 `@webgpu/types` 不在 `@types/` 底下，不會被自動載入，必須在 `tsconfig.base.json` 明確列進 `types`。
