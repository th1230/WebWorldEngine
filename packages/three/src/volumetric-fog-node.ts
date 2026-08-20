/* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的，見 fullscreen-node.ts */
import { createFieldNodes } from './field-node.ts';
import {
  createDepthConvention,
  loadTsl,
  loadWebGPU,
  sampleDepth,
  texture2DPlaceholder,
  viewPositionFromDepth,
} from './fullscreen-node.ts';
import type { Color, Matrix4, Texture, Vector3 } from 'three';

/**
 * 體積霧的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 逐行對照 `volumetric-fog.ts` 的 GLSL。遮蔽查的是**共用的**
 * `wwFieldVisibility`（沿追蹤方向推開），所以這裡用 `field-node.ts` 的
 * `visibility` —— 與距離場陰影不同，那個有自己的一份。
 *
 * 兩份一不一致由 `tools/gpu-check/cross-backend.mjs` 量。
 */

export interface VolumetricFogNodeHandle {
  material: unknown;
  setTextures: (depth: Texture, field: Texture | null, albedo: Texture | null) => void;
  setMatrices: (projectionInverse: Matrix4, cameraMatrix: Matrix4) => void;
  setField: (min: Vector3, extent: number, cell: number, has: boolean) => void;
  setLight: (direction: Vector3, color: Color) => void;
  setParams: (params: {
    color: Color;
    density: number;
    steps: number;
    range: number;
    anisotropy: number;
    shadowSteps: number;
  }) => void;
  setConvention: (renderer: unknown) => void;
}

export async function createVolumetricFogNodeMaterial(): Promise<VolumetricFogNodeHandle> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const {
    Fn,
    Loop,
    If,
    Break,
    float,
    vec2,
    vec3,
    vec4,
    uniform,
    uv,
    texture,
    normalize,
    dot,
    mat4,
    length,
    min,
    max,
    pow,
    exp,
    mod,
    screenCoordinate,
  } = tsl;

  const field = createFieldNodes(tsl, webgpu);
  const convention = createDepthConvention(tsl);

  const tDepth = texture(texture2DPlaceholder(webgpu));
  const uProjectionInverse = uniform(mat4());
  const uCameraMatrix = uniform(mat4());
  const uLightDirection = uniform(vec3(0, -1, 0));
  // ## 顏色的 uniform 要用 `Color`，不是 `vec3`
  //
  // `uniform(vec3(...))` 的 `.value` 是一個 `Vector3`，而 `Vector3.set(color)`
  // 會把 Color 當成 x、y/z 給 undefined —— 整個變成 **NaN**。而 NaN 在畫面上
  // 是黑的，看起來像「霧沒有散射」。
  const uLightColor = uniform(new webgpu.Color(0xffffff));
  const uFogColor = uniform(new webgpu.Color(0xffffff));
  const uDensity = uniform(float(0.004));
  const uSteps = uniform(float(48));
  const uRange = uniform(float(220));
  const uAnisotropy = uniform(float(0.7));
  const uShadowSteps = uniform(float(32));
  const uHasField = uniform(float(0));

  /**
   * Bayer 4×4 的有序抖動。
   *
   * GLSL 那份是一個 `float[16]` 的常數陣列查表。TSL 沒有常數陣列，所以這裡把
   * 那 16 個值**展開成 16 個 If**。
   *
   * 看起來很笨，而那是刻意的：Bayer 矩陣有封閉式（把 x 與 y 的位元交錯之後
   * 位元反轉），但推導錯了的話抖動的樣式會不一樣，而那要一個專門的關卡才驗
   * 得到。展開的那 16 個數字與 GLSL 那份**一眼對得起來**。
   */
  const bayer = Fn(([coordinate]: any[]) => {
    const x = mod(coordinate.x, 4).floor().toVar();
    const y = mod(coordinate.y, 4).floor().toVar();
    const index = x.add(y.mul(4)).toVar();
    const value = float(0).toVar();
    // 0 8 2 10 / 12 4 14 6 / 3 11 1 9 / 15 7 13 5
    const table = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    table.forEach((entry, at) => {
      If(index.equal(at), () => {
        value.assign(entry);
      });
    });
    return value.div(16);
  });

  const fragment = Fn(() => {
    const screenUv = uv();
    const rawDepth = sampleDepth(tsl, tDepth, screenUv).toVar();
    const isSky = rawDepth.greaterThanEqual(1).toVar();

    const viewPosition = viewPositionFromDepth(
      tsl,
      screenUv,
      rawDepth,
      uProjectionInverse,
      convention,
    ).toVar();
    // 天空那一條走的是「往 0.99 的深度打一條射線」，因為那裡沒有幾何。
    const skyDirection = normalize(
      viewPositionFromDepth(tsl, screenUv, float(0.99), uProjectionInverse, convention),
    ).toVar();
    const viewDirection = vec3(0, 0, 0).toVar();
    const travel = float(0).toVar();
    If(isSky, () => {
      viewDirection.assign(skyDirection);
      travel.assign(uRange);
    }).Else(() => {
      viewDirection.assign(normalize(viewPosition));
      travel.assign(min(length(viewPosition), uRange));
    });

    const worldOrigin = uCameraMatrix.mul(vec4(0, 0, 0, 1)).xyz.toVar();
    const worldDirection = normalize(uCameraMatrix.mul(vec4(viewDirection, 0)).xyz).toVar();
    const toLight = normalize(uLightDirection.negate()).toVar();

    const cosTheta = dot(worldDirection, toLight).toVar();
    const g = uAnisotropy;
    const gg = g.mul(g).toVar();
    const phase = float(1)
      .sub(gg)
      .div(pow(max(gg.add(1).sub(g.mul(cosTheta).mul(2)), 1e-4), 1.5).mul(4 * Math.PI))
      .toVar();

    const stepSize = travel.div(uSteps).toVar();
    const offset = bayer(vec2(screenCoordinate.x, screenCoordinate.y)).toVar();
    const scattered = vec3(0, 0, 0).toVar();
    const transmittance = float(1).toVar();

    Loop({ start: 0, end: 64, type: 'int', condition: '<' }, ({ i }: any) => {
      If(float(i).greaterThanEqual(uSteps), () => {
        Break();
      });
      const t = float(i).add(offset).mul(stepSize).toVar();
      const point = worldOrigin.add(worldDirection.mul(t)).toVar();
      const visibility = float(1).toVar();
      If(uHasField.greaterThan(0.5), () => {
        visibility.assign(field.visibility(point, toLight, uRange, uShadowSteps, float(8)));
      });
      const density = uDensity.mul(stepSize).toVar();
      const inScatter = uLightColor.mul(uFogColor).mul(visibility.mul(phase).mul(density)).toVar();
      scattered.addAssign(inScatter.mul(transmittance));
      transmittance.mulAssign(exp(density.negate()));
    });

    return vec4(scattered, transmittance);
  });

  const material = new webgpu.NodeMaterial();
  material.fragmentNode = fragment();
  material.depthTest = false;
  material.depthWrite = false;

  return {
    material,
    setTextures: (depth, fieldTexture, albedo) => {
      tDepth.value = depth;
      if (fieldTexture !== null) field.tField.value = fieldTexture;
      if (albedo !== null) field.tAlbedo.value = albedo;
    },
    setMatrices: (projectionInverse, cameraMatrix) => {
      (uProjectionInverse.value as Matrix4).copy(projectionInverse);
      (uCameraMatrix.value as Matrix4).copy(cameraMatrix);
    },
    setField: (fieldMin, extent, cell, has) => {
      (field.uFieldMin.value as Vector3).copy(fieldMin);
      field.uFieldExtent.value = extent;
      field.uCell.value = cell;
      uHasField.value = has ? 1 : 0;
    },
    setLight: (direction, color) => {
      (uLightDirection.value as Vector3).copy(direction);
      (uLightColor.value as { copy: (c: unknown) => void }).copy(color);
    },
    setParams: (params) => {
      (uFogColor.value as { copy: (c: unknown) => void }).copy(params.color);
      uDensity.value = params.density;
      uSteps.value = params.steps;
      uRange.value = params.range;
      uAnisotropy.value = params.anisotropy;
      uShadowSteps.value = params.shadowSteps;
    },
    setConvention: (renderer) => {
      convention.set(renderer);
    },
  };
}
