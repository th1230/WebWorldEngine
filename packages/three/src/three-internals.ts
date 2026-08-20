import type { DataTexture } from 'three';

/**
 * `THREE.BatchedMesh` 的私有欄位。
 *
 * ## 為什麼要碰私有欄位
 *
 * `BatchedMesh` 每幀在 `onBeforeRender` 裡走訪**全部** instance，每一個都
 * 讀矩陣、轉包圍球、測視錐。那正是空間分割要取代的東西 —— 而唯一的接點
 * 就是它拿來記錄「這一幀畫哪些」的那三個陣列。
 *
 * 官方沒有公開的替代路徑：`setVisibleAt()` 每呼叫一次就把 `_visibilityChanged`
 * 設為 true，於是它下一幀又會把全部 instance 走一遍 —— 那比不做還糟。
 *
 * ## 這個耦合會怎麼壞掉，以及為什麼還是選它
 *
 * Three.js 改名或改結構的話，這裡會**靜靜地畫不出東西**（`_multiDrawCount`
 * 寫到一個不存在的欄位不會報錯）。那正是本專案最忌諱的失效形態。
 *
 * 所以 {@link assertBatchedMeshInternals} 把它變成一個會紅的檢查，並且在
 * 建構時就跑 —— 不是等到畫面空白才發現。three 的版本在 package.json 鎖住。
 */
export interface BatchedMeshInternals {
  _instanceInfo: Array<{ visible: boolean; active: boolean; geometryIndex: number }>;
  _geometryInfo: Array<{ start: number; count: number; active: boolean }>;
  _multiDrawStarts: Int32Array;
  _multiDrawCounts: Int32Array;
  _multiDrawCount: number;
  _visibilityChanged: boolean;
  _indirectTexture: DataTexture;
  _matricesTexture: DataTexture;
  _maxInstanceCount: number;
  _maxVertexCount: number;
  _maxIndexCount: number;
}

const REQUIRED_ARRAYS = ['_multiDrawStarts', '_multiDrawCounts'] as const;
const REQUIRED_LISTS = ['_instanceInfo', '_geometryInfo'] as const;
const REQUIRED_TEXTURES = ['_indirectTexture', '_matricesTexture'] as const;

/**
 * 確認這一版 three 的 `BatchedMesh` 內部結構仍是我們預期的形狀。
 *
 * 缺任何一項就丟例外。**寧可在建構時炸掉，也不要在畫面上少東西** ——
 * 後者沒有任何錯誤訊息，而且看起來就只是「這個套件沒什麼用」。
 */
export function assertBatchedMeshInternals(mesh: object): BatchedMeshInternals {
  const raw = mesh as unknown as Record<string, unknown>;
  const missing: string[] = [];

  for (const key of REQUIRED_ARRAYS) {
    if (!(raw[key] instanceof Int32Array)) missing.push(`${key}: Int32Array`);
  }
  for (const key of REQUIRED_LISTS) {
    if (!Array.isArray(raw[key])) missing.push(`${key}: Array`);
  }
  for (const key of REQUIRED_TEXTURES) {
    const texture = raw[key] as { image?: { data?: unknown } } | undefined;
    if (
      !(texture?.image?.data instanceof Uint32Array) &&
      !(texture?.image?.data instanceof Float32Array)
    ) {
      missing.push(`${key}.image.data: TypedArray`);
    }
  }
  if (typeof raw['_multiDrawCount'] !== 'number') missing.push('_multiDrawCount: number');
  if (typeof raw['_visibilityChanged'] !== 'boolean') missing.push('_visibilityChanged: boolean');

  if (missing.length > 0) {
    throw new Error(
      `WW.InstancedMesh 依賴 THREE.BatchedMesh 的內部結構，而這一版對不上：\n` +
        missing.map((m) => `  缺少 ${m}`).join('\n') +
        `\n\n這通常代表 three 升級後改了 BatchedMesh 的實作。` +
        `\n請對照 packages/three/src/three-internals.ts 更新，` +
        `或把 three 鎖回 0.185.x。`,
    );
  }

  return mesh as unknown as BatchedMeshInternals;
}
