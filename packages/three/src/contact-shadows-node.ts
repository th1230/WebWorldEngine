/* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的，見 fullscreen-node.ts */
import {
  createDepthConvention,
  flipV,
  loadTsl,
  loadWebGPU,
  sampleDepth,
  texture2DPlaceholder,
  viewPositionFromDepth,
} from './fullscreen-node.ts';
import type { Matrix4, Texture, Vector3 } from 'three';

/**
 * 接觸陰影的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 逐行對照 `contact-shadows.ts` 的 GLSL 轉寫。同樣的早退、同樣的步數上限、
 * 同樣的推開量 —— 「換一種寫法但等價」在兩邊算出不同答案的時候查不動。
 *
 * 兩份一不一致由 `tools/gpu-check/cross-backend.mjs` 量。
 */

export interface ContactShadowsNodeHandle {
  material: unknown;
  setTextures: (normal: Texture, depth: Texture) => void;
  setMatrices: (projection: Matrix4, projectionInverse: Matrix4) => void;
  setLight: (direction: Vector3) => void;
  setDebug: (mode: number) => void;
  /** 深度約定要跟著 renderer 走。 */
  setConvention: (renderer: unknown) => void;
  setParams: (params: {
    distance: number;
    steps: number;
    thickness: number;
    strength: number;
  }) => void;
}

export async function createContactShadowsNodeMaterial(): Promise<ContactShadowsNodeHandle> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const { Fn, Loop, If, Break, float, vec3, vec4, uniform, uv, texture, normalize, dot, mat4 } =
    tsl;

  // `texture(null)` 建不起來，所以先給一張佔位的 —— `setTextures` 之後會換掉。
  const tNormal = texture(texture2DPlaceholder(webgpu));
  const tDepth = texture(texture2DPlaceholder(webgpu));
  const uProjection = uniform(mat4());
  const uProjectionInverse = uniform(mat4());
  const uLightDirection = uniform(vec3(0, 1, 0));
  const uDistance = uniform(float(0.4));
  const uSteps = uniform(float(16));
  const uThickness = uniform(float(0.25));
  const uStrength = uniform(float(1));
  /** 中間值印成畫面。0 正常，1 原始深度，2 法線，3 視空間 z，4 面向光的程度。 */
  const uDebug = uniform(float(0));
  // 裝置深度 → NDC z：兩個座標系不一樣，見 createDepthConvention。
  const convention = createDepthConvention(tsl);

  const fragment = Fn(() => {
    const screenUv = uv();
    const rawDepth = sampleDepth(tsl, tDepth, screenUv).toVar();
    const result = float(1).toVar();
    const stepsReached = float(0).toVar();

    // 天空：沒有東西就沒有接觸。GLSL 那份是 `return`，TSL 沒有提前 return，
    // 所以整段包在 If 裡 —— 結構不同，算出來的東西一樣。
    If(rawDepth.lessThan(1), () => {
      const origin = viewPositionFromDepth(
        tsl,
        screenUv,
        rawDepth,
        uProjectionInverse,
        convention,
      ).toVar();
      const normal = normalize(tNormal.sample(flipV(tsl, screenUv)).xyz.mul(2).sub(1)).toVar();
      // 往光源走（uLightDirection 是照過來的方向，所以要取負）。
      const toLight = normalize(uLightDirection.negate()).toVar();

      // 背光面本來就在陰影裡，追它只是白花步數。
      If(dot(normal, toLight).greaterThan(0), () => {
        // 沿著法線推開一點點再開始。不推的話第一步就打到自己，整個畫面變黑。
        const start = origin.add(normal.mul(uThickness).mul(0.5)).toVar();
        const stepLength = uDistance.div(uSteps).toVar();
        const occlusion = float(0).toVar();
        const reached = float(0).toVar();

        Loop({ start: 1, end: 33, type: 'int', condition: '<' }, ({ i }: any) => {
          If(float(i).greaterThan(uSteps), () => {
            Break();
          });
          reached.assign(float(i));
          const samplePoint = start.add(toLight.mul(stepLength.mul(float(i)))).toVar();
          const clip = uProjection.mul(vec4(samplePoint, 1)).toVar();
          If(clip.w.lessThanEqual(0), () => {
            Break();
          });
          const sampleUv = clip.xy.div(clip.w).mul(0.5).add(0.5).toVar();
          // 畫面外就沒有資料了 —— 這是螢幕空間的本質限制，不是可以補的。
          If(
            sampleUv.x
              .lessThan(0)
              .or(sampleUv.x.greaterThan(1))
              .or(sampleUv.y.lessThan(0))
              .or(sampleUv.y.greaterThan(1)),
            () => {
              Break();
            },
          );

          const sceneRaw = sampleDepth(tsl, tDepth, sampleUv).toVar();
          // ## 這裡刻意**不用** `Continue()`
          //
          // GLSL 那份是 `if (sceneRaw >= 1.0) continue;`。TSL 也有 `Continue()`，
          // 而實測把它放在 `If` 裡面時整個迴圈提早結束 —— 於是永遠找不到遮蔽，
          // 結果恆為 1，而且不報錯。
          //
          // 換成把後面整段包進 `If(sceneRaw < 1)` —— 語意一模一樣（跳過這一步），
          // 而且不依賴那個行為。
          If(sceneRaw.lessThan(1), () => {
            const scenePoint = viewPositionFromDepth(
              tsl,
              sampleUv,
              sceneRaw,
              uProjectionInverse,
              convention,
            ).toVar();

            // 視空間的 z 是負的，越靠近相機越大。場景比取樣點更靠近相機 = 擋住了。
            const difference = scenePoint.z.sub(samplePoint.z).toVar();
            If(difference.greaterThan(0).and(difference.lessThan(uThickness)), () => {
              occlusion.assign(1);
              Break();
            });
          });
        });

        result.assign(float(1).sub(occlusion.mul(uStrength)));
        stepsReached.assign(reached);
      });
    });

    const debugged = vec3(result).toVar();
    If(uDebug.equal(1), () => {
      debugged.assign(vec3(rawDepth));
    });
    If(uDebug.equal(2), () => {
      debugged.assign(tNormal.sample(flipV(tsl, screenUv)).xyz);
    });
    // 9/10/11：參數本身。設錯的話上面每一個中間值看起來都正常，只有結果不對。
    If(uDebug.equal(9), () => {
      debugged.assign(vec3(uThickness.mul(4)));
    });
    If(uDebug.equal(10), () => {
      debugged.assign(vec3(uSteps.div(32)));
    });
    If(uDebug.equal(11), () => {
      debugged.assign(vec3(uDistance.mul(0.5)));
    });
    // 13：迴圈裡**最小的正差值**除以 4。小於 0.3 就代表它落在厚度 1.2 之內，
    //     那時遮蔽本來就該成立。
    If(uDebug.equal(13), () => {
      const o = viewPositionFromDepth(
        tsl,
        screenUv,
        rawDepth,
        uProjectionInverse,
        convention,
      ).toVar();
      const n = normalize(tNormal.sample(flipV(tsl, screenUv)).xyz.mul(2).sub(1)).toVar();
      const l = normalize(uLightDirection.negate()).toVar();
      const st = o.add(n.mul(uThickness).mul(0.5)).toVar();
      const sl = uDistance.div(uSteps).toVar();
      const smallest = float(99).toVar();
      Loop({ start: 1, end: 33, type: 'int', condition: '<' }, ({ i }: any) => {
        If(float(i).greaterThan(uSteps), () => {
          Break();
        });
        const sp = st.add(l.mul(sl.mul(float(i)))).toVar();
        const c = uProjection.mul(vec4(sp, 1)).toVar();
        const su = c.xy.div(c.w).mul(0.5).add(0.5).toVar();
        const sr = sampleDepth(tsl, tDepth, su).toVar();
        If(sr.lessThan(1), () => {
          const scp = viewPositionFromDepth(tsl, su, sr, uProjectionInverse, convention);
          const d = scp.z.sub(sp.z);
          If(d.greaterThan(0), () => {
            smallest.assign(smallest.min(d));
          });
        });
      });
      debugged.assign(vec3(smallest.div(4)));
    });
    // 14：厚度本身除以 4（1.2 → 0.3）。乘 4 那個版本會飽和，分不出 0.25 與 1.2。
    If(uDebug.equal(14), () => {
      debugged.assign(vec3(uThickness.div(4)));
    });
    // 15：哪些像素被判為天空（早退）。白 = 有幾何，黑 = 天空。
    If(uDebug.equal(15), () => {
      const isGeometry = float(0).toVar();
      If(rawDepth.lessThan(1), () => {
        isGeometry.assign(1);
      });
      debugged.assign(vec3(isGeometry));
    });
    // 12：迴圈實際跑到第幾步（除以 16）。提早 break 的話這個數字會很小。
    If(uDebug.equal(12), () => {
      debugged.assign(vec3(stepsReached.div(16)));
    });
    // 7：面向光的程度。這個閘門把整片擋掉的話，結果會恆為 1。
    If(uDebug.equal(7), () => {
      const n7 = normalize(tNormal.sample(flipV(tsl, screenUv)).xyz.mul(2).sub(1));
      debugged.assign(vec3(dot(n7, normalize(uLightDirection.negate())).mul(0.5).add(0.5)));
    });
    // 8：迴圈裡看到的最大深度差（除以 thickness）。> 1 代表打到但被厚度擋掉，
    //    ≤ 0 代表根本沒有東西擋在前面。
    If(uDebug.equal(8), () => {
      const o8 = viewPositionFromDepth(
        tsl,
        screenUv,
        rawDepth,
        uProjectionInverse,
        convention,
      ).toVar();
      const n8 = normalize(tNormal.sample(flipV(tsl, screenUv)).xyz.mul(2).sub(1)).toVar();
      const l8 = normalize(uLightDirection.negate()).toVar();
      const s8 = o8.add(n8.mul(uThickness).mul(0.5)).toVar();
      const step8 = uDistance.div(uSteps).toVar();
      const best = float(-1).toVar();
      Loop({ start: 1, end: 33, type: 'int', condition: '<' }, ({ i }: any) => {
        If(float(i).greaterThan(uSteps), () => {
          Break();
        });
        const sp = s8.add(l8.mul(step8.mul(float(i)))).toVar();
        const c = uProjection.mul(vec4(sp, 1)).toVar();
        const su = c.xy.div(c.w).mul(0.5).add(0.5).toVar();
        const sr = sampleDepth(tsl, tDepth, su).toVar();
        If(sr.lessThan(1), () => {
          const scp = viewPositionFromDepth(tsl, su, sr, uProjectionInverse, convention);
          best.assign(best.max(scp.z.sub(sp.z).div(uThickness)));
        });
      });
      debugged.assign(vec3(best.mul(0.5).add(0.5)));
    });
    // 4：把自己的位置投影回 UV 再取一次深度。與 1 相同代表投影往返是對的；
    //    不同就代表取樣座標被翻轉了（TSL 對 render target 會自動套 flipY）。
    If(uDebug.equal(4), () => {
      const origin4 = viewPositionFromDepth(
        tsl,
        screenUv,
        rawDepth,
        uProjectionInverse,
        convention,
      );
      const clip4 = uProjection.mul(vec4(origin4, 1));
      const uv4 = clip4.xy.div(clip4.w).mul(0.5).add(0.5);
      debugged.assign(vec3(sampleDepth(tsl, tDepth, uv4)));
    });
    // 5：片段自己的 uv 的 y。6：投影往返算出來的 y。兩者相加為 1 就是翻轉了。
    If(uDebug.equal(5), () => {
      debugged.assign(vec3(screenUv.y));
    });
    If(uDebug.equal(6), () => {
      const origin6 = viewPositionFromDepth(
        tsl,
        screenUv,
        rawDepth,
        uProjectionInverse,
        convention,
      );
      const clip6 = uProjection.mul(vec4(origin6, 1));
      debugged.assign(vec3(clip6.y.div(clip6.w).mul(0.5).add(0.5)));
    });
    If(uDebug.equal(3), () => {
      debugged.assign(
        vec3(
          viewPositionFromDepth(tsl, screenUv, rawDepth, uProjectionInverse, convention)
            .z.negate()
            .div(50),
        ),
      );
    });
    return vec4(debugged, 1);
  });

  const material = new webgpu.NodeMaterial();
  material.fragmentNode = fragment();
  material.depthTest = false;
  material.depthWrite = false;

  return {
    material,
    setTextures: (normal, depth) => {
      tNormal.value = normal;
      tDepth.value = depth;
    },
    setMatrices: (projection, projectionInverse) => {
      (uProjection.value as Matrix4).copy(projection);
      (uProjectionInverse.value as Matrix4).copy(projectionInverse);
    },
    setLight: (direction) => {
      (uLightDirection.value as Vector3).copy(direction);
    },
    setConvention: (renderer) => {
      convention.set(renderer);
    },
    setDebug: (mode) => {
      uDebug.value = mode;
    },
    setParams: (params) => {
      uDistance.value = params.distance;
      uSteps.value = params.steps;
      uThickness.value = params.thickness;
      uStrength.value = params.strength;
    },
  };
}
