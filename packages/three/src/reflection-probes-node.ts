/* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的，見 fullscreen-node.ts */
import { texture2DPlaceholder } from './fullscreen-node.ts';
import type { Tsl, TslNode } from './fullscreen-node.ts';
import type { ReflectionProbes } from './reflection-probes.ts';

/**
 * 反射探針的查表 —— **TSL 那一份**。
 *
 * 對應 `reflection-probes.ts` 裡的 `REFLECTION_PROBE_SAMPLE_GLSL`。追蹤反射與
 * 水面都查這一份，所以這一側也只有一份。
 *
 * 八面體的折疊那一段特別容易寫錯，而且**只有 z 為負的方向會走到** —— 反射
 * 向上的水面與地板幾乎全是 z ≥ 0，於是折疊寫錯了也看不出來。跨後端關卡的
 * 取樣點裡刻意有一個朝 −z 的（見 `tools/gpu-check/reflection-probes.mjs` 的
 * 「地板偏 −z 那一塊照出黃牆」）。
 */

export interface ReflectionProbeSampler {
  atlas: TslNode;
  uMin: TslNode;
  uInvSize: TslNode;
  uResolution: TslNode;
  uColumns: TslNode;
  uStride: TslNode;
  uAtlasSize: TslNode;
  uIntensity: TslNode;
  /** 方向 → 圖塊內的 uv。與 CPU 的 `octEncode` 同一條式子。 */
  octEncode: (direction: TslNode) => TslNode;
  /** 第 index 顆探針，往 direction 看過去的輻射。 */
  probe: (index: TslNode, direction: TslNode) => TslNode;
  /** 世界座標 + 方向 → 輻射，八顆三線性混合。體積外回 fallback。 */
  at: (worldPos: TslNode, direction: TslNode, fallback: TslNode) => TslNode;
  /** 每幀把探針的參數搬過來。 */
  update: (probes: ReflectionProbes) => void;
}

export function createReflectionProbeSampler(tsl: Tsl, three: Tsl): ReflectionProbeSampler {
  const { texture, uniform, vec2, vec3, float, Loop, If, abs, sign, mix, floor, mod, step } = tsl;

  const atlas = texture(texture2DPlaceholder(three));
  const uMin = uniform(vec3(0, 0, 0));
  const uInvSize = uniform(vec3(1, 1, 1));
  const uResolution = uniform(vec3(2, 2, 2));
  const uColumns = uniform(float(1));
  const uStride = uniform(float(18));
  const uAtlasSize = uniform(vec2(1, 1));
  const uIntensity = uniform(float(1));

  const octEncode = (direction: TslNode): TslNode => {
    const n = direction.div(abs(direction.x).add(abs(direction.y)).add(abs(direction.z)));
    const folded = vec2(1, 1)
      .sub(abs(vec2(n.y, n.x)))
      .mul(vec2(sign(n.x), sign(n.y)));
    // GLSL 那份用 `if ( n.z < 0.0 )`。這裡用 mix —— 結果一樣，不引進分支。
    //
    // `sign(0)` 在 GLSL 是 0，在這裡也是 0 —— 而 GLSL 那份寫的是
    // `n.x >= 0.0 ? 1.0 : -1.0`（0 算正）。方向剛好落在軸上的機率是零測度，
    // 而實測兩邊的六個面差 0.000%，所以這個差別量不到。寫下來免得以後有人
    // 以為它們一定一樣。
    const p = mix(vec2(n.x, n.y), folded, step(n.z, 0));
    return p.mul(0.5).add(0.5);
  };

  const probe = (index: TslNode, direction: TslNode): TslNode => {
    const oct = octEncode(direction);
    const column = mod(index, uColumns);
    const row = floor(index.div(uColumns));
    // 內容區從邊界那一圈之後才開始，所以偏移 1、範圍是 tileSize 而不是 stride。
    const tile = uStride.sub(2);
    const texel = vec2(column, row).mul(uStride).add(1).add(oct.mul(tile));
    return atlas.sample(texel.div(uAtlasSize)).rgb;
  };

  const at = (worldPos: TslNode, direction: TslNode, fallback: TslNode): TslNode => {
    const uvw = worldPos.sub(uMin).mul(uInvSize);
    const low = step(vec3(0, 0, 0), uvw.add(1e-3));
    const high = step(uvw.sub(1e-3), vec3(1, 1, 1));
    const inside = low.x.mul(low.y).mul(low.z).mul(high.x).mul(high.y).mul(high.z);

    const clamped = uvw.clamp(0, 1);
    const grid = clamped.mul(uResolution.sub(1));
    const base = floor(grid);
    const fraction = grid.sub(base);
    const total = vec3(0, 0, 0).toVar();
    const weightSum = float(0).toVar();

    Loop({ start: 0, end: 8, type: 'int', condition: '<' }, ({ i }: any) => {
      // 位元運算要在 **int** 上做。GLSL 那份是 `float( i & 1 )` —— 先位元再
      // 轉 float。在 float 上叫 bitAnd 是另一件事（而且不會報錯）。
      const offset = vec3(
        float(i.bitAnd(1)),
        float(i.shiftRight(1).bitAnd(1)),
        float(i.shiftRight(2).bitAnd(1)),
      );
      const cell = base.add(offset).min(uResolution.sub(1));
      const blend = mix(vec3(1, 1, 1).sub(fraction), fraction, offset);
      const weight = blend.x.mul(blend.y).mul(blend.z);
      If(weight.greaterThan(0), () => {
        const index = cell.x
          .add(cell.y.mul(uResolution.x))
          .add(cell.z.mul(uResolution.x).mul(uResolution.y));
        total.addAssign(probe(index, direction).mul(weight));
        weightSum.addAssign(weight);
      });
    });

    const sampled = total.div(weightSum.max(1e-6)).mul(uIntensity);
    return mix(fallback, sampled, inside);
  };

  const update = (probes: ReflectionProbes): void => {
    const u = probes.uniforms();
    atlas.value = u.wwReflAtlas!.value;
    (uMin.value as { copy: (v: unknown) => void }).copy(u.wwReflMin!.value);
    (uInvSize.value as { copy: (v: unknown) => void }).copy(u.wwReflInvSize!.value);
    (uResolution.value as { copy: (v: unknown) => void }).copy(u.wwReflResolution!.value);
    uColumns.value = u.wwReflColumns!.value;
    uStride.value = u.wwReflStride!.value;
    const size = u.wwReflAtlasSize!.value as { x: number; y: number };
    (uAtlasSize.value as { set: (x: number, y: number) => void }).set(size.x, size.y);
    uIntensity.value = u.wwReflIntensity!.value;
  };

  return {
    atlas,
    uMin,
    uInvSize,
    uResolution,
    uColumns,
    uStride,
    uAtlasSize,
    uIntensity,
    octEncode,
    probe,
    at,
    update,
  };
}
