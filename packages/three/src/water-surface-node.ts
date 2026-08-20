/* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的，見 fullscreen-node.ts */
import {
  createDepthConvention,
  loadTsl,
  loadWebGPU,
  texture2DPlaceholder,
} from './fullscreen-node.ts';
import { createReflectionProbeSampler } from './reflection-probes-node.ts';
import type { Color, Texture, Vector3 } from 'three';
import type { ReflectionProbes } from './reflection-probes.ts';
import type { Water } from './water.ts';

/**
 * 水面的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 與前面四個效果不同，這一個是**掛在網格上的材質**，不是全螢幕 pass ——
 * 所以頂點那一段（波形位移與法線）也要有 TSL 版。
 *
 * 位移讀的是 `water.displacementNode(tsl)`，而它與 `displacementGLSL()`、
 * 與 CPU 的 `heightAt` 讀的是**同一個 `packed`**。三者不可能分岔，而那正是
 * `water.ts` 存在的理由 —— 多一個後端不該讓它變成三份各自的實作。
 *
 * 逐行對照 `water-surface.ts`。兩份一不一致由跨後端關卡量。
 */

export interface WaterSurfaceNodeHandle {
  material: unknown;
  setTime: (time: number) => void;
  setScene: (color: Texture, depth: Texture) => void;
  setCamera: (near: number, far: number) => void;
  setProbes: (probes: ReflectionProbes | null) => void;
  setParams: (params: {
    absorption: readonly [number, number, number];
    scatter: Color;
    refraction: number;
    foamDepth: number;
    crestFoam: number;
    sunDirection: Vector3;
    sunColor: Color;
    sky: Color;
    reflectivity: number;
    waterLevel: number;
  }) => void;
  setConvention: (renderer: unknown) => void;
  setDebug: (mode: number) => void;
}

export async function createWaterSurfaceNodeMaterial(
  water: Water,
): Promise<WaterSurfaceNodeHandle> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const {
    Fn,
    If,
    float,
    vec2,
    vec3,
    vec4,
    uniform,
    texture,
    normalize,
    cross,
    dot,
    reflect,
    mix,
    exp,
    pow,
    max,
    clamp,
    smoothstep,
    screenUV,
    positionLocal,
    modelWorldMatrix,
    modelWorldMatrixInverse,
    cameraPosition,
    cameraViewMatrix,
    varying,
    perspectiveDepthToViewZ,
    cos,
    sin,
  } = tsl;

  const probes = createReflectionProbeSampler(tsl, webgpu);
  const convention = createDepthConvention(tsl);
  const displace = water.displacementNode(tsl as never);

  const tScene = texture(texture2DPlaceholder(webgpu));
  const tSceneDepth = texture(texture2DPlaceholder(webgpu));
  const uTime = uniform(float(0));
  const uNear = uniform(float(0.1));
  const uFar = uniform(float(1000));
  const uAbsorption = uniform(vec3(0.35, 0.08, 0.045));
  const uScatter = uniform(new webgpu.Color(0x0a2b33));
  const uRefraction = uniform(float(0.05));
  const uFoamDepth = uniform(float(1.5));
  const uCrestFoam = uniform(float(0));
  const uWaterLevel = uniform(float(0));
  const uSunDirection = uniform(vec3(0.4, 0.7, 0.35));
  const uSunColor = uniform(new webgpu.Color(0xffffff));
  const uSky = uniform(new webgpu.Color(0x86a8c8));
  const uReflectivity = uniform(float(1));
  const uHasProbes = uniform(float(0));
  /** 與 GLSL 那份同號：1 世界座標、2 travelled、3 泡沫、4 菲涅耳、5 法線。 */
  const uDebug = uniform(float(0));

  /** 世界座標與法線 —— 頂點與片段都要，所以算一次傳過去。 */
  const surface = (): { position: any; normal: any } => {
    const base = modelWorldMatrix.mul(vec4(positionLocal, 1));
    const step = float(0.5);
    const here = displace(vec2(base.x, base.z), uTime);
    const alongX = displace(vec2(base.x.add(step), base.z), uTime);
    const alongZ = displace(vec2(base.x, base.z.add(step)), uTime);

    const p0 = vec3(base.x.add(here.x), here.y, base.z.add(here.z));
    const px = vec3(base.x.add(step).add(alongX.x), alongX.y, base.z.add(alongX.z));
    const pz = vec3(base.x.add(alongZ.x), alongZ.y, base.z.add(step).add(alongZ.z));

    const n = normalize(cross(pz.sub(p0), px.sub(p0)));
    // 叉積的方向取決於兩條切線的順序，而水面法線一定朝上。
    const up = mix(n.negate(), n, n.y.greaterThan(0));
    return { position: p0, normal: up };
  };

  /**
   * `positionNode` 要的是**區域座標**，不是世界座標。
   *
   * 波形是在世界空間算的（`heightAt` 與 GLSL 那份都是），所以算完要換回去 ——
   * 直接回世界座標的話模型矩陣會被套第二次。這個網格躺平時的矩陣是繞 X 轉
   * −90 度，套兩次就是轉 180 度，水面翻到相機後面去，而畫面上看起來只是
   * 「水沒有畫出來」。
   */
  const positionNode = Fn(() => modelWorldMatrixInverse.mul(vec4(surface().position, 1)).xyz)();

  /**
   * 深度緩衝的值 → 視空間的距離（正值）。
   *
   * 用 TSL 自己的 `perspectiveDepthToViewZ`，不要手寫。手寫的那條式子是
   * **WebGL 的**（clip 的 z 在 −1…1），而 WebGPU 是 0…1 —— 兩者的線性化不
   * 一樣。實測手寫的版本把水底算遠了大約兩倍，於是 `travelled` 大六倍，
   * 而水色整片偏向散射色。
   *
   * 這一支是 Three 依 builder 的座標系產生的，所以兩個後端都對。
   */
  const linearDepth = (raw: any): any => perspectiveDepthToViewZ(raw, uNear, uFar).negate();

  /**
   * 世界座標與法線走 **varying**，不是在片段裡重算。
   *
   * GLSL 那份是 `varying vec3 vWorldPosition` —— 片段拿到的是光柵化**插值**
   * 出來的值。在片段裡重算波形算出來的是「真正的曲面」，兩者差一個 quad 內
   * 的插值誤差（這個網格 256×256 蓋 300 單位，一格 1.2 單位，浪高約 1，
   * 所以誤差是 0.1–0.3）。
   *
   * 那個誤差在深水處無所謂，但岸邊的 `travelled` 只有 2 左右 —— 於是泡沫
   * 的量差一大截。實測近岸那一列兩邊差 300%，而中段與遠處只差 2–7%。
   */
  const vWorldPosition = varying(Fn(() => surface().position)(), 'wwWaterPosition');
  const vWorldNormal = varying(Fn(() => surface().normal)(), 'wwWaterNormal');

  const fragment = Fn(() => {
    const position = vWorldPosition;
    const normal = normalize(vWorldNormal);
    // ## `screenUV` 不必再翻 V
    //
    // 全螢幕 pass 用的是四邊形的 `uv()` 屬性，那個要補 flipV（TSL 取樣
    // render target 時會自動翻）。而 `screenUV` 本來就是螢幕的座標，與那些
    // 貼圖同一個約定 —— 再翻一次就取樣到鏡像的那一列。
    //
    // 實測：畫面下方的水讀到上方天空的深度（約 600 而不是 50），於是
    // `travelled` 飽和，整片水都是散射色，而且**改 surfaceDistance 完全沒有
    // 反應**（那個「改了卻沒差」正是查到這裡的線索）。
    const screenUvRaw = screenUV;
    const viewDirection = normalize(cameraPosition.sub(position)).toVar();

    // ## 這裡要的是**視空間的垂直深度**，不是歐氏距離
    //
    // GLSL 那份是 `wwLinearDepth( gl_FragCoord.z )`，而深度緩衝線性化出來的
    // 是「沿著相機朝向的那一段」，不是「相機到這一點的直線距離」。兩者在
    // 畫面中央幾乎一樣，越靠邊差越多。
    //
    // 而 `travelled` 是這個量與場景深度**相減** —— 兩邊用不同的量的話差值
    // 就沒有意義。實測畫面近處差到 58%，遠處只差 2%（那裡幾乎全是反射，
    // 折射的權重很低），那個分布正好指向這裡。
    const surfaceDistance = cameraViewMatrix.mul(vec4(position, 1)).z.negate().toVar();

    const offset = normal.xz.mul(uRefraction).div(surfaceDistance.mul(0.05).add(1)).toVar();
    const refractedUv = clamp(screenUvRaw.add(offset), 0, 1).toVar();

    const refractedDistance = linearDepth(tSceneDepth.sample(refractedUv)).toVar();
    // 推到「水面前面的東西」上就不推。
    If(refractedDistance.lessThan(surfaceDistance), () => {
      refractedUv.assign(screenUvRaw);
      refractedDistance.assign(linearDepth(tSceneDepth.sample(screenUvRaw)));
    });

    const bottom = tScene.sample(refractedUv).rgb.toVar();
    const travelled = max(refractedDistance.sub(surfaceDistance), 0).toVar();

    // 水色是**吸收**出來的，不是塗上去的。
    const transmittance = exp(uAbsorption.negate().mul(travelled)).toVar();
    const refracted = bottom
      .mul(transmittance)
      .add(vec3(uScatter).mul(float(1).sub(transmittance)))
      .toVar();

    const reflectDirection = reflect(viewDirection.negate(), normal).toVar();
    const reflected = vec3(uSky).toVar();
    If(uHasProbes.greaterThan(0.5), () => {
      reflected.assign(probes.at(position, reflectDirection, vec3(uSky)));
    });

    // 菲涅耳（Schlick）。水的 F0 是 0.02。
    const cosTheta = clamp(dot(normal, viewDirection), 0, 1).toVar();
    const fresnel = float(0.02)
      .add(pow(float(1).sub(cosTheta), 5).mul(0.98))
      .mul(uReflectivity)
      .toVar();

    const color = mix(refracted, reflected, fresnel).toVar();

    // 岸邊的泡沫：判準是水很淺。
    const foam = float(1)
      .sub(smoothstep(0, uFoamDepth, travelled))
      .toVar();
    const crest = float(0).toVar();
    If(uCrestFoam.greaterThan(0), () => {
      crest.assign(smoothstep(uCrestFoam, uCrestFoam.mul(1.6), position.y.sub(uWaterLevel)));
    });
    foam.assign(clamp(foam.add(crest), 0, 1));
    color.assign(mix(color, vec3(1, 1, 1), foam.mul(0.85)));

    // 太陽的高光。
    const halfway = normalize(uSunDirection.add(viewDirection)).toVar();
    const specular = pow(max(dot(normal, halfway), 0), 200).toVar();
    color.addAssign(vec3(uSunColor).mul(specular).mul(float(1).sub(foam)));

    // 中間值印成畫面。號碼與 GLSL 那份**一樣** —— 不一樣的話跨後端比中間值
    // 時會比到不同的東西，而那比不比更糟。
    const out = vec3(color).toVar();
    If(uDebug.equal(1), () => {
      out.assign(position);
    });
    If(uDebug.equal(2), () => {
      out.assign(vec3(travelled));
    });
    If(uDebug.equal(3), () => {
      out.assign(vec3(foam));
    });
    If(uDebug.equal(4), () => {
      out.assign(vec3(fresnel));
    });
    If(uDebug.equal(5), () => {
      out.assign(normal.mul(0.5).add(0.5));
    });
    If(uDebug.equal(6), () => {
      out.assign(refracted);
    });
    If(uDebug.equal(7), () => {
      out.assign(reflected);
    });
    If(uDebug.equal(8), () => {
      out.assign(vec3(surfaceDistance));
    });
    If(uDebug.equal(9), () => {
      out.assign(vec3(refractedDistance));
    });
    If(uDebug.equal(10), () => {
      const uvOffset = refractedUv.sub(screenUvRaw);
      out.assign(vec3(uvOffset.x, uvOffset.y, 0));
    });
    return vec4(out, 1);
  });

  const material = new webgpu.NodeMaterial();
  material.positionNode = positionNode;
  material.fragmentNode = fragment();
  // 只畫正面 —— 從水底下看是另一套物理，見 `water-surface.ts`。
  material.side = webgpu.FrontSide;
  void cos;
  void sin;

  return {
    material,
    setTime: (time) => {
      uTime.value = time;
    },
    setScene: (color, depth) => {
      tScene.value = color;
      tSceneDepth.value = depth;
    },
    setCamera: (near, far) => {
      uNear.value = near;
      uFar.value = far;
    },
    setProbes: (source) => {
      if (source === null) {
        uHasProbes.value = 0;
        return;
      }
      probes.update(source);
      uHasProbes.value = 1;
    },
    setParams: (params) => {
      (uAbsorption.value as { set: (x: number, y: number, z: number) => void }).set(
        params.absorption[0],
        params.absorption[1],
        params.absorption[2],
      );
      (uScatter.value as { copy: (c: unknown) => void }).copy(params.scatter);
      uRefraction.value = params.refraction;
      uFoamDepth.value = params.foamDepth;
      uCrestFoam.value = params.crestFoam;
      (uSunDirection.value as Vector3).copy(params.sunDirection);
      (uSunColor.value as { copy: (c: unknown) => void }).copy(params.sunColor);
      (uSky.value as { copy: (c: unknown) => void }).copy(params.sky);
      uReflectivity.value = params.reflectivity;
      uWaterLevel.value = params.waterLevel;
    },
    setDebug: (mode) => {
      uDebug.value = mode;
    },
    setConvention: (renderer) => {
      convention.set(renderer);
    },
  };
}
