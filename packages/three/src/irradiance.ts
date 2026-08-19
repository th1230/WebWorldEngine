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
  intensity: number;

  /** 每顆探針 4 個係數 × RGB，攤平。 */
  private readonly sh: Float32Array;
  private readonly textures: Data3DTexture[] = [];
  private readonly data: Uint16Array[] = [];
  private _baked = 0;
  private dirty = true;

  constructor(options: IrradianceVolumeOptions) {
    this.min = options.min.clone();
    this.size = options.size.clone();
    this.resolution = [...options.resolution];
    this.intensity = options.intensity ?? 1;

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
      this.textures.push(texture);
    }
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

  /** 這一顆算烘好了。分開記是因為 `setProbe` 也用在測試與載入既有資料。 */
  markBaked(count = 1): void {
    this._baked = Math.min(this._baked + count, this.probeCount);
  }

  /** 把改動推上 GPU。改了探針而沒有推的症狀是畫面停在上一版。 */
  upload(): void {
    if (!this.dirty) return;
    for (const texture of this.textures) texture.needsUpdate = true;
    this.dirty = false;
  }

  /**
   * 給 shader 的 uniform。`applyIrradiance` 會用它，一般不必自己碰。
   */
  uniforms(): Record<string, { value: unknown }> {
    return {
      wwIrrSH0: { value: this.textures[0] },
      wwIrrSH1: { value: this.textures[1] },
      wwIrrSH2: { value: this.textures[2] },
      wwIrrSH3: { value: this.textures[3] },
      wwIrrMin: { value: this.min },
      wwIrrInvSize: {
        value: new Vector3(1 / this.size.x, 1 / this.size.y, 1 / this.size.z),
      },
      wwIrrIntensity: { value: this.intensity },
    };
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
    for (const texture of this.textures) texture.dispose();
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
  return new Vector3(
    sh[0]! * 0.886227 + 1.023328 * (sh[3]! * y + sh[6]! * z + sh[9]! * x),
    sh[1]! * 0.886227 + 1.023328 * (sh[4]! * y + sh[7]! * z + sh[10]! * x),
    sh[2]! * 0.886227 + 1.023328 * (sh[5]! * y + sh[8]! * z + sh[11]! * x),
  );
}

export interface BakeOptions {
  /**
   * 這一次呼叫最多花多久，毫秒。預設 8。
   *
   * ## 為什麼一定要分幀
   *
   * 每顆探針都要把場景**畫六次**（cubemap 的六個面）再讀回來。8,192 顆
   * 就是 49,152 次繪製加 8,192 次 GPU→CPU 讀回。一次做完會凍住畫面好幾
   * 十秒，而那看起來像當掉。
   *
   * 所以這裡每幀烘一點，用時間預算控制。烘的過程中畫面照樣是流暢的，只是
   * 間接光會**逐漸浮現** —— 那是可以接受的、而且看得懂的行為。
   */
  budgetMs?: number;
  /**
   * cubemap 每個面的邊長。預設 16。
   *
   * 探針記的是**低頻**的間接光（SH L1 只有 4 個係數），所以拍很大張沒有
   * 意義 —— 投影完就丟掉了。16 已經遠超 L1 表達得出來的細節。
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
export async function bakeIrradiance(
  renderer: WebGLRenderer,
  scene: Scene,
  volume: IrradianceVolume,
  options: BakeOptions = {},
): Promise<number> {
  if (volume.baked >= volume.probeCount) return 0;

  const budgetMs = options.budgetMs ?? 8;
  const faceSize = options.faceSize ?? 16;

  const { LightProbeGenerator } = await import('three/addons/lights/LightProbeGenerator.js');

  const target = new WebGLCubeRenderTarget(faceSize);
  target.texture.type = HalfFloatType;
  const camera = new CubeCamera(options.near ?? 0.1, options.far ?? 1000, target);
  const at = new Vector3();

  const started = performance.now();
  let done = 0;
  try {
    while (volume.baked + done < volume.probeCount) {
      const index = volume.baked + done;
      volume.probePosition(index, at);
      camera.position.copy(at);
      camera.updateMatrixWorld(true);
      camera.update(renderer, scene);

      const probe = await LightProbeGenerator.fromCubeRenderTarget(renderer, target);
      volume.setProbe(index, probe.sh.coefficients);
      done++;

      // 預算檢查放在**烘完一顆之後**：一顆烘到一半停下來的話那顆是空的，
      // 而空探針是全黑的 —— 畫面上會出現一個黑塊。
      if (performance.now() - started >= budgetMs) break;
    }
  } finally {
    target.dispose();
  }

  volume.markBaked(done);
  volume.upload();
  return done;
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
      inject(one, uniforms);
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

function inject(material: Material, uniforms: Record<string, { value: unknown }>): void {
  if (injected.has(material)) return;
  injected.add(material);

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
