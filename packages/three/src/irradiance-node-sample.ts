import { texture3DPlaceholder } from './fullscreen-node.ts';
import type { Tsl, TslNode } from './fullscreen-node.ts';
import type { IrradianceVolume } from './irradiance.ts';

/**
 * 探針體積的查表 —— **TSL 那一份**。
 *
 * 對應 `irradiance-glsl.ts` 的 `wwIrradiance`。材質那條路（`applyIrradianceNode`）
 * 與螢幕空間的效果（反射打到螢幕外的東西時要知道那裡多亮、體積霧要知道每一步
 * 收到多少光）查的是同一份資料，所以這一側也要只有一份。
 *
 * 常數與 GLSL 那份、與 Three 的 `shGetIrradianceAt` 逐字相同（0.886227 = π·Y₀₀，
 * 1.023328 = 2 · 0.511664）。
 */

export interface IrradianceNodeSampler {
  textures: TslNode[];
  uMin: TslNode;
  uInvSize: TslNode;
  uIntensity: TslNode;
  /** 世界座標 + 法線 → 輻照度。體積外回 0。 */
  at: (worldPos: TslNode, normal: TslNode) => TslNode;
  /** 每幀把體積的參數搬過來。 */
  update: (volume: IrradianceVolume) => void;
}

export function createIrradianceSampler(tsl: Tsl, three: Tsl): IrradianceNodeSampler {
  const { texture3D, uniform, vec3, float, step } = tsl;

  const textures = [0, 1, 2, 3].map(() => texture3D(texture3DPlaceholder(three)));
  const uMin = uniform(vec3(0, 0, 0));
  const uInvSize = uniform(vec3(1, 1, 1));
  const uIntensity = uniform(float(1));

  const at = (worldPos: TslNode, normal: TslNode): TslNode => {
    const uvw = worldPos.sub(uMin).mul(uInvSize);
    // ## 體積外不給光，而且用乘的不用分支
    //
    // GLSL 那份用 `if` 提早返回。這裡用 step 相乘 —— 結果一樣，而在 node
    // 材質裡不引進分支比較安全。與 `irradiance-node.ts` 的判斷一致。
    const low = step(vec3(0, 0, 0), uvw);
    const high = step(uvw, vec3(1, 1, 1));
    const mask = low.x.mul(low.y).mul(low.z).mul(high.x).mul(high.y).mul(high.z);

    const c0 = textures[0]!.sample(uvw).xyz;
    const c1 = textures[1]!.sample(uvw).xyz;
    const c2 = textures[2]!.sample(uvw).xyz;
    const c3 = textures[3]!.sample(uvw).xyz;

    // 常數與 GLSL 那份、與 Three 的 shGetIrradianceAt 逐字相同。
    const directional = c1
      .mul(normal.y)
      .add(c2.mul(normal.z))
      .add(c3.mul(normal.x))
      .mul(1.023328);
    return c0.mul(0.886227).add(directional).max(vec3(0, 0, 0)).mul(uIntensity).mul(mask);
  };

  const update = (volume: IrradianceVolume): void => {
    const volumeTextures = volume.textures;
    for (let i = 0; i < 4; i++) textures[i]!.value = volumeTextures[i];
    (uMin.value as { copy: (v: unknown) => void }).copy(volume.min);
    (uInvSize.value as { set: (x: number, y: number, z: number) => void }).set(
      1 / volume.size.x,
      1 / volume.size.y,
      1 / volume.size.z,
    );
    uIntensity.value = volume.intensity;
  };

  return { textures, uMin, uInvSize, uIntensity, at, update };
}
