import {
  ClampToEdgeWrapping,
  Data3DTexture,
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Vector3,
} from 'three';

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
  private _warnedRadius = false;
  private readonly data: Uint16Array[] = [];
  private _baked = 0;
  /**
   * 過期的探針，照加入順序排。
   *
   * 用 `Set` 是為了同一顆被標兩次不會排兩遍 —— 一個東西在兩顆探針之間
   * 移動時，中間那幾顆每幀都會被標到。
   */
  private readonly _stale = new Set<number>();
  /** 日夜循環用的關鍵幀，照相位排序。空的代表沒在用那條路。 */
  private readonly _keyframes: { phase: number; sh: Float32Array }[] = [];
  private _phase = 0;
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
    // ## 那張貼圖也要吃建構時給的值
    //
    // 它的初值寫死成 1 的話，`new IrradianceVolume({ intensity: 0 })` 在 node
    // 那條路上**照樣全亮** —— setter 從來沒跑過。關卡抓到的就是這個：
    // 「關掉時 R 應該是 0」讀到 134.9。
    (this.intensityTexture.image.data as Float32Array)[0] = options.intensity ?? 1;
    this.intensityTexture.needsUpdate = true;
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

  /**
   * 強度也放一張 1×1 的貼圖。
   *
   * ## 為什麼是貼圖不是 uniform
   *
   * node 那條路上這個值掛在 lighting context 底下，而**那一組的 uniform 只
   * 在第一次繪製時上傳**（見 `irradiance-node.ts` 裡量到的四種做法）。
   *
   * 而同一個節點裡的**貼圖**是會更新的 —— 那是量出來的：搬一塊藍板子過去、
   * 重烘附近的探針，WebGPU 上畫面裡的藍從 0.0244 漲到 0.0601，與 WebGL 的
   * 0.0244 → 0.0602 逐位元相同。四張 SH 貼圖就在同一個節點裡。
   *
   * 所以強度改走同一條路。代價是那條路上每個 fragment 多一次 1×1 的取樣 ——
   * 換掉的是「這個公開屬性在一個後端上靜靜地沒有作用」。
   */
  readonly intensityTexture: DataTexture = (() => {
    const texture = new DataTexture(new Float32Array([1, 0, 0, 0]), 1, 1, RGBAFormat, FloatType);
    texture.needsUpdate = true;
    return texture;
  })();

  set intensity(value: number) {
    if (this._uniforms.wwIrrIntensity!.value === value) return;
    this._uniforms.wwIrrIntensity!.value = value;
    // node 那條路讀的是這張貼圖 —— uniform 那邊它收不到。
    (this.intensityTexture.image.data as Float32Array)[0] = value;
    this.intensityTexture.needsUpdate = true;
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
   * 把現在烘好的整份 SH 收成一個**關鍵幀**，掛在 `phase` 這個值上。
   *
   * ## 為什麼日夜循環不能用重烘解決
   *
   * `invalidateAround` 處理的是「東西移動」——影響附近那十幾顆。太陽移動
   * 影響的是**每一顆**：幾何沒動，但收到的光全變了。
   *
   * 量過了：整份重烘 256 顆要 693 ms，而且那不是可以攤掉的 —— 一邊跑一邊
   * 持續重烘，**每幀多付 12.1 ms**（交錯 A/B 量的）。太陽不會停，所以那筆
   * 錢也不會停。烘出來的東西要求每幀重烘，等於沒有烘。
   *
   * ## 所以改成先烘幾個角度，執行期內插
   *
   * 太陽的路徑是**事先知道的**（那正是日夜循環的定義），所以可以在載入時
   * 把幾個角度各烘一份，執行期在兩份之間內插。
   *
   * 代價與收益：
   *
   * | | |
   * | --- | --- |
   * | 載入時多烘 N 份 | 一份 693 ms，8 份約 5.5 秒（漸進，不卡幀） |
   * | 記憶體 | 一份 256 顆是 **6 KB**，八份 49 KB |
   * | 執行期改變太陽 | 3,072 次內插 + 一次小上傳，**不重烘** |
   * | 著色器 | **完全不動** —— 混完寫回同一批貼圖 |
   *
   * 著色器不動這一點是刻意的：日夜循環不該讓取樣端多付任何東西，而且不動
   * 就不會有「WebGL 會動 WebGPU 不會」那類兩條路分岔的問題。
   *
   * ## 這條路的限制要講清楚
   *
   * 它只支援**事先知道的**光照變化。玩家拿著手電筒亂晃不在這條路上 ——
   * 那是動態光，走的是重烘或螢幕空間那邊。
   *
   * @param phase 這一份對應的相位。通常用 0–1 表示一天，但只要單調就行。
   */
  saveKeyframe(phase: number): void {
    const existing = this._keyframes.findIndex((k) => k.phase === phase);
    const entry = { phase, sh: this.sh.slice() };
    if (existing >= 0) this._keyframes[existing] = entry;
    else this._keyframes.push(entry);
    this._keyframes.sort((a, b) => a.phase - b.phase);
  }

  /** 存了幾個關鍵幀。0 代表沒在用日夜那條路。 */
  get keyframeCount(): number {
    return this._keyframes.length;
  }

  /**
   * 現在的相位。設它會在關鍵幀之間內插，寫回探針並上傳。
   *
   * 沒有關鍵幀的話這個值沒有作用 —— 那是「沒在用日夜循環」的正常狀態，
   * 不是錯誤。
   *
   * **要與你自己的太陽同步。** 這個套件不動你的燈光（那是 Three 的物件，
   * 也是你的場景），所以相位與太陽角度的對應是呼叫端維持的。對不上的症狀
   * 是「間接光的方向與影子的方向不一致」——看起來像烘壞了。
   */
  get phase(): number {
    return this._phase;
  }

  set phase(value: number) {
    this._phase = value;
    if (this._keyframes.length === 0) return;

    const frames = this._keyframes;
    // 夾在兩端之間。超出去就用最近的那一份 —— 外插會讓亮度跑到負的。
    if (value <= frames[0]!.phase) {
      this.writeSH(frames[0]!.sh);
      return;
    }
    const last = frames[frames.length - 1]!;
    if (value >= last.phase) {
      this.writeSH(last.sh);
      return;
    }
    let hi = 1;
    while (hi < frames.length && frames[hi]!.phase < value) hi++;
    const a = frames[hi - 1]!;
    const b = frames[hi]!;
    const span = b.phase - a.phase;
    const t = span <= 0 ? 0 : (value - a.phase) / span;
    this.blendSH(a.sh, b.sh, t);
  }

  /** 把一份 SH 原封不動寫回探針。 */
  private writeSH(source: Float32Array): void {
    this.sh.set(source);
    this.encodeAll();
  }

  /** 兩份 SH 線性混合寫回探針。 */
  private blendSH(a: Float32Array, b: Float32Array, t: number): void {
    const sh = this.sh;
    for (let i = 0; i < sh.length; i++) sh[i] = a[i]! + (b[i]! - a[i]!) * t;
    this.encodeAll();
  }

  /**
   * 把 `sh` 整份重新編碼進貼圖資料。
   *
   * 逐顆走 `setProbe` 也可以，但那會多做一次係數物件的包裝 —— 而這一支是
   * 每幀可能被呼叫的（相位一直在變）。
   */
  private encodeAll(): void {
    const sh = this.sh;
    for (let index = 0; index < this.probeCount; index++) {
      const base = index * COEFFICIENTS * 3;
      const texel = index * 4;
      for (let c = 0; c < COEFFICIENTS; c++) {
        const data = this.data[c]!;
        data[texel] = DataUtils.toHalfFloat(sh[base + c * 3]!);
        data[texel + 1] = DataUtils.toHalfFloat(sh[base + c * 3 + 1]!);
        data[texel + 2] = DataUtils.toHalfFloat(sh[base + c * 3 + 2]!);
        data[texel + 3] = 0x3c00;
      }
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
    // ## 半徑比格距還小的話一顆都標不到，而那是靜靜地沒效果
    //
    // 探針只在格點上。半徑小於格距的時候，那個球有可能整個落在格與格之間 ——
    // 一顆都碰不到，回傳 0，然後間接光完全不更新。
    //
    // 實測踩到：4×2×4 的體積格距 26.7，用半徑 14 去標**一顆都沒標到**，
    // 而畫面上就只是「那個東西不反彈光」，看起來像功能沒做。
    if (marked === 0 && !this._warnedRadius) {
      const spacing = Math.max(stepX, stepY, stepZ);
      if (radius < spacing) {
        this._warnedRadius = true;
        console.warn(
          [
            `WW.IrradianceVolume.invalidateAround: 半徑 ${radius} 比探針格距 ${spacing.toFixed(1)} 還小，`,
            '這一次一顆都沒標到 —— 間接光不會更新，而且不會有其他徵兆。',
            '半徑至少要一個格距才保證碰得到探針，或者把 resolution 調高。',
          ].join('\n'),
        );
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
  nextToBake(exclude?: ReadonlySet<number>): number {
    // ## `exclude` 是「這一輪已經挑走的」
    //
    // 少了它，一輪就只烘得動**一顆**：烘焙是先發射再一次等完的，所以挑的
    // 當下還不能標記完成 —— 於是下一次呼叫又回同一顆。
    //
    // 而那個退化只在「過期」這條路上發生（東西移動、光源移動），「還沒烘過」
    // 那條路因為有 `_baked` 在推進所以看不出來。實測整份重烘 256 顆跑了
    // **256 輪**，每輪各付一次 GPU 同步 —— 每顆 10.19 ms，而批次正常時是 2.7。
    for (const index of this._stale) {
      if (exclude === undefined || !exclude.has(index)) return index;
    }
    for (let index = this._baked; index < this.probeCount; index++) {
      if (exclude === undefined || !exclude.has(index)) return index;
    }
    return -1;
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
          const w = (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy) * (dz === 0 ? 1 - fz : fz);
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
