import {
  ClampToEdgeWrapping,
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Vector3,
  WebGLCubeRenderTarget,
  CubeCamera,
} from 'three';
import type { Material, Object3D, Scene, WebGLRenderer } from 'three';
import { projectCubeToSH, type FacePixels } from './cube-sh.ts';

/** `invalidateAround` 每幀會走很多顆，不要每次配一個。 */
const _invalidateAt = new Vector3();

/**
 * 間接光：烘出來的輻照度探針體積。
 *
 * ## 為什麼這是「資料問題」而不是「渲染器問題」
 *
 * 全域光照原本整個被標成不做，理由是「會把強化層變成另一個渲染器」。那個
 * 理由對 GI 的一半成立，而它被拿來擋掉了整個 —— 見 [ADR-0006](../../../specs/adr/0006-baked-irradiance-not-realtime-gi.md)。
 *
 * 即時動態 GI（Lumen 那一類）確實要擁有整條管線，那一半仍然不做。但**烘
 * 出來的間接光**根本不碰管線：
 *
 * | | 誰做 |
 * | --- | --- |
 * | 把畫面畫出來 | Three 的 renderer |
 * | 探針怎麼烘、怎麼存、怎麼串流、怎麼分預算 | 這裡 |
 *
 * 著色端加的只有一次查表加一個 SH 求值，接法與 CSM 同一類（`onBeforeCompile`）。
 * 沒有新的 render pass。
 *
 * ## 為什麼間接光是「看起來真」的關鍵
 *
 * 只有直接光的話，陰影裡是**全黑**的，而現實中沒有全黑的陰影 —— 天空、
 * 地面、旁邊的牆都在往裡面送光。那個差別看起來就是「像塑膠」與「像真的」。
 *
 * 這也是為什麼它值得做：幾何再細、陰影再準，少了它整個世界還是假的。
 *
 * ## 為什麼用 SH L1 而不是更高階
 *
 * 每顆探針存 4 個係數 × RGB。L2（9 個係數）方向性更好，但**體積裡的探針
 * 數量是三次方成長的** —— 32×8×32 就是 8,192 顆。省下來的不是一顆探針的
 * 記憶體，是整個網格的。
 *
 * L1 也是 UE 的 ILC 與多數探針體積的選擇，理由一樣。
 *
 * ## 為什麼用 Three 自己的 SH 慣例
 *
 * 投影用的是 `three/addons` 的 `LightProbeGenerator`，求值用的常數與 Three
 * 的 `shGetIrradianceAt` **逐字相同**（0.886227 / 1.023328）。
 *
 * 這與簡化器用 meshoptimizer、切線用 MikkTSpace 是同一個判斷：自己寫一份
 * 「數學上也對但慣例差一點」的版本，症狀是亮度差一截或方向反了，而且不會
 * 報錯。用同一份慣例就不會有那個問題。
 */

/** SH L1：4 個係數，每個 RGB。 */
const COEFFICIENTS = 4;

export interface IrradianceVolumeOptions {
  /** 體積的最小角（世界座標）。 */
  min: Vector3;
  /** 三軸長度。 */
  size: Vector3;
  /**
   * 三軸各放幾顆探針。
   *
   * 探針數是**三次方成長**的：[16,4,16] 是 1,024 顆，[32,8,32] 是 8,192 顆。
   * 而每一顆都要拍一張 cubemap 才烘得出來，所以這個數字直接決定烘要多久。
   *
   * 垂直方向通常可以少很多 —— 間接光在高度上變化比水平慢。
   */
  resolution: [number, number, number];
  /**
   * 整體強度。預設 1。
   *
   * 這是**開發者的曝光選擇**，不是物理量。烘出來的值是場景真正的輻照度，
   * 但「要多亮才好看」與色調對應、曝光綁在一起，那些都在開發者那一側。
   */
  intensity?: number;
}

/**
 * 一格三維探針網格，加上它在 GPU 上的樣子。
 *
 * 探針資料放在 4 張 `Data3DTexture`（每張 RGBA16F，只用 RGB）。用**半精度**
 * 而不是單精度是因為 WebGL2 保證半精度可以線性過濾，單精度要看
 * `OES_texture_float_linear` 在不在。
 *
 * 而線性過濾正是這件事的重點：探針之間的平滑內插如果要在 shader 裡自己做，
 * 是 8 次取樣 × 4 張貼圖 = 32 次；交給硬體就是 4 次。
 */
export class IrradianceVolume {
  readonly min: Vector3;
  readonly size: Vector3;
  readonly resolution: readonly [number, number, number];
  readonly probeCount: number;

  /** 每顆探針 4 個係數 × RGB，攤平。 */
  private readonly sh: Float32Array;
  private readonly _textures: Data3DTexture[] = [];
  /** 有沒有接過 node 材質。有的話 intensity 就改不動了 —— 見 setter。 */
  private _hasNodeMaterial = false;
  private _warnedIntensity = false;
  private readonly data: Uint16Array[] = [];
  private _baked = 0;
  /**
   * 過期的探針，照加入順序排。
   *
   * 用 `Set` 是為了同一顆被標兩次不會排兩遍 —— 一個東西在兩顆探針之間
   * 移動時，中間那幾顆每幀都會被標到。
   */
  private readonly _stale = new Set<number>();
  private dirty = true;
  /**
   * uniform 物件**建一次就不再換**。
   *
   * `onBeforeCompile` 只在編譯時跑一次，它把這些物件塞進 shader 的 uniforms。
   * 之後要改的必須是**同一個物件的 `.value`** —— 每次回傳一份新的話，接上去
   * 之後改 `intensity` 完全沒有反應，而且不會報錯。
   *
   * 這個坑差一點就踩到：A/B 比較正是靠改 `intensity` 做的，而它會靜靜地
   * 兩邊都量到同一個值。
   */
  private readonly _uniforms: Record<string, { value: unknown }>;

  constructor(options: IrradianceVolumeOptions) {
    this.min = options.min.clone();
    this.size = options.size.clone();
    this.resolution = [...options.resolution];
    const [nx, ny, nz] = this.resolution;
    if (nx < 2 || ny < 2 || nz < 2) {
      // 任何一軸只有一層的話三線性內插在那個方向退化成常數，而症狀是
      // 「間接光在那個方向完全不變」—— 看起來像烘壞了，其實是網格太薄。
      throw new Error(`WW.IrradianceVolume: 每一軸至少要 2 顆探針，收到 [${nx}, ${ny}, ${nz}]`);
    }
    this.probeCount = nx * ny * nz;
    this.sh = new Float32Array(this.probeCount * COEFFICIENTS * 3);

    for (let c = 0; c < COEFFICIENTS; c++) {
      const data = new Uint16Array(this.probeCount * 4);
      const texture = new Data3DTexture(data, nx, ny, nz);
      texture.format = RGBAFormat;
      texture.type = HalfFloatType;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      // 邊界夾住：體積外的查詢會拿到邊緣那顆探針，而不是繞到另一邊。
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.wrapR = ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.data.push(data);
      this._textures.push(texture);
    }

    this._uniforms = {
      wwIrrSH0: { value: this._textures[0] },
      wwIrrSH1: { value: this._textures[1] },
      wwIrrSH2: { value: this._textures[2] },
      wwIrrSH3: { value: this._textures[3] },
      wwIrrMin: { value: this.min },
      wwIrrInvSize: { value: new Vector3(1 / this.size.x, 1 / this.size.y, 1 / this.size.z) },
      wwIrrIntensity: { value: options.intensity ?? 1 },
    };
  }

  /**
   * 整體強度。改它會**立刻**反映到已經接上的材質（見 `_uniforms`）。
   *
   * 設成 0 就等於關掉間接光，而且走的還是**同一條著色器路徑** —— A/B 比較
   * 要用這個。換材質做 A/B 比的是兩個不同的著色器，那個比較說明不了間接光。
   */
  get intensity(): number {
    return this._uniforms.wwIrrIntensity!.value as number;
  }

  set intensity(value: number) {
    if (this._uniforms.wwIrrIntensity!.value === value) return;
    this._uniforms.wwIrrIntensity!.value = value;

    // ## node 材質那條路改不動，所以要吼出來
    //
    // WebGL 那邊 intensity 是 uniform，每幀上傳，改了立刻生效。node 那邊
    // 它是**編譯期常數**（原因見 irradiance-node.ts），改了之後畫面一個
    // 位元都不會動。
    //
    // 靜靜地沒反應是這個專案最怕的形狀，所以這裡明講。試過的替代方案：
    // 做成 TSL 的 uniform（值傳到了但不上傳）、重接一份新的節點圖、
    // `needsUpdate = true` 強制重編 —— 三個都沒有讓畫面改變。
    if (this._hasNodeMaterial && !this._warnedIntensity) {
      this._warnedIntensity = true;
      console.warn(
        [
          'WW.IrradianceVolume: 接上 node 材質（WebGPU）之後改 intensity 不會有效果。',
          '那條路的強度是編譯期常數 —— WebGL 上會變，WebGPU 上不會，而且兩邊都不報錯。',
          '要改的話在 new IrradianceVolume({ intensity }) 的時候就給定。',
        ].join('\n'),
      );
    }
  }

  /** `applyIrradianceNode` 接上之後回報一聲，讓 intensity 的 setter 知道要吼。 */
  markNodeMaterial(): void {
    this._hasNodeMaterial = true;
  }

  /**
   * 探針貼圖。node 材質那條路要直接拿去做 `texture3D`。
   *
   * 開出來是因為兩條路共用的必須是**同一批貼圖** —— 各自持有一份的話烘好的
   * 資料只會進到其中一邊，而症狀是「其中一個後端沒有間接光」。
   */
  get textures(): readonly Data3DTexture[] {
    return this._textures;
  }

  /** 已經烘好幾顆。等於 `probeCount` 就是烘完了。 */
  get baked(): number {
    return this._baked;
  }

  /** 烘完的比例 0–1，拿來畫進度。 */
  get progress(): number {
    return this._baked / this.probeCount;
  }

  /** 第 `index` 顆探針在世界座標的哪裡。 */
  probePosition(index: number, target = new Vector3()): Vector3 {
    const [nx, ny, nz] = this.resolution;
    const x = index % nx;
    const y = Math.floor(index / nx) % ny;
    const z = Math.floor(index / (nx * ny)) % nz;
    // 探針放在格點上（含兩端），這樣體積的邊界剛好有探針 —— 放在格子中心
    // 的話邊緣半格沒有資料，而那半格會被夾住的邊界值糊掉。
    return target.set(
      this.min.x + (this.size.x * x) / (nx - 1),
      this.min.y + (this.size.y * y) / (ny - 1),
      this.min.z + (this.size.z * z) / (nz - 1),
    );
  }

  /**
   * 寫進一顆探針的 SH 係數。
   *
   * @param coefficients 至少 4 組 RGB（Three 的 `SphericalHarmonics3.coefficients`
   *   直接可以用 —— 前 4 個就是 L1，多的會被忽略）。
   */
  setProbe(index: number, coefficients: readonly { x: number; y: number; z: number }[]): void {
    const base = index * COEFFICIENTS * 3;
    for (let c = 0; c < COEFFICIENTS; c++) {
      const v = coefficients[c];
      if (v === undefined) continue;
      this.sh[base + c * 3] = v.x;
      this.sh[base + c * 3 + 1] = v.y;
      this.sh[base + c * 3 + 2] = v.z;
      const texel = index * 4;
      this.data[c]![texel] = DataUtils.toHalfFloat(v.x);
      this.data[c]![texel + 1] = DataUtils.toHalfFloat(v.y);
      this.data[c]![texel + 2] = DataUtils.toHalfFloat(v.z);
      this.data[c]![texel + 3] = 0x3c00; // 半精度的 1.0
    }
    this.dirty = true;
  }

  /**
   * 把一個範圍內的探針標成過期，下次烘的時候優先重烘。
   *
   * ## 這是「會動的東西不反彈光」那個限制的解法
   *
   * 烘出來的探針是靜態的：一台紅色的車開過白牆邊，牆不會沾到紅色。
   * [ADR-0006](../../../specs/adr/0006-baked-irradiance-not-realtime-gi.md)
   * 把那個限制寫下來了。
   *
   * 補它的方式**不是**寫一套螢幕空間 GI（那是渲染器的事），是重烘附近的
   * 探針 —— 探針怎麼烘、怎麼分預算正是那份 ADR 說這裡該做的那一半。
   *
   * ## 它有多貴，以及為什麼那個數字重要
   *
   * 一顆探針 **2.7 ms**（原本 37 ms，見 roadmap）。所以這不是「每幀重烘
   * 一整片」的功能 —— 標太多顆會直接吃掉幀。
   *
   * 合理的用法是「一個會動的東西，標它周圍那幾顆」，而且接受間接光**慢
   * 幾幀才跟上**。那個延遲是這條路的代價，換來的是不必擁有渲染管線。
   *
   * @param center 世界座標。
   * @param radius 這個半徑內的探針都重烘。
   * @returns 標了幾顆（已經在排隊的不重複算）。
   */
  invalidateAround(center: Vector3, radius: number): number {
    const [nx, ny, nz] = this.resolution;
    // 換算成格子座標的範圍，只走那一塊 —— 整份掃過去的話大體積會很慢，
    // 而這個函式是每幀被呼叫的。
    const stepX = this.size.x / (nx - 1);
    const stepY = this.size.y / (ny - 1);
    const stepZ = this.size.z / (nz - 1);
    const x0 = Math.max(0, Math.floor((center.x - radius - this.min.x) / stepX));
    const x1 = Math.min(nx - 1, Math.ceil((center.x + radius - this.min.x) / stepX));
    const y0 = Math.max(0, Math.floor((center.y - radius - this.min.y) / stepY));
    const y1 = Math.min(ny - 1, Math.ceil((center.y + radius - this.min.y) / stepY));
    const z0 = Math.max(0, Math.floor((center.z - radius - this.min.z) / stepZ));
    const z1 = Math.min(nz - 1, Math.ceil((center.z + radius - this.min.z) / stepZ));

    const radiusSq = radius * radius;
    const at = _invalidateAt;
    let marked = 0;
    for (let z = z0; z <= z1; z++) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const index = (z * ny + y) * nx + x;
          this.probePosition(index, at);
          // 用球而不是盒 —— 盒的角落那幾顆離得比 radius 遠，重烘它們是白花錢。
          if (at.distanceToSquared(center) > radiusSq) continue;
          if (this._stale.has(index)) continue;
          this._stale.add(index);
          marked++;
        }
      }
    }
    return marked;
  }

  /** 還有幾顆排隊等重烘。 */
  get stale(): number {
    return this._stale.size;
  }

  /**
   * 下一顆該烘哪一個：**過期的優先**，再來才是還沒烘過的。
   *
   * 過期的優先是因為那是**畫面上看得到的錯**（東西動了但光沒跟上）；
   * 還沒烘的那些只是還沒亮起來，而那個過程本來就是漸進的。
   *
   * @returns 探針編號，沒有要烘的就回 −1。
   */
nextToBake(): number {
    for (const index of this._stale) return index;
    return this._baked < this.probeCount ? this._baked : -1;
  }

  /** 這一顆烘完了。過期佇列裡的移掉，沒烘過的推進度。 */
  markProbeDone(index: number): void {
    if (this._stale.delete(index)) return;
    if (index === this._baked) this._baked = Math.min(this._baked + 1, this.probeCount);
  }

  /** 這一顆算烘好了。分開記是因為 `setProbe` 也用在測試與載入既有資料。 */
  markBaked(count = 1): void {
    this._baked = Math.min(this._baked + count, this.probeCount);
  }

  /** 把改動推上 GPU。改了探針而沒有推的症狀是畫面停在上一版。 */
  upload(): void {
    if (!this.dirty) return;
    for (const texture of this._textures) texture.needsUpdate = true;
    this.dirty = false;
  }

  /**
   * 給 shader 的 uniform。`applyIrradiance` 會用它，一般不必自己碰。
   */
  uniforms(): Record<string, { value: unknown }> {
    return this._uniforms;
  }

  /**
   * 讀回一顆探針的係數。給測試與除錯用 —— GPU 那一份是半精度，這一份是原值。
   */
  probeCoefficients(index: number): Float32Array {
    const base = index * COEFFICIENTS * 3;
    return this.sh.slice(base, base + COEFFICIENTS * 3);
  }

  /**
   * 用與 shader **完全相同**的公式在 CPU 上求值。
   *
   * 存在的理由是驗證：shader 裡的錯是不會報錯的（這個專案踩過好幾次），
   * 而有一份 CPU 版就能在測試裡問「這個位置這個法線應該多亮」。
   *
   * 內插也是三線性的，與 GPU 的 `LinearFilter` 對應。
   */
  sampleAt(position: Vector3, normal: Vector3): Vector3 {
    const [nx, ny, nz] = this.resolution;
    const gx = clamp01((position.x - this.min.x) / this.size.x) * (nx - 1);
    const gy = clamp01((position.y - this.min.y) / this.size.y) * (ny - 1);
    const gz = clamp01((position.z - this.min.z) / this.size.z) * (nz - 1);

    const x0 = Math.min(Math.floor(gx), nx - 2);
    const y0 = Math.min(Math.floor(gy), ny - 2);
    const z0 = Math.min(Math.floor(gz), nz - 2);
    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;

    const acc = new Float32Array(COEFFICIENTS * 3);
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const w =
            (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy) * (dz === 0 ? 1 - fz : fz);
          if (w === 0) continue;
          const index = x0 + dx + (y0 + dy) * nx + (z0 + dz) * nx * ny;
          const base = index * COEFFICIENTS * 3;
          for (let k = 0; k < COEFFICIENTS * 3; k++) acc[k]! += this.sh[base + k]! * w;
        }
      }
    }
    return evaluateSH(acc, normal).multiplyScalar(this.intensity);
  }

  dispose(): void {
    for (const texture of this._textures) texture.dispose();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * SH L1 求值 —— 常數與 Three 的 `shGetIrradianceAt` 逐字相同。
 *
 * 0.886227 = π · Y₀₀，1.023328 = 2 · 0.511664。改動它們就等於與 Three 的
 * `LightProbe` 用不同的慣例，而那個差別是「整體亮度差一截」，不會報錯。
 */
function evaluateSH(sh: ArrayLike<number>, normal: Vector3): Vector3 {
  const { x, y, z } = normal;
  // ## 負值要夾掉，而且要**跟 shader 夾在同一個地方**
  //
  // L1 的振幅大過 L0 的時候，背光那一面會算出負的輻照度 —— 那沒有物理意義，
  // 而畫面上它是一個把周圍光吃掉的黑洞。
  //
  // 這一份與 shader 裡的 `max( result, vec3( 0.0 ) )` 對應。少了它兩邊會
  // 在「哪些位置是負的」這件事上分岔，而這一份的存在理由就是當 shader 的
  // 對照組 —— 對不上的話它反而會替錯的值背書。
  return new Vector3(
    Math.max(sh[0]! * 0.886227 + 1.023328 * (sh[3]! * y + sh[6]! * z + sh[9]! * x), 0),
    Math.max(sh[1]! * 0.886227 + 1.023328 * (sh[4]! * y + sh[7]! * z + sh[10]! * x), 0),
    Math.max(sh[2]! * 0.886227 + 1.023328 * (sh[5]! * y + sh[8]! * z + sh[11]! * x), 0),
  );
}

export interface IrradianceBakeOptions {
  /**
   * 這一次呼叫最多花多久，毫秒。預設 8。
   *
   * ## 這個預算管的是「發出去」，不是「等回來」
   *
   * 每顆探針要把場景畫六次（cubemap 的六個面）再讀回來。**畫六次只要
   * 0.3 ms，讀回才是大頭** —— 而讀回是非同步的，等它的時候主執行緒是
   * 空的。
   *
   * 所以這個預算計時的是「排命令」那一段：排到超過預算就停手，然後一次
   * 把這一輪發出去的讀回全部等完。實測一輪塞得下約七顆（12 ms 預算），
   * 平均一顆 2.7 ms。
   *
   * 第一版把它寫成「每幀最多花這麼久」，而那時候一顆探針要 37 ms ——
   * 預設 8 ms 的預算每次超出四倍半，這行說明是假的。修法見 roadmap
   * 「烘探針快了 13.7 倍」那一節。
   *
   * 烘的過程中間接光會**逐漸浮現**，那是可以接受、而且看得懂的行為。
   */
  budgetMs?: number;
  /**
   * cubemap 每個面的邊長。預設 16。
   *
   * 探針記的是**低頻**的間接光（SH L1 只有 4 個係數），所以拍很大張沒有
   * 意義 —— 投影完就丟掉了。16 已經遠超 L1 表達得出來的細節。
   *
   * 調小也**幾乎不會變快**：實測面寬 4 與 32（像素差 64 倍）一顆探針的
   * 時間差不到 10%，因為成本在讀回的同步點上，不在像素數上。
   */
  faceSize?: number;
  /** 近裁面。預設 0.1。 */
  near?: number;
  /** 遠裁面。預設 1000。 */
  far?: number;
}

/**
 * 烘探針，**分幀**。每幀呼叫一次，直到 `volume.baked === volume.probeCount`。
 *
 * ```js
 * const volume = new WW.IrradianceVolume({ min, size, resolution: [16, 4, 16] });
 * // 每幀：
 * if (volume.baked < volume.probeCount) await WW.bakeIrradiance(renderer, scene, volume);
 * ```
 *
 * ## 烘的時候要把「會被間接光照到的東西」留在場景裡
 *
 * 這裡拍的就是**當下的 scene**。所以烘之前該關掉的是會自己發光又會動的
 * 東西（角色、粒子）—— 它們會被烤進靜態的間接光裡，然後永遠留在那裡。
 *
 * 這件事沒辦法自動判斷（哪些算靜態是內容的意思，不是型別的意思），所以
 * 這裡不猜，由呼叫端決定。
 *
 * @returns 這一次烘了幾顆。
 */
/**
 * 烘用的 render target 與 cube camera，照 renderer 與面寬快取。
 *
 * 每次重開的成本與「畫六次」同一個量級 —— 而這個函式每幀都會被呼叫。
 */
const bakeCaches = new WeakMap<
  object,
  Map<number, { target: WebGLCubeRenderTarget; camera: CubeCamera }>
>();

async function bakeCache(
  renderer: WebGLRenderer,
  faceSize: number,
  options: IrradianceBakeOptions,
): Promise<{ target: WebGLCubeRenderTarget; camera: CubeCamera }> {
  let bySize = bakeCaches.get(renderer);
  if (bySize === undefined) {
    bySize = new Map();
    bakeCaches.set(renderer, bySize);
  }
  const existing = bySize.get(faceSize);
  if (existing !== undefined) return existing;

  const isWebGL = (renderer as { isWebGLRenderer?: boolean }).isWebGLRenderer === true;
  const target = isWebGL
    ? new WebGLCubeRenderTarget(faceSize)
    : new ((await import('three/webgpu')) as unknown as {
        CubeRenderTarget: new (size: number) => WebGLCubeRenderTarget;
      }).CubeRenderTarget(faceSize);
  target.texture.type = HalfFloatType;
  const camera = new CubeCamera(options.near ?? 0.1, options.far ?? 1000, target);
  const entry = { target, camera };
  bySize.set(faceSize, entry);
  return entry;
}

/**
 * 放掉某個 renderer 的烘焙暫存。烘完之後不再需要就可以呼叫。
 *
 * 不呼叫也不會漏 —— `WeakMap` 會跟著 renderer 一起走。
 */
export function disposeBakeCache(renderer: WebGLRenderer): void {
  const bySize = bakeCaches.get(renderer);
  if (bySize === undefined) return;
  for (const { target } of bySize.values()) target.dispose();
  bakeCaches.delete(renderer);
}

export async function bakeIrradiance(
  renderer: WebGLRenderer,
  scene: Scene,
  volume: IrradianceVolume,
  options: IrradianceBakeOptions = {},
): Promise<number> {
  if (volume.nextToBake() < 0) return 0;

  const budgetMs = options.budgetMs ?? 8;
  const faceSize = options.faceSize ?? 16;

  // ## render target 與 cube camera 要重複用，而且**讀回要一次等完**
  //
  // 第一版逐顆探針呼叫 addon 的 `fromCubeRenderTarget`，而它在自己的迴圈裡
  // 逐面 await —— 六個面就是六次 GPU→CPU 同步。拆開量：
  //
  // | | 時間 |
  // | --- | ---: |
  // | 把場景畫六次 | **0.3 ms** |
  // | 投影＋讀回 | **36.8 ms** |
  //
  // 而且面寬從 4 開到 32（像素多 64 倍）那 36.8 ms 完全不動 —— 它不是在算，
  // 是在等。
  //
  // 所以這裡改成：先把這一輪所有探針的畫與讀回**全部發出去**，最後一次等完
  // 再投影。`readRenderTargetPixelsAsync` 在呼叫的當下就把 readPixels 排進
  // 命令流（進 PBO）並下 fence，所以後面那顆探針重畫同一張 target **不會**
  // 蓋掉前一顆的資料 —— 命令是照順序執行的。
  const cache = await bakeCache(renderer, faceSize, options);
  const { target, camera } = cache;
  const at = new Vector3();
  const isWebGL = (renderer as { isWebGLRenderer?: boolean }).isWebGLRenderer === true;
  const flip = isWebGL ? -1 : 1;
  const faceTexels = faceSize * faceSize * 4;

  const pending: { index: number; faces: FacePixels[]; waits: Promise<unknown>[] }[] = [];
  const started = performance.now();

  // 先把這一輪要烘的挑出來 —— 挑的時候不能就地標記完成（那要等讀回），
  // 所以用一個本地的集合擋掉重複挑到同一顆。
  const claimed = new Set<number>();
  for (;;) {
    const index = nextUnclaimed(volume, claimed);
    if (index < 0) break;
    claimed.add(index);
    volume.probePosition(index, at);
    camera.position.copy(at);
    camera.updateMatrixWorld(true);
    camera.update(renderer, scene);

    const faces: FacePixels[] = [];
    const waits: Promise<unknown>[] = [];
    for (let face = 0; face < 6; face++) {
      if (isWebGL) {
        // 每一顆探針要自己的緩衝 —— 共用的話還沒等到就被下一顆蓋掉。
        const buffer = new Uint16Array(faceTexels);
        faces.push(buffer);
        // **不 await。** 這一行同步把 readPixels 排進命令流，剩下的是等 fence。
        waits.push(
          (renderer as unknown as {
            readRenderTargetPixelsAsync: (...args: unknown[]) => Promise<unknown>;
          }).readRenderTargetPixelsAsync(target, 0, 0, faceSize, faceSize, buffer, face),
        );
      } else {
        // WebGPU 那條路是把資料**回傳**，不是填進傳進去的緩衝。
        const slot = faces.length;
        faces.push(new Uint16Array(0));
        waits.push(
          (renderer as unknown as {
            readRenderTargetPixelsAsync: (...args: unknown[]) => Promise<FacePixels>;
          })
            .readRenderTargetPixelsAsync(target, 0, 0, faceSize, faceSize, 0, face)
            .then((data) => {
              faces[slot] = data;
            }),
        );
      }
    }
    pending.push({ index, faces, waits });

    // 預算只管**發出去**這一段（一顆約 0.3 ms）。等待那一段是非同步的，
    // 不佔主執行緒 —— 拿它去卡預算的話一顆就爆掉，而那正是第一版的問題。
    if (performance.now() - started >= budgetMs) break;
  }

  // 一次等完。六次同步變成一輪一次。
  await Promise.all(pending.flatMap((entry) => entry.waits));

  // ## 解碼看的是**貼圖的型別**，不是哪個 renderer
  //
  // 第一版寫成「WebGL 用 fromHalfFloat、WebGPU 不解碼」，而兩邊的 target 都是
  // HalfFloat —— 於是 WebGPU 那條路把半精度的位元樣式當成數值用，係數變成
  // 24,178（1.0 的半精度位元樣式是 15360），畫面整片爆白。
  //
  // 兩件事本來就沒有關係：翻轉看座標系，解碼看像素怎麼存。
  const decode =
    target.texture.type === HalfFloatType ? DataUtils.fromHalfFloat : (value: number): number => value;
  for (const entry of pending) {
    const sh = projectCubeToSH(entry.faces, { faceSize, flip, decode });
    volume.setProbe(entry.index, sh.coefficients);
    volume.markProbeDone(entry.index);
  }
  const done = pending.length;
  volume.upload();
  return done;
}

/**
 * 下一顆還沒被這一輪挑走的。
 *
 * `volume.nextToBake()` 每次都回同一顆（它要等烘完才會前進），所以同一輪
 * 裡要自己記住挑過誰 —— 不記的話一輪會把同一顆烘七次。
 */
function nextUnclaimed(volume: IrradianceVolume, claimed: ReadonlySet<number>): number {
  const first = volume.nextToBake();
  if (first < 0) return -1;
  if (!claimed.has(first)) return first;
  // 過期的那幾顆挑完了，往還沒烘過的接下去。
  for (let index = volume.baked; index < volume.probeCount; index++) {
    if (!claimed.has(index)) return index;
  }
  return -1;
}

/**
 * 把 `root` 底下每個材質接上這個體積的間接光。
 *
 * ```js
 * WW.applyIrradiance(volume, scene);
 * ```
 *
 * 與 `applyShadows` 同一個形狀，連坑都一樣：`onBeforeCompile` 是**單一插槽**，
 * 所以這裡也是先接住原本那個再包起來。順序不重要。
 *
 * @returns 接了幾個材質。
 */
export function applyIrradiance(volume: IrradianceVolume, root: Object3D): number {
  const seen = new Set<Material>();
  const uniforms = volume.uniforms();

  root.traverse((object) => {
    const material = (object as { material?: Material | Material[] }).material;
    if (material === undefined) return;
    for (const one of Array.isArray(material) ? material : [material]) {
      if (seen.has(one)) continue;
      seen.add(one);
      inject(one, uniforms, volume);
    }
  });

  if (seen.size === 0) {
    console.warn(
      'WW.applyIrradiance: 這個 root 底下沒有任何材質，所以一個都沒接上 —— 場景不會有間接光。\n' +
        '通常是傳錯物件了（要傳 scene 或含有 mesh 的節點）。',
    );
  }
  return seen.size;
}

/** 已經接過的材質不再接第二次 —— 同一份材質被很多物件共用是常態。 */
const injected = new WeakSet<Material>();
/** node 材質那條路是非同步接上的，這裡記著還沒好的。 */
const pendingNodes = new Set<Promise<unknown>>();

/**
 * 等 node 材質那條路接完。
 *
 * WebGL 那條路是同步的（`onBeforeCompile` 只是設一個函式），但 node 那條
 * 要動態 import `three/tsl`，所以它是非同步的。
 *
 * **不等的話前幾幀是沒有間接光的**，而量測如果剛好落在那幾幀裡，會量到
 * 「沒有效果」然後把它讀成實作沒接上 —— 這個專案在 VAT 上就是因為量錯
 * 時機而得出過三倍的假結論。
 *
 * ```js
 * WW.applyIrradiance(volume, scene);
 * await WW.irradianceNodeReady();   // WebGPU 上要等；WebGL 上立刻返回
 * ```
 */
export async function irradianceNodeReady(): Promise<void> {
  await Promise.all([...pendingNodes]);
}
/** 只吼一次。整個場景都是 basic 材質的話會有幾百個。 */
let warnedUnlit = false;

function inject(
  material: Material,
  uniforms: Record<string, { value: unknown }>,
  volume: IrradianceVolume,
): void {
  if (injected.has(material)) return;
  injected.add(material);

  // ## node 材質走另一條路
  //
  // `onBeforeCompile` 是 WebGL 那條路的鉤子，`WebGPURenderer` 的編譯**完全
  // 不經過它**。在這裡不分流的話，WebGPU 上是靜靜地完全沒有間接光 —— 看
  // 起來像「烘壞了」或「這個場景本來就這麼暗」。
  //
  // 這個專案在 VAT 上踩過一模一樣的坑（實作在 WebGL、量測在 WebGPU），
  // 所以那之後的規矩是兩邊一起做、兩邊一起驗。
  if ((material as { isNodeMaterial?: boolean }).isNodeMaterial === true) {
    // 動態 import，所以是非同步的。失敗要吼出來 —— 靜靜跳過就回到上面那個
    // 「看起來像烘壞了」的狀態。
    const pending = import('./irradiance-node.ts')
      .then((m) => m.applyIrradianceNode(material as never, volume))
      .catch((error: unknown) => {
        console.error('WW.applyIrradiance: node 材質那條路接失敗，WebGPU 上不會有間接光。', error);
      })
      .finally(() => pendingNodes.delete(pending));
    pendingNodes.add(pending);
    return;
  }

  const previous = material.onBeforeCompile;

  material.onBeforeCompile = function (
    this: Material,
    ...args: Parameters<Material['onBeforeCompile']>
  ): void {
    previous.apply(this, args);

    const shader = args[0] as {
      uniforms: Record<string, { value: unknown }>;
      vertexShader: string;
      fragmentShader: string;
    };
    Object.assign(shader.uniforms, uniforms);

    // ## 世界座標要自己傳下來
    //
    // Three 的片段著色器手上沒有世界座標（`vViewPosition` 是視空間的）。
    // 而探針體積是定義在世界裡的，用視空間查表的話**鏡頭一動間接光就跟著
    // 飄** —— 那是最典型的「看起來像在閃」的錯。
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 wwWorldPos;',
      )
      .replace(
        '#include <worldpos_vertex>',
        // `worldpos_vertex` 只有在需要的時候才會定義 `worldPosition`，所以
        // 這裡自己算一份，不依賴那個條件。
        '#include <worldpos_vertex>\nwwWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );

    // ## 沒有光照的材質接不上，而且是**靜靜地**接不上
    //
    // `MeshBasicMaterial` 這一類根本不做光照，它的片段著色器裡沒有
    // `lights_fragment_maps` 這個插入點。字串取代找不到目標時不會報錯，
    // 只是原樣返回 —— 於是那個材質完全沒有間接光，其他材質有。
    //
    // 那正是這個專案最怕的形狀：局部失效、沒有錯誤、看起來像「烘得不夠亮」。
    if (!shader.fragmentShader.includes('#include <lights_fragment_maps>')) {
      if (!warnedUnlit) {
        warnedUnlit = true;
        console.warn(
          [
            'WW.applyIrradiance: 有材質不做光照（例如 MeshBasicMaterial），接不上間接光。',
            '症狀是那些東西看起來比周圍平，而且不會有任何錯誤訊息。',
            '要間接光的話換成 MeshStandardMaterial 這一類會受光的材質。',
          ].join('\n'),
        );
      }
      return;
    }

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 wwWorldPos;
uniform sampler3D wwIrrSH0;
uniform sampler3D wwIrrSH1;
uniform sampler3D wwIrrSH2;
uniform sampler3D wwIrrSH3;
uniform vec3 wwIrrMin;
uniform vec3 wwIrrInvSize;
uniform float wwIrrIntensity;

vec3 wwIrradiance( vec3 worldPos, vec3 normal ) {
  vec3 uvw = ( worldPos - wwIrrMin ) * wwIrrInvSize;
  // 體積外就沒有間接光。夾住的話外面會拖著一條邊緣顏色，那比沒有更奇怪。
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) {
    return vec3( 0.0 );
  }
  vec3 c0 = texture( wwIrrSH0, uvw ).rgb;
  vec3 c1 = texture( wwIrrSH1, uvw ).rgb;
  vec3 c2 = texture( wwIrrSH2, uvw ).rgb;
  vec3 c3 = texture( wwIrrSH3, uvw ).rgb;
  // 常數與 Three 的 shGetIrradianceAt 逐字相同。
  vec3 result = c0 * 0.886227 + 1.023328 * ( c1 * normal.y + c2 * normal.z + c3 * normal.x );
  return max( result, vec3( 0.0 ) ) * wwIrrIntensity;
}`,
      )
      // 接在 IBL 那一段之後：那裡正好是 `irradiance` 已經備妥、還沒被
      // `RE_IndirectDiffuse` 吃掉的位置。
      .replace(
        '#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\nirradiance += wwIrradiance( wwWorldPos, normal );',
      );
  };

  material.needsUpdate = true;
}
