import type { Vector3 } from 'three';

/**
 * 天空的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * ## 為什麼一定要有第二份
 *
 * `WebGPURenderer` 不吃 `ShaderMaterial`：丟給它會在 `NodeBuilder` 裡直接
 * 報錯（`Material "ShaderMaterial" is not compatible.`）。所以只做 GLSL 那份
 * 的話，WebGPU 上不是「天空比較醜」，是**整個場景畫不出來**。
 *
 * 這與間接光、VAT 是同一個結構問題，而那兩個已經各有兩份。
 *
 * ## 兩份怎麼保證不分岔
 *
 * 註解寫「記得一起改」是沒有用的 —— 那正是這個專案一直在防的東西。所以這裡
 * 靠的是**量**：`tools/gpu-check/cross-backend.mjs` 在兩個後端跑同一個場景、
 * 讀同一批像素，不一致就紅。
 *
 * 間接光與 VAT 那兩份目前只驗「WebGPU 那邊有動」，沒有驗「兩邊一樣」——
 * 那道關卡把它們也一起蓋進去。
 *
 * ## 逐行轉寫，不是重新設計
 *
 * 下面的結構刻意與 `sky.ts` 的 GLSL 一行一行對得起來（同樣的常數、同樣的
 * 迴圈次數、同樣的早退）。看起來囉嗦，但「換一種寫法但等價」在出事的時候
 * 是查不動的 —— 兩邊長得一樣才比對得出哪一行不同。
 */

/** 與 GLSL 那份逐字相同的常數。改一個就要改兩個，而關卡會抓到沒改的那一邊。 */
const EARTH_RADIUS = 6371000;
const ATMOSPHERE_RADIUS = 6471000;
const RAYLEIGH_SCALE = 8000;
const MIE_SCALE = 1200;
const RAYLEIGH_BETA: readonly [number, number, number] = [5.5e-6, 13.0e-6, 22.4e-6];
const MIE_BETA = 21e-6;
const PRIMARY_STEPS = 16;
const LIGHT_STEPS = 8;

interface TslModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL 的 Fn 是可變參數的，型別在這裡只會擋路
  Fn: (fn: any) => (...args: unknown[]) => TslNode;
  Loop: (config: unknown, body: (state: { i: TslNode }) => void) => void;
  If: (condition: TslNode, body: () => void) => { Else: (body: () => void) => void };
  Break: () => void;
  Continue: () => void;
  float: (value: unknown) => TslNode;
  vec2: (...args: unknown[]) => TslNode;
  vec3: (...args: unknown[]) => TslNode;
  vec4: (...args: unknown[]) => TslNode;
  uniform: (value: unknown, type?: string) => TslUniform;
  positionLocal: TslNode;
  normalize: (v: TslNode) => TslNode;
  dot: (a: TslNode, b: TslNode) => TslNode;
  sqrt: (v: TslNode) => TslNode;
  exp: (v: TslNode) => TslNode;
  pow: (a: TslNode, b: unknown) => TslNode;
  length: (v: TslNode) => TslNode;
  min: (a: TslNode, b: unknown) => TslNode;
  select: (condition: TslNode, a: unknown, b: unknown) => TslNode;
}

interface TslNode {
  add: (v: unknown) => TslNode;
  sub: (v: unknown) => TslNode;
  mul: (v: unknown) => TslNode;
  div: (v: unknown) => TslNode;
  negate: () => TslNode;
  lessThan: (v: unknown) => TslNode;
  greaterThan: (v: unknown) => TslNode;
  toVar: () => TslNode;
  assign: (v: unknown) => void;
  addAssign: (v: unknown) => void;
  x: TslNode;
  y: TslNode;
  z: TslNode;
}

interface TslUniform {
  value: unknown;
}

export interface SkyNodeHandle {
  material: unknown;
  /** 太陽方向的 uniform —— 改它就會重畫，不必重建材質。 */
  setSun: (direction: Vector3) => void;
  setIntensity: (value: number) => void;
  setMieG: (value: number) => void;
}

/**
 * 建一個畫大氣的 node 材質。
 *
 * `three/tsl` 與 `three/webgpu` 是動態載入的 —— 只用 WebGL 的人不該為了這條
 * 路多下載一份。所以這支是非同步的。
 */
export async function createSkyNodeMaterial(options: {
  intensity: number;
  mieDirectional: number;
}): Promise<SkyNodeHandle> {
  const tsl = (await import('three/tsl')) as unknown as TslModule;
  const webgpu = (await import('three/webgpu')) as unknown as {
    NodeMaterial: new (parameters?: unknown) => { fragmentNode: unknown; needsUpdate: boolean };
    BackSide: number;
  };

  const {
    Fn,
    Loop,
    If,
    Break,
    Continue,
    float,
    vec2,
    vec3,
    vec4,
    uniform,
    positionLocal,
    normalize,
    dot,
    sqrt,
    exp,
    pow,
    length,
    min,
    select,
  } = tsl;

  const uSunDirection = uniform(vec3(0, 1, 0));
  const uIntensity = uniform(options.intensity);
  const uMieG = uniform(options.mieDirectional);

  /** 射線與球（以原點為心）的交點。與 GLSL 那份的 `raySphere` 逐行相同。 */
  const raySphere = Fn(([origin, direction, radius]: TslNode[]) => {
    const b = dot(origin!, direction!).toVar();
    const c = dot(origin!, origin!).sub(radius!.mul(radius!)).toVar();
    const d = b.mul(b).sub(c).toVar();
    const result = vec2(-1, -1).toVar();
    If(d.greaterThan(0), () => {
      const root = sqrt(d);
      result.assign(vec2(b.negate().sub(root), b.negate().add(root)));
    });
    return result;
  });

  const rayleighBeta = vec3(...RAYLEIGH_BETA);

  const fragment = Fn(() => {
    const direction = normalize(positionLocal).toVar();
    const sun = normalize(uSunDirection as unknown as TslNode).toVar();
    const origin = vec3(0, EARTH_RADIUS + 1, 0).toVar();

    const atmosphere = raySphere(origin, direction, float(ATMOSPHERE_RADIUS)).toVar();
    const color = vec3(0, 0, 0).toVar();

    If(atmosphere.y.greaterThan(0), () => {
      // 打到地面的話只積分到地面為止 —— 不切的話地平線下會亮得莫名其妙。
      const ground = raySphere(origin, direction, float(EARTH_RADIUS)).toVar();
      const far = select(ground.x.greaterThan(0), min(atmosphere.y, ground.x), atmosphere.y).toVar();

      const stepSize = far.div(PRIMARY_STEPS).toVar();
      const rayleighSum = vec3(0, 0, 0).toVar();
      const mieSum = vec3(0, 0, 0).toVar();
      const rayleighDepth = float(0).toVar();
      const mieDepth = float(0).toVar();

      Loop({ start: 0, end: PRIMARY_STEPS, type: 'int', condition: '<' }, ({ i }) => {
        const point = origin.add(direction.mul(float(i).add(0.5).mul(stepSize))).toVar();
        const height = length(point).sub(EARTH_RADIUS).toVar();
        const rayleighDensity = exp(height.negate().div(RAYLEIGH_SCALE)).mul(stepSize).toVar();
        const mieDensity = exp(height.negate().div(MIE_SCALE)).mul(stepSize).toVar();
        rayleighDepth.addAssign(rayleighDensity);
        mieDepth.addAssign(mieDensity);

        const lightHit = raySphere(point, sun, float(ATMOSPHERE_RADIUS)).toVar();
        const lightStep = lightHit.y.div(LIGHT_STEPS).toVar();
        const lightRayleigh = float(0).toVar();
        const lightMie = float(0).toVar();
        const blocked = float(0).toVar();

        Loop({ start: 0, end: LIGHT_STEPS, type: 'int', condition: '<' }, ({ i: j }) => {
          const lightPoint = point.add(sun.mul(float(j).add(0.5).mul(lightStep))).toVar();
          const lightHeight = length(lightPoint).sub(EARTH_RADIUS).toVar();
          If(lightHeight.lessThan(0), () => {
            blocked.assign(1);
            Break();
          });
          lightRayleigh.addAssign(exp(lightHeight.negate().div(RAYLEIGH_SCALE)).mul(lightStep));
          lightMie.addAssign(exp(lightHeight.negate().div(MIE_SCALE)).mul(lightStep));
        });

        If(blocked.greaterThan(0.5), () => {
          Continue();
        });

        // 進來與出去各衰減一次。
        const attenuation = exp(
          rayleighBeta
            .mul(rayleighDepth.add(lightRayleigh))
            .add(float(MIE_BETA).mul(mieDepth.add(lightMie)))
            .negate(),
        ).toVar();
        rayleighSum.addAssign(attenuation.mul(rayleighDensity));
        mieSum.addAssign(attenuation.mul(mieDensity));
      });

      const cosTheta = dot(direction, sun).toVar();
      const rayleighPhase = float(3 / (16 * Math.PI))
        .mul(cosTheta.mul(cosTheta).add(1))
        .toVar();
      const g = uMieG as unknown as TslNode;
      const gg = g.mul(g).toVar();
      const miePhase = float(1)
        .sub(gg)
        .div(pow(gg.add(1).sub(g.mul(cosTheta).mul(2)), 1.5).mul(4 * Math.PI))
        .toVar();

      color.assign(
        rayleighBeta
          .mul(rayleighSum)
          .mul(rayleighPhase)
          .add(mieSum.mul(MIE_BETA).mul(miePhase))
          .mul(uIntensity as unknown as TslNode),
      );
    });

    return vec4(color, 1);
  });

  const material = new webgpu.NodeMaterial();
  material.fragmentNode = fragment();
  (material as unknown as { side: number }).side = webgpu.BackSide;
  (material as unknown as { depthWrite: boolean }).depthWrite = false;

  return {
    material,
    setSun: (value) => {
      (uSunDirection.value as { copy: (v: Vector3) => void }).copy(value);
    },
    setIntensity: (value) => {
      uIntensity.value = value;
    },
    setMieG: (value) => {
      uMieG.value = value;
    },
  };
}
