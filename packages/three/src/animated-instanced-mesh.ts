import { InstancedMesh } from './instanced-mesh.ts';
import type { InstancedMeshOptions } from './instanced-mesh.ts';
import type { BakedVertexAnimation } from './vertex-animation.ts';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';

/**
 * 一堆會動的東西，**當成靜態幾何來畫**。
 *
 * ## 它解掉的
 *
 * 實測（`tools/gpu-check/skinned-scaling.mjs`）：800 個 `THREE.SkinnedMesh`
 * 要 7.566 ms、**740 次繪製**（一個 instance 一次，完全不批次），而那 20 萬個
 * 三角形本身只值 1.02 ms。每個會動的 instance 比靜態的貴 **10 倍**，而且那
 * 10 倍全部在逐 instance 那一側。
 *
 * 動畫烘進貼圖之後（`bakeVertexAnimation`），幾何就是靜態的了 —— 於是這個
 * 類別直接繼承 `InstancedMesh`，**批次、剔除、LOD 選階全部照舊**。這裡加的
 * 只有一段 vertex shader：從貼圖讀位置。
 *
 * ## 實測（3,200 個，同一根 rig）
 *
 * | | GPU | 繪製 | 三角形 |
 * | --- | ---: | ---: | ---: |
 * | `THREE.SkinnedMesh` | 26.543 ms | 2,971 | 807,842 |
 * | VAT（關 LOD，同樣的三角形數） | 4.993 ms | **2** | 803,762 |
 * | VAT + LOD | **3.241 ms** | **2** | 94,562 |
 *
 * 兩個數字回答兩件事：**只算批次是省 81.2%**（同樣的幾何，只是不再一個一個
 * 送），**整條路是省 87.8%**（LOD 也回來了）。
 *
 * 分開報是因為它們的來源不同 —— 混在一起的話「批次值多少」就永遠說不清楚。
 *
 * ## 每個 instance 各動各的
 *
 * 全部同步擺同一個姿勢的話，一片人群看起來像一排機器人。所以每個 instance
 * 有自己的相位，而相位是從**它的 instance 編號**推出來的（`batchId`），
 * 不必再開一條逐 instance 的資料通道。
 *
 * ## 時間軸上要內插，頂點軸上不能
 *
 * 貼圖的兩個維度意義完全不同：一個是頂點編號（相鄰兩個頂點在空間上毫無關係），
 * 一個是時間（相鄰兩幀是連續的）。所以貼圖本身設 `NearestFilter`，而時間軸
 * 的內插在 shader 裡自己做 —— 讀兩幀再混。
 *
 * 不做的話動作會一格一格跳，而那看起來像「動畫檔壞了」。
 */

export interface AnimatedInstancedMeshOptions extends InstancedMeshOptions {
  /**
   * 每個 instance 的相位差多少（0–1 之間的比例）。預設 1，也就是整段動畫
   * 均勻散開。
   *
   * 設成 0 就是全部同步 —— 那在「一排整齊踏步的士兵」上是想要的，在人群上
   * 不是。
   */
  phaseSpread?: number;
}

export class AnimatedInstancedMesh extends InstancedMesh {
  private readonly _time = { value: 0 };

  constructor(
    baked: BakedVertexAnimation,
    material: Material,
    count: number,
    options: AnimatedInstancedMeshOptions = {},
  ) {
    // 幾何是烘好的那份（多一個 `wwVertexId`），位置由 shader 從貼圖讀。
    //
    // ## LOD 是可以開的，而且不必重烘貼圖
    //
    // 一開始以為不行：簡化會重排並丟掉頂點，而貼圖是用**原本的頂點編號**
    // 索引的。但簡化器**只會移除頂點，不會生出新的** —— 而
    // `compact()` 會把每一個 attribute 都帶過去，包括 `wwVertexId`。
    //
    // 所以簡化後的每個頂點仍然帶著它原本的編號，同一張貼圖對每一階都成立。
    // 實測：355 個頂點簡化到 100 個，100 個相異的 `wwVertexId`，一個都沒亂。
    //
    // ## 但只在**已經有索引**的幾何上開
    //
    // 沒有索引的話產生流程會先 `weld()`，而它的鍵值涵蓋每一個 attribute ——
    // `wwVertexId` 逐頂點都不同，於是**一個都焊不起來**，簡化器找不到可以
    // 塌陷的邊，回傳原樣。結果是「產生了 LOD 但每一階都跟第 0 階一樣」，
    // 而那比沒有 LOD 更糟：統計上看起來 LOD 有在運作。
    //
    // 呼叫端當然可以自己覆寫。
    // ## 遠景合併要關掉，而且理由是**正確性**不是相容性
    //
    // 合併是把一格的 instance 烘成一份幾何，然後當成**一個** instance 畫。
    // 而這條路的動畫相位是逐 instance 的（從它的批次編號推出來）——合併之後
    // 那一整格會共用一個相位，於是本來各動各的一群東西，會在合併的那一瞬間
    // 突然同步。
    //
    // 那是看得見的跳動，而且沒有任何錯誤。要合併的話得連動畫一起烘進合併後
    // 的幾何，那是另一件事。
    //
    // （順帶：`mergeInstances` 只處理 position/normal/uv/tangent 這四個固定
    // 的 attribute，所以合併出來的幾何本來就會少掉 `wwVertexId`，然後被
    // `BatchedMesh` 當場擋下。那是一個更早、更吵的失敗 —— 但即使修好它，
    // 上面那個相位的問題還在。）
    const indexed = baked.geometry.getIndex() !== null;
    super(baked.geometry, material, count, { autoLod: indexed, hlod: false, ...options });

    const uniforms = {
      wwVat: { value: baked.texture },
      wwVatTime: this._time,
      wwVatFrames: { value: baked.frameCount },
      wwVatWidth: { value: baked.vertexCount },
      wwVatDuration: { value: baked.duration },
      wwVatPhase: { value: options.phaseSpread ?? 1 },
    };

    // ## node 材質上這段注入不會生效 —— 而它必須大聲說
    //
    // `onBeforeCompile` 是 WebGL 那條路的鉤子。`WebGPURenderer` 用的是 node
    // 材質，整條編譯路徑不經過它，所以掛上去**什麼都不會發生**。
    //
    // 而「什麼都不會發生」在這裡的樣子特別會騙人：位置從來沒被改寫，於是
    // 每一個 instance 都停在**綁定姿勢**。畫面上是一群完全不動的模型 ——
    // 看起來像「動畫資料有問題」或「忘了呼叫 update」，最不可能被懷疑的
    // 就是「這條路在這個 renderer 上根本沒接上」。
    //
    // 這個專案在材質那條軸上已經踩過同一個坑：實作在 WebGL、量測在 WebGPU，
    // 兩邊碰不到，而症狀是「開了旋鈕但沒省」。
    if ((material as { isNodeMaterial?: boolean }).isNodeMaterial === true) {
      console.warn(
        [
          'WW.AnimatedInstancedMesh: 這是 node 材質（WebGPURenderer 那條路），',
          '而頂點動畫是靠 onBeforeCompile 注入的 —— node 材質不經過那個鉤子。',
          '結果會是**一群停在綁定姿勢、完全不動的模型**，而且不會有任何錯誤。',
          '批次、剔除、LOD 選階都照常運作，只有動畫不會播。',
          'WebGPU 上目前請改用 THREE.SkinnedMesh。',
        ].join('\n'),
      );
    }

    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (
      shader: WebGLProgramParametersWithUniforms,
      ...rest: unknown[]
    ): void => {
      // 使用者可能自己掛過一個 —— 蓋掉別人的鉤子等於靜靜改變他的材質。
      (previous as ((...args: unknown[]) => void) | undefined)?.call(material, shader, ...rest);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = injectVertexAnimation(shader.vertexShader);
    };
    material.needsUpdate = true;
  }

  /** 動畫走到第幾秒。每幀呼叫。 */
  set time(seconds: number) {
    this._time.value = seconds;
  }

  get time(): number {
    return this._time.value;
  }
}

/**
 * 把「從貼圖讀位置」插進 vertex shader。
 *
 * ## 為什麼是換 `#include <begin_vertex>`
 *
 * 那個 chunk 就是 `vec3 transformed = vec3( position );` —— 後面所有的變形
 * （batching、instancing、morph、投影）都吃 `transformed`。在它之後改就會被
 * 後面的步驟蓋掉或錯過，在它之前改則還沒有那個變數。
 *
 * ## 為什麼相位用 batchId
 *
 * `batching_vertex` 已經算好了 `batchId`（這個 instance 的編號），而它就在
 * `begin_vertex` 之前。拿它當亂數種子就不必再開一條逐 instance 的資料通道。
 *
 * 找不到那一行就**丟例外**：Three 換版把 chunk 改掉的話，靜靜不生效的症狀是
 * 「所有東西都擺在綁定姿勢」，看起來像動畫沒播，而不像注入失敗。
 */
export function injectVertexAnimation(vertexShader: string): string {
  const anchor = '#include <begin_vertex>';
  if (!vertexShader.includes(anchor)) {
    throw new Error(
      'WW.AnimatedInstancedMesh: vertex shader 裡找不到 #include <begin_vertex>，' +
        '這個版本的 Three 改過了。',
    );
  }

  const injection = [
    'uniform sampler2D wwVat;',
    'uniform float wwVatTime;',
    'uniform float wwVatFrames;',
    'uniform float wwVatWidth;',
    'uniform float wwVatDuration;',
    'uniform float wwVatPhase;',
    'attribute float wwVertexId;',
    '',
    'vec3 wwVatSample( float frame ) {',
    // texel 中心：+0.5 再除以尺寸。少了它會落在兩個 texel 的邊界上，
    // 而 NearestFilter 在邊界上挑哪一個是未定義的 —— 症狀是畫面偶爾抖一下。
    //
    // 寬度用 uniform 傳進來，**不用 `textureSize()`** —— 那是 GLSL ES 3.00
    // 才有的，而 Three 預設編的是 1.00。用了會整支 shader 編不過，而畫面上
    // 是那個材質的東西整個不見。
    '  float u = ( wwVertexId + 0.5 ) / wwVatWidth;',
    '  float v = ( frame + 0.5 ) / wwVatFrames;',
    '  return texture2D( wwVat, vec2( u, v ) ).xyz;',
    '}',
  ].join('\n');

  const body = [
    '#include <begin_vertex>',
    '{',
    // 每個 instance 自己的相位，種子取自它在批次裡的編號。
    //
    // **不是 `batchId`** —— 那個變數不存在。Three 的 batching chunk 算的是
    // `mat4 batchingMatrix = getBatchingMatrix( getIndirectIndex( gl_DrawID ) )`，
    // 索引本身沒有存成具名變數，所以要自己再呼叫一次 `getIndirectIndex`。
    //
    // 第一版寫 `batchId`，shader 當場編不過。而那個失敗**不會讓量測看起來
    // 不對**：`renderer.info.render.triangles` 算的是送出去的幾何，不管
    // 程式有沒有連結成功 —— 三角形數完全正常，時間還快得不得了。
    // 抓到它的是主控台的錯誤訊息，不是任何一個數字。
    '  float wwId = 0.0;',
    '  #ifdef USE_BATCHING',
    '    wwId = float( getIndirectIndex( gl_DrawID ) );',
    '  #endif',
    '  float wwSeed = fract( sin( wwId * 12.9898 ) * 43758.5453 );',
    '  float wwT = wwVatTime / max( wwVatDuration, 1e-6 ) + wwSeed * wwVatPhase;',
    '  float wwPos = fract( wwT ) * ( wwVatFrames - 1.0 );',
    '  float wwA = floor( wwPos );',
    // 時間軸上要內插 —— 不做的話動作一格一格跳，看起來像動畫檔壞了。
    '  vec3 wwP0 = wwVatSample( wwA );',
    '  vec3 wwP1 = wwVatSample( min( wwA + 1.0, wwVatFrames - 1.0 ) );',
    '  transformed = mix( wwP0, wwP1, wwPos - wwA );',
    '}',
  ].join('\n');

  return `${injection}\n${vertexShader.replace(anchor, body)}`;
}
