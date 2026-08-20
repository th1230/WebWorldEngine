/* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的，見 fullscreen-node.ts */
import { createFieldNodes } from './field-node.ts';
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
 * 距離場陰影的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 逐行對照 `distance-field-shadows.ts` 的 GLSL。注意它有**自己的一份追蹤
 * 迴圈**（從表面沿法線推開一格再開始），與 `field-glsl.ts` 的
 * `wwFieldVisibility`（沿追蹤方向推開）不同 —— 這裡照它自己那份轉，不是照
 * 共用那份。轉錯的話陰影的起點差一格，而那在掠射角上是整片的差別。
 *
 * 兩份一不一致由 `tools/gpu-check/cross-backend.mjs` 量。
 */

export interface DistanceFieldShadowsNodeHandle {
  material: unknown;
  setTextures: (depth: Texture, normal: Texture, field: Texture) => void;
  setMatrices: (projectionInverse: Matrix4, cameraMatrix: Matrix4) => void;
  setField: (min: Vector3, extent: number, cell: number) => void;
  setLight: (direction: Vector3) => void;
  setParams: (params: { range: number; steps: number; softness: number; strength: number }) => void;
  setConvention: (renderer: unknown) => void;
}

export async function createDistanceFieldShadowsNodeMaterial(): Promise<DistanceFieldShadowsNodeHandle> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const { Fn, Loop, If, Break, float, vec3, vec4, uniform, uv, texture, normalize, dot, mat4 } =
    tsl;

  const field = createFieldNodes(tsl, webgpu);
  const convention = createDepthConvention(tsl);

  const tDepth = texture(texture2DPlaceholder(webgpu));
  const tNormal = texture(texture2DPlaceholder(webgpu));
  const uProjectionInverse = uniform(mat4());
  const uCameraMatrix = uniform(mat4());
  const uLightDirection = uniform(vec3(0, -1, 0));
  const uRange = uniform(float(1));
  const uSteps = uniform(float(48));
  const uSoftness = uniform(float(8));
  const uStrength = uniform(float(1));

  const fragment = Fn(() => {
    const screenUv = uv();
    const rawDepth = sampleDepth(tsl, tDepth, screenUv).toVar();
    const shadow = float(1).toVar();

    If(rawDepth.lessThan(1), () => {
      const viewPosition = viewPositionFromDepth(
        tsl,
        screenUv,
        rawDepth,
        uProjectionInverse,
        convention,
      ).toVar();
      const worldPosition = uCameraMatrix.mul(vec4(viewPosition, 1)).xyz.toVar();

      const viewNormal = normalize(tNormal.sample(flipV(tsl, screenUv)).xyz.mul(2).sub(1)).toVar();
      // `mat3( uCameraMatrix ) * viewNormal` —— 只要旋轉，不要平移。
      const worldNormal = normalize(uCameraMatrix.mul(vec4(viewNormal, 0)).xyz).toVar();
      const toLight = normalize(uLightDirection.negate()).toVar();

      // 背光面本來就在陰影裡，追它只是白花步數。
      If(dot(worldNormal, toLight).greaterThan(0), () => {
        const point = worldPosition.add(worldNormal.mul(field.uCell)).toVar();
        const travelled = field.uCell.toVar();
        const closest = float(1).toVar();

        Loop({ start: 0, end: 128, type: 'int', condition: '<' }, ({ i }: any) => {
          If(float(i).greaterThanEqual(uSteps).or(travelled.greaterThanEqual(uRange)), () => {
            Break();
          });
          const distance = field.at(point).toVar();
          If(distance.lessThan(field.uCell.mul(0.25)), () => {
            closest.assign(0);
            Break();
          });
          closest.assign(closest.min(uSoftness.mul(distance).div(travelled)));
          point.addAssign(toLight.mul(distance));
          travelled.addAssign(distance);
        });

        shadow.assign(float(1).sub(float(1).sub(closest.clamp(0, 1)).mul(uStrength)));
      });
    });

    return vec4(vec3(shadow), 1);
  });

  const material = new webgpu.NodeMaterial();
  material.fragmentNode = fragment();
  material.depthTest = false;
  material.depthWrite = false;

  return {
    material,
    setTextures: (depth, normal, fieldTexture) => {
      tDepth.value = depth;
      tNormal.value = normal;
      field.tField.value = fieldTexture;
    },
    setMatrices: (projectionInverse, cameraMatrix) => {
      (uProjectionInverse.value as Matrix4).copy(projectionInverse);
      (uCameraMatrix.value as Matrix4).copy(cameraMatrix);
    },
    setField: (min, extent, cell) => {
      (field.uFieldMin.value as Vector3).copy(min);
      field.uFieldExtent.value = extent;
      field.uCell.value = cell;
    },
    setLight: (direction) => {
      (uLightDirection.value as Vector3).copy(direction);
    },
    setParams: (params) => {
      uRange.value = params.range;
      uSteps.value = params.steps;
      uSoftness.value = params.softness;
      uStrength.value = params.strength;
    },
    setConvention: (renderer) => {
      convention.set(renderer);
    },
  };
}
