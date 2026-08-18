import type { Material, WebGLProgramParametersWithUniforms } from 'three';

/**
 * 遠處不取樣細節貼圖 —— **一份材質，逐 instance 決定**。
 *
 * ## 為什麼不需要「逐 instance 的材質」
 *
 * 直覺會想成「遠的用便宜材質、近的用貴的」，而那需要同一批 instance 裡用不同
 * 材質 —— 一個 `BatchedMesh` 做不到（一份幾何、一次 multi-draw）。
 *
 * 但 Three 的 batching shader 已經把每個 instance 的世界矩陣放進 vertex shader
 * 了（`batchingMatrix`）。所以一份材質就夠：在 shader 裡算出「這個 instance 在
 * 螢幕上多大」，再決定要不要取樣。
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
 * 同樣兩張貼圖，差三倍。**這筆錢只在物件夠大時才付得有價值**，而「夠大」是
 * 可以逐 instance 判斷的。
 *
 * ## 為什麼預設關
 *
 * 少取樣 normal 會讓遠處變平 —— **那是改變畫面**，屬於開發者（doctrine 四問的
 * 第一問）。引擎把成本算出來、把旋鈕交出去，不自己訂門檻。
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
  /** 投影半徑小於這麼多像素時，停止取樣細節貼圖。 */
  pixels: number;
  /** 單一 instance 未縮放時的包圍球半徑。用來把縮放換算成螢幕大小。 */
  baseRadius: number;
}

export interface MaterialDetailHandle {
  /** 每幀更新：每單位距離幾個像素。與選階用的是同一個值。 */
  setProjectionScale(ppu: number): void;
}

/** 取樣前先把導數算好 —— 分支裡算的話就是未定義行為。 */
function guardedSample(original: string, declaration: string, uv: string, sampler: string): string {
  return [
    `vec2 wwDx_${sampler} = dFdx( ${uv} );`,
    `vec2 wwDy_${sampler} = dFdy( ${uv} );`,
    `${declaration};`,
    `if ( vWWDetail > 0.0 ) {`,
    `  ${original.replace(`texture2D( ${sampler}, ${uv} )`, `textureGrad( ${sampler}, ${uv}, wwDx_${sampler}, wwDy_${sampler} )`)}`,
    `}`,
  ].join('\n');
}

export function installMaterialDetail(
  material: Material,
  options: MaterialDetailOptions,
): MaterialDetailHandle {
  const ppu = { value: 1 };
  const pixels = { value: options.pixels };
  const baseRadius = { value: options.baseRadius };

  const previous = material.onBeforeCompile;

  material.onBeforeCompile = (
    shader: WebGLProgramParametersWithUniforms,
    ...rest: unknown[]
  ): void => {
    // 使用者可能自己掛過一個 —— 蓋掉別人的鉤子等於靜靜改變他的材質。
    (previous as (...args: unknown[]) => void)?.call(material, shader, ...rest);

    shader.uniforms.wwPpu = ppu;
    shader.uniforms.wwDetailPixels = pixels;
    shader.uniforms.wwBaseRadius = baseRadius;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'varying float vWWDetail;',
          'uniform float wwPpu;',
          'uniform float wwDetailPixels;',
          'uniform float wwBaseRadius;',
        ].join('\n'),
      )
      .replace(
        '#include <project_vertex>',
        [
          '#include <project_vertex>',
          '#ifdef USE_BATCHING',
          // batchingMatrix 的第一欄長度就是這個 instance 的縮放。
          '  float wwScale = length( batchingMatrix[ 0 ].xyz );',
          '#else',
          '  float wwScale = 1.0;',
          '#endif',
          '  float wwDistance = max( - mvPosition.z, 1e-4 );',
          '  float wwPixels = wwScale * wwBaseRadius * wwPpu / wwDistance;',
          // 軟邊界：硬切會讓整批在同一個距離上一起變平，那個跳變比變平本身
          // 還明顯。
          '  vWWDetail = smoothstep( wwDetailPixels * 0.75, wwDetailPixels, wwPixels );',
        ].join('\n'),
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWWDetail;')
      .replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        guardedSample(
          'mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
          'vec3 mapN = vec3( 0.0, 0.0, 1.0 )',
          'vNormalMapUv',
          'normalMap',
        ),
      )
      .replace(
        'vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );',
        guardedSample(
          'texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );',
          'vec4 texelRoughness = vec4( 1.0 )',
          'vRoughnessMapUv',
          'roughnessMap',
        ),
      )
      .replace(
        'vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );',
        guardedSample(
          'texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );',
          'vec4 texelMetalness = vec4( 1.0 )',
          'vMetalnessMapUv',
          'metalnessMap',
        ),
      );
  };
  material.needsUpdate = true;

  return {
    setProjectionScale: (value: number): void => {
      ppu.value = value;
    },
  };
}
