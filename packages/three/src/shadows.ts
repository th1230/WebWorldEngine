import type { Material, Object3D } from 'three';

/**
 * 世界尺度的陰影：把 cascaded shadow maps 接對。
 *
 * ## 為什麼這裡不自己寫一套 CSM
 *
 * Three 自己就有（`three/addons/csm`），而且還有 node 材質那份
 * （`CSMShadowNode`）。跟簡化器用 meshoptimizer、切線用 MikkTSpace 是同一個
 * 判斷：**自己重寫一份「數學上也對但跟別人不一致」的東西，症狀是細微的錯誤
 * 而且不會報錯。**
 *
 * 所以這個檔案很短。它做的是把那個 addon 的兩個坑補起來 —— 而那兩個坑
 * 都是這個專案最怕的那種：**沒有錯誤訊息**。
 *
 * ## 坑一：`setupMaterial` 要逐材質呼叫，漏掉就沒有陰影
 *
 * CSM 是逐材質注入 shader 的。沒被注入的材質不會去取樣那幾張 cascade，
 * 而症狀是**那個東西上完全沒有陰影**，其他東西的陰影卻好好的。
 *
 * 實測踩過：只對石頭那份材質呼叫，忘了地面 —— 結果整片地板一點影子都沒有，
 * 而我差點把它讀成「CSM 根本沒接上」。
 *
 * ## 坑二：`setupMaterial` 是**直接指派** `onBeforeCompile`
 *
 * ```js
 * material.onBeforeCompile = function ( shader ) { … };   // 蓋掉前一個
 * ```
 *
 * 所以它在 `WW.AnimatedInstancedMesh` 之後呼叫的話，頂點動畫會被蓋掉 ——
 * 一群停在綁定姿勢的模型，不報錯。
 *
 * 這裡的做法是**在蓋掉之前先接住**：把原本那個記下來，包進新的一起呼叫。
 * 於是順序不再重要，而「順序」正是最不該讓使用者記住的那種知識。
 *
 * ## 成本（實測，2,000 個 instance）
 *
 * | | GPU | 繪製 | 三角形 |
 * | --- | ---: | ---: | ---: |
 * | 無陰影 | 2.508 ms | 2 | 100,562 |
 * | 單張 shadow map | 3.704 ms | 4 | 261,106 |
 * | CSM 四段 | 9.125 ms | 9 | 690,274 |
 *
 * 四段就是把場景再畫四次進 shadow map，所以三角形變 6.9 倍。**這筆錢是
 * 開發者的**：要不要陰影、要幾段、範圍多大，全部是他的選擇。這裡只負責
 * 讓它接得對，並且把價錢寫在這裡。
 */

/**
 * CSM 那個物件身上這裡真正會用到的部分。
 *
 * 用結構型別而不是 `import type { CSM }`：那個 import 會把 addon 拉進
 * 相依，而只用 WebGL、根本不做陰影的人不該為它付下載量。
 */
export interface CascadedShadows {
  setupMaterial(material: Material): void;
}

/**
 * 把 `root` 底下每一個材質都接上 CSM，**而且不弄壞已經掛在上面的東西**。
 *
 * ```js
 * const csm = new CSM({ camera, parent: scene, cascades: 4 });
 * WW.applyShadows(csm, scene);   // 順序不重要，這裡會接住
 * ```
 *
 * 每個材質只會被接一次 —— 同一份材質被很多物件共用是常態，重複接會讓
 * 那串 `onBeforeCompile` 越疊越長。
 *
 * @returns 接了幾個材質。0 代表 `root` 底下沒有任何材質，那通常是傳錯東西了。
 */
export function applyShadows(csm: CascadedShadows, root: Object3D): number {
  const seen = new Set<Material>();

  root.traverse((object) => {
    const material = (object as { material?: Material | Material[] }).material;
    if (material === undefined) return;
    for (const one of Array.isArray(material) ? material : [material]) {
      if (seen.has(one)) continue;
      seen.add(one);
      setupPreservingHook(csm, one);
    }
  });

  if (seen.size === 0) {
    // 靜靜地什麼都沒接的症狀是「整個場景都沒有陰影」，而那看起來像 CSM
    // 設定錯了，不像「這裡根本沒找到材質」。
    console.warn(
      'WW.applyShadows: 這個 root 底下沒有任何材質，所以一個都沒接上 —— 場景會完全沒有陰影。\n' +
        '通常是傳錯物件了（要傳 scene 或含有 mesh 的節點）。',
    );
  }
  return seen.size;
}

/**
 * 呼叫 `csm.setupMaterial`，但把它蓋掉的那個鉤子接回來。
 *
 * CSM 的注入只是加 uniform，不改 shader 原始碼；我們的注入會改
 * `vertexShader`。兩個接在一起沒有衝突 —— 衝突的只有「誰佔住那個插槽」。
 */
function setupPreservingHook(csm: CascadedShadows, material: Material): void {
  const previous = material.onBeforeCompile;
  csm.setupMaterial(material);
  const injected = material.onBeforeCompile;

  // CSM 沒有換掉它（例如它已經接過這份材質）就不必包。
  if (injected === previous) return;

  material.onBeforeCompile = function (
    this: Material,
    ...args: Parameters<Material['onBeforeCompile']>
  ): void {
    // 先跑原本的（可能是頂點動畫的注入），再跑 CSM 的。
    //
    // 順序是這樣而不是反過來：原本那個可能會改 `vertexShader`，而 CSM 只
    // 加 uniform 並把 shader 物件記下來。CSM 要記到的是**最終**那一份。
    previous.apply(this, args);
    injected.apply(this, args);
  };
}
