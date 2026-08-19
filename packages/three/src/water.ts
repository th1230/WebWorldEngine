/**
 * 水面：**一份波形定義，兩邊共用**。
 *
 * ## 先講做不到的
 *
 * 「跟真的一樣的水」在即時演算裡做不到，**UE 也沒有做到**。UE 的 Water 是
 * Gerstner 波加著色，不是流體模擬；真正的流體（FLIP／SPH）它只在很小的
 * 範圍局部用。海洋看起來真實是**渲染**的功勞，不是物理。
 *
 * 所以「水」要拆成兩件不同的事，混在一起會做出一個很貴又不對的東西：
 *
 * | | 誰負責 |
 * | --- | --- |
 * | **看起來像水**（折射、吸收、泡沫、菲涅耳） | `WaterSurface` |
 * | **互動對不對**（浮力、船身、隨波起伏） | 這裡 |
 *
 * ## 這裡原本寫著「外觀套件不碰」—— 那條界線畫錯了
 *
 * 原本的理由是「外觀與光照同一類」。而錯的地方很具體：**水的外觀幾乎全部
 * 是從這個套件已經算出來的東西推出來的** —— 水深來自場景深度、反射來自反射
 * 探針、波峰的形狀來自這個檔案。
 *
 * 交給開發者自己寫的話，他要重新求一次水深、重新接一次探針、而且**重新寫
 * 一份波形**。最後那一項正是這個檔案存在要防的事。
 *
 * 所以界線移到 `water-surface.ts`：這裡仍然只回答「水面多高」（浮力要的），
 * 而外觀是一個**用同一個 `Water` 建出來的材質**，位移那段 GLSL 就是下面
 * `displacementGLSL()` 產生的同一個字串。
 *
 * ## 這個檔案存在的真正理由：兩邊必須是同一條式子
 *
 * 水面在畫面上是 vertex shader 把頂點推上去畫出來的；浮力是 CPU 上算「這個
 * 點的水面多高」。**兩邊各寫一份的話，東西會浮在錯的高度** —— 船身陷進浪裡
 * 或飄在半空，而且**不會報錯**，只是「看起來怪怪的」。
 *
 * 那是這個專案最怕的失效形態，而它在這裡幾乎是必然會發生的：兩份程式碼、
 * 兩個作者、兩個時間點寫的。
 *
 * 所以這裡只有一份 `WaterWave[]`，CPU 走 `heightAt`，GPU 走
 * `waterDisplacementGLSL()` 產生的字串 —— **同一組參數餵給兩邊**。
 *
 * ## 為什麼是 Gerstner 而不是簡單的正弦
 *
 * 正弦波的波峰是圓的，看起來像布不像水。Gerstner 波把頂點**沿著行進方向也
 * 位移**，於是波峰被擠尖、波谷被拉平 —— 那就是海浪的形狀。
 *
 * 代價是位移不再只有垂直方向，所以「某個 x/z 的水面多高」嚴格來說要解一個
 * 反函數。實務上做幾次迭代就夠（見 `heightAt`）。
 */

/** 一道 Gerstner 波。 */
export interface WaterWave {
  /** 行進方向（會被正規化）。 */
  directionX: number;
  directionZ: number;
  /** 波長，世界單位。 */
  length: number;
  /** 波高（峰到谷的一半）。 */
  amplitude: number;
  /** 每秒走多少個波長。 */
  speed: number;
  /**
   * 陡峭度，0–1。
   *
   * 0 就是普通正弦波。往 1 靠波峰越尖，超過 1 波峰會自己翻過去交叉 ——
   * 那在畫面上是**水面破掉**，所以這裡會夾住。
   */
  steepness: number;
}

/** 預設的一組浪：三道不同方向與波長，疊起來就不會看出週期。 */
export const DEFAULT_WAVES: readonly WaterWave[] = [
  { directionX: 1, directionZ: 0.3, length: 24, amplitude: 0.5, speed: 0.6, steepness: 0.6 },
  { directionX: -0.4, directionZ: 1, length: 13, amplitude: 0.25, speed: 0.9, steepness: 0.5 },
  { directionX: 0.7, directionZ: -0.8, length: 6.5, amplitude: 0.1, speed: 1.4, steepness: 0.4 },
];

export interface WaterOptions {
  /** 靜水面的高度。 */
  level?: number;
  /** 用哪幾道波。預設 `DEFAULT_WAVES`。 */
  waves?: readonly WaterWave[];
}

/**
 * 一片水。**它不是 `Object3D`，也不畫任何東西** —— 它只回答「這裡的水面
 * 多高、法線朝哪」，以及交出一段給 vertex shader 用的 GLSL。
 *
 * 畫水是開發者的事（那是材質），而這裡保證的是：**他畫出來的水面，與浮力
 * 算的是同一個水面。**
 */
export class Water {
  readonly level: number;
  readonly waves: readonly WaterWave[];
  /** 正規化並夾過的參數，兩邊共用。 */
  private readonly packed: Float64Array;

  constructor(options: WaterOptions = {}) {
    this.level = options.level ?? 0;
    this.waves = options.waves ?? DEFAULT_WAVES;

    // 一次算好：方向正規化、波數、角頻率、夾住的陡峭度。
    //
    // 每道波 6 個數：dx, dz, k（波數）, a（振幅）, omega（角頻率）, q（陡峭）
    this.packed = new Float64Array(this.waves.length * 6);
    for (const [i, w] of this.waves.entries()) {
      const len = Math.hypot(w.directionX, w.directionZ) || 1;
      const k = (Math.PI * 2) / Math.max(w.length, 1e-6);
      const at = i * 6;
      this.packed[at] = w.directionX / len;
      this.packed[at + 1] = w.directionZ / len;
      this.packed[at + 2] = k;
      this.packed[at + 3] = w.amplitude;
      // 相速度 = speed × 波長 ÷ 波長 = speed × 2π ÷ 週期。這裡用
      // 「每秒走幾個波長」定義 speed，所以 omega = k × speed × 波長。
      this.packed[at + 4] = k * w.speed * w.length;
      // **夾住陡峭度。** 超過 1 波峰會自己交叉，畫面上是水面破掉 ——
      // 而那個參數是開發者填的，填錯不該變成破圖。
      //
      // 每一道波再除以「波的數量 × k × a」才是嚴格的不自交條件，但那會讓
      // 少量的浪變得很平。這裡取實務上的折衷並夾在 1。
      this.packed[at + 5] = Math.min(Math.max(w.steepness, 0), 1);
    }
  }

  /**
   * `(x, z)` 這一點在時間 `t` 的水面高度。
   *
   * ## 為什麼要迭代
   *
   * Gerstner 波會把頂點**水平方向也推開**，所以「畫面上落在 x 的那個頂點」
   * 原本並不在 x。直接把 x 代進去算會得到偏移的高度 —— 浪越陡差越多，而
   * 症狀是船在陡浪裡浮錯位置。
   *
   * 解法是反推：先猜原點就是 (x, z)，算出它被推到哪，把差距補回去，再算一次。
   * 三次就收斂到肉眼看不出來的程度。
   */
  heightAt(x: number, z: number, t: number): number {
    let sx = x;
    let sz = z;
    // 三次迭代反推原始取樣點。次數是固定的 —— 這在浮力迴圈裡每個物體都要跑，
    // 而「收斂了沒」的判斷比多跑一次還貴。
    for (let iter = 0; iter < 3; iter++) {
      let dx = 0;
      let dz = 0;
      const p = this.packed;
      for (let at = 0; at < p.length; at += 6) {
        const phase = (p[at]! * sx + p[at + 1]! * sz) * p[at + 2]! - p[at + 4]! * t;
        const q = p[at + 5]! * p[at + 3]!;
        const c = Math.cos(phase);
        dx += p[at]! * q * c;
        dz += p[at + 1]! * q * c;
      }
      sx = x - dx;
      sz = z - dz;
    }

    let height = 0;
    const p = this.packed;
    for (let at = 0; at < p.length; at += 6) {
      const phase = (p[at]! * sx + p[at + 1]! * sz) * p[at + 2]! - p[at + 4]! * t;
      height += p[at + 3]! * Math.sin(phase);
    }
    return this.level + height;
  }

  /**
   * 這一點的水面法線。給浮力算傾覆力矩、或給小船對齊水面用。
   *
   * 用有限差分而不是解析式：解析式要對 Gerstner 的位移做鏈鎖微分，而那份
   * 推導**與 shader 那份很容易對不起來**（這整個檔案存在的理由就是那個）。
   * 差分只依賴 `heightAt`，所以它永遠與水面一致。
   */
  normalAt(x: number, z: number, t: number, epsilon = 0.1): [number, number, number] {
    const hx = this.heightAt(x + epsilon, z, t) - this.heightAt(x - epsilon, z, t);
    const hz = this.heightAt(x, z + epsilon, t) - this.heightAt(x, z - epsilon, t);
    const nx = -hx / (2 * epsilon);
    const nz = -hz / (2 * epsilon);
    const len = Math.hypot(nx, 1, nz);
    return [nx / len, 1 / len, nz / len];
  }

  /**
   * 給 vertex shader 的那一段 GLSL —— **與 `heightAt` 是同一組參數**。
   *
   * 用法是把它插進材質的 `onBeforeCompile`（或用 `WW.applyWater`）：
   *
   * ```glsl
   * transformed += wwWaterDisplace( transformed.xz, wwWaterTime );
   * ```
   *
   * 產生的是常數展開的式子，不是迴圈讀 uniform —— 波的數量在建構時就固定了，
   * 而展開之後 shader 編譯器可以把它整段最佳化掉。
   */
  displacementGLSL(functionName = 'wwWaterDisplace'): string {
    const lines: string[] = [
      `vec3 ${functionName}( vec2 p, float t ) {`,
      '  vec3 sum = vec3( 0.0 );',
    ];
    const p = this.packed;
    for (let at = 0; at < p.length; at += 6) {
      const dx = p[at]!;
      const dz = p[at + 1]!;
      const k = p[at + 2]!;
      const a = p[at + 3]!;
      const omega = p[at + 4]!;
      const q = p[at + 5]! * a;
      lines.push(
        '  {',
        `    float ph = ( ${f(dx)} * p.x + ${f(dz)} * p.y ) * ${f(k)} - ${f(omega)} * t;`,
        `    sum.x += ${f(dx)} * ${f(q)} * cos( ph );`,
        `    sum.z += ${f(dz)} * ${f(q)} * cos( ph );`,
        `    sum.y += ${f(a)} * sin( ph );`,
        '  }',
      );
    }
    lines.push(`  sum.y += ${f(this.level)};`, '  return sum;', '}');
    return lines.join('\n');
  }
}

/** GLSL 不接受 `1` 當 float，也不接受指數記法以外的科學記號。 */
function f(value: number): string {
  if (!Number.isFinite(value)) return '0.0';
  const s = value.toPrecision(9);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}
