import { Matrix4, NoColorSpace, ShaderMaterial, Vector3, WebGLRenderTarget } from 'three';
import { drawFullscreen, FULLSCREEN_VERTEX, VIEW_POSITION_GLSL } from './fullscreen.ts';
// 只有型別是靜態的 —— 那份 TSL 轉寫是動態載入的，見 `renderNode`。
import type { DistanceFieldShadowsNodeHandle } from './distance-field-shadows-node.ts';
import type { Camera, PerspectiveCamera, Texture, WebGLRenderer } from 'three';
import type { SceneDepthNormals } from './depth-normals.ts';
import type { GlobalDistanceField } from './global-distance-field.ts';

/**
 * 距離場陰影：shadow map 在**遠處**撐不住的那一段。
 *
 * ## 三層陰影，各管一段尺度
 *
 * | | 管哪一段 | 為什麼別人管不了 |
 * | --- | --- | --- |
 * | `ContactShadows` | 幾公分 | shadow map 的一個 texel 就好幾公分 |
 * | CSM（`applyShadows`） | 幾十公尺 | |
 * | **這裡** | 幾百公尺以外 | 級聯再切下去解析度已經沒有意義 |
 *
 * CSM 是把視錐切成幾段、每段一張 map。切到最遠那一段時，一張 map 要罩住
 * 好幾百公尺 —— 每個 texel 對應到公尺級，遠山的陰影糊成一團色塊。再多切幾段
 * 的話近處那幾張的預算就被吃掉了。
 *
 * 距離場沒有這個問題，因為它**不是投影出來的**：它是一個三維的場，查詢的
 * 成本與距離無關。遠處的陰影因此與近處一樣「準」——準到場的解析度為止。
 *
 * ## 而它順便解掉螢幕外
 *
 * shadow map 要把投射陰影的東西畫進去，所以那些東西必須在光的視錐裡。
 * 距離場裡的東西**本來就都在場裡**，鏡頭轉開不影響。
 *
 * ## 軟陰影是免費的
 *
 * 球體追蹤每一步都知道「離最近的表面多遠」。那個距離與已走的路程之比就是
 * 圓錐張角的近似 —— 擦邊而過的射線給出半影，正中的給出全影。
 *
 * shadow map 要做到同一件事得多取樣好幾次（PCF／PCSS）。這裡是**追蹤本來就
 * 會算出來的副產品**，不加成本。
 *
 * ## 限制要講清楚
 *
 * 場是低頻的（一格 `extent / resolution`）。比一格還小的東西在場裡幾乎不存在，
 * 所以它們**不投射這種陰影** —— 那些交給 CSM 與接觸陰影。
 *
 * 三層各管一段是刻意的，不是還沒統一。
 */

export interface DistanceFieldShadowsOptions {
  /**
   * 追多遠，世界單位。預設用場的一半。
   *
   * 這是「多遠以內的東西會擋光」。與場的 `extent` 綁在一起 —— 超過場的範圍
   * 就沒有資料了，追過去只是白花步數。
   */
  range?: number;
  /** 幾步。預設 48。球體追蹤是自適應的，所以這是上限不是實際步數。 */
  steps?: number;
  /**
   * 半影的柔和度。預設 8。
   *
   * 越小越柔（半影越寬）。這是圓錐張角的倒數，物理上對應光源的角直徑 ——
   * 太陽約 0.5 度，所以真實的值很大（100 以上）。預設值刻意柔一點，因為
   * 場是低頻的，硬邊會把場的格子暴露出來。
   */
  softness?: number;
  /** 陰影多深，0–1。預設 1。 */
  strength?: number;
}

export class DistanceFieldShadows {
  private readonly options: Required<DistanceFieldShadowsOptions>;
  private target: WebGLRenderTarget | null = null;
  private readonly material: ShaderMaterial;
  /** WebGPU 那條路的材質。惰性建立 —— 只用 WebGL 的人不該下載 `three/tsl`。 */
  private node: DistanceFieldShadowsNodeHandle | null = null;
  private nodePending: Promise<void> | null = null;
  private readonly projectionInverse = new Matrix4();

  constructor(options: DistanceFieldShadowsOptions = {}) {
    this.options = {
      range: options.range ?? 0,
      steps: options.steps ?? 48,
      softness: options.softness ?? 8,
      strength: options.strength ?? 1,
    };

    this.material = new ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        tNormal: { value: null },
        tField: { value: null },
        uProjectionInverse: { value: new Matrix4() },
        uCameraMatrix: { value: new Matrix4() },
        uFieldMin: { value: new Vector3() },
        uFieldExtent: { value: 1 },
        uCell: { value: 1 },
        uLightDirection: { value: new Vector3(0, -1, 0) },
        uRange: { value: 1 },
        uSteps: { value: this.options.steps },
        uSoftness: { value: this.options.softness },
        uStrength: { value: this.options.strength },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * 算這一幀的距離場陰影。
   *
   * @param lightDirection 光**照過來**的方向（從光源指向場景），世界座標。
   * @returns 遮蔽貼圖。1 = 沒被擋，0 = 全擋。
   */
  render(
    renderer: WebGLRenderer,
    camera: Camera,
    gbuffer: SceneDepthNormals,
    field: GlobalDistanceField,
    lightDirection: Vector3,
  ): Texture | null {
    const depth = gbuffer.depthTexture;
    const normal = gbuffer.normalTexture;
    if (depth === null || normal === null) return null;
    gbuffer.isFresh(renderer);

    this.ensureTarget(gbuffer.width, gbuffer.height);

    // WebGPU 不吃 ShaderMaterial，走 node 那份。兩份的一致性由跨後端關卡守。
    if ((renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true) {
      return this.renderNode(renderer, camera, depth, normal, field, lightDirection);
    }

    const perspective = camera as PerspectiveCamera;
    const uniforms = this.material.uniforms;
    uniforms.tDepth!.value = depth;
    uniforms.tNormal!.value = normal;
    uniforms.tField!.value = field.texture;
    this.projectionInverse.copy(perspective.projectionMatrix).invert();
    uniforms.uProjectionInverse!.value = this.projectionInverse;
    // 追蹤在**世界**空間做（場是世界對齊的），所以要把視空間的位置換回去。
    uniforms.uCameraMatrix!.value = camera.matrixWorld;
    uniforms.uFieldMin!.value = field.min;
    uniforms.uFieldExtent!.value = field.extent;
    uniforms.uCell!.value = field.extent / field.resolution;
    uniforms.uLightDirection!.value = lightDirection;
    uniforms.uRange!.value = this.options.range > 0 ? this.options.range : field.extent * 0.5;
    uniforms.uSteps!.value = this.options.steps;
    uniforms.uSoftness!.value = this.options.softness;
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
   */
  private renderNode(
    renderer: WebGLRenderer,
    camera: Camera,
    depth: Texture,
    normal: Texture,
    field: GlobalDistanceField,
    lightDirection: Vector3,
  ): Texture | null {
    if (this.node === null) {
      this.nodePending ??= import('./distance-field-shadows-node.ts')
        .then((m) => m.createDistanceFieldShadowsNodeMaterial())
        .then((handle) => {
          this.node = handle;
        })
        .catch((error: unknown) => {
          // **大聲說出來。** 靜靜失敗的症狀是「WebGPU 上這個效果完全沒有」，
          // 而那看起來像場景沒設定好，不像材質建不起來。
          console.error('WW.DistanceFieldShadows：node 材質建不起來，WebGPU 上不會有距離場陰影。', error);
        });
      return null;
    }
    this.projectionInverse.copy((camera as { projectionMatrix: Matrix4 }).projectionMatrix).invert();
    this.node.setTextures(depth, normal, field.texture);
    this.node.setMatrices(this.projectionInverse, camera.matrixWorld);
    this.node.setField(field.min, field.extent, field.extent / field.resolution);
    this.node.setLight(lightDirection);
    this.node.setParams({
      range: this.options.range > 0 ? this.options.range : field.extent * 0.5,
      steps: this.options.steps,
      softness: this.options.softness,
      strength: this.options.strength,
    });
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
    // 八位元：這是遮蔽遮罩，而且讀得回來（見 ContactShadows 的同一段）。
    this.target = new WebGLRenderTarget(width, height, { colorSpace: NoColorSpace, depthBuffer: false });
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
  }
}

const FRAGMENT = /* glsl */ `
precision highp sampler3D;

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler3D tField;
uniform mat4 uProjectionInverse;
uniform mat4 uCameraMatrix;
uniform vec3 uFieldMin;
uniform float uFieldExtent;
uniform float uCell;
uniform vec3 uLightDirection;
uniform float uRange;
uniform float uSteps;
uniform float uSoftness;
uniform float uStrength;
varying vec2 vUv;

${VIEW_POSITION_GLSL}

/** 查一點的距離。場外面回一個大的正值 —— 場外沒有資料，不是「有東西」。 */
float fieldAt( vec3 worldPoint ) {
  vec3 uvw = ( worldPoint - uFieldMin ) / uFieldExtent;
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) {
    return uFieldExtent;
  }
  return texture( tField, uvw ).r;
}

void main() {
  float rawDepth = texture2D( tDepth, vUv ).x;
  if ( rawDepth >= 1.0 ) {
    gl_FragColor = vec4( 1.0 );
    return;
  }

  vec3 viewPosition = wwViewPositionFromDepth( vUv, rawDepth, uProjectionInverse );
  vec3 worldPosition = ( uCameraMatrix * vec4( viewPosition, 1.0 ) ).xyz;

  // 法線在視空間，換回世界才能與光比對。方向的變換不含平移，所以取 3×3。
  vec3 viewNormal = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );
  vec3 worldNormal = normalize( mat3( uCameraMatrix ) * viewNormal );

  vec3 toLight = normalize( -uLightDirection );
  float facing = dot( worldNormal, toLight );
  // 背光面本來就在陰影裡。追它不只白花，還會因為起點在表面上而全黑。
  if ( facing <= 0.0 ) {
    gl_FragColor = vec4( 1.0 );
    return;
  }

  // 沿著法線推開一格再開始。場是低頻的，起點太靠近表面會查到自己。
  vec3 point = worldPosition + worldNormal * uCell;
  float travelled = uCell;
  float closest = 1.0;

  for ( int i = 0; i < 128; i++ ) {
    if ( float( i ) >= uSteps || travelled >= uRange ) break;
    float distance = fieldAt( point );
    // 進到表面裡面了 —— 全影。
    if ( distance < uCell * 0.25 ) {
      closest = 0.0;
      break;
    }
    // 圓錐追蹤的半影：距離與已走路程之比越小，擦得越近。
    closest = min( closest, uSoftness * distance / travelled );
    point += toLight * distance;
    travelled += distance;
  }

  float shadow = clamp( closest, 0.0, 1.0 );
  gl_FragColor = vec4( vec3( 1.0 - ( 1.0 - shadow ) * uStrength ), 1.0 );
}
`;
