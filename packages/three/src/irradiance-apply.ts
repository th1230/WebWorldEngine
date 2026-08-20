/**
 * 把烘好的間接光接到使用者的材質上。
 *
 * 契約只有一條：`volume.uniforms()`。其餘全部是 Three 的材質那一側 ——
 * `onBeforeCompile` 的注入（WebGL）與 node 那條路的非同步載入（WebGPU）。
 *
 * 與 `applyShadows` 同一個形狀，連坑都一樣：`onBeforeCompile` 是**單一插槽**，
 * 所以這裡也是先接住原本那個再包起來。
 */
import type { Material, Object3D } from 'three';
import { IRRADIANCE_SAMPLE_GLSL, IRRADIANCE_UNIFORMS_GLSL } from './irradiance-glsl.ts';
import { type IrradianceVolume } from './irradiance.ts';

/**
 * 把 `root` 底下每個材質接上這個體積的間接光。
 *
 * ```js
 * WW.applyIrradiance(volume, scene);
 * ```
 *
 * 與 `applyShadows` 同一個形狀，連坑都一樣：`onBeforeCompile` 是**單一插槽**，
 * 所以這裡也是先接住原本那個再包起來。順序不重要。
 *
 * @returns 接了幾個材質。
 */
export function applyIrradiance(volume: IrradianceVolume, root: Object3D): number {
  const seen = new Set<Material>();
  const uniforms = volume.uniforms();

  root.traverse((object) => {
    const material = (object as { material?: Material | Material[] }).material;
    if (material === undefined) return;
    for (const one of Array.isArray(material) ? material : [material]) {
      if (seen.has(one)) continue;
      seen.add(one);
      inject(one, uniforms, volume);
    }
  });

  if (seen.size === 0) {
    console.warn(
      'WW.applyIrradiance: 這個 root 底下沒有任何材質，所以一個都沒接上 —— 場景不會有間接光。\n' +
        '通常是傳錯物件了（要傳 scene 或含有 mesh 的節點）。',
    );
  }
  return seen.size;
}

/** 已經接過的材質不再接第二次 —— 同一份材質被很多物件共用是常態。 */
const injected = new WeakSet<Material>();
/** node 材質那條路是非同步接上的，這裡記著還沒好的。 */
const pendingNodes = new Set<Promise<unknown>>();

/**
 * 等 node 材質那條路接完。
 *
 * WebGL 那條路是同步的（`onBeforeCompile` 只是設一個函式），但 node 那條
 * 要動態 import `three/tsl`，所以它是非同步的。
 *
 * **不等的話前幾幀是沒有間接光的**，而量測如果剛好落在那幾幀裡，會量到
 * 「沒有效果」然後把它讀成實作沒接上 —— 這個專案在 VAT 上就是因為量錯
 * 時機而得出過三倍的假結論。
 *
 * ```js
 * WW.applyIrradiance(volume, scene);
 * await WW.irradianceNodeReady();   // WebGPU 上要等；WebGL 上立刻返回
 * ```
 */
export async function irradianceNodeReady(): Promise<void> {
  await Promise.all([...pendingNodes]);
}
/** 只吼一次。整個場景都是 basic 材質的話會有幾百個。 */
let warnedUnlit = false;

function inject(
  material: Material,
  uniforms: Record<string, { value: unknown }>,
  volume: IrradianceVolume,
): void {
  if (injected.has(material)) return;
  injected.add(material);

  // ## node 材質走另一條路
  //
  // `onBeforeCompile` 是 WebGL 那條路的鉤子，`WebGPURenderer` 的編譯**完全
  // 不經過它**。在這裡不分流的話，WebGPU 上是靜靜地完全沒有間接光 —— 看
  // 起來像「烘壞了」或「這個場景本來就這麼暗」。
  //
  // 這個專案在 VAT 上踩過一模一樣的坑（實作在 WebGL、量測在 WebGPU），
  // 所以那之後的規矩是兩邊一起做、兩邊一起驗。
  if ((material as { isNodeMaterial?: boolean }).isNodeMaterial === true) {
    // 動態 import，所以是非同步的。失敗要吼出來 —— 靜靜跳過就回到上面那個
    // 「看起來像烘壞了」的狀態。
    const pending = import('./irradiance-node.ts')
      .then((m) => m.applyIrradianceNode(material as never, volume))
      .catch((error: unknown) => {
        console.error('WW.applyIrradiance: node 材質那條路接失敗，WebGPU 上不會有間接光。', error);
      })
      .finally(() => pendingNodes.delete(pending));
    pendingNodes.add(pending);
    return;
  }

  const previous = material.onBeforeCompile;

  material.onBeforeCompile = function (
    this: Material,
    ...args: Parameters<Material['onBeforeCompile']>
  ): void {
    previous.apply(this, args);

    const shader = args[0] as {
      uniforms: Record<string, { value: unknown }>;
      vertexShader: string;
      fragmentShader: string;
    };
    Object.assign(shader.uniforms, uniforms);

    // ## 世界座標要自己傳下來
    //
    // Three 的片段著色器手上沒有世界座標（`vViewPosition` 是視空間的）。
    // 而探針體積是定義在世界裡的，用視空間查表的話**鏡頭一動間接光就跟著
    // 飄** —— 那是最典型的「看起來像在閃」的錯。
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 wwWorldPos;')
      .replace(
        '#include <worldpos_vertex>',
        // `worldpos_vertex` 只有在需要的時候才會定義 `worldPosition`，所以
        // 這裡自己算一份，不依賴那個條件。
        '#include <worldpos_vertex>\nwwWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );

    // ## 沒有光照的材質接不上，而且是**靜靜地**接不上
    //
    // `MeshBasicMaterial` 這一類根本不做光照，它的片段著色器裡沒有
    // `lights_fragment_maps` 這個插入點。字串取代找不到目標時不會報錯，
    // 只是原樣返回 —— 於是那個材質完全沒有間接光，其他材質有。
    //
    // 那正是這個專案最怕的形狀：局部失效、沒有錯誤、看起來像「烘得不夠亮」。
    if (!shader.fragmentShader.includes('#include <lights_fragment_maps>')) {
      if (!warnedUnlit) {
        warnedUnlit = true;
        console.warn(
          [
            'WW.applyIrradiance: 有材質不做光照（例如 MeshBasicMaterial），接不上間接光。',
            '症狀是那些東西看起來比周圍平，而且不會有任何錯誤訊息。',
            '要間接光的話換成 MeshStandardMaterial 這一類會受光的材質。',
          ].join('\n'),
        );
      }
      return;
    }

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 wwWorldPos;
${IRRADIANCE_UNIFORMS_GLSL}
${IRRADIANCE_SAMPLE_GLSL}`,
      )
      // 接在 IBL 那一段之後：那裡正好是 `irradiance` 已經備妥、還沒被
      // `RE_IndirectDiffuse` 吃掉的位置。
      .replace(
        '#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\nirradiance += wwIrradiance( wwWorldPos, inverseTransformDirection( normal, viewMatrix ) );',
      );
  };

  material.needsUpdate = true;
}
