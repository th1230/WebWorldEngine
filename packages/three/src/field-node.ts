/* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的，見 fullscreen-node.ts */
import { texture3DPlaceholder } from './fullscreen-node.ts';
import type { Tsl, TslNode } from './fullscreen-node.ts';

/**
 * 全域距離場的查表 —— **TSL 那一份**。
 *
 * 與 `field-glsl.ts` 逐行對照。距離場陰影、追蹤反射、體積霧三個效果都查這一份，
 * 所以它與 GLSL 那份分岔的話，三個效果會一起錯 —— 而且是「陰影說那裡有牆，
 * 霧說沒有」這種互相矛盾的錯。
 *
 * 兩份一不一致由 `tools/gpu-check/cross-backend.mjs` 量。
 */

export interface FieldNodeHandles {
  /** 場的距離貼圖與反照率貼圖，以及範圍。設定它們的是各個效果。 */
  tField: TslNode;
  tAlbedo: TslNode;
  uFieldMin: TslNode;
  uFieldExtent: TslNode;
  uCell: TslNode;
  /** 這一點離最近的表面多遠。場外面回「很遠」，不是 0。 */
  at: (point: TslNode) => TslNode;
  /** 打到的那個表面是什麼顏色。場外面回白色。 */
  albedoAt: (point: TslNode) => TslNode;
  /** 從一點往一個方向追，0 全擋、1 沒擋。 */
  visibility: (
    origin: TslNode,
    direction: TslNode,
    range: TslNode,
    steps: TslNode,
    softness: TslNode,
  ) => TslNode;
}

/**
 * 建一組距離場的查表節點。
 *
 * 回傳的 `tField` / `tAlbedo` 等是 uniform 節點 —— 呼叫端每幀設它們的 `.value`。
 */
export function createFieldNodes(tsl: Tsl, three: Tsl): FieldNodeHandles {
  const { texture3D, uniform, vec3, float, Fn, Loop, If, Break } = tsl;

  const tField = texture3D(texture3DPlaceholder(three));
  const tAlbedo = texture3D(texture3DPlaceholder(three));
  const uFieldMin = uniform(vec3(0, 0, 0));
  const uFieldExtent = uniform(float(1));
  const uCell = uniform(float(1));

  /** 世界座標 → 場的 uvw，以及「在不在場裡面」。 */
  const toUvw = (point: TslNode): { uvw: TslNode; inside: TslNode } => {
    const uvw = point.sub(uFieldMin).div(uFieldExtent);
    // GLSL 那份用 `any(lessThan(...))` 提早返回。這裡用乘的 —— 結果一樣，
    // 而且不引進分支。與 `irradiance-node.ts` 的判斷一致。
    const { step } = tsl;
    const low = step(vec3(0, 0, 0), uvw);
    const high = step(uvw, vec3(1, 1, 1));
    const inside = low.x.mul(low.y).mul(low.z).mul(high.x).mul(high.y).mul(high.z);
    return { uvw, inside };
  };

  const at = (point: TslNode): TslNode => {
    const { uvw, inside } = toUvw(point);
    // ## 場外面回傳「很遠」，不是 0
    //
    // 場的外面代表**沒有資料**，不代表那裡有東西。回 0 的話整個場外面會被
    // 當成實心的 —— 陰影全黑、霧全暗、反射全打到。而場只有幾百公尺寬。
    // 對**節點本身**取樣，不要再包一層 `texture3D(node, uv)` —— 那會被當成
    // 「拿一個節點當貼圖」，TSL 直接丟「expects a valid instance of
    // THREE.Texture()」，而訊息看不出是包了兩層。
    const sampled = tField.sample(uvw).r;
    return sampled.mul(inside).add(uFieldExtent.mul(float(1).sub(inside)));
  };

  const albedoAt = (point: TslNode): TslNode => {
    const { uvw, inside } = toUvw(point);
    const sampled = tAlbedo.sample(uvw).rgb;
    return sampled.mul(inside).add(vec3(1, 1, 1).mul(float(1).sub(inside)));
  };

  /**
   * 球體追蹤：每一步都跳「離最近的表面多遠」，所以空曠處一兩步跨過去，貼近
   * 表面時自動變細。半影是免費的副產品 —— 距離與已走路程之比就是圓錐張角。
   */
  const visibility = Fn(
    ([origin, direction, range, steps, softness]: TslNode[]) => {
      const point = origin!.add(direction!.mul(uCell)).toVar();
      const travelled = uCell.toVar();
      const closest = float(1).toVar();
      const blocked = float(0).toVar();

      Loop({ start: 0, end: 128, type: 'int', condition: '<' }, ({ i }: any) => {
        If(float(i).greaterThanEqual(steps!).or(travelled.greaterThanEqual(range!)), () => {
          Break();
        });
        const distance = at(point).toVar();
        If(distance.lessThan(uCell.mul(0.25)), () => {
          blocked.assign(1);
          Break();
        });
        closest.assign(closest.min(softness!.mul(distance).div(travelled)));
        point.addAssign(direction!.mul(distance));
        travelled.addAssign(distance);
      });

      // GLSL 那份打到就 `return 0.0`。TSL 沒有提前 return，所以用旗標乘回去 ——
      // 算出來的東西一樣。
      return closest.clamp(0, 1).mul(float(1).sub(blocked));
    },
  );

  return { tField, tAlbedo, uFieldMin, uFieldExtent, uCell, at, albedoAt, visibility };
}
