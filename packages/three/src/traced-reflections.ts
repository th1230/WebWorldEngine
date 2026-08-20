import {
  Color,
  Matrix4,
  NoColorSpace,
  ShaderMaterial,
  Vector3,
  HalfFloatType,
  WebGLRenderTarget,
} from 'three';
import { drawFullscreen, FULLSCREEN_VERTEX, VIEW_POSITION_GLSL } from './fullscreen.ts';
// 只有型別是靜態的 —— 那份 TSL 轉寫是動態載入的，見 `renderNode`。
import type { TracedReflectionsNodeHandle } from './traced-reflections-node.ts';
import { IRRADIANCE_SAMPLE_GLSL, IRRADIANCE_UNIFORMS_GLSL } from './irradiance-glsl.ts';
import {
  REFLECTION_PROBE_SAMPLE_GLSL,
  REFLECTION_PROBE_UNIFORMS_GLSL,
} from './reflection-probes.ts';
import type { Camera, PerspectiveCamera, Texture, WebGLRenderer, Scene } from 'three';
import type { GlobalDistanceField } from './global-distance-field.ts';
import type { IrradianceVolume } from './irradiance.ts';
import type { ReflectionProbes } from './reflection-probes.ts';
import { worldFor } from './world.ts';

/**
 * 反射：先在畫面上找，找不到就去距離場裡找。
 *
 * ## 為什麼純螢幕空間的反射不夠
 *
 * Three 的 addons 有 `SSRPass`，而它的限制是結構性的：**反射只找得到畫面上
 * 已經有的東西**。所以
 *
 * - 鏡頭外的牆不會出現在水面上
 * - 你自己的腳在水裡看不到（被身體擋住的那一半）
 * - 相機一轉，反射裡的東西整批消失又整批出現
 *
 * 最後那一點特別致命：它不是「不夠準」，是**會動的錯**，而人眼對那個非常敏感。
 *
 * ## 兩層，與間接光同一個分法
 *
 * | | 找什麼 | 代價 |
 * | --- | --- | --- |
 * | 螢幕空間 | 畫面上有的東西，**銳利** | 幾步深度比對 |
 * | 距離場 | 螢幕外、被擋住的東西，**低頻** | 球體追蹤 |
 *
 * 這與 `ScreenSpaceGI` + `GlobalDistanceField` 的分層一模一樣，而且用的是
 * **同一批結構**。反射不是另外蓋一套，是把已經蓋好的地基換一個方向追。
 *
 * ## 距離場那一層的顏色從哪裡來
 *
 * 距離場只知道「那裡有東西」。射出來的光是**兩件事的乘積**：
 *
 * - 那個表面的顏色（反照率）—— 全域距離場順手合成的那一份
 * - 那一點收到多少光（輻照度）—— 探針體積
 *
 * 只用輻照度是不夠的，而那個錯很容易犯：實測反射到一個紅箱子拿到的是
 * R 0.081 / B 0.128（偏藍），因為太陽是白的。**紅牆會反射成白的。**
 *
 * 那是低頻的、糊的，但它在**正確的位置**上。而反射最需要的是位置對：一團
 * 大致正確的顏色出現在該出現的地方，比銳利但整批閃現的東西真實得多。
 *
 * 用的還是 `applyIrradiance` 的**同一份 GLSL 原始碼**（`irradiance-glsl.ts`），
 * 所以反射裡的亮度與直接看到的不可能分岔。
 *
 * ## 粗糙度
 *
 * 粗糙的表面反射的是一個圓錐而不是一條線。這裡用「粗糙時直接偏向距離場那一
 * 層」來近似 —— 因為那一層本來就是糊的。銳利的鏡面走螢幕空間，霧面走距離場，
 * 中間混合。
 *
 * 那不是物理正確的 BRDF 重要性取樣，而它省掉的是每個 fragment 好幾條射線。
 */

export interface TracedReflectionsOptions {
  /** 螢幕空間追蹤幾步。預設 24。 */
  screenSteps?: number;
  /** 螢幕空間每一步多長，世界單位。預設 0.4。 */
  screenStep?: number;
  /** 螢幕空間的厚度上限，世界單位。預設 1。與接觸陰影同一個道理。 */
  thickness?: number;
  /** 距離場追蹤幾步。預設 48。 */
  fieldSteps?: number;
  /** 追多遠，世界單位。預設用場的一半。 */
  range?: number;
  /**
   * 表面的粗糙度 0–1。預設 0.15。
   *
   * 0 是完美鏡面（全走螢幕空間），1 是完全霧面（全走距離場）。
   */
  roughness?: number;
  /** 什麼都沒打到時的顏色（天空）。預設深藍。 */
  sky?: Color;
}

/** 每幀會變的東西。與其他效果同一個形狀 —— 位置參數的順序記不住。 */
export interface TracedReflectionsFrame {
  /** 已經畫好的那一張畫面 —— 螢幕空間的反射是從它取樣的。 */
  color: Texture;
  /** 打不到畫面內的東西時，沿著距離場繼續追。 */
  field?: GlobalDistanceField | null;
  /** 追不到的方向退回間接光。 */
  irradiance?: IrradianceVolume | null;
  /** 有探針的話優先用探針 —— 它記得畫面外的環境。 */
  probes?: ReflectionProbes | null;
}

export class TracedReflections {
  private readonly options: Required<TracedReflectionsOptions>;
  private target: WebGLRenderTarget | null = null;
  private readonly material: ShaderMaterial;
  private readonly projectionInverse = new Matrix4();
  /** WebGPU 那條路的材質。惰性建立 —— 只用 WebGL 的人不該下載 `three/tsl`。 */
  private node: TracedReflectionsNodeHandle | null = null;
  private nodePending: Promise<void> | null = null;

  constructor(options: TracedReflectionsOptions = {}) {
    this.options = {
      screenSteps: options.screenSteps ?? 24,
      screenStep: options.screenStep ?? 0.4,
      thickness: options.thickness ?? 1,
      fieldSteps: options.fieldSteps ?? 48,
      range: options.range ?? 0,
      roughness: options.roughness ?? 0.15,
      sky: options.sky ?? new Color(0x2a3a55),
    };

    this.material = new ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tNormal: { value: null },
        tField: { value: null },
        tAlbedo: { value: null },
        wwIrrSH0: { value: null },
        wwIrrSH1: { value: null },
        wwIrrSH2: { value: null },
        wwIrrSH3: { value: null },
        wwIrrMin: { value: new Vector3() },
        wwIrrInvSize: { value: new Vector3(1, 1, 1) },
        wwIrrIntensity: { value: 1 },
        uProjection: { value: new Matrix4() },
        uProjectionInverse: { value: new Matrix4() },
        uCameraMatrix: { value: new Matrix4() },
        uFieldMin: { value: new Vector3() },
        uFieldExtent: { value: 1 },
        uCell: { value: 1 },
        uHasField: { value: 0 },
        uHasIrradiance: { value: 0 },
        uScreenSteps: { value: this.options.screenSteps },
        uScreenStep: { value: this.options.screenStep },
        uThickness: { value: this.options.thickness },
        uFieldSteps: { value: this.options.fieldSteps },
        uRange: { value: 1 },
        uRoughness: { value: this.options.roughness },
        uSky: { value: this.options.sky },
        uHasProbes: { value: 0 },
        uDebug: { value: 0 },
        // ## 探針那幾個 uniform 必須**現在**就宣告，即使還沒有探針
        //
        // Three 只在程式第一次編譯時，拿當下 `material.uniforms` 有哪些鍵
        // 去決定「每幀要上傳哪些」（`seqWithValue`）。之後才補進去的鍵
        // 永遠不會被上傳 —— 而畫面不會報錯，只是反射永遠退回天空色。
        wwReflAtlas: { value: null },
        wwReflMin: { value: new Vector3() },
        wwReflInvSize: { value: new Vector3(1, 1, 1) },
        wwReflResolution: { value: new Vector3(2, 2, 2) },
        wwReflColumns: { value: 1 },
        wwReflStride: { value: 18 },
        wwReflAtlasSize: { value: new Vector3(1, 1, 0) },
        wwReflIntensity: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * 把中間值畫出來。0 正常，1 體積座標，2 反射方向，3 第 0 顆探針，
   * 4 八面體 uv，5 整張圖集，6 有沒有接上探針。
   */
  debugMode = 0;

  /** 表面的粗糙度。0 全走螢幕空間，1 全走距離場。 */
  get roughness(): number {
    return this.options.roughness;
  }

  set roughness(value: number) {
    this.options.roughness = value;
  }

  /**
   * 算這一幀的反射。
   *
   * @param colorTexture 這一幀已經畫好的畫面。螢幕空間那一層取樣它。
   * @param field 全域距離場。給了才有螢幕外的反射。
   * @param irradiance 探針體積。給了距離場那一層才知道打到的東西多亮。
   */
  /**
   * 畫這一幀的效果。
   *
   * 共用的深度法線圖是**自己去 `worldFor(scene)` 拿的** —— 呼叫端不必
   * 知道它存在，也不會弄錯順序。記得每幀開頭呼叫一次 `beginFrame()`，
   * 那樣同一張圖一幀只會畫一次。
   */
  render(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    frame: TracedReflectionsFrame,
  ): Texture | null {
    const gbuffer = worldFor(scene).depthNormals(renderer, camera);
    const { color: colorTexture, field = null, irradiance = null, probes = null } = frame;
    const depth = gbuffer.depthTexture;
    const normal = gbuffer.normalTexture;
    if (depth === null || normal === null) return null;

    this.ensureTarget(gbuffer.width, gbuffer.height);

    // WebGPU 不吃 ShaderMaterial，走 node 那份。兩份的一致性由跨後端關卡守。
    if ((renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true) {
      return this.renderNode(
        renderer,
        camera,
        colorTexture,
        depth,
        normal,
        field,
        irradiance,
        probes,
      );
    }

    const perspective = camera as PerspectiveCamera;
    const u = this.material.uniforms;
    u.tColor!.value = colorTexture;
    u.tDepth!.value = depth;
    u.tNormal!.value = normal;
    u.uProjection!.value = perspective.projectionMatrix;
    this.projectionInverse.copy(perspective.projectionMatrix).invert();
    u.uProjectionInverse!.value = this.projectionInverse;
    u.uCameraMatrix!.value = camera.matrixWorld;

    if (field !== null) {
      u.tField!.value = field.texture;
      u.tAlbedo!.value = field.albedoTexture;
      u.uFieldMin!.value = field.min;
      u.uFieldExtent!.value = field.extent;
      u.uCell!.value = field.extent / field.resolution;
      u.uRange!.value = this.options.range > 0 ? this.options.range : field.extent * 0.5;
      u.uHasField!.value = 1;
    } else {
      u.uHasField!.value = 0;
    }

    if (irradiance !== null) {
      const textures = irradiance.textures;
      u.wwIrrSH0!.value = textures[0];
      u.wwIrrSH1!.value = textures[1];
      u.wwIrrSH2!.value = textures[2];
      u.wwIrrSH3!.value = textures[3];
      u.wwIrrMin!.value = irradiance.min;
      (u.wwIrrInvSize!.value as Vector3).set(
        1 / irradiance.size.x,
        1 / irradiance.size.y,
        1 / irradiance.size.z,
      );
      u.wwIrrIntensity!.value = irradiance.intensity;
      u.uHasIrradiance!.value = 1;
    } else {
      u.uHasIrradiance!.value = 0;
    }

    u.uScreenSteps!.value = this.options.screenSteps;
    u.uScreenStep!.value = this.options.screenStep;
    u.uThickness!.value = this.options.thickness;
    u.uFieldSteps!.value = this.options.fieldSteps;
    u.uRoughness!.value = this.options.roughness;
    u.uSky!.value = this.options.sky;
    u.uDebug!.value = this.debugMode;

    if (probes !== null) {
      // 複製**值**進既有的 holder，不是換掉 holder。每幀都複製，所以
      // 探針那邊改 intensity 這裡跟著動。
      const probeUniforms = probes.uniforms();
      for (const key of Object.keys(probeUniforms)) {
        const slot = u[key];
        if (slot !== undefined) slot.value = probeUniforms[key]!.value;
      }
      u.uHasProbes!.value = 1;
    } else {
      u.uHasProbes!.value = 0;
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
    colorTexture: Texture,
    depth: Texture,
    normal: Texture,
    field: GlobalDistanceField | null,
    irradiance: IrradianceVolume | null,
    probes: ReflectionProbes | null,
  ): Texture | null {
    if (this.node === null) {
      this.nodePending ??= import('./traced-reflections-node.ts')
        .then((m) => m.createTracedReflectionsNodeMaterial())
        .then((handle) => {
          this.node = handle;
        })
        .catch((error: unknown) => {
          // **大聲說出來。** 靜靜失敗的症狀是「WebGPU 上這個效果完全沒有」，
          // 而那看起來像場景沒設定好，不像材質建不起來。
          console.error('WW.TracedReflections：node 材質建不起來，WebGPU 上不會有反射。', error);
        });
      return null;
    }
    const perspective = camera as PerspectiveCamera;
    this.projectionInverse.copy(perspective.projectionMatrix).invert();
    this.node.setTextures(colorTexture, depth, normal);
    this.node.setMatrices(perspective.projectionMatrix, this.projectionInverse, camera.matrixWorld);
    this.node.setField(field, this.options.range);
    this.node.setIrradiance(irradiance);
    this.node.setProbes(probes);
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
    if (this.target !== null && this.target.width === width && this.target.height === height)
      return;
    this.target?.dispose();
    // 反射是**顏色**，而且可能超過 1（亮的天空、鏡面高光），所以半精度。
    // 遮蔽遮罩那一類用八位元就好，這一類不行。
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

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler3D tField;
uniform sampler3D tAlbedo;
${IRRADIANCE_UNIFORMS_GLSL}
${REFLECTION_PROBE_UNIFORMS_GLSL}
uniform float uHasProbes;
uniform float uDebug;
uniform mat4 uProjection;
uniform mat4 uProjectionInverse;
uniform mat4 uCameraMatrix;
uniform vec3 uFieldMin;
uniform float uFieldExtent;
uniform float uCell;
uniform float uHasField;
uniform float uHasIrradiance;
uniform float uScreenSteps;
uniform float uScreenStep;
uniform float uThickness;
uniform float uFieldSteps;
uniform float uRange;
uniform float uRoughness;
uniform vec3 uSky;
varying vec2 vUv;

${VIEW_POSITION_GLSL}
${IRRADIANCE_SAMPLE_GLSL}
${REFLECTION_PROBE_SAMPLE_GLSL}

float fieldAt( vec3 worldPoint ) {
  vec3 uvw = ( worldPoint - uFieldMin ) / uFieldExtent;
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) {
    return uFieldExtent;
  }
  return texture( tField, uvw ).r;
}

/** 打到的那個表面是什麼顏色。距離場只答得出「有東西」。 */
vec3 albedoAtField( vec3 worldPoint ) {
  vec3 uvw = ( worldPoint - uFieldMin ) / uFieldExtent;
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) {
    return vec3( 1.0 );
  }
  return texture( tAlbedo, uvw ).rgb;
}

void main() {
  float rawDepth = texture2D( tDepth, vUv ).x;
  if ( rawDepth >= 1.0 ) {
    gl_FragColor = vec4( uSky, 0.0 );
    return;
  }

  vec3 viewPosition = wwViewPositionFromDepth( vUv, rawDepth, uProjectionInverse );
  vec3 viewNormal = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );
  // 從相機指向這一點。視空間裡相機在原點，所以位置本身就是方向。
  vec3 viewDir = normalize( viewPosition );
  vec3 reflected = normalize( reflect( viewDir, viewNormal ) );

  vec3 screenColor = vec3( 0.0 );
  float screenHit = 0.0;

  // ## 第一層：畫面上找得到嗎
  //
  // 沿著法線推開再開始。不推的話在**掠射角**上第一步還在自己的深度容差裡，
  // 於是鏡面反射出自己的顏色。
  //
  // 平的鏡子從中等角度看不會發生（反射的射線一步就離開表面了），所以關卡
  // 的取樣點驗不到它 —— 實測拿掉之後整張只差 0.8 個百分點（打到的比例
  // 35.65% 對 36.45%），訂不出安全的門檻。曲面與掠射角上差別大得多，但那
  // 要一個專門為它蓋的場景。
  //
  // 所以這一條是**知道驗不到而留著**的，不是沒想過。
  vec3 point = viewPosition + viewNormal * uThickness * 0.5;
  for ( int i = 1; i <= 64; i++ ) {
    if ( float( i ) > uScreenSteps ) break;
    point += reflected * uScreenStep;
    vec4 clip = uProjection * vec4( point, 1.0 );
    if ( clip.w <= 0.0 ) break;
    vec2 uv = ( clip.xy / clip.w ) * 0.5 + 0.5;
    // 出畫面了 —— 這正是螢幕空間答不出來的那一段，交給下一層。
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;

    float sceneRaw = texture2D( tDepth, uv ).x;
    if ( sceneRaw >= 1.0 ) continue;
    vec3 scenePoint = wwViewPositionFromDepth( uv, sceneRaw, uProjectionInverse );
    float difference = scenePoint.z - point.z;
    if ( difference > 0.0 && difference < uThickness ) {
      screenColor = texture2D( tColor, uv ).rgb;
      screenHit = 1.0;
      break;
    }
  }

  // ## 第二層：距離場
  //
  // 螢幕空間找不到的東西**不是不存在**，只是不在畫面上。這一層專門補那一段。
  // 世界座標在距離場與反射探針兩層都要用，所以提到外面算一次。
  vec3 worldPosition = ( uCameraMatrix * vec4( viewPosition, 1.0 ) ).xyz;
  vec3 worldNormal = normalize( mat3( uCameraMatrix ) * viewNormal );
  vec3 worldReflected = normalize( mat3( uCameraMatrix ) * reflected );

  // ## 第三層：反射探針
  //
  // 距離場答得出「那裡有東西、什麼顏色」，但它算的亮度是反照率 × 輻照度 ——
  // 一個 Lambert 的假設。天空、場外面的一切、亮而有方向性的東西（太陽的
  // 高光、發光的招牌）都不在裡面。
  //
  // 探針拍的是**實際的輻射**，所以它接的位置是「什麼都沒打到」那一條 ——
  // 原本那裡是一個寫死的顏色。探針體積外面仍然退回那個顏色。
  // ## 中間值印成畫面
  //
  // 反射答錯的時候，從外面只看得到「顏色不對」。而不對的原因可能在世界
  // 座標、在反射方向、在八面體的 uv、在圖集的位置 —— 猜是猜不出來的。
  if ( uDebug > 0.5 ) {
    if ( uDebug < 1.5 ) { gl_FragColor = vec4( ( worldPosition - wwReflMin ) * wwReflInvSize, 1.0 ); return; }
    if ( uDebug < 2.5 ) { gl_FragColor = vec4( worldReflected * 0.5 + 0.5, 1.0 ); return; }
    if ( uDebug < 3.5 ) { gl_FragColor = vec4( wwReflProbe( 0.0, worldReflected ), 1.0 ); return; }
    if ( uDebug < 4.5 ) { gl_FragColor = vec4( wwReflOctEncode( worldReflected ), 0.0, 1.0 ); return; }
    if ( uDebug < 5.5 ) { gl_FragColor = vec4( texture( wwReflAtlas, vUv ).rgb, 1.0 ); return; }
    if ( uDebug < 6.5 ) { gl_FragColor = vec4( vec3( uHasProbes ), 1.0 ); return; }
  }

  vec3 missColor = uSky;
  if ( uHasProbes > 0.5 ) {
    missColor = wwReflectionAt( worldPosition, worldReflected, uSky );
  }

  vec3 fieldColor = missColor;
  float fieldHit = 0.0;
  if ( uHasField > 0.5 ) {

    vec3 p = worldPosition + worldNormal * uCell;
    float travelled = uCell;
    for ( int i = 0; i < 128; i++ ) {
      if ( float( i ) >= uFieldSteps || travelled >= uRange ) break;
      float distance = fieldAt( p );
      if ( distance < uCell * 0.25 ) {
        fieldHit = 1.0;
        // ## 射出來的光 = 表面的顏色 × 它收到的光
        //
        // 只乘輻照度是不夠的 —— 那是「打到的地方**收到**多少光」，而不是
        // 「那個表面**射出**什麼顏色」。少了反照率，一面紅牆會反射成白的。
        //
        // 實測過：只有輻照度時反射到紅箱子拿到的是 R 0.081 / B 0.128（偏藍，
        // 因為太陽是白的）。乘上反照率之後才是紅的。
        //
        // 法線用反向的射線近似：反彈與反射都是低頻的，看不出差別。
        vec3 surfaceAlbedo = albedoAtField( p );
        vec3 incoming = uHasIrradiance > 0.5 ? wwIrradiance( p, -worldReflected ) : vec3( 1.0 );
        fieldColor = surfaceAlbedo * incoming;
        break;
      }
      p += worldReflected * distance;
      travelled += distance;
    }
  }

  // ## 兩層怎麼混
  //
  // 銳利的鏡面優先用螢幕空間（它銳利）；粗糙的表面本來就糊，直接偏向距離場。
  float screenWeight = screenHit * ( 1.0 - uRoughness );
  vec3 result = mix( fieldHit > 0.5 ? fieldColor : missColor, screenColor, screenWeight );
  gl_FragColor = vec4( result, max( screenHit, fieldHit ) );
}
`;
