import {
  DepthTexture,
  FloatType,
  MeshDepthMaterial,
  NearestFilter,
  NoColorSpace,
  OrthographicCamera,
  RGBADepthPacking,
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { Color } from 'three';
import { PageTable, type VirtualTextureLayout } from '@webworld/format';
import { Matrix4, ShaderMaterial } from 'three';
import { drawFullscreen, FULLSCREEN_VERTEX, VIEW_POSITION_GLSL } from './fullscreen.ts';
import type { Camera, PerspectiveCamera, Scene, Texture, WebGLRenderer } from 'three';
import type { SceneDepthNormals } from './depth-normals.ts';

/**
 * 虛擬陰影圖：假裝很大的陰影圖，實際只配置得下的那一張。
 *
 * ## 它解的問題與 CSM 不一樣
 *
 * CSM 是把視錐切成幾段、每段一張 map。切得再細，**每一段內部**還是「一張
 * map 罩住一整段」——所以近處的陰影解析度仍然被那一段的範圍除掉。
 *
 * 虛擬陰影圖換一個做法：陰影圖在概念上是 16,384²，但只有**畫面上真的看得到
 * 的那幾塊**被畫出來。看不到的地方一個 texel 都不花。
 *
 * 那正好是虛擬貼圖的機制 —— 而那個機制上一輪已經做好了。這裡直接用同一個
 * `PageTable`（頁表、回退鏈、預算、釘住最粗階全部一樣），差別只有一件事：
 *
 * | | 虛擬貼圖 | 虛擬陰影圖 |
 * | --- | --- | --- |
 * | 頁的內容從哪來 | 呼叫端給的像素 | **當場畫出來的深度** |
 *
 * ## 為什麼一頁一頁畫是可行的
 *
 * 一頁就是把光源的正交視錐切出一小塊，然後只畫那一塊。每頁一次繪製聽起來
 * 很多，但**只有新進來的頁要畫** —— 相機不動時是零。與全域距離場的分幀重算
 * 是同一個判斷。
 *
 * ## 回退鏈讓「還沒畫好」是安全的
 *
 * 頁表保證每一格都指得到某個祖先（最粗那一階是釘住的）。所以還沒畫到的地方
 * 拿到的是**比較粗的陰影**，不是破洞。糊是可以接受的失敗形態，破洞不是 ——
 * 這條與虛擬貼圖是同一句話。
 */

export interface VirtualShadowMapOptions extends VirtualTextureLayout {
  /** 光源覆蓋的世界範圍（正交視錐的邊長）。預設 400。 */
  extent?: number;
  /** 光源視錐的深度範圍。預設 800。 */
  depth?: number;
  /** 一幀最多畫幾頁。預設 8 —— 與所有其他預算同一個道理。 */
  budget?: number;
}

export class VirtualShadowMap {
  readonly table: PageTable;
  /** 深度圖集。真正配置的那一張。 */
  readonly atlas: WebGLRenderTarget;
  /** 頁表。NEAREST，不可以改成 LINEAR。 */
  readonly indirection: DataTexture;
  readonly extent: number;
  readonly depth: number;

  /** 診斷：畫了幾頁。相機不動時應該停住。 */
  pagesDrawn = 0;
  private rootDrawn = false;
  /** 除錯用：1 = 輸出光源空間 UV 與深度，−1 = 輸出圖集裡存的深度。 */
  debugMode = 0;

  private readonly camera = new OrthographicCamera();
  private readonly budget: number;
  private readonly depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  private readonly lightDirection = new Vector3(0, -1, 0);
  private readonly centre = new Vector3();
  /** 整份視錐（不是單頁）的視圖矩陣 —— 著色端要用它把世界座標換到光源空間。 */
  private readonly lightView = new Matrix4();
  private resolveTarget: WebGLRenderTarget | null = null;
  private resolveMaterial: ShaderMaterial | null = null;
  private readonly projectionInverse = new Matrix4();

  constructor(options: VirtualShadowMapOptions) {
    this.table = new PageTable(options);
    this.extent = options.extent ?? 400;
    this.depth = options.depth ?? 800;
    this.budget = Math.max(1, Math.floor(options.budget ?? 8));

    const atlasSize = this.table.pageSize * this.table.atlasPages;
    // ## 深度存成 RGBA 打包，不是深度貼圖
    //
    // 一張圖集裡塞很多頁，而每頁要能單獨清除與繪製。用真正的 depth attachment
    // 的話清除是整張的 —— 逐頁清會把別頁也清掉。打包成顏色就可以用 scissor
    // 只清一小塊。
    this.atlas = new WebGLRenderTarget(atlasSize, atlasSize, {
      format: RGBAFormat,
      type: UnsignedByteType,
      colorSpace: NoColorSpace,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthTexture: new DepthTexture(atlasSize, atlasSize, FloatType),
    });

    const table = new DataTexture(
      this.table.indirection,
      this.table.pagesPerSide,
      this.table.pagesPerSide,
      RGBAFormat,
      UnsignedByteType,
    );
    // 與虛擬貼圖同一句話：內插兩個頁位址會得到第三個不存在的位址。
    table.minFilter = NearestFilter;
    table.magFilter = NearestFilter;
    table.generateMipmaps = false;
    table.needsUpdate = true;
    this.indirection = table;
  }

  /** 假裝出來的解析度。超過 `maxTextureSize` 就是這東西的存在理由。 */
  get virtualSize(): number {
    return this.table.pageSize * this.table.pagesPerSide;
  }

  /** 真正配置的那一張有多大。 */
  get atlasSize(): number {
    return this.table.pageSize * this.table.atlasPages;
  }

  /**
   * 設定光源的方向與中心。
   *
   * @param direction 光**照過來**的方向。
   * @param centre 光源視錐的中心，通常跟著相機走。
   */
  setLight(direction: Vector3, centre: Vector3): void {
    this.lightDirection.copy(direction).normalize();
    this.centre.copy(centre);
    // 整份視錐的視圖矩陣。逐頁的相機只是在光源平面上平移，方向與 near/far
    // 都一樣 —— 所以**存進圖集的深度是跨頁可比的**，而那正是這個做法成立
    // 的前提。不一樣的話每頁的陰影會各自偏一點，接縫處出現一格一格的錯位。
    const full = _fullCamera;
    full.position.copy(this.centre).addScaledVector(this.lightDirection, -this.depth / 2);
    full.up.set(0, 1, 0);
    if (Math.abs(this.lightDirection.y) > 0.999) full.up.set(0, 0, 1);
    full.lookAt(this.centre);
    full.updateMatrixWorld(true);
    this.lightView.copy(full.matrixWorld).invert();
  }

  /**
   * 世界座標在光源空間的 UV。
   *
   * **不可以拿世界的 x/z 當 UV。** 光源平面是斜的（除非光正好垂直向下），
   * 所以那樣算出來的區域會整個歪掉 —— 而症狀是「要了一堆頁，但要的不是
   * 看得到的那一塊」，畫面上完全看不出原因。實測踩過。
   */
  worldToUv(point: Vector3, target = { u: 0, v: 0 }): { u: number; v: number } {
    const local = _uvLocal.copy(point).applyMatrix4(this.lightView);
    target.u = local.x / this.extent + 0.5;
    target.v = local.y / this.extent + 0.5;
    return target;
  }

  /** 登記某一塊 UV 區域（光源空間）在某個階數要用到。 */
  requestRegion(u0: number, v0: number, u1: number, v1: number, level: number): void {
    const side = Math.max(1, this.table.pagesPerSide >> level);
    const x0 = Math.max(0, Math.floor(Math.min(u0, u1) * side));
    const x1 = Math.min(side - 1, Math.floor(Math.max(u0, u1) * side));
    const y0 = Math.max(0, Math.floor(Math.min(v0, v1) * side));
    const y1 = Math.min(side - 1, Math.floor(Math.max(v0, v1) * side));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) this.table.request(level, x, y);
    }
  }

  /**
   * 把這一輪要到的頁畫出來，一次最多 `budget` 頁。
   *
   * @returns 這一次畫了幾頁。相機不動時應該是 0。
   */
  update(renderer: WebGLRenderer, scene: Scene): number {
    const loads = this.table.commit(this.budget);
    // ## 釘住的那一頁要**自己補上**
    //
    // 頁表在建構時就把最粗那一階標成住著的（它是回退鏈的底），但 `commit()`
    // 只回報**新加進去**的頁 —— 所以它永遠不會被畫。
    //
    // 症狀是還沒細到的地方讀到 0（= 無限近），整片變成陰影。虛擬貼圖那邊
    // 踩過**一模一樣**的坑（那次是整片變黑），而我沒有把教訓帶過來。
    if (!this.rootDrawn) {
      this.rootDrawn = true;
      loads.unshift({
        level: this.table.levels - 1,
        px: 0,
        py: 0,
        slotX: this.table.rootSlot.slotX,
        slotY: this.table.rootSlot.slotY,
      });
    }
    if (loads.length === 0) {
      this.indirection.needsUpdate = true;
      return 0;
    }

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;
    const previousScissorTest = renderer.getScissorTest();
    scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.atlas);
    renderer.setScissorTest(true);
    // ## 頁要清成白的，不是黑的
    //
    // 深度是打包成顏色的，而黑色解回來是 **0**，也就是「無限近」。沒有
    // 東西的地方因此變成「有東西擋在最前面」—— 整個畫面都在陰影裡。
    //
    // 實測踩過：遮罩 100% 全暗，而每一個中間值（畫了幾頁、頁表、大小）
    // 看起來都對。Three 自己的 shadow map 也是清成白的，同一個理由。
    renderer.getClearColor(_previousClear);
    const previousAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0xffffff, 1);

    const pageSize = this.table.pageSize;
    for (const load of loads) {
      this.aimAt(load.level, load.px, load.py);
      const x = load.slotX * pageSize;
      const y = load.slotY * pageSize;
      renderer.setViewport(x, y, pageSize, pageSize);
      renderer.setScissor(x, y, pageSize, pageSize);
      // 只清這一格 —— 整張清會把別頁清掉，而那是「陰影閃爍」的典型原因。
      renderer.clear(true, true, false);
      renderer.render(scene, this.camera);
      this.pagesDrawn++;
    }

    renderer.setClearColor(_previousClear, previousAlpha);
    renderer.setScissorTest(previousScissorTest);
    renderer.setViewport(0, 0, this.atlas.width, this.atlas.height);
    renderer.setScissor(0, 0, this.atlas.width, this.atlas.height);
    renderer.setRenderTarget(previousTarget);
    scene.overrideMaterial = previousOverride;
    this.indirection.needsUpdate = true;
    return loads.length;
  }

  /**
   * 把這一幀的陰影解出來：一張遮罩，1 = 被照到，0 = 在陰影裡。
   *
   * 走的是與接觸陰影、距離場陰影同一個形狀 —— 吃共用的深度法線，輸出一張
   * 遮罩讓呼叫端自己合成。
   */
  resolve(renderer: WebGLRenderer, camera: Camera, gbuffer: SceneDepthNormals): Texture | null {
    const depth = gbuffer.depthTexture;
    const normal = gbuffer.normalTexture;
    if (depth === null || normal === null) return null;
    gbuffer.isFresh(renderer);

    const material = this.ensureResolveMaterial();
    this.ensureResolveTarget(gbuffer.width, gbuffer.height);

    const perspective = camera as PerspectiveCamera;
    const u = material.uniforms;
    u.tDepth!.value = depth;
    u.tNormal!.value = normal;
    u.tShadow!.value = this.atlas.texture;
    u.tTable!.value = this.indirection;
    this.projectionInverse.copy(perspective.projectionMatrix).invert();
    u.uProjectionInverse!.value = this.projectionInverse;
    u.uCameraMatrix!.value = camera.matrixWorld;
    u.uLightView!.value = this.lightView;
    u.uLightDirection!.value = this.lightDirection;
    u.uExtent!.value = this.extent;
    u.uDepthRange!.value = this.depth;
    u.uPagesPerSide!.value = this.table.pagesPerSide;
    u.uAtlasPages!.value = this.table.atlasPages;
    u.uPageSize!.value = this.table.pageSize;
    u.uDebug!.value = this.debugMode;

    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.resolveTarget);
    renderer.clear(true, false, false);
    drawFullscreen(renderer, material);
    renderer.setRenderTarget(previous);
    return this.resolveTarget!.texture;
  }

  private ensureResolveMaterial(): ShaderMaterial {
    if (this.resolveMaterial !== null) return this.resolveMaterial;
    this.resolveMaterial = new ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        tNormal: { value: null },
        tShadow: { value: null },
        tTable: { value: null },
        uProjectionInverse: { value: new Matrix4() },
        uCameraMatrix: { value: new Matrix4() },
        uLightView: { value: new Matrix4() },
        uLightDirection: { value: new Vector3() },
        uExtent: { value: 1 },
        uDepthRange: { value: 1 },
        uPagesPerSide: { value: 1 },
        uAtlasPages: { value: 1 },
        uPageSize: { value: 1 },
        uDebug: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: RESOLVE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    return this.resolveMaterial;
  }

  private ensureResolveTarget(width: number, height: number): void {
    if (this.resolveTarget !== null && this.resolveTarget.width === width && this.resolveTarget.height === height) {
      return;
    }
    this.resolveTarget?.dispose();
    this.resolveTarget = new WebGLRenderTarget(width, height, { colorSpace: NoColorSpace, depthBuffer: false });
  }

  /**
   * 把正交相機對準某一頁蓋住的那一小塊。
   *
   * 一頁在第 `level` 階蓋住 `extent / (pagesPerSide >> level)` 那麼寬的世界。
   */
  private aimAt(level: number, px: number, py: number): void {
    const side = Math.max(1, this.table.pagesPerSide >> level);
    const pageExtent = this.extent / side;
    const halfExtent = this.extent / 2;

    // 這一頁在光源平面上的中心（以整份視錐的中心為原點）。
    const offsetU = -halfExtent + (px + 0.5) * pageExtent;
    const offsetV = -halfExtent + (py + 0.5) * pageExtent;

    const camera = this.camera;
    camera.left = -pageExtent / 2;
    camera.right = pageExtent / 2;
    camera.top = pageExtent / 2;
    camera.bottom = -pageExtent / 2;
    camera.near = 0;
    camera.far = this.depth;

    // 相機擺在光源那一側，看向中心。
    camera.position.copy(this.centre).addScaledVector(this.lightDirection, -this.depth / 2);
    camera.up.set(0, 1, 0);
    // 光幾乎垂直向下時 up 與方向共線，lookAt 會退化成 NaN —— 換一個 up。
    if (Math.abs(this.lightDirection.y) > 0.999) camera.up.set(0, 0, 1);
    camera.lookAt(this.centre);
    camera.updateMatrixWorld(true);

    // 在光源的平面上平移到這一頁 —— 用相機自己的右／上軸，才不必自己推導。
    const right = _right.setFromMatrixColumn(camera.matrixWorld, 0);
    const up = _up.setFromMatrixColumn(camera.matrixWorld, 1);
    camera.position.addScaledVector(right, offsetU).addScaledVector(up, offsetV);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.resolveTarget?.dispose();
    this.resolveMaterial?.dispose();
    this.atlas.dispose();
    this.indirection.dispose();
    this.depthMaterial.dispose();
  }
}

const _uvLocal = new Vector3();
const _previousClear = new Color();
const _fullCamera = new OrthographicCamera();
const _right = new Vector3();
const _up = new Vector3();

/**
 * 解陰影的著色器。
 *
 * ## 深度是打包成 RGBA 的
 *
 * 圖集裡每頁要能單獨清除，所以深度存成顏色（`RGBADepthPacking`）而不是真正
 * 的 depth attachment。解開來就是 Three 的 `unpackRGBAToDepth` 那一段 ——
 * 這裡逐字照抄，因為寫錯的話深度會差一個尺度，而症狀是「整片都在陰影裡」或
 * 「完全沒有陰影」，兩個都看起來像功能沒接上。
 *
 * ## 偏移是照**光源空間的 texel** 算的
 *
 * 陰影痤瘡（自己遮自己）的偏移要跟一個 texel 的世界大小成比例。虛擬陰影圖的
 * texel 很小，所以偏移也該很小 —— 沿用一般 shadow map 的偏移會把接觸的地方
 * 整個推開，那正是這個東西要解掉的問題。
 */
const RESOLVE_FRAGMENT = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tShadow;
uniform sampler2D tTable;
uniform mat4 uProjectionInverse;
uniform mat4 uCameraMatrix;
uniform mat4 uLightView;
uniform vec3 uLightDirection;
uniform float uExtent;
uniform float uDepthRange;
uniform float uPagesPerSide;
uniform float uAtlasPages;
uniform float uPageSize;
uniform float uDebug;
varying vec2 vUv;

${VIEW_POSITION_GLSL}

/** 與 Three 的 unpackRGBAToDepth 逐字相同。 */
float wwUnpackDepth( vec4 packed ) {
  return dot( packed, vec4( 1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0 ) );
}

void main() {
  float rawDepth = texture2D( tDepth, vUv ).x;
  if ( rawDepth >= 1.0 ) {
    gl_FragColor = vec4( 1.0 );
    return;
  }

  vec3 viewPosition = wwViewPositionFromDepth( vUv, rawDepth, uProjectionInverse );
  vec3 worldPosition = ( uCameraMatrix * vec4( viewPosition, 1.0 ) ).xyz;
  vec3 viewNormal = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );
  vec3 worldNormal = normalize( mat3( uCameraMatrix ) * viewNormal );

  vec3 toLight = normalize( -uLightDirection );
  float facing = dot( worldNormal, toLight );
  // 背光面本來就是暗的，不必問陰影圖 —— 而且問了反而會拿到自己的深度。
  if ( facing <= 0.0 ) {
    gl_FragColor = vec4( 0.0, 0.0, 0.0, 1.0 );
    return;
  }

  // 換到光源空間：x/y 是平面上的位置，−z 是沿著光走了多遠。
  vec3 lightSpace = ( uLightView * vec4( worldPosition, 1.0 ) ).xyz;
  vec2 uv = lightSpace.xy / uExtent + 0.5;
  if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) {
    // 光源視錐外面沒有資料 —— 當成照得到，不是當成陰影。
    gl_FragColor = vec4( 1.0 );
    return;
  }
  float depth = -lightSpace.z / uDepthRange;

  // 頁表：這一格該去圖集哪裡拿，以及它是第幾階。
  vec4 entry = texture2D( tTable, uv );
  vec2 slot = floor( entry.xy * 255.0 + 0.5 );
  float level = floor( entry.z * 255.0 + 0.5 );

  float span = exp2( level );
  vec2 pageUv = fract( uv * uPagesPerSide / span );
  vec2 atlasUv = ( slot + pageUv ) / uAtlasPages;

  float stored = wwUnpackDepth( texture2D( tShadow, atlasUv ) );

  // ## 偏移就是一個 texel 的深度差，沒有別的項
  //
  // 一個 texel 的世界大小 = 這一階一頁蓋多少世界 ÷ 一頁幾個 texel。
  //
  // 中間一度加了斜度項與一個常數，因為畫面整片變黑 —— 但那**不是痤瘡**，
  // 是相機瞄到影子正中間（整個視野都在影子裡，本來就該全黑）。瞄準修好
  // 之後量了四種寫法，邊界的平滑度是：
  //
  // | 偏移 | 邊界落在幾個不同位置（越多越平滑） |
  // | --- | ---: |
  // | 只有 texel | **30** |
  // | texel × 斜度 | 22 |
  // | texel × 斜度 + 常數 | 22 |
  // | 只有常數 | 14 |
  //
  // 多的每一項都只是把邊界推糊。**加東西之前要先確定症狀的原因**。
  float texelWorld = ( uExtent * span ) / ( uPagesPerSide * uPageSize );
  float bias = ( texelWorld * 2.0 ) / uDepthRange;
  float lit = depth - bias <= stored ? 1.0 : 0.0;
  if ( uDebug > 2.5 ) { float d = ( stored - depth ) * 20.0 + 0.5; gl_FragColor = vec4( d, d, d, 1.0 ); return; }
  if ( uDebug > 1.5 ) { gl_FragColor = vec4( entry.xy, level / 32.0, 1.0 ); return; }
  if ( uDebug < -1.5 ) { gl_FragColor = vec4( atlasUv, 0.0, 1.0 ); return; }
  if ( uDebug > 0.5 ) { gl_FragColor = vec4( uv, depth, 1.0 ); return; }
  if ( uDebug < -0.5 ) { gl_FragColor = vec4( stored, stored, stored, 1.0 ); return; }
  gl_FragColor = vec4( vec3( lit ), 1.0 );
}
`;
