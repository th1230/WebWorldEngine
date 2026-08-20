import {
  Color,
  FrontSide,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  ShaderMaterial,
  UnsignedShortType,
  Vector2,
  Vector3,
  DepthTexture,
  WebGLRenderTarget,
} from 'three';
import {
  REFLECTION_PROBE_SAMPLE_GLSL,
  REFLECTION_PROBE_UNIFORMS_GLSL,
} from './reflection-probes.ts';
import type { Camera, Object3D, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import type { ReflectionProbes } from './reflection-probes.ts';
// 只有型別是靜態的 —— 那份 TSL 轉寫是動態載入的，見 `ensureNode`。
import type { WaterSurfaceNodeHandle } from './water-surface-node.ts';
import type { Water } from './water.ts';

/**
 * 水看起來像水的那一半。
 *
 * ## 這裡推翻了 `water.ts` 原本畫的界線
 *
 * `Water` 那個檔案原本寫著「看起來像水（折射、泡沫、次表面）是開發者的材質，
 * 套件不碰」，理由是那與光照同一類。
 *
 * 那條界線畫錯了，而錯的地方很具體：**水的外觀幾乎全部是從這個套件已經算出來
 * 的東西推出來的**。
 *
 * | 外觀上的哪一項 | 它需要什麼 | 誰已經有了 |
 * | --- | --- | --- |
 * | 折射、水色隨深度變 | 水面下有多厚的水 | 場景深度 |
 * | 岸邊的泡沫 | 同一個水深 | 同上 |
 * | 反射天空與環境 | 那個方向的輻射 | 反射探針 |
 * | 波峰的形狀與法線 | 波形 | `Water`，與浮力**同一份** |
 *
 * 交給開發者自己寫的話，他要重新求一次水深、重新接一次探針、而且**重新寫一份
 * 波形**。最後那一項正是 `water.ts` 整個檔案存在要防的事。
 *
 * 所以界線移到這裡：`Water` 仍然只回答「水面多高」（浮力要的），而外觀是一個
 * **用同一個 `Water` 建出來的材質**。兩者不可能分岔，因為位移那段 GLSL 是
 * `water.displacementGLSL()` 產生的同一個字串。
 *
 * ## 用法
 *
 * ```js
 * const water = new WW.Water({ level: 0 });
 * const surface = new WW.WaterSurface({ water, probes });
 * const mesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 200, 200), surface.material);
 * mesh.rotation.x = -Math.PI / 2;
 * scene.add(mesh);
 *
 * // 每幀，畫之前：
 * surface.setTime(clock.getElapsedTime());
 * surface.capture(renderer, scene, camera, mesh);   // 把水**以外**的東西拍進來
 * renderer.render(scene, camera);
 * ```
 *
 * `capture` 要拍的是水以外的場景，所以它會暫時把水藏起來。忘了排除水的話，
 * 折射會取樣到水自己，而症狀是水面上出現一層越疊越糊的鏡像。
 */

export interface WaterSurfaceOptions {
  /** 波形。與浮力用的是**同一個物件**。 */
  water: Water;
  /**
   * 每公尺吸收掉多少光，RGB 各一個。預設 `[0.35, 0.08, 0.045]`。
   *
   * ## 這三個數字的比例才是「水的顏色」
   *
   * 純水對紅光的吸收比藍光高將近一個數量級 —— 那正是為什麼深水是藍綠色，
   * 而不是因為「水是藍色的」。所以水色不該用一個顏色去調，要用**吸收**：
   * 淺處自然接近水底的顏色，深處自然轉藍綠，中間是連續的。
   *
   * 直接塗一個藍色的話，淺水也是藍的 —— 而那是看起來最假的一件事。
   */
  absorption?: readonly [number, number, number];
  /** 水體本身散射出來的顏色（深水最後會收斂到它）。 */
  scatter?: Color;
  /** 折射最多把畫面推開多少，螢幕比例。預設 0.05。 */
  refraction?: number;
  /** 水深小於這個值就開始起泡沫，公尺。預設 1.5。 */
  foamDepth?: number;
  /**
   * 浪頭高過靜水面多少就開始翻白，公尺。預設 0（關掉）。
   *
   * 與岸邊的泡沫是不同的東西：一個是淺水，一個是浪太高。平靜的水面上出現
   * 白沫比沒有白沫更假，所以預設不開 —— 用得到它的是「浪很大」的場景，
   * 而那時作者自己知道。
   */
  crestFoam?: number;
  /** 太陽的方向（從水面指向太陽）與顏色，給鏡面高光用。 */
  sunDirection?: Vector3;
  sunColor?: Color;
  /** 打不到探針時的天空色。 */
  sky?: Color;
  /** 反射強度。0 完全不反射，1 照菲涅耳。預設 1。 */
  reflectivity?: number;
}

/** 建好之後還能改的那些 —— `water` 不在裡面，換波形要換整個 `WaterSurface`。 */
export type WaterSurfaceParams = Omit<WaterSurfaceOptions, 'water'>;

export class WaterSurface {
  readonly material: ShaderMaterial;
  private readonly options: Required<Omit<WaterSurfaceOptions, 'water'>> & { water: Water };
  private target: WebGLRenderTarget | null = null;
  private readonly hidden: Object3D[] = [];
  /**
   * WebGPU 那條路的材質。惰性建立 —— 只用 WebGL 的人不該下載 `three/tsl`。
   *
   * 水與前面幾個效果不同：它是掛在網格上的**材質**，而網格是呼叫端建的。
   * 所以這裡不能等到 render 才換 —— 要有一個明確的「拿 WebGPU 那份材質」。
   */
  private node: WaterSurfaceNodeHandle | null = null;
  private nodePending: Promise<void> | null = null;
  private probes: ReflectionProbes | null = null;

  constructor(options: WaterSurfaceOptions) {
    this.options = {
      water: options.water,
      absorption: options.absorption ?? [0.35, 0.08, 0.045],
      scatter: options.scatter ?? new Color(0x0a2b33),
      refraction: options.refraction ?? 0.05,
      foamDepth: options.foamDepth ?? 1.5,
      crestFoam: options.crestFoam ?? 0,
      sunDirection: options.sunDirection ?? new Vector3(0.4, 0.7, 0.35).normalize(),
      sunColor: options.sunColor ?? new Color(0xffffff),
      sky: options.sky ?? new Color(0x86a8c8),
      reflectivity: options.reflectivity ?? 1,
    };

    this.material = new ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tSceneDepth: { value: null },
        uTime: { value: 0 },
        uNear: { value: 0.1 },
        uFar: { value: 1000 },
        uResolution: { value: new Vector2(1, 1) },
        uAbsorption: { value: new Vector3(...this.options.absorption) },
        uScatter: { value: this.options.scatter },
        uRefraction: { value: this.options.refraction },
        uFoamDepth: { value: this.options.foamDepth },
        uSunDirection: { value: this.options.sunDirection },
        uSunColor: { value: this.options.sunColor },
        uSky: { value: this.options.sky },
        uReflectivity: { value: this.options.reflectivity },
        uHasProbes: { value: 0 },
        uCrestFoam: { value: this.options.crestFoam },
        uWaterLevel: { value: options.water.level },
        uDebug: { value: 0 },
        // 探針那幾個要**現在**就宣告 —— Three 只在第一次編譯時決定要上傳哪些
        // uniform，之後補進去的永遠不會被上傳。反射那邊踩過同一個坑。
        wwReflAtlas: { value: null },
        wwReflMin: { value: new Vector3() },
        wwReflInvSize: { value: new Vector3(1, 1, 1) },
        wwReflResolution: { value: new Vector3(2, 2, 2) },
        wwReflColumns: { value: 1 },
        wwReflStride: { value: 18 },
        wwReflAtlasSize: { value: new Vector3(1, 1, 0) },
        wwReflIntensity: { value: 1 },
      },
      vertexShader: vertexShader(this.options.water),
      fragmentShader: FRAGMENT,
      // 只畫正面。水面的法線一定朝上，而從水底下看是另一套完全不同的物理
      // （全內反射、上方的窗）—— 用 DoubleSide 只會得到一個「法線方向對，
      // 但其餘全錯」的畫面。做不到的事要看得出來沒做。
      side: FrontSide,
    });
  }

  /**
   * 把中間值畫出來。0 是正常，其餘見 `water-surface-node.ts`。兩條路的
   * 號碼**一樣**。
   *
   * ## 為什麼是 setter 而不是普通欄位
   *
   * 其他效果（接觸陰影、追蹤反射、虛擬陰影圖）的 `debugMode` 是普通欄位，
   * 因為它們在**繪製當下**才讀它。這裡不行：`materialFor()` 會回傳材質，
   * 而號碼必須在那之前就進去。
   *
   * 實測踩過 —— `materialFor` 在設定之前被呼叫，於是 WebGPU 那邊的除錯
   * 模式**慢一拍**，跨後端比中間值時比到不同的東西。setter 立刻推給兩條
   * 路，呼叫順序就不再是隱含的相依。
   */
  get debugMode(): number {
    return this.material.uniforms.uDebug!.value as number;
  }

  set debugMode(mode: number) {
    this.material.uniforms.uDebug!.value = mode;
    this.node?.setDebug(mode);
  }

  /**
   * 改參數要走這裡，**不要去戳 `material.uniforms`**。
   *
   * `material` 是 WebGL 那份。WebGPU 上真正在畫的是 node 材質，改 uniform
   * 它一個字都收不到 —— 而症狀是「這個參數在 WebGPU 上沒反應」，看起來像
   * 效果本身壞了。範例場景的折射開關就這樣錯過一輪。
   */
  setParams(changes: Partial<WaterSurfaceParams>): void {
    Object.assign(this.options, changes);
    const u = this.material.uniforms;
    (u.uAbsorption!.value as Vector3).set(...this.options.absorption);
    (u.uScatter!.value as Color).copy(this.options.scatter);
    u.uRefraction!.value = this.options.refraction;
    u.uFoamDepth!.value = this.options.foamDepth;
    u.uCrestFoam!.value = this.options.crestFoam;
    (u.uSunDirection!.value as Vector3).copy(this.options.sunDirection);
    (u.uSunColor!.value as Color).copy(this.options.sunColor);
    (u.uSky!.value as Color).copy(this.options.sky);
    u.uReflectivity!.value = this.options.reflectivity;
    this.node?.setParams({ ...this.options, waterLevel: this.options.water.level });
  }

  setTime(time: number): void {
    this.material.uniforms.uTime!.value = time;
    this.node?.setTime(time);
  }

  /**
   * 拿這個 renderer 該用的材質。
   *
   * WebGL 上就是 `material`；WebGPU 上是 node 那份。
   *
   * **node 那份還沒建好時回 `null`** —— 不能回 `material`：`WebGPURenderer`
   * 拿到 `ShaderMaterial` 會直接丟「Material "ShaderMaterial" is not
   * compatible」，整個場景畫不出來。回 null 的意思是「這一幀先別畫水」，
   * 而那是呼叫端處理得了的。
   *
   * 呼叫端要在每幀把 `mesh.material` 設成它 —— 換材質是便宜的，而「材質
   * 建好了卻沒人換上去」是查不動的。
   */
  materialFor(renderer: unknown): unknown | null {
    if ((renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer !== true) {
      return this.material;
    }
    if (this.node === null) {
      this.nodePending ??= import('./water-surface-node.ts')
        .then((m) => m.createWaterSurfaceNodeMaterial(this.options.water))
        .then((handle) => {
          this.node = handle;
          // node 是**之後**才建好的，所以中間改過的參數要補上 —— 一律
          // 從 `this.options` 重送一次，不要另外記一份「改過什麼」。
          handle.setParams({ ...this.options, waterLevel: this.options.water.level });
          handle.setDebug(this.material.uniforms.uDebug!.value as number);
          handle.setTime(this.material.uniforms.uTime!.value as number);
          handle.setProbes(this.probes);
        })
        .catch((error: unknown) => {
          // **大聲說出來。** 靜靜失敗的症狀是「WebGPU 上這個效果完全沒有」，
          // 而那看起來像場景沒設定好，不像材質建不起來。
          console.error('WW.WaterSurface：node 材質建不起來，WebGPU 上不會有水面。', error);
        });
      return null;
    }
    this.node.setConvention(renderer);
    return this.node.material;
  }

  /** 接上反射探針。不接的話反射用的是 `sky` 那個固定顏色。 */
  setProbes(probes: ReflectionProbes | null): void {
    this.probes = probes;
    this.node?.setProbes(probes);
    const u = this.material.uniforms;
    if (probes === null) {
      u.uHasProbes!.value = 0;
      return;
    }
    const source = probes.uniforms();
    for (const key of Object.keys(source)) {
      const slot = u[key];
      if (slot !== undefined) slot.value = source[key]!.value;
    }
    u.uHasProbes!.value = 1;
  }

  /**
   * 把水**以外**的場景拍進來：顏色給折射用，深度給水深用。
   *
   * @param exclude 水面本身（或任何不該被折射看到的東西）。
   */
  capture(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    exclude: Object3D | readonly Object3D[],
  ): void {
    const size = renderer.getDrawingBufferSize(_size);
    this.ensureTarget(size.x, size.y);

    const list = Array.isArray(exclude) ? exclude : [exclude as Object3D];
    this.hidden.length = 0;
    for (const object of list) {
      if (object.visible) {
        object.visible = false;
        this.hidden.push(object);
      }
    }

    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);

    for (const object of this.hidden) object.visible = true;
    this.hidden.length = 0;

    const u = this.material.uniforms;
    this.node?.setScene(this.target!.texture, this.target!.depthTexture as never);
    const perspectiveCamera = camera as PerspectiveCamera;
    this.node?.setCamera(perspectiveCamera.near ?? 0.1, perspectiveCamera.far ?? 1000);
    u.tScene!.value = this.target!.texture;
    u.tSceneDepth!.value = this.target!.depthTexture;
    u.uResolution!.value = new Vector2(this.target!.width, this.target!.height);
    const perspective = camera as PerspectiveCamera;
    u.uNear!.value = perspective.near ?? 0.1;
    u.uFar!.value = perspective.far ?? 1000;
  }

  /** 折射與水深用的那張圖，除錯時看得到它有沒有拍到東西。 */
  get sceneTexture(): WebGLRenderTarget | null {
    return this.target;
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
  }

  private ensureTarget(width: number, height: number): void {
    if (this.target !== null && this.target.width === width && this.target.height === height)
      return;
    this.target?.dispose();
    // 位元數不是折射取樣誤差的來源 —— 換成 `UnsignedIntType` 重建重測，
    // 水底深度是 440.011 對 440.006，等於沒動。也就是說這個型別根本沒被
    // 採用（16 位元在 440 單位處的量化階距約 30 單位，真的是 16 位元的話
    // 不可能不動）。所以要查折射對不上時，不必再往這裡看。
    const depthTexture = new DepthTexture(width, height, UnsignedShortType);
    this.target = new WebGLRenderTarget(width, height, {
      // 折射拿到的是**還沒做色調映射**的線性顏色，所以與最後畫面對得起來。
      colorSpace: NoColorSpace,
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthTexture,
    });
  }
}

const _size = new Vector2();

/**
 * 頂點：位移用 `water.displacementGLSL()` **產生的同一個字串**，法線從同一支
 * 函式的切線算出來。
 *
 * 法線用位移函式的切線（前向），CPU 那邊的 `normalAt` 用 `heightAt` 的差分
 * （反向）—— 兩者到一階是同一件事。真正必須一致的是**高度**，而那是同一條
 * 式子，不是兩份推導。
 */
function vertexShader(water: Water): string {
  return /* glsl */ `
${water.displacementGLSL('wwWaterDisplace')}

uniform float uTime;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec4 vClipPosition;

void main() {
  vec4 base = modelMatrix * vec4( position, 1.0 );

  // 三個取樣點：自己、+x、+z。差分出兩條切線，叉積就是法線。
  // 步長要與波長比起來夠小、又要大到不被 float 精度吃掉 —— 0.5 公尺在
  // 預設那組波（最短 4 公尺）上是十分之一個波長。
  float step = 0.5;
  vec3 here = wwWaterDisplace( base.xz, uTime );
  vec3 alongX = wwWaterDisplace( base.xz + vec2( step, 0.0 ), uTime );
  vec3 alongZ = wwWaterDisplace( base.xz + vec2( 0.0, step ), uTime );

  vec3 p0 = vec3( base.x + here.x, here.y, base.z + here.z );
  vec3 px = vec3( base.x + step + alongX.x, alongX.y, base.z + alongX.z );
  vec3 pz = vec3( base.x + alongZ.x, alongZ.y, base.z + step + alongZ.z );

  vWorldPosition = p0;
  vWorldNormal = normalize( cross( pz - p0, px - p0 ) );
  // 叉積的方向取決於兩條切線的順序，而水面法線一定朝上。
  if ( vWorldNormal.y < 0.0 ) vWorldNormal = -vWorldNormal;

  vClipPosition = projectionMatrix * viewMatrix * vec4( p0, 1.0 );
  gl_Position = vClipPosition;
}
`;
}

const FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D tScene;
uniform sampler2D tSceneDepth;
uniform float uNear;
uniform float uFar;
uniform vec2 uResolution;
uniform vec3 uAbsorption;
uniform vec3 uScatter;
uniform float uRefraction;
uniform float uFoamDepth;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform float uReflectivity;
uniform float uHasProbes;
uniform float uTime;
uniform float uCrestFoam;
uniform float uWaterLevel;
uniform float uDebug;

${REFLECTION_PROBE_UNIFORMS_GLSL}
${REFLECTION_PROBE_SAMPLE_GLSL}

varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec4 vClipPosition;

/** 深度緩衝的值 → 相機到那一點的距離（正值）。 */
float wwLinearDepth( float rawDepth ) {
  float ndc = rawDepth * 2.0 - 1.0;
  return ( 2.0 * uNear * uFar ) / ( uFar + uNear - ndc * ( uFar - uNear ) );
}

void main() {
  vec2 screenUv = vClipPosition.xy / vClipPosition.w * 0.5 + 0.5;
  vec3 normal = normalize( vWorldNormal );
  vec3 viewDirection = normalize( cameraPosition - vWorldPosition );

  float surfaceDistance = wwLinearDepth( gl_FragCoord.z );

  // ## 折射：把取樣點沿著法線推開
  //
  // 推的量隨距離變小 —— 遠處的水面在畫面上只佔幾個像素，推同樣的螢幕比例
  // 會把整片糊掉。
  vec2 offset = normal.xz * uRefraction / ( 1.0 + surfaceDistance * 0.05 );
  vec2 refractedUv = clamp( screenUv + offset, vec2( 0.0 ), vec2( 1.0 ) );

  // ## 推到「水面前面的東西」上就不推
  //
  // 站在水裡的人、水面上的船 —— 它們比水面近，而把它們的顏色折射進水裡會
  // 讓輪廓在水面上糊開一圈。判準是「取樣到的那一點比水面還近」。
  float refractedDistance = wwLinearDepth( texture2D( tSceneDepth, refractedUv ).x );
  if ( refractedDistance < surfaceDistance ) {
    refractedUv = screenUv;
    refractedDistance = wwLinearDepth( texture2D( tSceneDepth, screenUv ).x );
  }

  vec3 bottom = texture2D( tScene, refractedUv ).rgb;
  // 光在水裡走的路程 —— 吸收算的是這個，不是垂直的水深。
  float travelled = max( refractedDistance - surfaceDistance, 0.0 );

  // ## 水色是**吸收**出來的，不是塗上去的
  //
  // 紅光的吸收係數比藍光高將近一個數量級，所以水越深越藍綠 —— 而淺處自然
  // 就是水底的顏色。塗一個藍色的話淺水也是藍的，那是看起來最假的一件事。
  vec3 transmittance = exp( -uAbsorption * travelled );
  vec3 refracted = bottom * transmittance + uScatter * ( 1.0 - transmittance );

  // ## 反射
  //
  // 打到的方向去問反射探針。水面反射的絕大多數是天空與遠處的環境，而那正是
  // 探針記得最好的東西（螢幕空間找不到、距離場只有低頻）。
  vec3 reflectDirection = reflect( -viewDirection, normal );
  vec3 reflected = uSky;
  if ( uHasProbes > 0.5 ) {
    reflected = wwReflectionAt( vWorldPosition, reflectDirection, uSky );
  }

  // 菲涅耳（Schlick）。水的 F0 是 0.02 —— 正對著看幾乎全透，掠射角幾乎全反射。
  // 那個對比是「水」這個材質最強的辨識特徵。
  float cosTheta = clamp( dot( normal, viewDirection ), 0.0, 1.0 );
  float fresnel = 0.02 + 0.98 * pow( 1.0 - cosTheta, 5.0 );
  fresnel *= uReflectivity;

  vec3 color = mix( refracted, reflected, fresnel );

  // ## 岸邊的泡沫
  //
  // 判準是**水很淺**（光走的路程很短），而不是「靠近某條線」—— 後者要作者
  // 標出海岸線，而海岸線是地形決定的。水深自己就知道岸在哪。
  float foam = 1.0 - smoothstep( 0.0, uFoamDepth, travelled );
  // ## 浪頭的白沫
  //
  // 與岸邊的泡沫是**不同的東西**：一個是淺水，一個是浪太高自己翻白。所以
  // 兩者相加而不是相乘 —— 深水的浪頭一樣會白。
  //
  // 判準是「比靜水面高出多少」。預設門檻高到不會發生（crestFoam 給 0 就
  // 完全關掉）：白沫只在夠大的浪上出現，平靜的水面上出現白沫比沒有白沫
  // 更假。
  float crest = uCrestFoam > 0.0
    ? smoothstep( uCrestFoam, uCrestFoam * 1.6, vWorldPosition.y - uWaterLevel )
    : 0.0;
  foam = clamp( foam + crest, 0.0, 1.0 );
  color = mix( color, vec3( 1.0 ), foam * 0.85 );

  // 太陽的高光。Blinn-Phong —— 水面的高光是一個很銳利的亮點，指數要大。
  vec3 halfway = normalize( uSunDirection + viewDirection );
  float specular = pow( max( dot( normal, halfway ), 0.0 ), 200.0 );
  color += uSunColor * specular * ( 1.0 - foam );

  // ## 中間值印成畫面
  //
  // 水看起來不對的時候，從外面只看得到「顏色怪怪的」。而怪的原因可能在
  // 水深、在折射的取樣點、在菲涅耳、在法線 —— 猜是猜不出來的。
  //
  // 第 1 路輸出的是**世界座標**（要 float 的 render target）。那一路可以
  // 直接跟 CPU 的 heightAt 對答案 —— 而「畫出來的水面就是浮力用的水面」
  // 正是整個 water.ts 存在的理由。
  if ( uDebug > 0.5 ) {
    if ( uDebug < 1.5 ) { gl_FragColor = vec4( vWorldPosition, 1.0 ); return; }
    if ( uDebug < 2.5 ) { gl_FragColor = vec4( vec3( travelled ), 1.0 ); return; }
    if ( uDebug < 3.5 ) { gl_FragColor = vec4( vec3( foam ), 1.0 ); return; }
    if ( uDebug < 4.5 ) { gl_FragColor = vec4( vec3( fresnel ), 1.0 ); return; }
    if ( uDebug < 5.5 ) { gl_FragColor = vec4( normal * 0.5 + 0.5, 1.0 ); return; }
    if ( uDebug < 6.5 ) { gl_FragColor = vec4( refracted, 1.0 ); return; }
    if ( uDebug < 7.5 ) { gl_FragColor = vec4( reflected, 1.0 ); return; }
    // 8/9：被相減的那兩個量。travelled 對不上的時候要知道是哪一個。
    if ( uDebug < 8.5 ) { gl_FragColor = vec4( vec3( surfaceDistance ), 1.0 ); return; }
    if ( uDebug < 9.5 ) { gl_FragColor = vec4( vec3( refractedDistance ), 1.0 ); return; }
    // 10：折射真正推了多遠。水底深度對不上的時候，第一個要問的是
    // 「兩邊有沒有取樣到同一個點」—— 而那只有這個量答得出來。
    if ( uDebug < 10.5 ) { gl_FragColor = vec4( refractedUv - screenUv, 0.0, 1.0 ); return; }
  }

  gl_FragColor = vec4( color, 1.0 );
}
`;
