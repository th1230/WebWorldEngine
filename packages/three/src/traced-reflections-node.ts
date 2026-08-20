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
import { createIrradianceSampler } from './irradiance-node-sample.ts';
import { createReflectionProbeSampler } from './reflection-probes-node.ts';
import type { Color, Matrix4, Texture, Vector3 } from 'three';
import type { GlobalDistanceField } from './global-distance-field.ts';
import type { IrradianceVolume } from './irradiance.ts';
import type { ReflectionProbes } from './reflection-probes.ts';

/**
 * 追蹤反射的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 這是四個效果裡最複雜的一個：它同時查距離場（打到什麼）、探針輻照度（那裡
 * 多亮）與反射探針（打不到東西時看到的環境）。三份查表在這一側都各只有一份
 * （`field-node.ts`、`irradiance-node-sample.ts`、`reflection-probes-node.ts`），
 * 與 GLSL 那側的三個共用字串一一對應。
 *
 * 逐行對照 `traced-reflections.ts`。兩份一不一致由跨後端關卡量。
 */

export interface TracedReflectionsNodeHandle {
  material: unknown;
  setTextures: (color: Texture, depth: Texture, normal: Texture) => void;
  setMatrices: (
    projection: Matrix4,
    projectionInverse: Matrix4,
    cameraMatrix: Matrix4,
  ) => void;
  setField: (field: GlobalDistanceField | null, range: number) => void;
  setIrradiance: (volume: IrradianceVolume | null) => void;
  setProbes: (probes: ReflectionProbes | null) => void;
  setParams: (params: {
    screenSteps: number;
    screenStep: number;
    thickness: number;
    fieldSteps: number;
    roughness: number;
    sky: Color;
  }) => void;
  setConvention: (renderer: unknown) => void;
}

export async function createTracedReflectionsNodeMaterial(): Promise<TracedReflectionsNodeHandle> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const { Fn, Loop, If, Break, float, vec3, vec4, uniform, uv, texture, normalize, reflect, mat4, mix } =
    tsl;

  const field = createFieldNodes(tsl, webgpu);
  const irradiance = createIrradianceSampler(tsl, webgpu);
  const probes = createReflectionProbeSampler(tsl, webgpu);
  const convention = createDepthConvention(tsl);

  const tColor = texture(texture2DPlaceholder(webgpu));
  const tDepth = texture(texture2DPlaceholder(webgpu));
  const tNormal = texture(texture2DPlaceholder(webgpu));
  const uProjection = uniform(mat4());
  const uProjectionInverse = uniform(mat4());
  const uCameraMatrix = uniform(mat4());
  const uScreenSteps = uniform(float(24));
  const uScreenStep = uniform(float(0.4));
  const uThickness = uniform(float(1));
  const uFieldSteps = uniform(float(48));
  const uRange = uniform(float(1));
  const uRoughness = uniform(float(0.15));
  const uSky = uniform(new webgpu.Color(0x2a3a55));
  const uHasField = uniform(float(0));
  const uHasIrradiance = uniform(float(0));
  const uHasProbes = uniform(float(0));

  const fragment = Fn(() => {
    const screenUv = uv();
    const rawDepth = sampleDepth(tsl, tDepth, screenUv).toVar();
    const result = vec3(uSky).toVar();
    const alpha = float(0).toVar();

    // 天空：沒有幾何就沒有反射。GLSL 那份是 `return`，這裡包在 If 裡。
    If(rawDepth.lessThan(1), () => {
      const viewPosition = viewPositionFromDepth(
        tsl,
        screenUv,
        rawDepth,
        uProjectionInverse,
        convention,
      ).toVar();
      const viewNormal = normalize(tNormal.sample(flipV(tsl, screenUv)).xyz.mul(2).sub(1)).toVar();
      const viewDir = normalize(viewPosition).toVar();
      const reflected = normalize(reflect(viewDir, viewNormal)).toVar();

      // ── 第一層：畫面上找得到嗎 ──
      const screenColor = vec3(0, 0, 0).toVar();
      const screenHit = float(0).toVar();
      const point = viewPosition.add(viewNormal.mul(uThickness).mul(0.5)).toVar();

      Loop({ start: 1, end: 65, type: 'int', condition: '<' }, ({ i }: any) => {
        If(float(i).greaterThan(uScreenSteps), () => {
          Break();
        });
        point.addAssign(reflected.mul(uScreenStep));
        const clip = uProjection.mul(vec4(point, 1)).toVar();
        If(clip.w.lessThanEqual(0), () => {
          Break();
        });
        const sampleUv = clip.xy.div(clip.w).mul(0.5).add(0.5).toVar();
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
        // GLSL 那份用 `continue`。這裡包成 If —— 實測 TSL 的 `Continue()` 放在
        // `If` 裡會讓整個迴圈提早結束（見 contact-shadows-node.ts）。
        If(sceneRaw.lessThan(1), () => {
          const scenePoint = viewPositionFromDepth(
            tsl,
            sampleUv,
            sceneRaw,
            uProjectionInverse,
            convention,
          ).toVar();
          const difference = scenePoint.z.sub(point.z).toVar();
          If(difference.greaterThan(0).and(difference.lessThan(uThickness)), () => {
            screenColor.assign(tColor.sample(flipV(tsl, sampleUv)).rgb);
            screenHit.assign(1);
            Break();
          });
        });
      });

      const worldPosition = uCameraMatrix.mul(vec4(viewPosition, 1)).xyz.toVar();
      const worldNormal = normalize(uCameraMatrix.mul(vec4(viewNormal, 0)).xyz).toVar();
      const worldReflected = normalize(uCameraMatrix.mul(vec4(reflected, 0)).xyz).toVar();

      // ── 第三層：反射探針（什麼都沒打到時看到的環境）──
      const missColor = vec3(uSky).toVar();
      If(uHasProbes.greaterThan(0.5), () => {
        missColor.assign(probes.at(worldPosition, worldReflected, vec3(uSky)));
      });

      // ── 第二層：距離場 ──
      const fieldColor = vec3(missColor).toVar();
      const fieldHit = float(0).toVar();
      If(uHasField.greaterThan(0.5), () => {
        const p = worldPosition.add(worldNormal.mul(field.uCell)).toVar();
        const travelled = field.uCell.toVar();
        Loop({ start: 0, end: 128, type: 'int', condition: '<' }, ({ i }: any) => {
          If(float(i).greaterThanEqual(uFieldSteps).or(travelled.greaterThanEqual(uRange)), () => {
            Break();
          });
          const distance = field.at(p).toVar();
          If(distance.lessThan(field.uCell.mul(0.25)), () => {
            fieldHit.assign(1);
            // 射出來的光 = 表面的顏色 × 它收到的光。只乘輻照度的話紅牆會
            // 反射成白的（GLSL 那份有實測數字）。
            const surfaceAlbedo = field.albedoAt(p).toVar();
            const incoming = vec3(1, 1, 1).toVar();
            If(uHasIrradiance.greaterThan(0.5), () => {
              incoming.assign(irradiance.at(p, worldReflected.negate()));
            });
            fieldColor.assign(surfaceAlbedo.mul(incoming));
            Break();
          });
          p.addAssign(worldReflected.mul(distance));
          travelled.addAssign(distance);
        });
      });

      // 銳利的鏡面優先用螢幕空間；粗糙的表面本來就糊，直接偏向距離場。
      const screenWeight = screenHit.mul(float(1).sub(uRoughness)).toVar();
      const base = mix(missColor, fieldColor, fieldHit).toVar();
      result.assign(mix(base, screenColor, screenWeight));
      alpha.assign(screenHit.max(fieldHit));
    });

    return vec4(result, alpha);
  });

  const material = new webgpu.NodeMaterial();
  material.fragmentNode = fragment();
  material.depthTest = false;
  material.depthWrite = false;

  return {
    material,
    setTextures: (color, depth, normal) => {
      tColor.value = color;
      tDepth.value = depth;
      tNormal.value = normal;
    },
    setMatrices: (projection, projectionInverse, cameraMatrix) => {
      (uProjection.value as Matrix4).copy(projection);
      (uProjectionInverse.value as Matrix4).copy(projectionInverse);
      (uCameraMatrix.value as Matrix4).copy(cameraMatrix);
    },
    setField: (source, range) => {
      if (source === null) {
        uHasField.value = 0;
        return;
      }
      field.tField.value = source.texture;
      field.tAlbedo.value = source.albedoTexture;
      (field.uFieldMin.value as Vector3).copy(source.min);
      field.uFieldExtent.value = source.extent;
      field.uCell.value = source.extent / source.resolution;
      uRange.value = range > 0 ? range : source.extent * 0.5;
      uHasField.value = 1;
    },
    setIrradiance: (volume) => {
      if (volume === null) {
        uHasIrradiance.value = 0;
        return;
      }
      irradiance.update(volume);
      uHasIrradiance.value = 1;
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
      uScreenSteps.value = params.screenSteps;
      uScreenStep.value = params.screenStep;
      uThickness.value = params.thickness;
      uFieldSteps.value = params.fieldSteps;
      uRoughness.value = params.roughness;
      (uSky.value as { copy: (c: unknown) => void }).copy(params.sky);
    },
    setConvention: (renderer) => {
      convention.set(renderer);
    },
  };
}
