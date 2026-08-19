import {
  BackSide,
  BoxGeometry,
  CubeCamera,
  HalfFloatType,
  Mesh,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLCubeRenderTarget,
} from 'three';
import type { CubeTexture, WebGLRenderer } from 'three';

/**
 * 大氣散射的天空。
 *
 * ## 為什麼天空是這個套件的事
 *
 * 天空看起來只是背景，但在光照上它是**最大的那盞光**：陰影裡的東西幾乎全靠
 * 它照亮。少了天空，陰影裡是全黑的，而現實中沒有全黑的陰影。
 *
 * 這也是為什麼「廣闊」的世界特別需要它 —— 天空佔畫面一半，而且它的顏色決定
 * 整個場景的色調。
 *
 * ## 它與已經做好的東西怎麼接
 *
 * 這裡烘出來的是一張 **cube 貼圖**，設成 `scene.background` 就好。而探針是
 * 靠**渲染場景**烘出來的 —— 所以探針會自動把天空吃進去，一行接線都不必寫。
 *
 * 日夜循環那條路因此也自動成立：每個相位烘探針時，天空已經是那個相位的顏色。
 * 太陽下山時天空變紅，探針記到的間接光就是紅的。
 *
 * **兩邊共用同一個太陽方向**是這件事唯一的要求，而那與水那一節「一份波形兩邊
 * 共用」是同一個道理。
 *
 * ## 為什麼烘成 cube 而不是每幀算
 *
 * 散射是沿著視線積分出來的（這裡 16 步，每步再往太陽方向積 8 步）。每個 sky
 * 像素 128 次取樣，而天空佔半個畫面 —— 那不便宜。
 *
 * 但太陽動得很慢。所以只有在太陽方向**真的變了**的時候才重烘一張 64² 的 cube，
 * 其餘時間就是一次 cubemap 取樣。與探針關鍵幀是同一個判斷：慢的東西不要每幀算。
 *
 * ## 模型
 *
 * 單次散射的 Rayleigh + Mie。Rayleigh 是分子散射（藍天、紅色的日落），Mie 是
 * 氣溶膠（太陽周圍那圈白光）。日落之所以紅是因為陽光穿過的大氣變厚，藍光被
 * 散射掉了 —— 那是積分出來的，不是調出來的顏色。
 */

export interface SkyAtmosphereOptions {
  /** cube 每一面的解析度。預設 64。天空是低頻的，不需要大。 */
  resolution?: number;
  /** 太陽方向改變多少才重烘（弧度）。預設 0.01（約 0.6 度）。 */
  threshold?: number;
  /** 大氣的整體強度。預設 22。 */
  intensity?: number;
  /** Mie 的方向性 −1..1。預設 0.76，也就是太陽周圍那圈光。 */
  mieDirectional?: number;
}

export class SkyAtmosphere {
  readonly target: WebGLCubeRenderTarget;
  private readonly material: ShaderMaterial;
  private readonly scene = new Scene();
  private readonly camera: CubeCamera;
  private readonly options: Required<SkyAtmosphereOptions>;
  private readonly lastSun = new Vector3(0, 0, 0);
  private baked = false;
  /** 診斷：重烘了幾次。太陽沒動卻一直漲代表門檻設得太小。 */
  bakes = 0;

  constructor(options: SkyAtmosphereOptions = {}) {
    this.options = {
      resolution: options.resolution ?? 64,
      threshold: options.threshold ?? 0.01,
      intensity: options.intensity ?? 22,
      mieDirectional: options.mieDirectional ?? 0.76,
    };

    this.target = new WebGLCubeRenderTarget(this.options.resolution, { type: HalfFloatType });
    this.camera = new CubeCamera(0.1, 10, this.target);

    this.material = new ShaderMaterial({
      uniforms: {
        uSunDirection: { value: new Vector3(0, 1, 0) },
        uIntensity: { value: this.options.intensity },
        uMieG: { value: this.options.mieDirectional },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      // 從裡面看，所以畫背面。
      side: BackSide,
      depthWrite: false,
    });

    const dome = new Mesh(new BoxGeometry(2, 2, 2), this.material);
    dome.frustumCulled = false;
    this.scene.add(dome);
  }

  /** 烘好的天空。設成 `scene.background`，探針就會自動吃到它。 */
  get texture(): CubeTexture {
    return this.target.texture;
  }

  /**
   * 太陽移到這個方向。方向是**從場景指向太陽**（也就是 `light.position` 正規化）。
   *
   * 只有在方向真的變了的時候才重烘 —— 太陽動得慢，而積分不便宜。
   *
   * @returns 這一次有沒有重烘。
   */
  update(renderer: WebGLRenderer, sunDirection: Vector3): boolean {
    if (this.baked && this.lastSun.angleTo(sunDirection) < this.options.threshold) return false;
    this.lastSun.copy(sunDirection).normalize();
    (this.material.uniforms.uSunDirection!.value as Vector3).copy(this.lastSun);

    const previous = renderer.getRenderTarget();
    this.camera.update(renderer, this.scene);
    renderer.setRenderTarget(previous);
    this.baked = true;
    this.bakes++;
    return true;
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}

const VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
  // 盒子的頂點位置就是方向 —— 從中心往外看。
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
varying vec3 vDirection;
uniform vec3 uSunDirection;
uniform float uIntensity;
uniform float uMieG;

// 地球與大氣的尺度，公尺。用真實的比例，日落的紅才是積分出來的而不是調出來的。
const float EARTH_RADIUS = 6371000.0;
const float ATMOSPHERE_RADIUS = 6471000.0;
const float RAYLEIGH_SCALE = 8000.0;
const float MIE_SCALE = 1200.0;
// Rayleigh 的散射係數：藍光散得比紅光多得多（大約是波長四次方的倒數）。
// 天空是藍的、日落是紅的，都是這三個數字的後果。
const vec3 RAYLEIGH_BETA = vec3( 5.5e-6, 13.0e-6, 22.4e-6 );
const float MIE_BETA = 21e-6;

const int PRIMARY_STEPS = 16;
const int LIGHT_STEPS = 8;

/** 射線與球（以原點為心）的交點。回傳進出的距離；沒交點回 (-1, -1)。 */
vec2 raySphere( vec3 origin, vec3 direction, float radius ) {
  float b = dot( origin, direction );
  float c = dot( origin, origin ) - radius * radius;
  float d = b * b - c;
  if ( d < 0.0 ) return vec2( -1.0 );
  d = sqrt( d );
  return vec2( -b - d, -b + d );
}

void main() {
  vec3 direction = normalize( vDirection );
  vec3 sun = normalize( uSunDirection );

  // 觀察者站在地表上一點點。
  vec3 origin = vec3( 0.0, EARTH_RADIUS + 1.0, 0.0 );

  vec2 atmosphere = raySphere( origin, direction, ATMOSPHERE_RADIUS );
  if ( atmosphere.y < 0.0 ) {
    gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
    return;
  }
  // 打到地面的話只積分到地面為止 —— 不切的話地平線下會亮得莫名其妙。
  vec2 ground = raySphere( origin, direction, EARTH_RADIUS );
  float far = ground.x > 0.0 ? min( atmosphere.y, ground.x ) : atmosphere.y;

  float stepSize = far / float( PRIMARY_STEPS );
  vec3 rayleighSum = vec3( 0.0 );
  vec3 mieSum = vec3( 0.0 );
  float rayleighDepth = 0.0;
  float mieDepth = 0.0;

  for ( int i = 0; i < PRIMARY_STEPS; i++ ) {
    vec3 point = origin + direction * ( ( float( i ) + 0.5 ) * stepSize );
    float height = length( point ) - EARTH_RADIUS;
    float rayleighDensity = exp( -height / RAYLEIGH_SCALE ) * stepSize;
    float mieDensity = exp( -height / MIE_SCALE ) * stepSize;
    rayleighDepth += rayleighDensity;
    mieDepth += mieDensity;

    // ## 這一點看得到太陽嗎
    //
    // 太陽在地平線下的時候，往太陽的射線會鑽進地球。這個 `blocked` 是**早退**，
    // 不是正確性的守衛 —— 拿掉它畫面一模一樣：射線鑽進地面之後 `lightHeight`
    // 變負的，`exp(-負/scale)` 就爆成很大的數，衰減因此趨近 0，結果同樣是黑的。
    //
    // 驗過了：拿掉之後夜晚兩邊都讀到 0.0000。留著是為了省掉那 8 步迴圈，
    // 而不是因為畫面會不一樣 —— 這件事寫下來，免得以後有人以為它在守什麼。
    vec2 lightHit = raySphere( point, sun, ATMOSPHERE_RADIUS );
    float lightStep = lightHit.y / float( LIGHT_STEPS );
    float lightRayleigh = 0.0;
    float lightMie = 0.0;
    bool blocked = false;

    for ( int j = 0; j < LIGHT_STEPS; j++ ) {
      vec3 lightPoint = point + sun * ( ( float( j ) + 0.5 ) * lightStep );
      float lightHeight = length( lightPoint ) - EARTH_RADIUS;
      if ( lightHeight < 0.0 ) { blocked = true; break; }
      lightRayleigh += exp( -lightHeight / RAYLEIGH_SCALE ) * lightStep;
      lightMie += exp( -lightHeight / MIE_SCALE ) * lightStep;
    }
    if ( blocked ) continue;

    // 進來與出去各衰減一次。
    vec3 attenuation = exp(
      -( RAYLEIGH_BETA * ( rayleighDepth + lightRayleigh ) + MIE_BETA * ( mieDepth + lightMie ) )
    );
    rayleighSum += rayleighDensity * attenuation;
    mieSum += mieDensity * attenuation;
  }

  float cosTheta = dot( direction, sun );
  // Rayleigh 的相位函數：前後對稱。
  float rayleighPhase = 3.0 / ( 16.0 * 3.14159265 ) * ( 1.0 + cosTheta * cosTheta );
  // Henyey-Greenstein：太陽周圍那一圈白光就是它。
  float g = uMieG;
  float gg = g * g;
  float miePhase =
    ( 1.0 - gg ) / ( 4.0 * 3.14159265 * pow( 1.0 + gg - 2.0 * g * cosTheta, 1.5 ) );

  vec3 color = uIntensity * ( rayleighPhase * RAYLEIGH_BETA * rayleighSum + miePhase * MIE_BETA * mieSum );
  gl_FragColor = vec4( color, 1.0 );
}
`;
