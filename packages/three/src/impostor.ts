import {
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh as ThreeInstancedMesh,
  LinearFilter,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { Camera, Material, Object3D, Texture, WebGLRenderer } from 'three';

/**
 * Impostor：把一個物件烘成一圈方向的圖，遠處用兩個三角形代替它。
 *
 * ## 為什麼要重新問這件事
 *
 * roadmap 上曾經量過一次「幾何那一側還剩多少」，結論是**沒剩多少**：把三角形
 * 砍掉四到七成，GPU 時間在 −11% 到 +12.8% 之間亂跳，符號還會翻面。
 *
 * 但那個量測是**代理**——它用「把選階壓到最粗」去逼近 impostor，而最粗階
 * 還有幾十個三角形，impostor 是兩個。代理與真東西之間差了一個數量級，而
 * 那次量測自己的符號翻面已經說了它落在雜訊裡。
 *
 * 所以這裡把真東西做出來再量一次。做完發現沒用的話，那個結論才站得住 ——
 * 遮蔽剔除就是這樣處理的。
 *
 * ## 為什麼是獨立的一個類別，不是 LOD 鏈的最後一階
 *
 * `InstancedMesh` 底層是 `BatchedMesh`，而它**整批共用一份材質**。Impostor
 * 要的著色與網格完全不同（取樣圖集、朝向相機），塞進同一份材質意味著每個
 * fragment 多一個分支 —— 而這個專案量過那種分支：**淨虧 15–20%**，那個旋鈕
 * 最後被整個拿掉。
 *
 * 分開就沒有那筆錢：impostor 是自己的一次繪製，網格那邊一行都沒動。
 */

export interface ImpostorBakeOptions {
  /**
   * 水平方向烘幾個視角。預設 16。
   *
   * 只烘水平一圈（不烘俯仰）是刻意的：遠處的東西幾乎都是從接近水平的角度看的，
   * 而俯仰也烘的話張數是平方成長。要俯仰的話那是另一個功能（octahedral），
   * 不是把這個數字調大。
   */
  views?: number;
  /** 每個視角的邊長。預設 128。 */
  size?: number;
}

export interface BakedImpostor {
  /** 一整圈視角拼成的圖集，橫向排列。 */
  texture: Texture;
  views: number;
  /** 物件的包圍球半徑（區域空間），拿來決定看板多大。 */
  radius: number;
  /** 包圍球心，區域空間。 */
  center: Vector3;
  /**
   * 圖集的 render target。
   *
   * 開出來是為了**看得到圖集本身**：看板上有問題的時候，從畫面查過去那條路
   * 上疊著挑格、uv、alphaTest，每一站都可能把症狀變成「就是黑的」。直接讀
   * 圖集才分得出「烘壞了」與「查錯格」。
   */
  target: { width: number; height: number };
  dispose: () => void;
}

/**
 * 繞著物件烘一圈。
 *
 * 用**正交投影**而不是透視：impostor 是給遠處用的，遠處的透視幾乎等於正交，
 * 而正交烘出來的圖在任何距離都對得上，不必記錄烘的時候站多遠。
 */
export function bakeImpostor(
  renderer: WebGLRenderer,
  object: Object3D,
  options: ImpostorBakeOptions = {},
): BakedImpostor {
  const views = Math.max(4, Math.floor(options.views ?? 16));
  const size = Math.max(16, Math.floor(options.size ?? 128));

  const sphere = boundsOf(object);
  const radius = sphere.radius;

  const target = new WebGLRenderTarget(size * views, size, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
  });

  const scene = new Scene();
  // 背景要是**透明的**，不是黑的：黑的話看板的邊緣會有一圈黑框，而那在
  // 一整片樹林裡看起來像每棵樹都鑲了邊。
  scene.background = null;

  const holder = object.clone(true);
  holder.position.sub(sphere.center);
  holder.updateMatrixWorld(true);
  scene.add(holder);

  // 正交相機剛好框住包圍球。
  const camera = new OrthographicCamera(-radius, radius, radius, -radius, 0.01, radius * 4);
  const at = new Vector3();

  const previousTarget = renderer.getRenderTarget();
  const previousClear = renderer.getClearAlpha();
  renderer.setRenderTarget(target);
  renderer.setClearAlpha(0);
  renderer.clear(true, true, false);
  // ## 清一次就好 —— 每一格再清一次會把別格清掉
  //
  // `WebGPURenderer` 的清除走的是 render pass 的 loadOp，那是**整張
  // attachment** 的；scissor 只管繪製。所以 `autoClear` 開著的話第 k 個
  // 視角會把前面 k−1 格全部清成透明，最後圖集裡只剩最後那一格。
  //
  // 量出來就是這個形狀：十六格裡只有第 15 格有東西，而它的值是對的。
  // 虛擬陰影圖那邊踩過同一個坑（見 `virtual-shadow-map.ts`）。
  const previousAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  for (let view = 0; view < views; view++) {
    const angle = (view / views) * Math.PI * 2;
    camera.position.set(Math.sin(angle) * radius * 2, 0, Math.cos(angle) * radius * 2);
    camera.lookAt(at.set(0, 0, 0));
    camera.updateMatrixWorld(true);
    // ## 視埠要設在 render target 上，**而且要在設完之後重綁一次**
    //
    // 綁了 render target 之後 Three 用的是 `target.viewport` —— `renderer`
    // 上那一組只在畫到畫布時有效。這一半原本就寫對了。
    //
    // 錯的是另一半：`setRenderTarget` 是在**綁定的那一刻**把 viewport 與
    // scissor 抄進內部狀態的，之後再改那兩個物件一個字都不會生效。而綁定
    // 原本在迴圈外面，所以十六個視角全部用同一組（整張圖集）——
    // 每一個都畫滿整張、後面蓋掉前面，最後圖集裡只有最後那個視角被拉寬
    // 十六倍。
    //
    // 那個症狀**上面的註解已經寫著了**，而它宣稱修好了。量出來沒有：圖集
    // 十六格裡只有中間八格有東西，alpha 從 0.70 對稱地掉到 0（那是一棵樹
    // 拉寬十六倍的形狀，不是十六棵樹）。
    //
    // 從畫面查過去看不出來 —— 那條路上疊著挑格、uv、alphaTest，每一站都
    // 會把症狀變成「就是黑的」。直接讀圖集才分得出來（doctrine 27）。
    target.viewport.set(view * size, 0, size, size);
    target.scissor.set(view * size, 0, size, size);
    target.scissorTest = true;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  }

  target.scissorTest = false;
  target.viewport.set(0, 0, target.width, target.height);
  renderer.autoClear = previousAutoClear;
  renderer.setClearAlpha(previousClear);
  renderer.setRenderTarget(previousTarget);

  return {
    target,
    texture: target.texture,
    views,
    radius,
    center: sphere.center.clone(),
    dispose: () => target.dispose(),
  };
}

function boundsOf(object: Object3D): Sphere {
  const sphere = new Sphere();
  const points: Vector3[] = [];
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const geometry = (child as { geometry?: BufferGeometry }).geometry;
    if (geometry === undefined) return;
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (box === null) return;
    for (const corner of [box.min, box.max]) {
      points.push(corner.clone().applyMatrix4(child.matrixWorld));
    }
  });
  if (points.length === 0) {
    sphere.center.set(0, 0, 0);
    sphere.radius = 1;
    return sphere;
  }
  sphere.setFromPoints(points);
  return sphere;
}

/**
 * 一批 impostor，一次繪製。
 *
 * 每個 instance 是兩個三角形，朝向相機，從圖集裡挑最接近目前視角的那一格。
 */
export class ImpostorBatch extends ThreeInstancedMesh {
  readonly baked: BakedImpostor;

  /** WebGPU 那條路的材質。惰性建立 —— 只用 WebGL 的人不該下載 `three/tsl`。 */
  private nodeMaterial: Material | null = null;

  /** node 那條路接好了沒。WebGL 上一直是 `null`。 */
  nodeReady: Promise<void> | null = null;

  constructor(baked: BakedImpostor, count: number) {
    const geometry = new BufferGeometry();
    // ## 四個頂點的 position **全部是原點**，角落放在 uv 裡
    //
    // 看板的角落本來就不是在區域空間裡張開的 —— 它是在**視空間**張開的
    // （見下面的注入）。所以 position 這個屬性從頭到尾只有一個用途：讓
    // instance 矩陣把它變成「這一棵樹的中心」。
    //
    // 這樣寫的第二個理由是 node 那條路：TSL 拿得到的只有**套過 instance
    // 矩陣之後**的 `positionLocal`。角落混在裡面的話中心就分不出來了，而
    // 每個 instance 的矩陣在 TSL 那側不是隨手拿得到的東西（Three 自己那段
    // 依緩衝大小分了三種讀法）。
    //
    // 角落改用 uv 推：`uv * 2 - 1` 就是 (−1,−1)…(1,1)。而 uv 本來就要留給
    // 圖集查表用，兩邊都用得上。
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    const material = new MeshBasicMaterial({
      map: baked.texture,
      transparent: true,
      // 邊緣要靠 alpha 裁掉，不然半透明排序會讓一整片樹林互相穿透。
      alphaTest: 0.35,
      color: new Color(0xffffff),
    });

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uViews = { value: baked.views };
      shader.uniforms.uRadius = { value: baked.radius };

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uViews;
uniform float uRadius;
varying float vView;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
{
  // ## 朝向相機的看板
  //
  // 用視空間的軸來張開：這樣不管相機怎麼轉，看板永遠正對鏡頭。用世界空間
  // 的固定軸的話它會在相機繞過去時被看到側面 —— 也就是一條線。
  // **instanceMatrix 不能漏。** Three 是在 project_vertex 那個 chunk 裡套用它，
  // 而這裡把那個 chunk 整個換掉了 —— 漏掉的話每一個看板都站在 mesh 的原點，
  // 三百個疊在同一個點上，畫面上等於什麼都沒有。
  //
  // 而那個症狀配上「繪製次數變少、三角形變少」看起來就像**大獲全勝**：
  // 實測 40,000 棵「省 95.5%」，畫面卻是空的。抓到它的是逐像素比對。
  vec3 centre = ( modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  vec3 offset = vec3( uv * 2.0 - 1.0, 0.0 ) * uRadius;
  transformed = centre + offset;

  // ## 挑哪一格：用**物件到相機**的水平方位角
  //
  // 烘的時候相機繞著物件轉，所以這裡要算的是同一個角。取模型矩陣的位移
  // 得到物件在世界的位置，與相機位置相減。
  vec3 toCamera = cameraPosition - ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
  float angle = atan( toCamera.x, toCamera.z );
  float turn = angle / ( 2.0 * PI );
  vView = floor( fract( turn ) * uViews + 0.5 );
}`,
        );

      // ## 位置已經是視空間了，不要再乘一次 modelView
      //
      // 但**`mvPosition` 這個變數要留著**：它是 `project_vertex` 宣告的，而
      // 後面的 chunk（霧、世界座標）還在用它。整行換掉的話頂點著色器直接
      // 編不過 —— 而編不過的症狀是**畫面全空，數字卻漂亮**：繪製次數少、
      // 三角形少，看起來像「省了 95.5%」。
      //
      // 抓到它的是逐像素比對（畫面差 51%），確認的是主控台那一行
      // `'mvPosition' : undeclared identifier`。這個專案在 VAT 的 `batchId`
      // 上踩過同一種：著色器沒編過，而所有的計數都照常好看。
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
gl_Position = projectionMatrix * mvPosition;`,
      );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uViews;
varying float vView;`,
        )
        .replace(
          '#include <map_fragment>',
          `{
  // 圖集是橫向排的，所以只要把 u 壓縮到一格再平移。
  float cell = mod( vView, uViews );
  vec2 atlasUv = vec2( ( vMapUv.x + cell ) / uViews, vMapUv.y );
  vec4 sampledDiffuseColor = texture2D( map, atlasUv );
  diffuseColor *= sampledDiffuseColor;
}`,
        );
    };

    super(geometry, material as Material, count);
    this.baked = baked;
    this.frustumCulled = false;
  }

  /**
   * WebGPU 上換成 node 材質那一份。
   *
   * ## 為什麼在這裡換，不是在建構時
   *
   * 建構時還不知道會用哪個 renderer。而 `onBeforeCompile` 那條路在
   * `WebGPURenderer` 上**完全不會被呼叫** —— 症狀是每一個看板都停在網格的
   * 原點，幾萬棵樹疊在同一個點上，畫面等於全空。
   *
   * 而那個症狀配上「繪製次數少、三角形少」看起來像大獲全勝。這個檔案的
   * 註解裡已經記著同一個坑在 WebGL 上長什麼樣。
   *
   * 換上去之前先回退到「什麼都不畫」是不行的（那就真的全空了），所以第一
   * 幀還是會用 WebGL 那份材質畫一次 —— 那一幀所有看板疊在原點。`nodeReady`
   * 讓測試等得過那一幀。
   */
  override onBeforeRender(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    geometry: BufferGeometry,
    material: Material,
    group: object,
  ): void {
    super.onBeforeRender(renderer, scene, camera, geometry, material, group as never);
    if ((renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer !== true) return;
    if (this.nodeMaterial !== null) {
      this.material = this.nodeMaterial;
      return;
    }
    this.nodeReady ??= import('./impostor-node.ts')
      .then((m) => m.createImpostorNodeMaterial(this.baked))
      .then((handle) => {
        this.nodeMaterial = handle.material as Material;
        this.material = this.nodeMaterial;
      })
      .catch((error: unknown) => {
        // **大聲說出來。** 靜靜失敗的症狀是「畫面全空但數字很漂亮」。
        console.error('WW.ImpostorBatch：node 材質建不起來，WebGPU 上看板會全部疊在原點。', error);
      });
  }
}
