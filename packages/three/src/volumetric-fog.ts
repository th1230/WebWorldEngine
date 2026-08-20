import { Color, HalfFloatType, Matrix4, NoColorSpace, ShaderMaterial, Vector3, WebGLRenderTarget } from 'three';
import { drawFullscreen, FULLSCREEN_VERTEX, VIEW_POSITION_GLSL } from './fullscreen.ts';
// 只有型別是靜態的 —— 那份 TSL 轉寫是動態載入的，見 `renderNode`。
import type { VolumetricFogNodeHandle } from './volumetric-fog-node.ts';
import { FIELD_SAMPLE_GLSL, FIELD_UNIFORMS_GLSL } from './field-glsl.ts';
import type { Camera, PerspectiveCamera, Texture, WebGLRenderer } from 'three';
import type { SceneDepthNormals } from './depth-normals.ts';
import type { GlobalDistanceField } from './global-distance-field.ts';

/**
 * 體積霧與光柱。
 *
 * ## 光柱要能被擋住，否則它會穿牆
 *
 * 體積霧就是「沿著視線一路問：這一點被照到嗎、這裡有多少霧」。難的不是霧，
 * 是**被照到嗎**——而那需要知道光源與這一點之間有沒有東西。
 *
 * 大部分 Web 上的體積霧沒有那個資訊，所以做法是「照到就是照到」：光柱因此
 * 穿過牆、穿過屋頂、穿過人。那不是不夠準，是**看起來就是假的**——因為光柱
 * 的形狀正是它撞到什麼的形狀。
 *
 * 這裡有全域距離場，所以每一步都問得到。用的是與距離場陰影**同一份 GLSL**
 * （`field-glsl.ts`）—— 兩邊分岔的話會變成「陰影說有牆、霧說沒有」。
 *
 * ## 為什麼霧是「看起來廣闊」的關鍵
 *
 * 空氣透視（遠處的東西偏向天空的顏色、對比降低）是人眼判斷距離最主要的線索
 * 之一。少了它，一座山看起來像一塊貼在近處的紙板 —— 幾何再準也一樣。
 *
 * 所以霧不是氣氛效果，它是「大」這條軸的一部分。
 *
 * ## 抖動起點，不是加步數
 *
 * 光線積分用固定步長會出現**條帶**（每一步的邊界連成一片一片的）。加步數要
 * 加很多才蓋得掉，而成本是線性的。
 *
 * 改成每個像素的起點抖動一點點（用 Bayer 矩陣），條帶就變成雜訊 —— 而低頻的
 * 霧上，雜訊比條帶難看得多得多。這與換階淡入用的是同一張矩陣。
 */

export interface VolumetricFogOptions {
  /** 霧的密度。預設 0.02。 */
  density?: number;
  /** 積分幾步。預設 32。 */
  steps?: number;
  /** 追多遠，世界單位。預設 400。 */
  range?: number;
  /** 霧的顏色。預設接近天空的冷灰。 */
  color?: Color;
  /**
   * 前向散射 −1..1。預設 0.6。
   *
   * 這是光柱之所以是**光柱**的原因：朝著光源看的時候霧特別亮。0 的話霧是
   * 均勻的一層灰，看不出光的方向。
   */
  anisotropy?: number;
  /** 陰影追蹤幾步。預設 24。 */
  shadowSteps?: number;
}

export class VolumetricFog {
  private readonly options: Required<VolumetricFogOptions>;
  private target: WebGLRenderTarget | null = null;
  private readonly material: ShaderMaterial;
  private readonly projectionInverse = new Matrix4();
  /** 沒有距離場時給 node 那條路的佔位原點。 */
  private readonly zero = new Vector3();
  /** WebGPU 那條路的材質。惰性建立 —— 只用 WebGL 的人不該下載 `three/tsl`。 */
  private node: VolumetricFogNodeHandle | null = null;
  private nodePending: Promise<void> | null = null;

  constructor(options: VolumetricFogOptions = {}) {
    this.options = {
      density: options.density ?? 0.02,
      steps: options.steps ?? 32,
      range: options.range ?? 400,
      color: options.color ?? new Color(0xb8c6d8),
      anisotropy: options.anisotropy ?? 0.6,
      shadowSteps: options.shadowSteps ?? 24,
    };

    this.material = new ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        tField: { value: null },
        tAlbedo: { value: null },
        uFieldMin: { value: new Vector3() },
        uFieldExtent: { value: 1 },
        uCell: { value: 1 },
        uProjectionInverse: { value: new Matrix4() },
        uCameraMatrix: { value: new Matrix4() },
        uLightDirection: { value: new Vector3(0, -1, 0) },
        uLightColor: { value: new Color(0xffffff) },
        uFogColor: { value: this.options.color },
        uDensity: { value: this.options.density },
        uSteps: { value: this.options.steps },
        uRange: { value: this.options.range },
        uAnisotropy: { value: this.options.anisotropy },
        uShadowSteps: { value: this.options.shadowSteps },
        uHasField: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
  }

  get density(): number {
    return this.options.density;
  }

  set density(value: number) {
    this.options.density = value;
  }

  /**
   * 算這一幀的霧。
   *
   * @param lightDirection 光**照過來**的方向，世界座標。
   * @param field 全域距離場。給了光柱才會被擋住；不給就是均勻的霧。
   * @returns RGB 是加進去的散射光，A 是透光率（要拿它去乘原本的畫面）。
   */
  render(
    renderer: WebGLRenderer,
    camera: Camera,
    gbuffer: SceneDepthNormals,
    lightDirection: Vector3,
    lightColor: Color,
    field: GlobalDistanceField | null = null,
  ): Texture | null {
    const depth = gbuffer.depthTexture;
    if (depth === null) return null;
    gbuffer.isFresh(renderer);
    this.ensureTarget(gbuffer.width, gbuffer.height);

    const perspective = camera as PerspectiveCamera;
    this.projectionInverse.copy(perspective.projectionMatrix).invert();

    // WebGPU 不吃 ShaderMaterial，走 node 那份。兩份的一致性由跨後端關卡守。
    if ((renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true) {
      return this.renderNode(renderer, camera, depth, lightDirection, lightColor, field);
    }
    const u = this.material.uniforms;
    u.tDepth!.value = depth;
    u.uProjectionInverse!.value = this.projectionInverse;
    u.uCameraMatrix!.value = camera.matrixWorld;
    u.uLightDirection!.value = lightDirection;
    u.uLightColor!.value = lightColor;
    u.uFogColor!.value = this.options.color;
    u.uDensity!.value = this.options.density;
    u.uSteps!.value = this.options.steps;
    u.uRange!.value = this.options.range;
    u.uAnisotropy!.value = this.options.anisotropy;
    u.uShadowSteps!.value = this.options.shadowSteps;

    if (field !== null) {
      u.tField!.value = field.texture;
      u.tAlbedo!.value = field.albedoTexture;
      u.uFieldMin!.value = field.min;
      u.uFieldExtent!.value = field.extent;
      u.uCell!.value = field.extent / field.resolution;
      u.uHasField!.value = 1;
    } else {
      u.uHasField!.value = 0;
    }

    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(true, false, false);
    drawFullscreen(renderer, this.material);
    renderer.setRenderTarget(previous);
    return this.target!.texture;
  }

  /** WebGPU 那條路。第一次呼叫啟動非同步建立並回傳 `null`。 */
  private renderNode(
    renderer: WebGLRenderer,
    camera: Camera,
    depth: Texture,
    lightDirection: Vector3,
    lightColor: Color,
    field: GlobalDistanceField | null,
  ): Texture | null {
    if (this.node === null) {
      this.nodePending ??= import('./volumetric-fog-node.ts')
        .then((m) => m.createVolumetricFogNodeMaterial())
        .then((handle) => {
          this.node = handle;
        });
      return null;
    }
    this.node.setTextures(depth, field?.texture ?? null, field?.albedoTexture ?? null);
    this.node.setMatrices(this.projectionInverse, camera.matrixWorld);
    this.node.setField(
      field?.min ?? this.zero,
      field?.extent ?? 1,
      field === null ? 1 : field.extent / field.resolution,
      field !== null,
    );
    this.node.setLight(lightDirection, lightColor);
    this.node.setParams(this.options);
    this.node.setConvention(renderer);

    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(true, false, false);
    drawFullscreen(renderer, this.node.material as never);
    renderer.setRenderTarget(previous);
    return this.target!.texture;
  }

  private ensureTarget(width: number, height: number): void {
    if (this.target !== null && this.target.width === width && this.target.height === height) return;
    this.target?.dispose();
    // 散射光可以超過 1（朝著太陽看的時候），所以半精度。
    this.target = new WebGLRenderTarget(width, height, {
      colorSpace: NoColorSpace,
      type: HalfFloatType,
      depthBuffer: false,
    });
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
  }
}

const FRAGMENT = /* glsl */ `
precision highp sampler3D;

uniform sampler2D tDepth;
${FIELD_UNIFORMS_GLSL}
uniform mat4 uProjectionInverse;
uniform mat4 uCameraMatrix;
uniform vec3 uLightDirection;
uniform vec3 uLightColor;
uniform vec3 uFogColor;
uniform float uDensity;
uniform float uSteps;
uniform float uRange;
uniform float uAnisotropy;
uniform float uShadowSteps;
uniform float uHasField;
varying vec2 vUv;

${VIEW_POSITION_GLSL}
${FIELD_SAMPLE_GLSL}

/** 與換階淡入同一張 Bayer 矩陣 —— 抖動起點，把條帶換成雜訊。 */
float wwBayerFog( vec2 coordinate ) {
  int x = int( mod( coordinate.x, 4.0 ) );
  int y = int( mod( coordinate.y, 4.0 ) );
  float table[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return table[ x + y * 4 ] / 16.0;
}

void main() {
  float rawDepth = texture2D( tDepth, vUv ).x;

  // 這條視線走多遠：打到東西就停在那裡，沒打到就走滿 range（天空）。
  vec3 viewPosition = rawDepth >= 1.0
    ? vec3( 0.0 )
    : wwViewPositionFromDepth( vUv, rawDepth, uProjectionInverse );
  vec3 viewDirection = rawDepth >= 1.0
    ? normalize( wwViewPositionFromDepth( vUv, 0.99, uProjectionInverse ) )
    : normalize( viewPosition );
  float travel = rawDepth >= 1.0 ? uRange : min( length( viewPosition ), uRange );

  vec3 worldOrigin = ( uCameraMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  vec3 worldDirection = normalize( mat3( uCameraMatrix ) * viewDirection );
  vec3 toLight = normalize( -uLightDirection );

  // Henyey-Greenstein：朝著光源看的時候霧特別亮，那就是光柱。
  float cosTheta = dot( worldDirection, toLight );
  float g = uAnisotropy;
  float gg = g * g;
  float phase = ( 1.0 - gg ) / ( 4.0 * 3.14159265 * pow( max( 1.0 + gg - 2.0 * g * cosTheta, 1e-4 ), 1.5 ) );

  float stepSize = travel / uSteps;
  // 抖動起點：固定步長會出現條帶，而條帶比雜訊難看得多。
  float offset = wwBayerFog( gl_FragCoord.xy );
  vec3 scattered = vec3( 0.0 );
  float transmittance = 1.0;

  for ( int i = 0; i < 64; i++ ) {
    if ( float( i ) >= uSteps ) break;
    float t = ( float( i ) + offset ) * stepSize;
    vec3 point = worldOrigin + worldDirection * t;

    // 這一點被照到嗎。沒有場的話就當成全亮 —— 那就是「均勻的霧」。
    float visibility = uHasField > 0.5
      ? wwFieldVisibility( point, toLight, uRange, uShadowSteps, 8.0 )
      : 1.0;

    float density = uDensity * stepSize;
    // 先衰減再累積：這一段的光要穿過前面所有的霧才到得了眼睛。
    vec3 inScatter = uLightColor * uFogColor * ( visibility * phase * density );
    scattered += inScatter * transmittance;
    transmittance *= exp( -density );
  }

  gl_FragColor = vec4( scattered, transmittance );
}
`;
