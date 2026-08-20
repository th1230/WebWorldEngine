import {
  ClampToEdgeWrapping,
  Data3DTexture,
  FloatType,
  LinearFilter,
  Matrix4,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { DistanceFieldVolume } from './distance-field-gi.ts';

/**
 * 全域距離場：把很多個物件的距離場合成一個，而且跟著相機走。
 *
 * ## 它為什麼是串流問題，不是渲染問題
 *
 * 單一物件的距離場（`DistanceFieldVolume`）已經能算遮蔽了，但一個世界裡有
 * 幾千個物件 —— 追蹤一條光線時逐一去問每個物件的場，等於每一步都做幾千次
 * 查表。那不是慢一點，那是不可能。
 *
 * Lumen 的解法是把附近的場**合成一個**，而合成出來的那一份跟著相機移動。
 * 而「哪些東西要住在記憶體裡、相機走遠了換誰」正是這個套件已經在做的事
 * （見世界串流那一節）—— 所以這一塊是串流，不是渲染。
 *
 * ## 相機一動就整份重算是不行的
 *
 * 32³ 是 32,768 格，每格要問附近所有物件 —— 每幀重算會直接凍住。
 *
 * 所以這裡走 clipmap 的做法：格子是固定的世界對齊網格，相機移動時**整份
 * 平移整數格**，只有新進來的那一層需要算。走一步只換一片，不是換一整塊。
 *
 * 那與 `WorldStream` 的格子是同一個想法，連「為什麼要對齊整數格」的理由都
 * 一樣：不對齊的話每一幀所有格子的內容都變了，增量就等於沒做。
 */

export interface GlobalDistanceFieldOptions {
  /** 每一軸幾格。預設 32。 */
  resolution?: number;
  /** 整份場的邊長，世界單位。預設 200。 */
  extent?: number;
  /**
   * 一幀最多重算幾格。預設 4096。
   *
   * 與遠景合併的烘焙預算同一個道理：相機瞬移的時候整份都要換，而一次做完
   * 會是一次可見的卡頓。分幀做的話那幾幀場是舊的 —— 遮蔽會慢一點跟上，
   * 那是安全的方向（畫面正確，只是暗得慢）。
   */
  budget?: number;
}

/** 場裡的一個物件：它的距離場，加上它在世界的位置。 */
export interface FieldInstance {
  volume: DistanceFieldVolume;
  /** 物件的世界矩陣。查表時會用它的逆矩陣把點換回區域空間。 */
  matrixWorld: Matrix4;
}

export class GlobalDistanceField {
  readonly resolution: number;
  readonly extent: number;
  readonly texture: Data3DTexture;
  /** 與 `texture` 同一格網格，存的是最近那個表面的反照率。 */
  readonly albedoTexture: Data3DTexture;
  /** 這一份場目前的最小角，世界座標（對齊整數格）。 */
  readonly min = new Vector3();

  private readonly data: Float32Array;
  /**
   * 每一格「最近那個表面是什麼顏色」。
   *
   * 八位元夠：反照率的值域就是 0–1，而反彈與反射本來就是低頻的。
   */
  private readonly albedoData: Uint8Array;
  private readonly budget: number;
  private readonly cell: number;
  private readonly instances: FieldInstance[] = [];
  /** 還沒算的格子（線性索引）。相機一動就把新進來的推進來。 */
  private pending: number[] = [];
  private centred = false;

  /** 診斷：這一幀算了幾格、還欠幾格。 */
  cellsBuilt = 0;

  constructor(options: GlobalDistanceFieldOptions = {}) {
    this.resolution = Math.max(8, Math.floor(options.resolution ?? 32));
    this.extent = options.extent ?? 200;
    this.budget = Math.max(1, Math.floor(options.budget ?? 4096));
    this.cell = this.extent / this.resolution;

    const n = this.resolution;
    this.data = new Float32Array(n * n * n).fill(this.extent);
    const texture = new Data3DTexture(this.data, n, n, n);
    texture.format = RedFormat;
    texture.type = FloatType;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.wrapR = ClampToEdgeWrapping;
    texture.needsUpdate = true;
    this.texture = texture;

    this.albedoData = new Uint8Array(n * n * n * 4);
    const albedo = new Data3DTexture(this.albedoData, n, n, n);
    albedo.format = RGBAFormat;
    albedo.type = UnsignedByteType;
    albedo.minFilter = LinearFilter;
    albedo.magFilter = LinearFilter;
    albedo.wrapS = ClampToEdgeWrapping;
    albedo.wrapT = ClampToEdgeWrapping;
    albedo.wrapR = ClampToEdgeWrapping;
    albedo.needsUpdate = true;
    this.albedoTexture = albedo;
  }

  /** 把一個物件放進場裡。 */
  add(instance: FieldInstance): void {
    this.instances.push(instance);

    // ## 比一格還小的東西，這份場**表示不出來**
    //
    // 全域場是低頻的：一格 `extent / resolution` 個單位，而每一格只存一個
    // 距離。物件比一格還小的話，格心很可能全部落在它外面 —— 於是那個物件
    // 在這份場裡等於不存在，光線直接穿過去。
    //
    // 那是解析度的本質，不是 bug。但它的症狀是**那個東西就是不擋光**，
    // 而畫面上看不出原因 —— 所以要講出來。
    //
    // 細節本來就不該由這份場管：貼身的遮蔽歸 `ScreenSpaceGI`，單一物件的
    // 準確形狀歸 `DistanceFieldVolume`。這份場管的是「遠處那一大塊擋不擋」。
    const span = Math.max(instance.volume.size.x, instance.volume.size.y, instance.volume.size.z);
    if (span < this.cell * 2 && !this.warnedSmall) {
      this.warnedSmall = true;
      console.warn(
        [
          `WW.GlobalDistanceField: 加進來的物件（約 ${span.toFixed(1)} 單位）比一格（${this.cell.toFixed(1)}）還小，`,
          '在這份場裡幾乎擋不住光 —— 格心會落在它外面，光線直接穿過去。',
          '這是解析度的本質：全域場管的是遠處那一大塊，貼身的遮蔽歸 ScreenSpaceGI，',
          '單一物件的準確形狀歸 DistanceFieldVolume。',
          '真的要它擋的話，把 resolution 調高或 extent 調小。',
        ].join('\n'),
      );
    }

    // 內容變了，整份重算 —— 這不是每幀會發生的事。
    this.invalidateAll();
  }

  private warnedSmall = false;

  remove(volume: DistanceFieldVolume): void {
    const index = this.instances.findIndex((entry) => entry.volume === volume);
    if (index < 0) return;
    this.instances.splice(index, 1);
    this.invalidateAll();
  }

  private invalidateAll(): void {
    const total = this.resolution ** 3;
    this.pending = [];
    for (let i = 0; i < total; i++) this.pending.push(i);
  }

  /** 還欠幾格沒算。0 代表這一份場是完整的。 */
  get pendingCells(): number {
    return this.pending.length;
  }

  /**
   * 每幀呼叫：把場移到相機附近，然後在預算內算一些格子。
   *
   * @returns 這一次算了幾格。
   */
  update(cameraPosition: Vector3): number {
    // ## 對齊整數格
    //
    // 不對齊的話相機動一點點所有格子的世界座標就全變了，增量等於沒做。
    const half = this.extent / 2;
    const wantedX = Math.round((cameraPosition.x - half) / this.cell) * this.cell;
    const wantedY = Math.round((cameraPosition.y - half) / this.cell) * this.cell;
    const wantedZ = Math.round((cameraPosition.z - half) / this.cell) * this.cell;

    if (
      !this.centred ||
      wantedX !== this.min.x ||
      wantedY !== this.min.y ||
      wantedZ !== this.min.z
    ) {
      this.min.set(wantedX, wantedY, wantedZ);
      this.centred = true;
      // 平移之後**整份都不對了**（每一格的世界座標都變了）。真正的 clipmap
      // 會把重疊的部分搬過去，這裡先全部重算 —— 而重算是分幀的，所以那個
      // 差別是「暗得慢幾幀」，不是卡頓。
      this.invalidateAll();
    }

    this.cellsBuilt = 0;
    const n = this.resolution;
    const at = _updateAt;

    while (this.pending.length > 0 && this.cellsBuilt < this.budget) {
      const index = this.pending.pop()!;
      const x = index % n;
      const y = ((index / n) | 0) % n;
      const z = (index / (n * n)) | 0;
      at.set(
        this.min.x + (x + 0.5) * this.cell,
        this.min.y + (y + 0.5) * this.cell,
        this.min.z + (z + 0.5) * this.cell,
      );
      this.data[index] = this.composeAt(at, _composeAlbedo);
      this.albedoData[index * 4] = Math.round(Math.min(1, Math.max(0, _composeAlbedo.x)) * 255);
      this.albedoData[index * 4 + 1] = Math.round(Math.min(1, Math.max(0, _composeAlbedo.y)) * 255);
      this.albedoData[index * 4 + 2] = Math.round(Math.min(1, Math.max(0, _composeAlbedo.z)) * 255);
      this.albedoData[index * 4 + 3] = 255;
      this.cellsBuilt++;
    }

    if (this.cellsBuilt > 0) {
      this.texture.needsUpdate = true;
      this.albedoTexture.needsUpdate = true;
    }
    return this.cellsBuilt;
  }

  /**
   * 合成一點的距離：所有物件裡**最近的那一個**。
   *
   * 取 min 是距離場合成的定義 —— 一個點到「這堆東西」的距離，就是它到最近
   * 那一個的距離。
   */
  private composeAt(worldPoint: Vector3, albedo: Vector3): number {
    let closest = this.extent;
    let nearest: FieldInstance | null = null;
    for (const instance of this.instances) {
      // 換到那個物件的區域空間再查。
      const local = _composeLocal
        .copy(worldPoint)
        .applyMatrix4(_composeInverse.copy(instance.matrixWorld).invert());
      // 完全在那個場外面的話，用「到場的外接盒有多遠」當下界 —— 直接查會
      // 被夾到邊緣值，而邊緣值對遠處的點是嚴重低估（看起來像那裡有東西）。
      const outside = distanceToBox(local, instance.volume.min, instance.volume.size);
      const distance = outside > 0 ? outside : instance.volume.distanceAt(local);
      if (distance < closest) {
        closest = distance;
        nearest = instance;
      }
    }
    // ## 順手把最近那個表面的顏色也記下來
    //
    // 距離場只答得出「那裡有東西」。追蹤打到之後**那是什麼顏色**要另外
    // 一份資料 —— 而在 CPU 上那份已經有了（每個 `DistanceFieldVolume`
    // 自己的表面快取）。這裡把它合成到同一格世界網格上，著色器才查得到。
    //
    // 這正是 Lumen 的 surface cache 升到全域的那一步：反射打到一面紅牆
    // 要回傳紅色，而不是「那裡有東西」加上「那裡有多亮」。少了它，反射
    // 到的顏色會是**打到的地方收到的光**，而不是那個表面射出來的光 ——
    // 紅牆會反射成白的。
    if (nearest === null) {
      albedo.set(0, 0, 0);
    } else {
      const local = _composeLocal
        .copy(worldPoint)
        .applyMatrix4(_composeInverse.copy(nearest.matrixWorld).invert());
      nearest.volume.albedoAt(local, albedo);
    }
    return closest;
  }

  /** 查一點的距離，三線性內插。 */
  distanceAt(point: Vector3): number {
    const n = this.resolution;
    const gx = clamp01((point.x - this.min.x) / this.extent) * (n - 1);
    const gy = clamp01((point.y - this.min.y) / this.extent) * (n - 1);
    const gz = clamp01((point.z - this.min.z) / this.extent) * (n - 1);
    const x0 = Math.min(Math.floor(gx), n - 2);
    const y0 = Math.min(Math.floor(gy), n - 2);
    const z0 = Math.min(Math.floor(gz), n - 2);
    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;

    let sum = 0;
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const w = (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy) * (dz === 0 ? 1 - fz : fz);
          if (w === 0) continue;
          sum += this.data[((z0 + dz) * n + (y0 + dy)) * n + (x0 + dx)]! * w;
        }
      }
    }
    return sum;
  }

  /**
   * 從一點往一個方向追蹤，回傳遮蔽 0–1。
   *
   * 與 `DistanceFieldVolume.occlusionAlong` 同一個式子 —— 差別只在查的是
   * 合成後的場，所以**鏡頭外、而且不屬於同一個物件**的東西照樣擋得住。
   */
  occlusionAlong(origin: Vector3, direction: Vector3, range = this.extent * 0.25): number {
    const point = _traceAt.copy(origin);
    const bias = this.cell;
    let travelled = bias;
    point.addScaledVector(direction, bias);
    let closest = Infinity;

    for (let step = 0; step < 48 && travelled < range; step++) {
      const distance = this.distanceAt(point);
      if (distance < 1e-4) return 1;
      closest = Math.min(closest, distance / Math.max(travelled, 1e-4));
      point.addScaledVector(direction, distance);
      travelled += distance;
    }
    return Math.max(0, Math.min(1, 1 - closest));
  }

  /**
   * 往一個方向追蹤，回傳**打到的表面反彈出來的光**。
   *
   * ## 這是第二次反彈
   *
   * `occlusionAlong` 只答「有沒有被擋住」。這一支再往前一步：打到之後
   * 去查那個表面是什麼顏色（表面快取），乘上那一點的輻照度（探針），
   * 得到它射出多少光。
   *
   * 而**那正是為什麼第二次反彈便宜**：不是再追一次，是查一次表。Lumen
   * 的 surface cache 與 radiance cache 就是在做這件事。
   *
   * @param irradianceAt 查一點的輻照度。通常接 `IrradianceVolume.sampleAt`。
   * @returns 反彈回來的光。沒打到東西就是 0（那個方向是空的）。
   */
  radianceAlong(
    origin: Vector3,
    direction: Vector3,
    irradianceAt: (point: Vector3, normal: Vector3) => Vector3,
    range = this.extent * 0.25,
    target = new Vector3(),
  ): Vector3 {
    target.set(0, 0, 0);
    const point = _radianceAt.copy(origin);
    const bias = this.cell;
    let travelled = bias;
    point.addScaledVector(direction, bias);

    for (let step = 0; step < 48 && travelled < range; step++) {
      const distance = this.distanceAt(point);
      if (distance < this.cell * 0.5) {
        // 打到了。找出是誰，查它的表面顏色。
        const instance = this.nearestInstance(point);
        if (instance === null) return target;
        const local = _radianceLocal
          .copy(point)
          .applyMatrix4(_radianceInverse.copy(instance.matrixWorld).invert());
        instance.volume.albedoAt(local, _radianceAlbedo);
        // 射出的光 = 反照率 × 那一點收到的光。法線用**反向的光線**近似
        // ——真正的法線要從距離場的梯度算，而那要多三次查表；反彈光是
        // 低頻的，這個近似看不出差別。
        const incoming = irradianceAt(point, _radianceNormal.copy(direction).negate());
        return target.set(
          _radianceAlbedo.x * incoming.x,
          _radianceAlbedo.y * incoming.y,
          _radianceAlbedo.z * incoming.z,
        );
      }
      point.addScaledVector(direction, distance);
      travelled += distance;
    }
    return target;
  }

  /** 哪一個物件離這一點最近 —— 追蹤打到之後要問它的顏色。 */
  private nearestInstance(worldPoint: Vector3): FieldInstance | null {
    let best: FieldInstance | null = null;
    let bestDistance = Infinity;
    for (const instance of this.instances) {
      const local = _radianceLocal
        .copy(worldPoint)
        .applyMatrix4(_radianceInverse.copy(instance.matrixWorld).invert());
      const outside = distanceToBox(local, instance.volume.min, instance.volume.size);
      const distance = outside > 0 ? outside : Math.abs(instance.volume.distanceAt(local));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = instance;
      }
    }
    return best;
  }

  dispose(): void {
    this.texture.dispose();
    this.albedoTexture.dispose();
  }
}

const _updateAt = new Vector3();
const _composeLocal = new Vector3();
const _composeAlbedo = new Vector3();
const _composeInverse = new Matrix4();
const _traceAt = new Vector3();
const _radianceAt = new Vector3();
const _radianceLocal = new Vector3();
const _radianceInverse = new Matrix4();
const _radianceAlbedo = new Vector3();
const _radianceNormal = new Vector3();

/** 點到一個軸對齊盒子的距離，裡面回 0。 */
function distanceToBox(point: Vector3, min: Vector3, size: Vector3): number {
  const dx = Math.max(min.x - point.x, 0, point.x - (min.x + size.x));
  const dy = Math.max(min.y - point.y, 0, point.y - (min.y + size.y));
  const dz = Math.max(min.z - point.z, 0, point.z - (min.z + size.z));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
