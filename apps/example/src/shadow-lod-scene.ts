import * as THREE from 'three';
import * as WW from '@webworld/three';

/**
 * 陰影 pass 自己剔除、自己選階的證明場景。
 *
 * ## 兩個主張要分開量
 *
 * 這件事同時修了一個**錯**和一個**慢**，而兩者要的場景剛好相反：
 *
 * - `offscreen`：一顆相機看不到、影子卻落在畫面裡的球。稀疏、乾淨，量的是
 *   「那個影子在不在」。
 * - `field`：幾千個散開的 instance。稠密，量的是「陰影 pass 送了幾個三角形」。
 * - `occluded`：一顆巨大的球擋住後面一整叢。量的是「被擋住的東西照樣要
 *   投影」—— 遮蔽緩衝是從主相機畫出來的，看不見不等於不投影。
 *
 * 一個場景同時量兩件事的話，稠密場的影子會蓋掉那顆球的影子，而稀疏場的
 * 三角形數量少到看不出選階的差別。
 */

export type ShadowLodMode = 'offscreen' | 'field' | 'occluded';

export interface ShadowLodOptions {
  mode: ShadowLodMode;
  /** 關掉就是 Three 原本的行為：陰影畫主相機那一次留下來的清單。 */
  shadowCulling: boolean;
  /** 給 `field` 用的 A/B：陰影的誤差上限。 */
  shadowErrorPixels?: number;
}

export interface ShadowLodScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  render: (renderer: THREE.WebGLRenderer) => void;
  /**
   * 那顆球的影子該落在畫面的哪裡，以及那一小塊有多暗（0 全黑、1 全亮）。
   *
   * 位置是**算出來的**不是寫死的：相機或光源動了，取樣點跟著動。寫死的
   * 取樣點在場景微調之後會安靜地量到旁邊的地面，而那看起來像效果壞了。
   */
  shadowSpot: (renderer: THREE.WebGLRenderer) => {
    u: number;
    v: number;
    controlU: number;
    controlV: number;
    /** 影子該落的那一塊有多亮。 */
    brightness: number;
    /** 同一幀裡確定沒被遮的那一塊有多亮。 */
    control: number;
  };
  /**
   * 陰影 pass 送了幾個三角形。
   *
   * 用 Three 自己的計數器，不是我們的統計 —— 兩套系統各自算才驗得到東西。
   * 開關 `castShadow` 各畫一次，差額就是陰影那一份：主畫面畫的東西一模一樣，
   * 差別只有多不多一次陰影 pass。
   */
  shadowTriangles: (renderer: THREE.WebGLRenderer) => number;
  /**
   * 陰影圖上的像素/單位、instance 半徑、每一階的誤差 —— 關卡拿這些**自己
   * 算出**該用第幾階，而不是把量到的數字寫死當成期望值。
   *
   * 把量到的當期望值的話，關卡永遠是綠的：它斷言的是「現在的行為等於
   * 現在的行為」。
   */
  contract: () => { ppu: number; radius: number; errors: number[]; errorPixels: number };
  /**
   * 連續量幾次，每一次陰影 pass 畫了幾個 instance。
   *
   * 會飄的話代表有狀態在背後累積 —— 實測過遠景合併就是這樣（每一幀合併
   * 掉更多，2976 → 2665 → 2297 → 1833 → 1299）。飄的東西量不出任何事情。
   */
  stability: (renderer: THREE.WebGLRenderer, times: number) => number[];
  /** 主畫面這一幀畫了幾個 instance，以及陰影 pass 畫了幾個。 */
  counts: () => {
    visible: number;
    shadow: number;
    shadowEnabled: boolean;
    /** 主畫面的階分布。 */
    levels: number[];
    /** 陰影 pass 的階分布。正交投影下該全部擠在同一階。 */
    shadowLevels: number[];
    /** 主畫面被遮蔽剔除拿掉幾個。 */
    occluded: number;
    /** 場上總共幾個。 */
    total: number;
  };
}

/** 光源的行進方向。低角度 —— 影子拉得長，投影者才離得開畫面。 */
const LIGHT = new THREE.Vector3(-1, -0.3, 0).normalize();
/** 那顆離題的球：相機看不到它，但它的影子落在原點附近。 */
const CASTER = new THREE.Vector3(60, 22, 0);
const CASTER_RADIUS = 7;

/** 沿著光線落到 y = 0 的那一點。 */
function groundHit(from: THREE.Vector3): THREE.Vector3 {
  const steps = from.y / -LIGHT.y;
  return new THREE.Vector3(from.x + LIGHT.x * steps, 0, from.z + LIGHT.z * steps);
}

export function makeShadowLodScene(options: ShadowLodOptions): ShadowLodScene {
  const root = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(root);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);

  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  // ## 光源放多遠，決定「距離」這個變數有沒有機會作亂
  //
  // 正交投影下選階**不該**看距離。要驗它真的沒看，場上就得有一大片距離
  // 差很多的東西 —— 光源離場地 120，而場地寬 120，於是最近與最遠差了
  // 好幾倍。照距離選的話這一片會裂成好幾階；正確的話全部同一階。
  //
  // 放 260 的話最近與最遠只差 1.6 倍，兩種算法都會擠在同一階 —— 那時
  // 這個關卡問不出任何事情。
  sun.position.copy(LIGHT).multiplyScalar(options.mode === "field" ? -120 : -260);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // ## 光源相機的範圍決定陰影圖的像素/單位，而那正是選階的依據
  //
  // `offscreen` 要罩住那顆離題的球（x = 60）與它的影子（x ≈ −13），所以
  // 要寬。`field` 反過來要**窄**：範圍越窄，同樣的 2048 就越細，一個東西
  // 在陰影圖上佔的像素越多，兩個誤差上限才挑得到不同的階。
  //
  // 第一版兩個模式共用 ±220，於是 3,000 個 instance 全部落在最粗那一階 ——
  // 放寬誤差當然沒有差別，量出來 0.0%。那不是效果沒用，是場景裡沒有
  // 那個情況。
  //
  // `occluded` 也用窄的：範圍寬的話契約會挑到最粗那一階，而整格都在最粗
  // 階正是遠景合併的觸發條件 —— 於是數字會隨著烘焙進度一直掉（實測
  // 485 → 170 → 79）。那是合併**正確**的行為，但它讓這個場景沒辦法乾淨地
  // 只回答「被擋住的東西有沒有投影」這一個問題。
  const shadowExtent = options.mode === "offscreen" ? 220 : 70;
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -shadowExtent;
  shadowCamera.right = shadowExtent;
  shadowCamera.top = shadowExtent;
  shadowCamera.bottom = -shadowExtent;
  shadowCamera.near = 1;
  shadowCamera.far = 700;
  shadowCamera.updateProjectionMatrix();
  root.add(sun);
  root.add(sun.target);
  root.add(new THREE.AmbientLight(0xffffff, 0.35));

  // ## 階是**明確給的**，不是讓自動 LOD 去產生
  //
  // 這個場景要測的是「陰影 pass 挑哪一階」，不是「自動 LOD 產得好不好」。
  // 讓產生器決定的話，關卡量到的差異裡混著兩件事，而其中一件不是它要測的。
  //
  // 第一版丟了一顆 `IcosahedronGeometry(1, 5)` 進去 —— 那只有 720 個三角形
  // （細分度給的是每面 (d+1)² 塊，不是 4^d），自動 LOD 判斷不值得分階，於是
  // 整條鏈只有一階。放寬誤差當然挑不到別的，量出來 0.0%。
  //
  // 誤差是「半徑 1 的球上差多少」。內接多面體逼近球面的矢高大致與細分度
  // 平方成反比，下面這串就是照那個量級給的。
  const DETAILS = [16, 8, 4, 2, 1];
  const LOD_ERRORS = [0, 0.01, 0.04, 0.15, 0.4];
  const geometry = {
    lods: DETAILS.map((detail) => new THREE.IcosahedronGeometry(1, detail)),
    errors: LOD_ERRORS,
  };
  const material = new THREE.MeshLambertMaterial({ color: 0xcccccc });

  const positions: THREE.Vector3[] = [];
  if (options.mode === 'offscreen') {
    positions.push(CASTER.clone());
    // ## 錨點：讓這個 mesh 不會被整個剔掉
    //
    // 全部 instance 都在畫面外的話，Three 會在主畫面那一次把**整個物件**
    // 剔掉，`onBeforeRender` 根本不會被呼叫 —— 那時繪製清單是上一幀的殘留，
    // 量到的不是「相機剔除影響陰影」而是「什麼都沒發生」。
    //
    // 錨點放在光線的下游（−x 更遠處），它們的影子不會落到取樣點上。
    positions.push(new THREE.Vector3(-40, 7, 26));
    positions.push(new THREE.Vector3(-46, 7, -30));
  } else if (options.mode === "occluded") {
    // ## 一顆巨大的球擋住後面一整叢
    //
    // 遮蔽緩衝是拿場上夠大的 instance 當遮蔽物、把其他人投上去測的。所以
    // 要有一個**明顯比別人大**而且靠近相機的東西，後面那一叢才會真的被判
    // 為看不見。
    positions.push(new THREE.Vector3(0, 30, 55));
    let seed = 990601;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 800; i++) {
      positions.push(new THREE.Vector3((next() - 0.5) * 40, 3, -10 + (next() - 0.5) * 30));
    }
  } else {
    // 固定亂數 —— A/B 兩次要是同一份場景。
    let seed = 20240611;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 3000; i++) {
      positions.push(new THREE.Vector3((next() - 0.5) * 120, 2.5, (next() - 0.5) * 120));
    }
  }

  const mesh = new WW.InstancedMesh(geometry, material, positions.length, {
    shadowCulling: options.shadowCulling,
    occlusion: options.mode === "occluded",
    ...(options.shadowErrorPixels === undefined
      ? {}
      : { shadowErrorPixels: options.shadowErrorPixels }),
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  positions.forEach((position, i) => {
    const radius =
      options.mode === 'field'
        ? 2.5
        : options.mode === 'occluded'
          ? i === 0
            ? 30
            : 3
          : i === 0
            ? CASTER_RADIUS
            : 5;
    mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale.setScalar(radius)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  root.add(mesh);

  const spot = groundHit(CASTER);
  // ## 控制點：同一幀裡確定**沒有**被遮的一塊地面
  //
  // 「影子在不在」不能拿一個寫死的亮度門檻去判 —— 被照亮的地面到底多亮
  // 取決於光強、環境光、色彩空間、色調映射，而那些都不是這個關卡在測的
  // 東西。第一版猜 0.6，實測被照亮的地面只有 0.329，關卡就紅了。
  //
  // 拿同一幀的另一點來比，門檻就變成「這兩塊一不一樣亮」，而那是這個
  // 關卡真正想問的問題。
  //
  // 往 +z 挪 16：影子在 z 方向的半寬只有球半徑（光是沿 x 打的），所以
  // 16 離影子邊緣還有 9 個單位；同時 13.6 度仍在 17.5 度的視野裡。
  const control = new THREE.Vector3(spot.x, 0, 16);
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 1, 900);
  if (options.mode === 'offscreen') {
    // 俯看影子落點。球在 x = 60，取樣點在 x ≈ −13 —— 相機軸線與「相機到球」
    // 的夾角約 58 度，而視錐的半對角約 34 度。差得夠遠，不必擔心邊界情況。
    camera.position.set(spot.x, 55, 35);
    camera.lookAt(spot.x, 0, 0);
  } else if (options.mode === "occluded") {
    // 站在那顆大球後面一點，讓它剛好罩住後面那一叢。
    camera.position.set(0, 34, 130);
    camera.lookAt(0, 12, 0);
  } else {
    camera.position.set(0, 45, 110);
    camera.lookAt(0, 0, 0);
  }
  camera.updateMatrixWorld(true);

  // ## 畫進自己的 target，不要畫進畫面
  //
  // 畫進預設的 framebuffer 的話，主迴圈下一幀就把它蓋掉了 —— 讀回來的
  // 東西取決於「關卡的 evaluate 有沒有跟 rAF 撞在一起」，而那是一個
  // 會隨機變紅的關卡。隨機變紅的關卡不是關卡。
  const target = new THREE.WebGLRenderTarget(1280, 720);
  const draw = (renderer: THREE.WebGLRenderer): void => {
    // 這個場景整個是為了陰影而存在的 —— 由它自己打開，而不是仰賴頁面的
    // `?shadows=1`。第一版沒開，量到的三角形是 0，而那看起來像效果壞了。
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
  };

  const patch = new Uint8Array(9 * 9 * 4);

  const project = (point: THREE.Vector3): { u: number; v: number } => {
    const ndc = point.clone().project(camera);
    return { u: (ndc.x + 1) / 2, v: (ndc.y + 1) / 2 };
  };

  /** 讀畫面上某一點周圍 9×9 的平均亮度。單點會被陰影邊緣的過濾騙到。 */
  const brightnessAt = (renderer: THREE.WebGLRenderer, point: THREE.Vector3): number => {
    const { u, v } = project(point);
    const x = Math.round(u * target.width);
    const y = Math.round(v * target.height);
    renderer.readRenderTargetPixels(target, x - 4, y - 4, 9, 9, patch);
    let sum = 0;
    for (let i = 0; i < patch.length; i += 4) sum += patch[i] ?? 0;
    return sum / (9 * 9) / 255;
  };

  return {
    root,
    camera,
    render: draw,
    shadowSpot: (renderer) => {
      draw(renderer);
      const at = project(spot);
      const controlAt = project(control);
      return {
        u: at.u,
        v: at.v,
        controlU: controlAt.u,
        controlV: controlAt.v,
        brightness: brightnessAt(renderer, spot),
        control: brightnessAt(renderer, control),
      };
    },
    shadowTriangles: (renderer) => {
      const info = renderer.info;
      info.autoReset = false;

      // 每一組都先畫一次不算 —— 第一幀要編譯著色器、上傳幾何，而那些
      // 一次性的東西不屬於「陰影 pass 送了幾個三角形」。
      sun.castShadow = false;
      draw(renderer);
      info.reset();
      draw(renderer);
      const withoutShadow = info.render.triangles;

      sun.castShadow = true;
      draw(renderer);
      info.reset();
      draw(renderer);
      const withShadow = info.render.triangles;

      info.autoReset = true;
      return withShadow - withoutShadow;
    },
    contract: () => ({
      // 正交：像素/單位 = 陰影圖邊長 ÷ 視野邊長。與距離無關。
      ppu: sun.shadow.mapSize.x / (shadowExtent * 2),
      radius: options.mode === "field" ? 2.5 : 5,
      errors: LOD_ERRORS,
      errorPixels: options.shadowErrorPixels ?? 6,
    }),
    stability: (renderer, times) => {
      const out: number[] = [];
      for (let i = 0; i < times; i++) {
        draw(renderer);
        out.push(mesh.shadowStats.instances);
      }
      return out;
    },
    counts: () => ({
      visible: mesh.stats.visible,
      shadow: mesh.shadowStats.instances,
      shadowEnabled: mesh.shadowStats.enabled,
      shadowLevels: Array.from(mesh.shadowStats.levels),
      occluded: mesh.stats.occluded,
      total: positions.length,
      levels: Array.from(mesh.stats.levels),
    }),
  };
}
