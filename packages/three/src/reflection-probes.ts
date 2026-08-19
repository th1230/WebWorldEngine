import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  Vector3,
} from 'three';
import { resampleCubeToOctahedral } from './octahedral.ts';
import type { FacePixels } from './cube-sh.ts';
import type { IrradianceVolume } from './irradiance.ts';

/**
 * 反射探針：每顆探針把周圍的**輻射**存成一小塊八面體圖，全部放在同一張圖集裡。
 *
 * ## 它補的是哪一段
 *
 * `TracedReflections` 已經有兩層：畫面上找得到的走螢幕空間，找不到的去全域
 * 距離場裡找。距離場那一層答得出「那裡有東西、什麼顏色」，但它算出來的亮度是
 * **反照率 × 輻照度** —— 一個 Lambert 的假設。
 *
 * 所以它答不出來的是：
 *
 * - 天空（現在是一個寫死的顏色 `sky`）
 * - 距離場範圍外的一切（場只有幾百公尺寬）
 * - 亮的、有方向性的東西：太陽的高光、發光的招牌、被照亮的窗
 *
 * 反射探針記的就是這些 —— 它拍的是**實際的輻射**，不是重建出來的。
 *
 * ## 它不自己管格子
 *
 * 探針的位置、哪一顆過期了、烘到第幾顆，全部**直接用輻照度探針的那一份**。
 * 理由不只是省程式碼：
 *
 * - 兩者是**同一次拍攝的兩個產物**。一次 cubemap，投影成 SH 給間接光，重取樣
 *   成八面體給反射。分兩次拍是兩倍的成本，換不到任何東西。
 * - 位置分兩份記的話會分岔，而分岔的症狀是「反射裡的世界比間接光偏了半格」。
 *
 * 代價是反射探針不能有自己的密度。那是刻意的取捨，寫在這裡而不是留給人踩。
 *
 * ## 跟著串流走
 *
 * 探針是在**烘之前就已經擺好**的。世界還沒串流進來的時候，那一格的探針拍到的
 * 是空的 —— 而它會一直是空的，因為烘過了就不會再烘。
 *
 * 症狀是「這一區的反射裡少了一棟樓」，而畫面不會報錯。所以串流進來一格內容時
 * 要呼叫 `volume.invalidateAround`（`WorldStream` 的 `onCellChanged` 就是為此
 * 存在），兩個產物會一起重烘。
 */

export interface ReflectionProbesOptions {
  /**
   * 每塊八面體圖的內容邊長。預設 16。
   *
   * 存進圖集的是 `tileSize + 2`（讓出邊界那一圈）。
   *
   * 開大**不會**變細：來源是 cubemap 的 6 × faceSize² 個像素，`tileSize`
   * 超過 `faceSize` 之後多出來的格子沒有來源，只會被鄰居補起來。要更細的
   * 反射要調的是烘焙的 `faceSize`。
   */
  tileSize?: number;
}

export class ReflectionProbes {
  readonly volume: IrradianceVolume;
  readonly tileSize: number;
  /** 含邊界的圖塊邊長。 */
  readonly stride: number;
  /** 圖集一列排幾塊。 */
  readonly columns: number;
  private readonly _texture: DataTexture;
  private readonly data: Uint16Array;
  /** 重取樣的暫存，一塊圖塊大。float32 進、half 出。 */
  private readonly scratch: Float32Array;
  private readonly _uniforms: Record<string, { value: unknown }>;
  private dirty = true;
  private _written = 0;

  constructor(volume: IrradianceVolume, options: ReflectionProbesOptions = {}) {
    this.volume = volume;
    this.tileSize = Math.max(4, Math.floor(options.tileSize ?? 16));
    this.stride = this.tileSize + 2;
    this.columns = Math.max(1, Math.ceil(Math.sqrt(volume.probeCount)));
    const rows = Math.ceil(volume.probeCount / this.columns);
    const width = this.columns * this.stride;
    const height = rows * this.stride;

    // 半精度：WebGL2 核心就保證 half-float 做得了線性過濾，float32 要靠
    // `OES_texture_float_linear`。反射一定要線性過濾（不然圖塊裡看得到格子），
    // 所以選一定有的那個。
    this.data = new Uint16Array(width * height * 4);
    this._texture = new DataTexture(this.data, width, height, RGBAFormat, HalfFloatType);
    this._texture.minFilter = LinearFilter;
    this._texture.magFilter = LinearFilter;
    this._texture.wrapS = ClampToEdgeWrapping;
    this._texture.wrapT = ClampToEdgeWrapping;
    this._texture.colorSpace = NoColorSpace;
    this._texture.generateMipmaps = false;
    this._texture.needsUpdate = true;

    this.scratch = new Float32Array(this.stride * this.stride * 4);

    const inverseSize = new Vector3(
      1 / Math.max(volume.size.x, 1e-6),
      1 / Math.max(volume.size.y, 1e-6),
      1 / Math.max(volume.size.z, 1e-6),
    );
    // 與 IrradianceVolume 同一個理由：uniform 物件建一次就不換，之後只改
    // `.value`。每次回傳新的話接上去之後就改不動了，而且不會報錯。
    this._uniforms = {
      wwReflAtlas: { value: this._texture },
      wwReflMin: { value: volume.min.clone() },
      wwReflInvSize: { value: inverseSize },
      wwReflResolution: {
        value: new Vector3(volume.resolution[0], volume.resolution[1], volume.resolution[2]),
      },
      wwReflColumns: { value: this.columns },
      wwReflStride: { value: this.stride },
      wwReflAtlasSize: { value: new Vector3(width, height, 0) },
      wwReflIntensity: { value: 1 },
    };
  }

  get texture(): DataTexture {
    return this._texture;
  }

  /** 寫過內容的圖塊數。等於 `volume.probeCount` 代表整份都有了。 */
  get written(): number {
    return this._written;
  }

  get intensity(): number {
    return this._uniforms.wwReflIntensity!.value as number;
  }

  set intensity(value: number) {
    this._uniforms.wwReflIntensity!.value = value;
  }

  uniforms(): Record<string, { value: unknown }> {
    return this._uniforms;
  }

  /** 第 `index` 塊圖塊左上角在圖集裡的 texel 座標（含邊界那一圈）。 */
  tileOrigin(index: number): { x: number; y: number } {
    return {
      x: (index % this.columns) * this.stride,
      y: Math.floor(index / this.columns) * this.stride,
    };
  }

  /**
   * 把一顆探針的六個面重取樣進圖集。
   *
   * 由 `bakeIrradiance` 呼叫 —— 它已經把面讀回來了，這裡是**同一批像素的
   * 第二個用途**，不必再畫一次。
   */
  writeTile(
    index: number,
    faces: readonly FacePixels[],
    options: { faceSize: number; flip: number; decode: (value: number) => number },
  ): void {
    if (index < 0 || index >= this.volume.probeCount) return;
    resampleCubeToOctahedral(faces, this.scratch, this.stride, 0, 0, {
      faceSize: options.faceSize,
      flip: options.flip,
      decode: options.decode,
      tileSize: this.tileSize,
    });

    const origin = this.tileOrigin(index);
    const width = this.columns * this.stride;
    for (let y = 0; y < this.stride; y++) {
      const from = y * this.stride * 4;
      const to = ((origin.y + y) * width + origin.x) * 4;
      for (let i = 0; i < this.stride * 4; i++) {
        this.data[to + i] = DataUtils.toHalfFloat(this.scratch[from + i]!);
      }
    }
    this._written++;
    this.dirty = true;
  }

  /** 有寫過的話上傳一次。每幀呼叫，沒動就什麼都不做。 */
  upload(): void {
    if (!this.dirty) return;
    this._texture.needsUpdate = true;
    this.dirty = false;
  }

  dispose(): void {
    this._texture.dispose();
  }
}

/**
 * 著色器裡查反射探針：世界座標 + 方向 → 輻射。
 *
 * ## 八顆一起查，不是查最近的一顆
 *
 * 查最近的一顆的話，相機走過格子的邊界時整片反射會**跳**一下。人眼對「一片
 * 東西同時變」比對「不夠準」敏感得多 —— 那正是純螢幕空間反射最致命的問題，
 * 這裡不該再犯一次。
 *
 * 八次取樣聽起來多，但這是螢幕空間的一個 pass，而且只有會反射的像素會走到。
 */
export const REFLECTION_PROBE_UNIFORMS_GLSL = /* glsl */ `
uniform sampler2D wwReflAtlas;
uniform vec3 wwReflMin;
uniform vec3 wwReflInvSize;
uniform vec3 wwReflResolution;
uniform float wwReflColumns;
uniform float wwReflStride;
uniform vec3 wwReflAtlasSize;
uniform float wwReflIntensity;
`;

export const REFLECTION_PROBE_SAMPLE_GLSL = /* glsl */ `
vec2 wwReflOctEncode( vec3 direction ) {
  vec3 n = direction / ( abs( direction.x ) + abs( direction.y ) + abs( direction.z ) );
  vec2 p = n.xy;
  if ( n.z < 0.0 ) {
    p = ( 1.0 - abs( vec2( n.y, n.x ) ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
  }
  return p * 0.5 + 0.5;
}

/** 第 index 顆探針，往 direction 看過去的輻射。 */
vec3 wwReflProbe( float index, vec3 direction ) {
  vec2 oct = wwReflOctEncode( direction );
  float column = mod( index, wwReflColumns );
  float row = floor( index / wwReflColumns );
  // 內容區從邊界那一圈之後才開始，所以偏移 1、範圍是 tileSize 而不是 stride。
  float tile = wwReflStride - 2.0;
  vec2 texel = vec2( column, row ) * wwReflStride + 1.0 + oct * tile;
  return texture( wwReflAtlas, texel / wwReflAtlasSize.xy ).rgb;
}

/**
 * 世界座標 + 方向 → 輻射，八顆三線性混合。
 *
 * 體積外回傳 fallback —— 夾住的話外面會拖著一條邊緣顏色，而那比沒有更怪。
 * 這與 wwIrradiance 的處理一致。
 */
vec3 wwReflectionAt( vec3 worldPos, vec3 direction, vec3 fallback ) {
  vec3 uvw = ( worldPos - wwReflMin ) * wwReflInvSize;
  // ## 邊界要留容差，因為**地板剛好貼在體積底部**是最常見的擺法
  //
  // 世界座標是從深度重建出來的，帶著浮點誤差。地板在 y = 0、體積底也在
  // y = 0 的時候，實測重建出來的 uvw.y 是 **−0.0001** —— 於是整片地板被判
  // 成體積外，回退，而畫面上看起來像這整套完全沒作用。
  //
  // 容差是給那個重建誤差的（1e-3 遠大於它、又遠小於一格探針間距），不是
  // 為了把體積偷偷放大。真的在外面的點照樣回退。
  const float wwEdge = 1e-3;
  if ( any( lessThan( uvw, vec3( -wwEdge ) ) ) || any( greaterThan( uvw, vec3( 1.0 + wwEdge ) ) ) ) {
    return fallback;
  }
  // 夾住之後才內插 —— 容差內的點該用邊界那一排探針，不是外推。
  uvw = clamp( uvw, 0.0, 1.0 );
  vec3 grid = uvw * ( wwReflResolution - 1.0 );
  vec3 base = floor( grid );
  vec3 fraction = grid - base;
  vec3 total = vec3( 0.0 );
  float weightSum = 0.0;
  for ( int i = 0; i < 8; i++ ) {
    vec3 offset = vec3( float( i & 1 ), float( ( i >> 1 ) & 1 ), float( ( i >> 2 ) & 1 ) );
    vec3 cell = min( base + offset, wwReflResolution - 1.0 );
    vec3 blend = mix( 1.0 - fraction, fraction, offset );
    float weight = blend.x * blend.y * blend.z;
    if ( weight <= 0.0 ) continue;
    float index = cell.x + cell.y * wwReflResolution.x + cell.z * wwReflResolution.x * wwReflResolution.y;
    total += wwReflProbe( index, direction ) * weight;
    weightSum += weight;
  }
  if ( weightSum <= 0.0 ) return fallback;
  return total / weightSum * wwReflIntensity;
}
`;
