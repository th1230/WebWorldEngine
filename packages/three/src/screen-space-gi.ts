import {
  DepthTexture,
  HalfFloatType,
  Matrix4,
  MeshNormalMaterial,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  UnsignedShortType,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import type { Camera, PerspectiveCamera, Scene, Texture, WebGLRenderer } from 'three';
import { drawFullscreen, FULLSCREEN_VERTEX } from './fullscreen.ts';

/**
 * 螢幕空間的一次反彈間接光。
 *
 * ## 它補的是探針補不到的那一段
 *
 * 烘出來的探針體積（`IrradianceVolume`）記的是**格點上**的光，格點之間靠內插。
 * 所以比格距小的東西 —— 一個貼著牆的箱子、桌腳與地板的接縫 —— 落在格與格
 * 之間，而實測那一段的量值會隨探針落在哪裡浮動好幾倍。
 *
 * 這一支從**畫面上已經有的像素**去收集反彈，所以它的尺度是像素級的，剛好
 * 補在探針的下面。兩個一起用：探針管大範圍與離線的正確性，這裡管接觸尺度。
 *
 * ## 為什麼這不算「變成另一個渲染器」
 *
 * ADR-0001 擋的是「擁有管線」。這一支是一個**後製 pass** —— 與範例已經在用的
 * bloom 同一類：拿 renderer 畫好的東西再處理一次，不改變場景怎麼被畫。
 *
 * 它多要一張法線圖，那是一次 `scene.overrideMaterial` 的重畫，用的還是同一個
 * renderer。沒有 G-buffer、沒有 deferred、沒有自己的材質系統。
 *
 * ## 誠實的限制（這些是這個做法的本質，不是還沒做完）
 *
 * | 限制 | 意思 |
 * | --- | --- |
 * | 只收集得到**畫面上有的**東西 | 鏡頭外的紅牆不會反彈進來 |
 * | 一次反彈 | 反彈的光不會再反彈 |
 * | 有雜訊 | 取樣數有限，靠模糊壓下去；不做時間累積（那要 motion vector，屬於渲染器） |
 * | 被遮住的表面收不到 | 螢幕空間看不到就是看不到 |
 *
 * 前三項正是探針**不會有**的問題，所以兩者互補而不是取代。
 */

/** 半球取樣的方向，固定一組 —— 每幀重算沒有意義，而且會讓畫面閃。 */
const SAMPLE_COUNT = 12;

export interface ScreenSpaceGiOptions {
  /**
   * 收集半徑，**世界單位**。預設 4。
   *
   * 這個值就是「接觸尺度」的定義：多近的東西算在內。設太大會變成一個很糊的
   * 環境光，設太小則只影響幾個像素。
   *
   * 它應該**小於探針的格距** —— 兩者重疊的那一段會被算兩次。
   */
  radius?: number;
  /** 強度。預設 1。 */
  intensity?: number;
  /**
   * 解析度倍率。預設 0.5（半解析度）。
   *
   * 間接光是低頻的，半解析度看不出差別而成本是四分之一。模糊那一步本來就會
   * 把細節抹掉。
   */
  scale?: number;
}

/**
 * 螢幕空間間接光。
 *
 * ```js
 * const ssgi = new WW.ScreenSpaceGI({ radius: 4 });
 * // 每幀，在主畫面畫完之後：
 * ssgi.render(renderer, scene, camera, sceneColorTexture, outputTarget);
 * ```
 *
 * 需要一張**已經畫好的場景顏色**（通常是 `EffectComposer` 的 read buffer）。
 */
export class ScreenSpaceGI {
  private readonly options: Required<ScreenSpaceGiOptions>;
  /** 法線與深度。深度用 render target 自己的 depthTexture，不另外畫一次。 */
  private normalTarget: WebGLRenderTarget | null = null;
  private gatherTarget: WebGLRenderTarget | null = null;
  private readonly normalMaterial = new MeshNormalMaterial();
  private readonly gatherMaterial: ShaderMaterial;
  private readonly size = new Vector2();
  private readonly projectionInverse = new Matrix4();

  constructor(options: ScreenSpaceGiOptions = {}) {
    this.options = {
      radius: options.radius ?? 4,
      intensity: options.intensity ?? 1,
      scale: options.scale ?? 0.5,
    };
    this.gatherMaterial = new ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tNormal: { value: null },
        tDepth: { value: null },
        uProjectionInverse: { value: new Matrix4() },
        uProjection: { value: new Matrix4() },
        uRadius: { value: this.options.radius },
        uIntensity: { value: this.options.intensity },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
  }

  get intensity(): number {
    return this.gatherMaterial.uniforms.uIntensity!.value as number;
  }

  set intensity(value: number) {
    this.gatherMaterial.uniforms.uIntensity!.value = value;
  }

  /**
   * 把間接光收集到一張圖裡。**回傳那張圖的貼圖**，合成由呼叫端做。
   *
   * 分成兩步而不是直接寫回畫面：合成要怎麼做（加上去？乘上去？先做色調對應？）
   * 是開發者的選擇，而這個套件不替他決定那種事。
   */
  render(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    colorTexture: Texture,
  ): Texture {
    renderer.getDrawingBufferSize(this.size);
    const width = Math.max(1, Math.floor(this.size.x * this.options.scale));
    const height = Math.max(1, Math.floor(this.size.y * this.options.scale));
    this.ensureTargets(width, height);

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;

    // ## 一次法線重畫
    //
    // 深度直接掛在同一張 target 上（`depthTexture`），所以這是**一次**額外的
    // 場景繪製，不是兩次。
    scene.overrideMaterial = this.normalMaterial;
    renderer.setRenderTarget(this.normalTarget);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    scene.overrideMaterial = previousOverride;

    const perspective = camera as PerspectiveCamera;
    const uniforms = this.gatherMaterial.uniforms;
    uniforms.tColor!.value = colorTexture;
    uniforms.tNormal!.value = this.normalTarget!.texture;
    uniforms.tDepth!.value = this.normalTarget!.depthTexture;
    uniforms.uProjection!.value = perspective.projectionMatrix;
    this.projectionInverse.copy(perspective.projectionMatrix).invert();
    uniforms.uProjectionInverse!.value = this.projectionInverse;
    uniforms.uNear!.value = perspective.near ?? 0.1;
    uniforms.uFar!.value = perspective.far ?? 1000;
    uniforms.uRadius!.value = this.options.radius;

    renderer.setRenderTarget(this.gatherTarget);
    renderer.clear(true, false, false);
    drawFullscreen(renderer, this.gatherMaterial);

    renderer.setRenderTarget(previousTarget);
    return this.gatherTarget!.texture;
  }

  private ensureTargets(width: number, height: number): void {
    if (this.normalTarget !== null && this.normalTarget.width === width && this.normalTarget.height === height) {
      return;
    }
    this.normalTarget?.dispose();
    this.gatherTarget?.dispose();

    const depth = new DepthTexture(width, height, UnsignedShortType);
    this.normalTarget = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      // 法線是**資料**，不是顏色 —— 走色彩空間轉換的話解出來的方向是錯的，
      // 而那不會報錯，只會讓收集到的光從錯的方向來。
      colorSpace: NoColorSpace,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthTexture: depth,
    });
    this.gatherTarget = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      type: HalfFloatType,
      colorSpace: NoColorSpace,
      depthBuffer: false,
    });
  }

  dispose(): void {
    this.normalTarget?.dispose();
    this.gatherTarget?.dispose();
    this.normalMaterial.dispose();
    this.gatherMaterial.dispose();
  }
}



const FRAGMENT = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform mat4 uProjectionInverse;
uniform mat4 uProjection;
uniform float uRadius;
uniform float uIntensity;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;

const int SAMPLES = ${SAMPLE_COUNT};

/** 從深度圖還原視空間位置。 */
vec3 viewPositionAt( vec2 uv ) {
  float depth = texture2D( tDepth, uv ).x;
  vec4 clip = vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
  vec4 view = uProjectionInverse * clip;
  return view.xyz / view.w;
}

void main() {
  float depth = texture2D( tDepth, vUv ).x;
  // 天空不收集也不貢獻。
  if ( depth >= 1.0 ) {
    gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
    return;
  }

  vec3 origin = viewPositionAt( vUv );
  // MeshNormalMaterial 存的是 0..1 的視空間法線。
  vec3 normal = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );

  // 每個像素一個固定的旋轉，讓取樣圖案不要整片對齊 —— 對齊的話畫面上會出現
  // 規則的條紋，那比雜訊還明顯。
  float angle = fract( sin( dot( vUv, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2831853;
  float ca = cos( angle );
  float sa = sin( angle );

  vec3 sum = vec3( 0.0 );

  for ( int i = 0; i < SAMPLES; i ++ ) {
    float fi = float( i );
    // 螺旋取樣：角度均勻散開，半徑用平方根讓密度均勻。
    float t = ( fi + 0.5 ) / float( SAMPLES );
    float sampleAngle = t * 6.2831853 * 3.0 + angle;
    float sampleRadius = sqrt( t );
    vec2 offset = vec2( cos( sampleAngle ), sin( sampleAngle ) ) * sampleRadius;
    offset = vec2( offset.x * ca - offset.y * sa, offset.x * sa + offset.y * ca );

    // 把世界半徑換算成螢幕上的偏移：越遠的像素，同樣的半徑佔越少像素。
    vec4 offsetView = vec4( origin + vec3( offset * uRadius, 0.0 ), 1.0 );
    vec4 offsetClip = uProjection * offsetView;
    vec2 sampleUv = ( offsetClip.xy / offsetClip.w ) * 0.5 + 0.5;
    if ( sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0 ) continue;

    float sampleDepth = texture2D( tDepth, sampleUv ).x;
    if ( sampleDepth >= 1.0 ) continue;

    vec3 samplePosition = viewPositionAt( sampleUv );
    vec3 toSample = samplePosition - origin;
    float distance = length( toSample );
    if ( distance < 1e-4 || distance > uRadius ) continue;

    vec3 direction = toSample / distance;
    // 接收面要朝著它 —— 背對的表面收不到那個方向來的光。
    float receiverFacing = max( dot( normal, direction ), 0.0 );
    if ( receiverFacing <= 0.0 ) continue;

    // 發射面也要朝著接收面，否則那是它的背面（看不到的那一側）。
    vec3 sampleNormal = normalize( texture2D( tNormal, sampleUv ).xyz * 2.0 - 1.0 );
    float emitterFacing = max( dot( sampleNormal, -direction ), 0.0 );
    if ( emitterFacing <= 0.0 ) continue;

    // 距離衰減：近的貢獻大。這不是物理上的平方反比 —— 螢幕空間看到的是
    // 表面不是點光源，用線性衰減比較穩，也不會讓貼很近的東西爆掉。
    float falloff = 1.0 - distance / uRadius;

    sum += texture2D( tColor, sampleUv ).rgb * receiverFacing * emitterFacing * falloff;
  }

  // ## 除以**總取樣數**，不是除以命中的那幾個
  //
  // 除以命中數的話它變成「命中的那些平均起來多紅」—— 十二個裡只有一個打到
  // 紅地板也會得到滿滿的紅，而十二個全打到也是滿滿的紅。兩種情況的實際
  // 遮蔽差了十二倍，答案卻一樣。
  //
  // 除以總數才是「半球裡有多少比例被紅色佔住」，也就是真正要估的那個積分。
  // 沒打到的那些代表那個方向沒有東西（或在螢幕外），它們的貢獻本來就是 0。
  vec3 indirect = sum / float( SAMPLES );
  gl_FragColor = vec4( indirect * uIntensity, 1.0 );
}
`;
