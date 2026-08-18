import { ShaderChunk } from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';

/**
 * 貼圖被縮到看不出細節時就不取樣它 —— **一份材質，逐 fragment 決定**。
 *
 * ## 判準是「這張貼圖還有沒有在貢獻細節」
 *
 * 直覺會問「這個物件在螢幕上多大」，但那答錯一種情況：物件很大而貼圖鋪得很稀
 * 時，細節本來就看不見，卻會被判定成該保留。
 *
 * 真正該問的是貼圖被縮小了多少，而那可以直接量 —— **UV 的螢幕導數**：
 *
 * ```glsl
 * length( dFdx( uv ) )   // 這個 fragment 跨過多少貼圖空間
 * ```
 *
 * 一個 fragment 跨過的 UV 越多，代表貼圖被縮得越兇，取樣出來的細節就越是在
 * 平均一片雜訊。這正是 GPU 自己挑 mip 階的依據。
 *
 * 這個判準還有兩個好處：
 *
 * - **不需要 instance 的矩陣**，所以 WebGL 與 node 兩條路可以共用同一個式子
 *   （node 那邊拿不到 `batchingMatrix`，它是 `batch()` 內部的區域變數）。
 * - **導數本來就要算**（`textureGrad` 需要），等於免費。
 *
 * ## 為什麼值得做
 *
 * 實測（`ab-ww-real`，同一份幾何同一條相機路徑，只換材質）：
 *
 * | | normal + ORM 佔 GPU |
 * | --- | ---: |
 * | 遠景（60,000 個、spread 900，每個幾個像素） | 8% |
 * | 近景（3,000 個、spread 60，物件很大） | **27%** |
 *
 * 同樣兩張貼圖差三倍 —— 這筆錢只在貼圖真的看得到時才付得有價值。
 *
 * ## 為什麼預設關
 *
 * 少取樣 normal 會讓表面變平 —— **那是改變畫面**，屬於開發者（doctrine 四問的
 * 第一問）。引擎把成本算出來、把旋鈕交出去，不自己訂門檻。
 *
 * ## 為什麼是替換 #include 而不是替換那幾行
 *
 * `onBeforeCompile` 拿到的 shader **還沒有展開 `#include`** —— 裡面是
 * `#include <normal_fragment_maps>` 這種指令，不是它的內容。直接去換那幾行
 * 程式碼會**一行都對不上，然後什麼都不會發生**：畫面正常、沒有錯誤、只是
 * 這個功能悄悄沒開。
 *
 * 第一版就是那樣寫的，而且量到「關 / 惰性 / 最大效果」三個設定**完全同分**
 * 才發現 —— 三個一模一樣本來就該當成訊號，不是巧合。
 *
 * 現在改成從 `ShaderChunk` 取出真正的內容、在上面動手腳、再換掉那一行
 * `#include`。副作用是「字串有沒有過期」自動成立 —— 來源就是 Three 自己。
 *
 * ## 為什麼是 textureGrad 而不是 texture
 *
 * 取樣寫在動態分支裡，而 `texture()` 在非均勻控制流下**導數是未定義的**。
 * 所以導數在分支外算好，分支內用 `textureGrad`。
 *
 * 不這麼做的症狀是：某些角度、某些距離出現細微的錯誤著色，沒有任何錯誤訊息
 * —— 正是這個專案最怕的那一類。
 */
export interface MaterialDetailOptions {
  /**
   * 一個 fragment 跨過多少 UV 就停止取樣細節貼圖。
   *
   * 直覺的換算：`1 / 貼圖寬度` 大約是「一個 fragment 剛好對一個 texel」。
   * 所以 1024² 的貼圖，`0.004` 大約是縮到四分之一大小的時候。
   */
  uvPerPixel: number;
}

export interface MaterialDetailHandle {
  /** 這個材質上注入有沒有生效。node 材質是 false。 */
  readonly active: boolean;
}

/**
 * 從 Three 真正的 chunk 生一份「還看得到細節才取樣」的版本。
 *
 * 導數在外面算，取樣換成三元運算子 —— 兩邊都不含 `texture()`，所以不會有
 * 非均勻控制流下取樣的未定義行為。
 *
 * 找不到那個呼叫就**丟例外**：那代表 Three 換版之後字串過期了，而靜靜不生效
 * 的症狀是「開了旋鈕但沒省」，查不到原因。
 */
function guardChunk(
  chunk: string,
  sampler: string,
  uv: string,
  fallback: string,
  define: string,
): string {
  const call = `texture2D( ${sampler}, ${uv} )`;
  if (!chunk.includes(call)) {
    throw new Error(
      `WW: Three 的 shader chunk 裡找不到 ${call} —— 這個版本的 Three 改過了，` +
        'materialDetailUvPerPixel 需要更新。',
    );
  }
  const guarded =
    `( max( length( wwDx_${sampler} ), length( wwDy_${sampler} ) ) < wwUvPerPixel` +
    ` ? textureGrad( ${sampler}, ${uv}, wwDx_${sampler}, wwDy_${sampler} )` +
    ` : ${fallback} )`;
  // **導數那兩行要包在跟 chunk 同一個 `#ifdef` 裡。**
  //
  // chunk 的內容本身就被條件包著（沒有那張貼圖時它展開成空的），而那個 UV
  // varying 也只有在條件成立時才存在。裸著放會在「沒有這張貼圖」的材質上
  // 直接編譯失敗 —— 而那是每一個沒有 normalMap 的材質。
  return [
    `#ifdef ${define}`,
    `vec2 wwDx_${sampler} = dFdx( ${uv} );`,
    `vec2 wwDy_${sampler} = dFdy( ${uv} );`,
    `#endif`,
    chunk.split(call).join(guarded),
  ].join('\n');
}

export function installMaterialDetail(
  material: Material,
  options: MaterialDetailOptions,
): MaterialDetailHandle {
  // ## node 材質上這個注入不會生效 —— 而它必須說出來
  //
  // `onBeforeCompile` 是 WebGL 那條路的鉤子。`WebGPURenderer` 用的是 node
  // 材質，它整條編譯路徑不經過那個鉤子，所以掛上去**什麼都不會發生**。
  //
  // 不講的話症狀是「開了旋鈕但一點都沒省」，而那看起來像旋鈕沒用，不像
  // 沒生效。準則：缺前置時要大聲說出缺什麼、少了它會怎樣。
  const isNode = (material as { isNodeMaterial?: boolean }).isNodeMaterial === true;
  if (isNode) {
    console.warn(
      [
        'WW.InstancedMesh: materialDetailPixels 在 node 材質上還沒有實作。',
        '它靠 onBeforeCompile 注入，而那是 WebGL 那條路的鉤子 —— WebGPURenderer',
        '走的 node 材質不經過它。這個旋鈕現在什麼都沒做。',
        '其餘的剔除、LOD、遠景合併完全不受影響。',
      ].join('\n'),
    );
  }

  const uvPerPixel = { value: options.uvPerPixel };
  const previous = material.onBeforeCompile;

  material.onBeforeCompile = (
    shader: WebGLProgramParametersWithUniforms,
    ...rest: unknown[]
  ): void => {
    // 使用者可能自己掛過一個 —— 蓋掉別人的鉤子等於靜靜改變他的材質。
    (previous as (...args: unknown[]) => void)?.call(material, shader, ...rest);

    shader.uniforms.wwUvPerPixel = uvPerPixel;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float wwUvPerPixel;')
      .replace(
        '#include <normal_fragment_maps>',
        guardChunk(
          ShaderChunk.normal_fragment_maps,
          'normalMap',
          'vNormalMapUv',
          // 平的切線空間法線。
          'vec4( 0.5, 0.5, 1.0, 1.0 )',
          'USE_NORMALMAP',
        ),
      )
      .replace(
        '#include <roughnessmap_fragment>',
        guardChunk(
          ShaderChunk.roughnessmap_fragment,
          'roughnessMap',
          'vRoughnessMapUv',
          'vec4( 1.0 )',
          'USE_ROUGHNESSMAP',
        ),
      )
      .replace(
        '#include <metalnessmap_fragment>',
        guardChunk(
          ShaderChunk.metalnessmap_fragment,
          'metalnessMap',
          'vMetalnessMapUv',
          'vec4( 1.0 )',
          'USE_METALNESSMAP',
        ),
      );
  };
  material.needsUpdate = true;

  return { active: !isNode };
}
