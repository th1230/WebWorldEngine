import { loadTsl, loadWebGPU } from './fullscreen-node.ts';
import type { BakedImpostor } from './impostor.ts';

/**
 * Impostor 的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 逐行對照 `impostor.ts` 的注入：同一個看板、同一條挑格的式子、同一張圖集。
 *
 * ## 為什麼一定要有兩份
 *
 * WebGL 那條路靠 `onBeforeCompile`，而 `WebGPURenderer` 整條編譯路徑**不經過
 * 那個鉤子**。只做一邊的症狀是每一個看板都停在網格的原點 —— 幾萬棵樹疊在同
 * 一個點上，畫面上等於什麼都沒有。
 *
 * 而那個症狀配上「繪製次數少、三角形少」看起來像**大獲全勝**。`impostor.ts`
 * 的註解裡記著同一個坑在 WebGL 上長什麼樣。
 *
 * ## 中心從哪裡來
 *
 * TSL 拿得到的是**套過 instance 矩陣之後**的 `positionLocal`。所以看板的四個
 * 角落不能放在 position 屬性裡 —— 混進去的話中心就分不出來了。
 *
 * 那也是為什麼 `impostor.ts` 把四個頂點的 position 全部設成原點、角落改用
 * `uv * 2 - 1` 推：這樣兩份實作的第一步是同一句話 ——「這一棵樹的中心」。
 *
 * ## 偏移在哪個空間張開
 *
 * GLSL 那份是在**視空間**加 `(x, y, 0) * radius`。這裡不能那樣做：
 * `positionNode` 回傳的是區域座標，之後還要被模型矩陣與視矩陣乘一次。
 *
 * 等價的寫法是在世界空間用相機的 right／up 張開，再換回區域空間 ——
 * `cameraWorldMatrix * vec4(offset, 0)` 就是「把視空間的向量轉到世界」，
 * w 給 0 是為了只要旋轉不要位移。
 */

export interface ImpostorNodeHandle {
  material: unknown;
}

export async function createImpostorNodeMaterial(
  baked: BakedImpostor,
): Promise<ImpostorNodeHandle> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const {
    Fn,
    float,
    vec2,
    vec4,
    uniform,
    uv,
    texture,
    positionLocal,
    cameraWorldMatrix,
    cameraPosition,
    modelWorldMatrix,
    modelWorldMatrixInverse,
    varyingProperty,
    atan,
    floor,
    fract,
    mod,
    PI2,
  } = tsl;

  const uViews = uniform(float(baked.views));
  const uRadius = uniform(float(baked.radius));
  const atlas = texture(baked.texture);

  // 挑到哪一格 —— 在頂點算，片段用。與 GLSL 那份的 `vView` 是同一個東西。
  const vView = varyingProperty('float', 'wwImpostorView');

  const positionNode = Fn(() => {
    // `positionLocal` 這時已經套過 instance 矩陣，而 position 屬性是原點，
    // 所以它就是這一棵樹的中心（在網格的區域空間裡）。
    const centre = positionLocal.toVar();
    const corner = uv().mul(2).sub(1).toVar();

    // ## 挑哪一格：用**物件到相機**的水平方位角
    //
    // 烘的時候相機繞著物件轉，所以這裡要算的是同一個角。
    const centreWorld = modelWorldMatrix.mul(vec4(centre, 1)).xyz.toVar();
    const toCamera = cameraPosition.sub(centreWorld).toVar();
    const turn = atan(toCamera.x, toCamera.z).div(PI2);
    vView.assign(floor(fract(turn).mul(uViews).add(0.5)));

    // 螢幕對齊的四邊形：視空間的 (x, y, 0) 等於世界空間的 right·x + up·y。
    const offsetWorld = cameraWorldMatrix.mul(
      vec4(corner.x.mul(uRadius), corner.y.mul(uRadius), 0, 0),
    ).xyz;
    const offsetLocal = modelWorldMatrixInverse.mul(vec4(offsetWorld, 0)).xyz;
    return centre.add(offsetLocal);
  })();

  // 圖集是橫向排的，所以只要把 u 壓縮到一格再平移。
  const colorNode = Fn(() => {
    const cell = mod(vView, uViews);
    // 圖集是 render target 的貼圖，而 TSL 取樣那種貼圖會自動翻一次 V ——
    // 補一次把它翻回來，才與 GLSL 那份取到同一個 texel。
    const atlasUv = vec2(uv().x.add(cell).div(uViews), float(1).sub(uv().y));
    return atlas.sample(atlasUv);
  })();

  const material = new webgpu.MeshBasicNodeMaterial();
  material.positionNode = positionNode;
  material.colorNode = colorNode;
  material.transparent = true;
  // 邊緣要靠 alpha 裁掉，不然半透明排序會讓一整片樹林互相穿透。
  material.alphaTest = 0.35;
  // 顏色與 alpha 都從 `colorNode` 出來，不要再乘一次材質自己的 map。
  material.map = null;

  return { material };
}
