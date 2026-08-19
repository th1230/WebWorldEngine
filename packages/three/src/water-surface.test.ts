import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import type { Vector3 } from 'three';
import { Water } from './water.ts';
import { WaterSurface } from './water-surface.ts';

/**
 * 這一支守的是「外觀與浮力共用同一份波形」。
 *
 * 外觀本身（折射、吸收、泡沫、菲涅耳）在 GPU 上，單元測試碰不到 —— 那些由
 * `tools/gpu-check/water-look.mjs` 量。這裡守的是**接得對不對**：位移那段
 * GLSL 是不是真的從同一個 `Water` 產生出來的。
 *
 * 那個坑一旦踩到，症狀是船浮在錯的高度，而且不會報錯。
 */
describe('WaterSurface', () => {
  it('頂點著色器裡的位移，就是 water.displacementGLSL() 產生的那一份', () => {
    const water = new Water({
      level: 3,
      waves: [{ directionX: 1, directionZ: 0.3, length: 17, amplitude: 1.4, speed: 0.7, steepness: 0.5 }],
    });
    const surface = new WaterSurface({ water });
    // 逐字包含 —— 不是「長得很像」。改寫一份等價的式子也算分岔。
    expect(surface.material.vertexShader).toContain(water.displacementGLSL('wwWaterDisplace'));
  });

  it('換一組波，著色器跟著換', () => {
    // 上面那條在「位移那段是寫死的常數字串」時也會過（只要剛好一樣）。
    // 這一條擋掉那個。
    const calm = new WaterSurface({
      water: new Water({ waves: [{ directionX: 1, directionZ: 0, length: 10, amplitude: 0.2, speed: 1, steepness: 0 }] }),
    });
    const rough = new WaterSurface({
      water: new Water({ waves: [{ directionX: 1, directionZ: 0, length: 10, amplitude: 4, speed: 1, steepness: 0 }] }),
    });
    expect(calm.material.vertexShader).not.toBe(rough.material.vertexShader);
  });

  it('靜水面的高度傳給了著色器 —— 浪頭白沫要拿它當基準', () => {
    const surface = new WaterSurface({ water: new Water({ level: -7 }) });
    expect(surface.material.uniforms.uWaterLevel!.value).toBe(-7);
  });

  it('吸收預設是分波長的 —— 紅被吃得最兇', () => {
    // 三個通道一樣的話水就只是「一片變暗的東西」，那是最假的一種水。
    const surface = new WaterSurface({ water: new Water() });
    const absorption = surface.material.uniforms.uAbsorption!.value as Vector3;
    expect(absorption.x).toBeGreaterThan(absorption.y);
    expect(absorption.y).toBeGreaterThan(absorption.z);
    expect(absorption.x / absorption.z).toBeGreaterThan(5);
  });

  it('浪頭白沫預設關掉 —— 平靜的水面不該冒白沫', () => {
    expect(new WaterSurface({ water: new Water() }).material.uniforms.uCrestFoam!.value).toBe(0);
  });

  it('探針那幾個 uniform 一開始就宣告好了', () => {
    // Three 只在第一次編譯時拿當下的鍵決定要上傳哪些 —— 之後才補進去的
    // 永遠不會被上傳，而症狀是反射永遠退回天空色，不會報錯。
    const surface = new WaterSurface({ water: new Water() });
    for (const key of [
      'wwReflAtlas',
      'wwReflMin',
      'wwReflInvSize',
      'wwReflResolution',
      'wwReflColumns',
      'wwReflStride',
      'wwReflAtlasSize',
      'wwReflIntensity',
    ]) {
      expect(surface.material.uniforms[key], key).toBeDefined();
    }
    expect(surface.material.uniforms.uHasProbes!.value).toBe(0);
  });

  it('沒接探針時 setProbes(null) 不會壞', () => {
    const surface = new WaterSurface({ water: new Water() });
    surface.setProbes(null);
    expect(surface.material.uniforms.uHasProbes!.value).toBe(0);
  });

  it('選項照著傳進去', () => {
    const sky = new Color(0x123456);
    const surface = new WaterSurface({
      water: new Water(),
      sky,
      foamDepth: 9,
      refraction: 0.01,
      crestFoam: 1.25,
      reflectivity: 0.5,
    });
    const u = surface.material.uniforms;
    expect(u.uSky!.value).toBe(sky);
    expect(u.uFoamDepth!.value).toBe(9);
    expect(u.uRefraction!.value).toBe(0.01);
    expect(u.uCrestFoam!.value).toBe(1.25);
    expect(u.uReflectivity!.value).toBe(0.5);
  });
});
