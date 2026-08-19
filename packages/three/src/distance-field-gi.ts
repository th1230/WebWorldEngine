import {
  ClampToEdgeWrapping,
  Data3DTexture,
  FloatType,
  LinearFilter,
  RedFormat,
  Vector3,
} from 'three';
import { bakeDistanceField, bakeSurfaceCache, type DistanceFieldOptions, type SurfaceCache } from '@webworld/format';
import type { BufferGeometry } from 'three';

/**
 * 距離場：讓間接光被**鏡頭外的東西**擋住。
 *
 * ## 它補的洞
 *
 * `ScreenSpaceGI` 只看得到畫面上的像素 —— 鏡頭外的牆既不擋光也不反彈光。
 * 那是螢幕空間這個做法的本質限制，不是還沒做完。
 *
 * `IrradianceVolume` 看得到整個場景，但它是**格點上的**：格與格之間靠內插，
 * 所以一個貼在牆邊的角落不會變暗 —— 探針不知道那裡有個角。
 *
 * 距離場兩個都補：它是一個三維的場，鏡頭外的東西照樣在裡面；而它是連續的
 * （每一點都問得到「最近的表面多遠」），所以角落問得出來。
 *
 * ## 這是 Lumen 那一類做法裡搬得過來的那一半
 *
 * Lumen 的骨幹是「對距離場追蹤光線」。那件事拆開來是：
 *
 * | | 誰做 |
 * | --- | --- |
 * | 距離場怎麼烘、怎麼存、怎麼串流 | **這裡**（資料，ADR-0001 說是我們的） |
 * | 追蹤那一步 | 一個後製 pass，與 `ScreenSpaceGI` 同一類 |
 * | 把畫面畫出來 | Three 的 renderer |
 *
 * 所以「即時 GI 要擁有整條管線」那句話對 Lumen 的**完整實作**成立（它還有
 * 表面快取、輻射快取、多層級的全域場），對**對距離場追蹤**這件事不成立。
 *
 * 這裡做的是後者：單一物件的距離場，用來算間接光的遮蔽。多物件的全域場是
 * 下一步，而它是串流問題 —— 也就是這個套件已經在做的那一類。
 */

export interface DistanceFieldGiOptions extends DistanceFieldOptions {
  /**
   * 遮蔽的取樣距離，世界單位。預設用場的四分之一。
   *
   * 這是「多近的東西算遮蔽」。與 `ScreenSpaceGI` 的 radius 是同一個意思，
   * 兩者應該接近 —— 差太多的話同一個角落會被算兩次或漏掉。
   */
  occlusionRange?: number;
  /**
   * 這份幾何的反照率，追蹤打到它時反彈出來的顏色。
   *
   * 沒給的話用頂點顏色；兩個都沒有就是白的（只做遮蔽，不做反彈）。
   */
  albedo?: [number, number, number];
}

/**
 * 一個物件的距離場，加上它在 GPU 上的樣子。
 *
 * 存成單通道浮點的 3D 貼圖：距離是**有號**的（裡面是負的），而半精度在
 * 靠近表面時精度不夠 —— 那正是最需要準的地方。
 */
export class DistanceFieldVolume {
  readonly texture: Data3DTexture;
  readonly min: Vector3;
  readonly size: Vector3;
  readonly resolution: number;
  readonly occlusionRange: number;
  /**
   * 表面快取：這附近的表面是什麼顏色。
   *
   * 距離場答得出「有沒有東西擋著」，答不出**那是什麼顏色** —— 而沒有
   * 顏色就只能做遮蔽，做不了反彈。這一份就是補那一半。
   */
  readonly surface: SurfaceCache;

  constructor(geometry: BufferGeometry, options: DistanceFieldGiOptions = {}) {
    const position = geometry.getAttribute('position');
    if (position === undefined) {
      throw new Error('WW.DistanceFieldVolume: 這份幾何沒有 position 屬性。');
    }
    const index = geometry.getIndex();
    const field = bakeDistanceField(
      position.array as ArrayLike<number>,
      index === null ? null : (index.array as ArrayLike<number>),
      options,
    );

    this.resolution = field.resolution;
    this.min = new Vector3(...field.min);
    this.size = new Vector3(...field.size);
    this.occlusionRange = options.occlusionRange ?? Math.max(...field.size) * 0.25;

    const colorAttribute = geometry.getAttribute('color');
    this.surface = bakeSurfaceCache(
      position.array as ArrayLike<number>,
      index === null ? null : (index.array as ArrayLike<number>),
      colorAttribute === undefined ? null : (colorAttribute.array as ArrayLike<number>),
      {
        resolution: Math.max(4, Math.floor(field.resolution / 2)),
        // **必須與距離場同一個 padding**，否則兩份場對不上 —— 追蹤在
        // 距離場裡停在表面，查表面快取時卻查到隔壁。
        padding: options.padding ?? 0.25,
        flat: options.albedo ?? [1, 1, 1],
      },
    );

    const texture = new Data3DTexture(field.data, field.resolution, field.resolution, field.resolution);
    texture.format = RedFormat;
    // ## 單精度，不是半精度
    //
    // 距離在靠近表面時要準到公分級，而半精度在那個量級上的間距已經看得到 ——
    // 症狀是光線在表面附近抖，遮蔽跟著閃。這張圖不大（32³ 是 32,768 個 float
    // ＝ 128 KB），省不了多少。
    texture.type = FloatType;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.wrapR = ClampToEdgeWrapping;
    texture.needsUpdate = true;
    this.texture = texture;
  }

  /**
   * 在 CPU 上查一點的距離，三線性內插。
   *
   * 與 shader 用的是同一個式子 —— 存在的理由與 `IrradianceVolume.sampleAt`
   * 一樣：shader 裡的錯不會報錯，而有一份 CPU 版就能在測試裡問答案。
   */
  distanceAt(point: Vector3): number {
    const n = this.resolution;
    const gx = clamp01((point.x - this.min.x) / this.size.x) * (n - 1);
    const gy = clamp01((point.y - this.min.y) / this.size.y) * (n - 1);
    const gz = clamp01((point.z - this.min.z) / this.size.z) * (n - 1);
    const x0 = Math.min(Math.floor(gx), n - 2);
    const y0 = Math.min(Math.floor(gy), n - 2);
    const z0 = Math.min(Math.floor(gz), n - 2);
    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;

    const data = this.texture.image.data as Float32Array;
    let sum = 0;
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const w = (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy) * (dz === 0 ? 1 - fz : fz);
          if (w === 0) continue;
          sum += data[((z0 + dz) * n + (y0 + dy)) * n + (x0 + dx)]! * w;
        }
      }
    }
    return sum;
  }

  /**
   * 從一點往一個方向走，回傳遮蔽程度 0–1（1 = 完全被擋住）。
   *
   * ## 為什麼可以大步走
   *
   * 每一點的值就是「至少可以安全走多遠」，所以直接跳那個距離。空曠處一兩步
   * 跨過去，貼近表面時自動變細 —— 步數跟著幾何的疏密走，不跟著距離走。
   *
   * 這一份是 CPU 版，給測試與離線用。畫面上那一份在 shader 裡，同一個式子。
   */
  occlusionAlong(origin: Vector3, direction: Vector3, range = this.occlusionRange): number {
    const point = _traceAt.copy(origin);
    let travelled = 0;
    let closest = Infinity;
    // 起點就在表面上的話第一步會是 0，所以先推開一點點。
    const bias = Math.max(...this.size.toArray()) / this.resolution;
    travelled += bias;
    point.addScaledVector(direction, bias);

    for (let step = 0; step < 32 && travelled < range; step++) {
      const distance = this.distanceAt(point);
      if (distance < 1e-4) return 1;
      // 圓錐追蹤的近似：距離與已走的路程之比越小，代表擦得越近。
      closest = Math.min(closest, distance / Math.max(travelled, 1e-4));
      point.addScaledVector(direction, distance);
      travelled += distance;
    }
    // 完全沒擦到任何東西就是沒有遮蔽。
    return Math.max(0, Math.min(1, 1 - closest));
  }

  /** 查一點附近的表面顏色（最近的格子，不內插 —— 反彈光是低頻的）。 */
  albedoAt(point: Vector3, target: Vector3): Vector3 {
    const cache = this.surface;
    const n = cache.resolution;
    const gx = Math.min(n - 1, Math.max(0, Math.floor(((point.x - cache.min[0]) / cache.size[0]) * n)));
    const gy = Math.min(n - 1, Math.max(0, Math.floor(((point.y - cache.min[1]) / cache.size[1]) * n)));
    const gz = Math.min(n - 1, Math.max(0, Math.floor(((point.z - cache.min[2]) / cache.size[2]) * n)));
    const cell = ((gz * n + gy) * n + gx) * 3;
    return target.set(cache.data[cell]!, cache.data[cell + 1]!, cache.data[cell + 2]!);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

const _traceAt = new Vector3();

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
