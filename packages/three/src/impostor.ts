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
import type { Material, Object3D, Texture, WebGLRenderer } from 'three';

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

  for (let view = 0; view < views; view++) {
    const angle = (view / views) * Math.PI * 2;
    camera.position.set(Math.sin(angle) * radius * 2, 0, Math.cos(angle) * radius * 2);
    camera.lookAt(at.set(0, 0, 0));
    camera.updateMatrixWorld(true);
    // ## 視埠要設在 **render target** 上，不是 renderer 上
    //
    // 綁了 render target 之後，Three 用的是 `target.viewport` —— `renderer`
    // 上那一組只在畫到畫布時有效。設錯地方的話十六個視角**每一個都畫滿整張
    // 圖集**，後面蓋掉前面，最後圖集裡只有最後那一個視角被拉寬十六倍。
    //
    // 而症狀是看板上出現一條變形的東西，看起來像「UV 算錯了」。
    target.viewport.set(view * size, 0, size, size);
    target.scissor.set(view * size, 0, size, size);
    target.scissorTest = true;
    renderer.render(scene, camera);
  }

  target.scissorTest = false;
  target.viewport.set(0, 0, target.width, target.height);
  renderer.setClearAlpha(previousClear);
  renderer.setRenderTarget(previousTarget);

  return {
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

  constructor(baked: BakedImpostor, count: number) {
    const geometry = new BufferGeometry();
    // 一個以原點為中心的方形看板，頂點著色器會把它朝向相機。
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
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
  vec3 offset = vec3( position.x, position.y, 0.0 ) * uRadius;
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
}
