import { Matrix4, NoColorSpace, ShaderMaterial, Vector3, WebGLRenderTarget } from 'three';
import { worldFor } from './world.ts';
import { drawFullscreen, FULLSCREEN_VERTEX, VIEW_POSITION_GLSL } from './fullscreen.ts';
// 只有型別是靜態的 —— 那份 TSL 轉寫是動態載入的，見 `renderNode`。
import type { ContactShadowsNodeHandle } from './contact-shadows-node.ts';
import type { Camera, PerspectiveCamera, Texture, WebGLRenderer, Scene } from 'three';

/**
 * 接觸陰影：shadow map 永遠糊掉的那幾公分。
 *
 * ## 它補的洞
 *
 * shadow map 的解析度是**整個範圍除以貼圖大小**。世界級的 CSM 罩得住幾公里，
 * 代價是每個 texel 對應到好幾公分 —— 而「腳跟地面之間」「箱子跟牆之間」那條
 * 接縫就在那個尺度上。
 *
 * 症狀很典型：東西看起來**浮在地上**。陰影是有的，但它從物體邊緣就開始糊，
 * 於是接觸點沒有那條深色的細線。人眼對那條線非常敏感 —— 它是判斷「東西有沒有
 * 真的碰到地面」的主要線索。
 *
 * 這與距離場陰影是互補的：距離場補**遠處**（範圍大到 shadow map 撐不住），
 * 接觸陰影補**近處**（尺度小到 shadow map 撐不住）。中間那一段還是 CSM 的。
 *
 * ## 為什麼是螢幕空間
 *
 * 要的是「這個像素附近幾公分有沒有東西擋著光」，而那個資訊**深度緩衝裡就有**。
 * 用距離場追的話精度不夠（一格好幾十公分），用更高解析度的 shadow map 的話
 * 記憶體是平方成長的。
 *
 * 代價是螢幕外的東西擋不到光 —— 但接觸陰影本來就只看幾公分，而幾公分外的
 * 東西幾乎一定也在畫面上。這是螢幕空間限制**剛好不痛**的少數場合。
 *
 * ## 厚度那個參數不是調味料
 *
 * 深度緩衝只知道每個像素**最前面**那一層有多遠，不知道它有多厚。所以「射線
 * 撞到的深度比較近」不代表被擋住 —— 也可能是射線從那個東西**後面**穿過去。
 *
 * 沒有厚度上限的話，遠處的背景會擋住前景的所有東西，畫面變成一大片黑。有了
 * 它，只有「深度差在合理範圍內」才算遮蔽。
 */

export interface ContactShadowsOptions {
  /**
   * 追多遠，**世界單位**。預設 0.5。
   *
   * 這是「接觸」的定義：超過這個距離的遮蔽歸 shadow map 管。調大不會更真實，
   * 只會讓螢幕空間的限制開始露出來（畫面邊緣的東西沒有陰影）。
   */
  distance?: number;
  /**
   * 幾步。預設 12。
   *
   * 步數決定的是**細不細**，不是遠不遠。太少的話陰影會有階梯狀的邊。
   */
  steps?: number;
  /**
   * 遮蔽物的厚度上限，世界單位。預設 0.3。
   *
   * 見上面那一段 —— 這個值太大會讓遠處的東西擋住近處的，太小則會漏掉真正的
   * 遮蔽。與物件的實際尺度有關，不是通用常數。
   */
  thickness?: number;
  /** 陰影多深，0–1。預設 0.75。1 是全黑。 */
  strength?: number;
}

/** 每幀會變的東西。與其他效果同一個形狀 —— 位置參數的順序記不住。 */
export interface ContactShadowsFrame {
  /** 光的方向（世界空間，從光源指向場景）。 */
  lightDirection: Vector3;
}

export class ContactShadows {
  private readonly options: Required<ContactShadowsOptions>;
  private target: WebGLRenderTarget | null = null;
  private readonly material: ShaderMaterial;
  private readonly projectionInverse = new Matrix4();
  private readonly lightViewDirection = new Vector3();

  constructor(options: ContactShadowsOptions = {}) {
    this.options = {
      distance: options.distance ?? 0.5,
      steps: options.steps ?? 12,
      thickness: options.thickness ?? 0.3,
      strength: options.strength ?? 0.75,
    };

    this.material = new ShaderMaterial({
      uniforms: {
        tNormal: { value: null },
        tDepth: { value: null },
        uProjection: { value: new Matrix4() },
        uProjectionInverse: { value: new Matrix4() },
        uLightDirection: { value: new Vector3(0, 1, 0) },
        uDistance: { value: this.options.distance },
        uSteps: { value: this.options.steps },
        uThickness: { value: this.options.thickness },
        uStrength: { value: this.options.strength },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * 算這一幀的接觸陰影。
   *
   * @param lightDirection 光**照過來**的方向（從光源指向場景），世界座標。
   *   給反了的話陰影會出現在物體被照亮的那一側 —— 那個錯很明顯，但它看起來
   *   像「這個效果就是壞的」而不是像「方向反了」。
   * @returns 遮蔽貼圖。1 = 沒被擋，0 = 全擋。乘進畫面即可。
   */
  /**
   * WebGPU 那條路的材質。惰性建立 —— 只用 WebGL 的人不該下載 `three/tsl`。
   *
   * 還沒好之前 `render` 回傳 `null`（跟「還沒有 gbuffer」同一個回應），
   * 呼叫端本來就要處理那個情況。
   */
  /** 這一幀的投影矩陣。node 那條路要自己複製一份（uniform 是它自己的）。 */
  private readonly projection = new Matrix4();
  /** 把中間值畫出來。只有 node 那條路有 —— 它是為了查 WebGPU 上的問題加的。 */
  debugMode = 0;
  private node: ContactShadowsNodeHandle | null = null;
  private nodePending: Promise<void> | null = null;

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
    frame: ContactShadowsFrame,
  ): Texture | null {
    const gbuffer = worldFor(scene).depthNormals(renderer, camera);
    const { lightDirection } = frame;
    const normal = gbuffer.normalTexture;
    const depth = gbuffer.depthTexture;
    if (normal === null || depth === null) return null;

    this.ensureTarget(gbuffer.width, gbuffer.height);

    const perspective = camera as PerspectiveCamera;
    this.projectionInverse.copy(perspective.projectionMatrix).invert();
    // ## 光的方向要換到視空間
    //
    // 追蹤整段都在視空間裡做（深度緩衝就是視空間的東西）。用世界座標的方向
    // 去追的話相機一轉陰影就跟著轉 —— 而那看起來像「陰影在飄」。
    this.lightViewDirection
      .copy(lightDirection)
      .transformDirection(camera.matrixWorldInverse)
      .normalize();

    // WebGPU 不吃 ShaderMaterial，走 node 那份。兩份的一致性由跨後端關卡守。
    this.projection.copy(perspective.projectionMatrix);
    if ((renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true) {
      return this.renderNode(renderer, normal, depth);
    }

    const uniforms = this.material.uniforms;
    uniforms.tNormal!.value = normal;
    uniforms.tDepth!.value = depth;
    uniforms.uProjection!.value = perspective.projectionMatrix;
    uniforms.uProjectionInverse!.value = this.projectionInverse;
    uniforms.uLightDirection!.value = this.lightViewDirection;
    uniforms.uDistance!.value = this.options.distance;
    uniforms.uSteps!.value = this.options.steps;
    uniforms.uThickness!.value = this.options.thickness;
    uniforms.uStrength!.value = this.options.strength;

    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(true, false, false);
    drawFullscreen(renderer, this.material);
    renderer.setRenderTarget(previous);
    return this.target!.texture;
  }

  /**
   * WebGPU 那條路。第一次呼叫啟動非同步建立並回傳 `null` —— 下一幀就好了。
   *
   * 要等它的話用 `contactShadowsNodeReady()`。
   */
  private renderNode(renderer: WebGLRenderer, normal: Texture, depth: Texture): Texture | null {
    if (this.node === null) {
      this.nodePending ??= import('./contact-shadows-node.ts')
        .then((m) => m.createContactShadowsNodeMaterial())
        .then((handle) => {
          this.node = handle;
        })
        .catch((error: unknown) => {
          // **大聲說出來。** 靜靜失敗的症狀是「WebGPU 上這個效果完全沒有」，
          // 而那看起來像場景沒設定好，不像材質建不起來。
          console.error('WW.ContactShadows：node 材質建不起來，WebGPU 上不會有接觸陰影。', error);
        });
      return null;
    }
    this.node.setTextures(normal, depth);
    this.node.setMatrices(this.projection, this.projectionInverse);
    this.node.setLight(this.lightViewDirection);
    this.node.setParams(this.options);
    this.node.setDebug(this.debugMode);
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
    // ## 八位元就夠，而且讀得回來
    //
    // 這是一張遮蔽遮罩，值域 0–1，256 階綽綽有餘。用半精度不只是浪費頻寬
    // ——半精度的 target 讀回來要 Uint16 再解碼，而這個專案已經因為「用
    // Float32Array 去讀半精度」拿到過一整片 0。驗證讀得回來這件事本身
    // 有價值，所以格式挑好讀的那個。
    this.target = new WebGLRenderTarget(width, height, {
      colorSpace: NoColorSpace,
      depthBuffer: false,
    });
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
  }
}

const FRAGMENT = /* glsl */ `
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform mat4 uProjection;
uniform mat4 uProjectionInverse;
uniform vec3 uLightDirection;
uniform float uDistance;
uniform float uSteps;
uniform float uThickness;
uniform float uStrength;
varying vec2 vUv;

${VIEW_POSITION_GLSL}

void main() {
  float rawDepth = texture2D( tDepth, vUv ).x;
  // 天空：沒有東西就沒有接觸。
  if ( rawDepth >= 1.0 ) {
    gl_FragColor = vec4( 1.0 );
    return;
  }

  vec3 origin = wwViewPositionFromDepth( vUv, rawDepth, uProjectionInverse );
  vec3 normal = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );

  // 往光源走（uLightDirection 是照過來的方向，所以要取負）。
  vec3 toLight = normalize( -uLightDirection );

  // 背光面本來就在陰影裡，追它只是白花步數。
  float facing = dot( normal, toLight );
  if ( facing <= 0.0 ) {
    gl_FragColor = vec4( 1.0 );
    return;
  }

  // 沿著法線推開一點點再開始。不推的話第一步就打到自己，整個畫面變黑 ——
  // 而那看起來像「效果太強」，很容易被誤調成把強度關掉。
  vec3 start = origin + normal * uThickness * 0.5;
  float stepLength = uDistance / uSteps;
  float occlusion = 0.0;

  for ( int i = 1; i <= 32; i++ ) {
    if ( float( i ) > uSteps ) break;
    vec3 samplePoint = start + toLight * ( stepLength * float( i ) );

    vec4 clip = uProjection * vec4( samplePoint, 1.0 );
    if ( clip.w <= 0.0 ) break;
    vec2 sampleUv = ( clip.xy / clip.w ) * 0.5 + 0.5;
    // 畫面外就沒有資料了 —— 這是螢幕空間的本質限制，不是可以補的。
    if ( sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0 ) break;

    float sceneRaw = texture2D( tDepth, sampleUv ).x;
    if ( sceneRaw >= 1.0 ) continue;
    vec3 scenePoint = wwViewPositionFromDepth( sampleUv, sceneRaw, uProjectionInverse );

    // 視空間的 z 是負的，越靠近相機越大。場景比取樣點更靠近相機 = 擋住了。
    float difference = scenePoint.z - samplePoint.z;
    if ( difference > 0.0 && difference < uThickness ) {
      occlusion = 1.0;
      break;
    }
  }

  gl_FragColor = vec4( vec3( 1.0 - occlusion * uStrength ), 1.0 );
}
`;
