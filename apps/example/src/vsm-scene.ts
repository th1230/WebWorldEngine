import * as THREE from 'three';
import * as WW from '@webworld/three';

/**
 * 虛擬陰影圖的證明場景：一條**斜的**陰影邊界。
 *
 * ## 為什麼邊界要斜的
 *
 * 陰影圖的解析度不足時，症狀是邊界被量化成一格一格的**階梯**。水平或垂直的
 * 邊界看不出來（階梯剛好對齊），斜的才看得出來。
 *
 * 所以量的是「掃過幾列，邊界落在幾個不同的位置」：解析度夠的話每一列都不一樣
 * （平滑地斜過去），不夠的話好幾列共用同一個位置（階梯）。
 *
 * ## A/B 是同一條程式碼、不同的虛擬解析度
 *
 * 兩邊都走虛擬陰影圖，差別只有 `pagesPerSide`：一個讓虛擬解析度遠大於圖集，
 * 一個讓它等於圖集（也就是退化成一張普通的陰影圖）。
 *
 * 換材質或換實作做 A/B 比的是兩個不同的東西，那說明不了解析度。
 */

const OCCLUDER = 24;

export interface VsmScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** 把看得到的區域全部畫進陰影圖。回傳畫了幾頁。 */
  settle: (renderer: THREE.WebGLRenderer) => number;
  /** 解出陰影遮罩並讀回來。 */
  resolve: (renderer: THREE.WebGLRenderer, debug?: number) => void;
  /** 掃一段列，回傳每一列陰影邊界落在第幾行（找不到就 −1）。 */
  edgeColumns: (renderer: THREE.WebGLRenderer) => number[];
  info: () => { virtualSize: number; atlasSize: number; maxTextureSize: number; pagesDrawn: number };
  /** 遮罩裡有多少比例是暗的 —— 找不到邊界時要先知道遮罩長什麼樣。 */
  maskStats: (renderer: THREE.WebGLRenderer) => { dark: number; mean: number; centre: number[] };
  /** 遮罩的粗略縮圖（16×9 的平均），拿來看它到底長什麼樣。 */
  maskMap: (renderer: THREE.WebGLRenderer) => number[];
}

export function makeVsmScene(pagesPerSide: number): VsmScene {
  const root = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(root);

  const ground = new THREE.Mesh(
    // 地面比光源視錐（300）小，所以陰影圖有些地方是**空的** —— 那才驗得到
    // 「頁要清成白的」。地面蓋滿整個視錐的話，清成黑的也看不出差別。
    new THREE.PlaneGeometry(220, 220),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  // 遮蔽物轉一個角度，影子的邊界因此是斜的。
  const occluder = new THREE.Mesh(
    new THREE.BoxGeometry(OCCLUDER, OCCLUDER, OCCLUDER),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  occluder.position.set(0, OCCLUDER / 2, 0);
  occluder.rotation.y = Math.PI * 0.17;
  occluder.updateMatrixWorld(true);
  root.add(occluder);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(60, 90, 30);
  root.add(sun);
  const lightDirection = new THREE.Vector3(0, 0, 0).sub(sun.position).normalize();

  const shadowMap = new WW.VirtualShadowMap({
    pageSize: 64,
    pagesPerSide,
    // 32×32 = 1,024 個槽位（圖集 2048²）。槽位數決定「同時能有多少頁是細的」，
    // 而那正是虛擬陰影圖真正的預算 —— 不是虛擬解析度。
    //
    // 用 32 而不是 24，是為了讓「虛擬解析度等於圖集」那一組也是 2 的次方
    // （頁表要求）。第一版用 24，PageTable 直接丟例外 —— 而那個例外讓整個
    // 模組載入失敗，關卡只看到「等 __ww.vsm 逾時」，完全看不出原因。
    atlasPages: 32,
    extent: 300,
    depth: 600,
    budget: 100000,
  });
  shadowMap.setLight(lightDirection, new THREE.Vector3(0, 0, 0));

  // 相機俯看影子那一段邊界。
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 1, 900);
  // 拉近看那一小塊影子邊界 —— 虛擬陰影圖給的是「你在看的地方很細」。
  // 站遠一點、視角開大一點，讓畫面同時看得到影子裡與影子外 —— 第一版瞄太遠
  // （完全在影子外，一條邊界都沒有），第二版瞄太近（整片都是影子）。
  camera.position.set(-40, 26, -34);
  camera.lookAt(-13, 0, -6);
  camera.fov = 34;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const gbuffer = new WW.SceneDepthNormals({ scale: 1 });
  let mask: THREE.Texture | null = null;

  return {
    root,
    camera,
    settle: (renderer) => {
      // ## 只要相機看得到的那一小塊
      //
      // 圖集只有 576 個槽位，而最細那一階有 pagesPerSide² 頁 —— 整片要下來
      // 是不可能的，也**沒有必要**：虛擬陰影圖的重點就是「只畫看得到的」。
      //
      // 第一版整片都要，結果 65,536 頁裡只有 63 頁塞得進圖集，其餘全部退回
      // 最粗那一階 —— 於是「細的那一份」其實一點都不細，量出來兩邊一樣。
      // 影子的尖端算得出來：箱高 24、太陽 (60,90,30) → 水平位移約 18 個單位，
      // 方向 (−60,−30) 正規化。所以邊界大約在 (−16, −8) 那一帶。
      //
      // 第一版瞄 (−26, −26)，那已經**在影子外面**了 —— 於是掃了 96 列一條
      // 邊界都沒有，而那看起來像效果壞了。
      const centre = new THREE.Vector3(-14, 0, -7);
      const radius = 16;
      // 用光源空間的 UV，不是世界的 x/z —— 光源平面是斜的。
      const corners = [
        new THREE.Vector3(centre.x - radius, 0, centre.z - radius),
        new THREE.Vector3(centre.x + radius, 0, centre.z - radius),
        new THREE.Vector3(centre.x - radius, 0, centre.z + radius),
        new THREE.Vector3(centre.x + radius, 0, centre.z + radius),
      ].map((c) => shadowMap.worldToUv(c, { u: 0, v: 0 }));
      const u0 = Math.min(...corners.map((c) => c.u));
      const u1 = Math.max(...corners.map((c) => c.u));
      const v0 = Math.min(...corners.map((c) => c.v));
      const v1 = Math.max(...corners.map((c) => c.v));
      const request = (): void => shadowMap.requestRegion(u0, v0, u1, v1, 0);
      request();
      let drawn = 0;
      let guard = 0;
      while (guard++ < 400) {
        const n = shadowMap.update(renderer, scene);
        drawn += n;
        if (n === 0) break;
        request();
      }
      return drawn;
    },    resolve: (renderer, debug = 0) => {
      shadowMap.debugMode = debug;
      gbuffer.update(renderer, scene, camera);
      mask = shadowMap.resolve(renderer, camera, gbuffer);
    },
    edgeColumns: (renderer) => {
      void mask;
      const target = (shadowMap as unknown as { resolveTarget: THREE.WebGLRenderTarget }).resolveTarget;
      const width = target.width;
      // ## 只掃畫面中央那一段
      //
      // 要求下來的只有相機瞄準的那一小塊，畫面邊緣會退回最粗那一階 —— 那裡的
      // 解析度極差，陰影痤瘡會把邊界偵測整個汙染掉。掃中央才是在量該量的東西。
      const rows = 64;
      const startRow = Math.floor(target.height * 0.42);
      const buffer = new Uint8Array(width * 4);
      const columns: number[] = [];
      for (let i = 0; i < rows; i++) {
        const y = startRow + i;
        renderer.readRenderTargetPixels(target, 0, y, width, 1, buffer);
        // 由左往右找第一個由亮轉暗的位置。
        let found = -1;
        // 掃整列。之前縮到中間 40% 是為了躲畫面邊緣的痤瘡，而那個痤瘡在偏移
        // 修好之後已經沒有了 —— 縮著反而讓起點落在影子裡面，於是找不到「由亮
        // 轉暗」的那一格。
        for (let x = 1; x < width; x++) {
          const previous = buffer[(x - 1) * 4] ?? 0;
          const current = buffer[x * 4] ?? 0;
          if (previous > 128 && current <= 128) {
            found = x;
            break;
          }
        }
        columns.push(found);
      }
      return columns;
    },
    maskStats: (renderer) => {
      const target = (shadowMap as unknown as { resolveTarget: THREE.WebGLRenderTarget }).resolveTarget;
      const buffer = new Uint8Array(target.width * target.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, buffer);
      let dark = 0;
      let sum = 0;
      const total = target.width * target.height;
      for (let i = 0; i < buffer.length; i += 4) {
        const v = buffer[i] ?? 0;
        sum += v;
        if (v <= 128) dark++;
      }
      const cx = target.width >> 1;
      const cy = target.height >> 1;
      const i = (cy * target.width + cx) * 4;
      return {
        dark: dark / total,
        mean: sum / total / 255,
        centre: [buffer[i] ?? 0, buffer[i + 1] ?? 0, buffer[i + 2] ?? 0],
      };
    },
    maskMap: (renderer) => {
      const target = (shadowMap as unknown as { resolveTarget: THREE.WebGLRenderTarget }).resolveTarget;
      const buffer = new Uint8Array(target.width * target.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, buffer);
      const cols = 16;
      const rows = 9;
      const out: number[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let sum = 0;
          let n = 0;
          const y0 = Math.floor((r / rows) * target.height);
          const y1 = Math.floor(((r + 1) / rows) * target.height);
          const x0 = Math.floor((c / cols) * target.width);
          const x1 = Math.floor(((c + 1) / cols) * target.width);
          for (let y = y0; y < y1; y += 3) {
            for (let x = x0; x < x1; x += 3) {
              sum += buffer[(y * target.width + x) * 4] ?? 0;
              n++;
            }
          }
          out.push(Math.round(sum / Math.max(n, 1)));
        }
      }
      return out;
    },
    info: () => ({
      virtualSize: shadowMap.virtualSize,
      atlasSize: shadowMap.atlasSize,
      maxTextureSize: 0,
      pagesDrawn: shadowMap.pagesDrawn,
    }),
  };
}
