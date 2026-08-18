import * as WW from '@webworld/three';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * 一個**普通的 Three.js 專案**。
 *
 * 整支程式裡只有一處跟這個套件有關。網址加上 `?ww=0` 就換回原生的
 * `THREE.InstancedMesh`，其餘一行都不必動 —— 那正是這個套件要證明的事。
 *
 *   http://localhost:5174/            強化版
 *   http://localhost:5174/?ww=0       原生
 *   http://localhost:5174/?count=200000
 *   http://localhost:5174/?post=1     加上後處理（EffectComposer + bloom）
 *   http://localhost:5174/?shadows=1  加上陰影（shadow map 是另一條 render 路徑）
 *   http://localhost:5174/?autolod=1  不自備 LOD 鏈，讓套件在 worker 裡產生
 *   http://localhost:5174/?cooked=1   載入 cook 過的資產（要先跑 pnpm cook）
 *   http://localhost:5174/?stream=1   開串流：內容跟著相機載入卸載
 */

const params = new URLSearchParams(location.search);
const enhanced = params.get('ww') !== '0';
const usePost = params.get('post') === '1';
const useShadows = params.get('shadows') === '1';
const useAutoLod = params.get('autolod') === '1';
const useCooked = params.get('cooked') === '1';
const useStream = params.get('stream') === '1';
const COOKED_MANIFEST = '/cooked/assets.manifest.json';
const COOKED_MESH = params.get('mesh') ?? 'mesh:rock-large';
const COUNT = Number(params.get('count') ?? 60_000);
const SPREAD = 900;

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 400, 1400);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 2500);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202028, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(120, 200, 80);
scene.add(sun);

// 陰影是**另一條 render 路徑**：Three.js 會用光源的相機再走訪一次場景，
// 畫進 shadow map。套件不必為它做任何特別處理 —— `onBeforeShadow` 會轉呼叫
// `onBeforeRender`，剔除與選階自然用 shadow 相機與 shadow map 的尺寸重算。
if (useShadows) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowCam = sun.shadow.camera;
  shadowCam.left = -400;
  shadowCam.right = 400;
  shadowCam.top = 400;
  shadowCam.bottom = -400;
  shadowCam.far = 900;
  shadowCam.updateProjectionMatrix();
}

// ── 內容：一片石頭 ───────────────────────────────────────────────────
// 三階 LOD。強化版會依螢幕誤差選階，原生版只會用第 0 階（它沒有 LOD 概念）。
//
// `?autolod=1` 改用一份**沒有處理過的密網格**（12,500 個三角形），因為那
// 才是 W2 要解決的情況：使用者手上是一份直接匯出的美術資產，不是一條
// 準備好的 LOD 鏈。用 500 面的球去示範「產生 LOD 不卡主執行緒」等於在
// 示範一件本來就不會卡的事。
const lods = useAutoLod
  ? [new THREE.IcosahedronGeometry(1, 24)]
  : [
      new THREE.IcosahedronGeometry(1, 4),
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.IcosahedronGeometry(1, 1),
    ];
// 每一階相對第 0 階的幾何誤差，世界單位。**從幾何本身量出來，不是猜的** ——
// 猜錯的方向若是低估，就會選到太粗的階，也就是靜靜地違反品質契約。
const errors = useAutoLod ? [0] : WW.sphericalLodErrors(lods);

// cook 過的資產連材質一起有：貼圖是 build 時壓成 BC 的，載進來就是
// `MeshStandardMaterial`。其餘三條路沒有貼圖可用，就自己寫一個 —— 兩邊
// 拿到的是**同一個類別**，之後的每一行都一樣。
const material = useCooked
  ? await WW.loadMaterial(COOKED_MANIFEST, COOKED_MESH).catch((error: unknown) => {
      console.warn('WW.loadMaterial 失敗，退回純色材質。', error);
      return new THREE.MeshStandardMaterial({ color: 0x8b8b93, roughness: 0.85 });
    })
  : new THREE.MeshStandardMaterial({ color: 0x8b8b93, roughness: 0.85 });

// ── 這裡就是全部的差別 ───────────────────────────────────────────────
//
// `?autolod=1` 走的是**只給一份幾何**那條路：套件會在 worker 裡把 LOD 鏈
// 補上，期間物件照常運作（用最細的幾何）。那才是「換一個字」最純粹的樣子。
//
// 自備 `{ lods, errors }` 仍然更好：誤差是你自己量的，而且不必付產生的時間。
//
// `?cooked=1` 走第三條路：LOD 鏈是 build 時算好的，runtime 一次簡化都不做。
// 三條路的 API 形狀一模一樣 —— 差別只在那個第一參數是什麼。
const source: WW.GeometrySource = useCooked
  ? await WW.load(COOKED_MANIFEST, COOKED_MESH).catch((error: unknown) => {
      console.warn('WW.load 失敗，退回程序化幾何。先跑 pnpm cook 再試。', error);
      return { lods, errors };
    })
  : useAutoLod
    ? lods[0]!
    : { lods, errors };

const rocks = enhanced
  ? new WW.InstancedMesh(source, material, COUNT)
  : new THREE.InstancedMesh(lods[0]!, material, COUNT);
// ─────────────────────────────────────────────────────────────────────

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const euler = new THREE.Euler();
const scale = new THREE.Vector3();
let seed = 1;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

// 開串流的話**不預先擺放**：內容由 `load(cx, cz, place)` 回答，
// 而它只在相機走到附近時才被問到。
if (!useStream) {
  for (let i = 0; i < COUNT; i++) {
    position.set((rand() - 0.5) * SPREAD, 0, (rand() - 0.5) * SPREAD);
    euler.set(rand() * 6.283, rand() * 6.283, rand() * 6.283);
    quaternion.setFromEuler(euler);
    const s = 0.6 + rand() * 2.4;
    scale.set(s, s, s);
    rocks.setMatrixAt(i, matrix.compose(position, quaternion, scale));
  }
}
scene.add(rocks);

// ── 並存：一個普通的 Mesh，套件完全不碰它 ────────────────────────────
const walker = new THREE.Mesh(
  new THREE.CapsuleGeometry(1.2, 2.4, 8, 16),
  new THREE.MeshStandardMaterial({ color: 0x58a6ff }),
);
scene.add(walker);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(SPREAD * 1.6, SPREAD * 1.6),
  new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1;
scene.add(ground);

if (useShadows) {
  rocks.castShadow = true;
  walker.castShadow = true;
  ground.receiveShadow = true;
}

// ── 後處理：完全是使用者那一側的東西，套件不參與 ─────────────────────
//
// `EffectComposer` 把場景畫進 render target 而不是畫布。這對套件有一個
// 具體的影響：螢幕誤差的分母是**那張 target 的高度**，不是畫布高度。
// 半解析度的 composer 若用畫布高度算，每個物件都會選到太細的階 ——
// 白付三角形，而且看不出來（畫面完全正確，只是慢）。
const composer = usePost ? new EffectComposer(renderer) : null;
if (composer !== null) {
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(
    new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.5, 0.85),
  );
  composer.addPass(new OutputPass());
  composer.setSize(innerWidth, innerHeight);
}

// ── 串流：世界比記憶體大 ─────────────────────────────────────────────
//
// 使用者只回答一個問題：**這一格裡有什麼**。何時載入、何時卸載、先載哪個、
// 一幀載幾個、邊界上怎麼不抖，全部是套件的事。
const world = enhanced ? WW.worldFor(scene) : null;

const CELL_SIZE = 120;
const PER_CELL = 400;

if (useStream && world !== null) {
  world.stream({
    cellSize: CELL_SIZE,
    radius: 600,
    load(cx, cz, place) {
      // 決定性的：座標算出種子，所以走出去再走回來是同一批石頭。
      // 不決定性的內容會讓「回頭發現世界變了」，而那種 bug 在巡遊測試裡
      // 表現為「記憶體沒漏但畫面對不上」。
      let s = (cx * 73_856_093) ^ (cz * 19_349_663);
      const rnd = (): number => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
      for (let i = 0; i < PER_CELL; i++) {
        position.set((cx + rnd()) * CELL_SIZE, 0, (cz + rnd()) * CELL_SIZE);
        euler.set(rnd() * 6.283, rnd() * 6.283, rnd() * 6.283);
        quaternion.setFromEuler(euler);
        const size = 0.6 + rnd() * 2.4;
        // 刻意重複使用同一個 Matrix4 —— 那是 Three.js 的慣例，介面必須撐得住。
        place(rocks as WW.InstancedMesh, matrix.compose(position, quaternion, scale.setScalar(size)));
      }
    },
  });
}
/** 這個頁面一共畫了幾幀。site-check 用它驗「不畫就不做事」。 */
let totalFrames = 0;
let windowFrames = 0;
let windowStart = 0;
let fps = 0;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  composer?.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop((time) => {
  const t = time / 1000;
  const radius = 260;
  camera.position.set(Math.cos(t * 0.12) * radius, 14, Math.sin(t * 0.12) * radius);
  camera.lookAt(Math.cos(t * 0.12 + 1.2) * 60, 8, Math.sin(t * 0.12 + 1.2) * 60);
  walker.position.set(camera.position.x * 0.9, 1.4, camera.position.z * 0.9);

  renderFrame();

  // 滑動視窗，不是開機以來的平均 —— 平均會把切換場景前後的兩段混在一起。
  windowFrames++;
  totalFrames++;
  if (time - windowStart >= 500) {
    fps = Math.round((windowFrames * 1000) / (time - windowStart));
    windowStart = time;
    windowFrames = 0;
    updateHud();
  }
});

function updateHud(): void {
  const info = renderer.info.render;
  const extras = [
    usePost ? 'post' : null,
    useShadows ? 'shadows' : null,
    useAutoLod ? 'autolod' : null,
    useCooked ? 'cooked' : null,
    useStream ? 'stream' : null,
  ].filter(Boolean);
  const lines = [
    `instance        ${COUNT.toLocaleString()}${extras.length > 0 ? `   [${extras.join(' ')}]` : ''}`,
    `draw calls      ${info.calls.toLocaleString()}`,
    `triangles       ${info.triangles.toLocaleString()}`,
    `fps (0.5 秒)    ${fps}`,
    '',
  ];

  if (world !== null) {
    const s = world.stats;
    const levels = Array.from((rocks as WW.InstancedMesh).stats.levels);
    lines.push(
      `<b>WW.InstancedMesh</b>`,
      `可見            ${s.visible.toLocaleString()} / ${s.instances.toLocaleString()}`,
      `逐一測試        ${s.tested.toLocaleString()}  (空間分割省下 ${(s.instances - s.tested).toLocaleString()})`,
      `可見 cell       ${s.visibleCells} / ${s.cells}`,
      `LOD 各階        ${levels.join(' / ')}`,
    );
    const lod = (rocks as WW.InstancedMesh).lodStats;
    if (lod !== null) {
      lines.push(
        `LOD 產生        ${lod.generationMs.toFixed(1)} ms ${lod.offMainThread ? '(worker)' : '(主執行緒！)'}`,
        `  主執行緒付了  ${lod.mainThreadMs.toFixed(1)} ms（複製 + 接回批次幾何）`,
      );
    }
    if (lodBlocking !== null) {
      // 這個數字量的是**整個頁面**的主執行緒空窗，含模組載入、擺放兩萬個
      // 矩陣、首次繪製。它是上界，不是 LOD 的成本 —— LOD 的成本是上一行。
      lines.push(`  頁面最長空窗  ${lodBlocking.worstMainThreadGapMs} ms（含啟動，不只 LOD）`);
    }
    const streaming = world.streaming;
    if (streaming !== null) {
      const s = streaming.stats;
      lines.push(
        `常駐 cell       ${s.resident}（載入中 ${s.loading}，排隊 ${s.pending}）`,
        `累計            載入 ${s.totalLoads} / 卸載 ${s.totalUnloads}`,
      );
    }
    lines.push(
      `<a href="?ww=0&count=${COUNT}">→ 換回 THREE.InstancedMesh</a>`,
    );
  } else {
    lines.push(
      `<span class="off">THREE.InstancedMesh（原生）</span>`,
      `沒有 LOD、沒有空間分割 —— 但程式照樣跑。`,
      '',
      `<a href="?count=${COUNT}">→ 換成 WW.InstancedMesh</a>`,
    );
  }

  hud.innerHTML = lines.join('\n');
}

/**
 * 給自動化檢查用的把手。
 *
 * 分頁不在前景時瀏覽器不會派送 `requestAnimationFrame`，所以無頭的驗證
 * 沒辦法靠動畫迴圈 —— 必須能自己推一幀。這也是「畫進使用者的 scene」
 * 這個決定的附帶好處：從外面拿到 `renderer` 就能完整重現一幀。
 */
function step(t = 0): void {
  // 開串流的話走直線遠離原點 —— 繞圈永遠只碰到同一批 cell，量不出
  // 「一直載入一直卸載」會不會漏。
  if (useStream) {
    camera.position.set(t * 40, 14, t * 40);
    camera.lookAt(t * 40 + 100, 8, t * 40 + 100);
  } else {
    const radius = 260;
    camera.position.set(Math.cos(t * 0.12) * radius, 14, Math.sin(t * 0.12) * radius);
    camera.lookAt(Math.cos(t * 0.12 + 1.2) * 60, 8, Math.sin(t * 0.12 + 1.2) * 60);
  }
  renderFrame();
}

/**
 * 真正把一幀交出去的地方。
 *
 * **動畫迴圈與手動推幀都必須走這裡。** 兩邊各寫一份 render 呼叫的話，
 * 加在其中一邊的東西（例如下面那個計時）在另一邊就不存在，而兩條路
 * 看起來都正常。
 */
function renderFrame(): void {
  if (composer !== null) composer.render();
  else renderer.render(scene, camera);

  // 第一幀送出去的時刻。網站在意的是「多久之後看得到東西」，而那是從
  // 導覽開始算的 —— `performance.now()` 的原點正是導覽起點。
  //
  // 量的是「我們把這一幀交給 GPU 的時間」，不是「像素真的出現在螢幕上」。
  // 兩者差一個 present，但後者從頁面裡量不到，硬報一個數字會比誠實地
  // 少報一段更糟。
  firstFrameMs ??= performance.now();
}

/** 第一幀送出去的時刻，毫秒，從導覽開始算。還沒畫過就是 null。 */
let firstFrameMs: number | null = null;

/**
 * 長時間巡遊之後有沒有漏。
 *
 * 記憶體漂移是串流唯一真正重要的正確性條件，而它在幀時間上完全看不出來
 * —— 漏掉的東西只會讓分頁在十分鐘後被瀏覽器殺掉。
 *
 * `renderer.info.memory` 是確定性的（幾何與貼圖的數量），JS heap 則會受
 * GC 時機影響，所以兩個都報，並且說明哪個能下結論。
 */
async function measureStreamDrift(ticks = 400): Promise<unknown> {
  if (!useStream || world === null) return { skipped: '沒有開串流' };
  const heap = (): number =>
    (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;

  // 先跑一段讓常駐集合進入穩態，再開始量 —— 從冷啟動量會把「填滿」
  // 算成「漏」。
  for (let i = 0; i < 100; i++) {
    step(i * 0.25);
    await Promise.resolve();
  }
  const before = {
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    heapMB: +(heap() / 1048576).toFixed(2),
    instances: (rocks as WW.InstancedMesh).count,
    capacity: (rocks as WW.InstancedMesh).capacity,
    loads: world.streaming!.stats.totalLoads,
  };

  for (let i = 100; i < 100 + ticks; i++) {
    step(i * 0.25);
    await Promise.resolve();
  }
  const after = {
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    heapMB: +(heap() / 1048576).toFixed(2),
    instances: (rocks as WW.InstancedMesh).count,
    capacity: (rocks as WW.InstancedMesh).capacity,
    loads: world.streaming!.stats.totalLoads,
  };

  return {
    ticks,
    before,
    after,
    cellsTravelled: after.loads - before.loads,
    stats: world.streaming!.stats,
  };
}

/**
 * 品質契約的實測：**同一個畫面，強化版與原生版差多少？**
 *
 * 契約是「幾何誤差投影到螢幕上 ≤ errorPixels」，所以正確的比對不是逐像素
 * 相等，而是「強化版的每個像素，在原生版的 ±R 鄰域裡找得到相符的顏色」。
 * 逐像素比對會被輪廓平移到隔壁的抗鋸齒差異淹沒，然後這個檢查就會被忽略。
 *
 * 參考影像用一個真的 `THREE.InstancedMesh` 畫 —— 那是完全獨立的路徑，
 * 不是同一份程式碼換個參數。同一份實作自己驗自己驗不出什麼。
 *
 * 回傳的 `outsideContract` 不保證是 0：輪廓落在不同的像素邊界上時，
 * 抗鋸齒混出來的顏色可能在鄰域裡根本不存在。判讀的方式是看它**集中在
 * 哪裡** —— `meanGradientAtOutside` 遠高於 `meanGradientOverall` 就代表
 * 差異都在輪廓上（合約允許的位移），而不是整片區域的著色變了。
 */
async function verifyQuality(t = 2, radiusPixels = 2, threshold = 8): Promise<unknown> {
  if (!enhanced) return { skipped: '這個模式本身就是原生版，沒有東西可以比' };

  // ## 串流的內容要先凍住
  //
  // 兩張圖之間如果還有 cell 在載入卸載，差的就不是畫質而是內容 —— 那種
  // 比對永遠會紅，然後整個檢查就會被當成雜訊忽略。
  //
  // `stopStream` 只停止載入卸載，已經在的東西留著，所以凍住之後比的
  // 仍然是一個真實的串流畫面。
  if (useStream && world !== null) world.stopStream();
  // 串流時真正活著的是 `rocks.count`，不是建構時的容量。
  const live = rocks.count;

  const width = 640;
  const height = 360;
  renderer.setSize(width, height, false);
  // composer 有自己的 render target，不跟著 renderer 走 —— 忘了它的話
  // 場景會用舊尺寸畫，然後被拉伸貼到新畫布上。
  composer?.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  // ## 擷取之前要先讓合併穩定下來
  //
  // 上面把畫布改成 640×360，而每像素的投影比例變了就會改變「哪幾格夠遠到
  // 可以合併」—— 於是縮放完的第一幀正好落在重新烘焙的中間。
  //
  // 那不是畫質問題，但它會讓這個檢查的數字每次都不一樣（實測鄰域外像素在
  // 959 與 1990 之間跳，梯度比 8.7 對 4.2）。一個會晃兩倍的檢查沒有人擋得住
  // 任何東西。
  const SETTLE_FRAMES = 60;
  for (let i = 0; i < SETTLE_FRAMES; i++) step(t);

  const capture = (): Promise<ImageData> => {
    step(t);
    const url = renderer.domElement.toDataURL('image/png');
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = (): void => {
        const surface = document.createElement('canvas');
        surface.width = width;
        surface.height = height;
        const ctx = surface.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        resolve(ctx.getImageData(0, 0, width, height));
      };
      image.onerror = reject;
      image.src = url;
    });
  };

  const enhancedPixels = await capture();

  // 參考：原生 InstancedMesh，最細的幾何，不剔除、不選階
  const reference = new THREE.InstancedMesh(lods[0]!, material, Math.max(live, 1));
  reference.count = live;
  reference.castShadow = rocks.castShadow;
  const copy = new THREE.Matrix4();
  for (let i = 0; i < live; i++) {
    (rocks as WW.InstancedMesh).getMatrixAt(i, copy);
    reference.setMatrixAt(i, copy);
  }
  rocks.visible = false;
  scene.add(reference);
  const nativePixels = await capture();
  scene.remove(reference);
  reference.dispose();
  rocks.visible = true;

  return {
    instances: live,
    streaming: useStream,
    ...(compare(enhancedPixels.data, nativePixels.data, width, height, radiusPixels, threshold) as object),
  };
}

function compare(
  test: Uint8ClampedArray,
  reference: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  threshold: number,
): unknown {
  const luminance = (d: Uint8ClampedArray, i: number): number =>
    0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  const gradient = (d: Uint8ClampedArray, x: number, y: number): number => {
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return 0;
    const i = (y * width + x) * 4;
    return (
      Math.abs(luminance(d, i + 4) - luminance(d, i - 4)) +
      Math.abs(luminance(d, i + width * 4) - luminance(d, i - width * 4))
    );
  };

  let outside = 0;
  let worst = 0;
  let outsideGradient = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let best = 255;
      for (let dy = -radius; dy <= radius && best > threshold; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius && best > threshold; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = (yy * width + xx) * 4;
          const d = Math.max(
            Math.abs(reference[j]! - test[i]!),
            Math.abs(reference[j + 1]! - test[i + 1]!),
            Math.abs(reference[j + 2]! - test[i + 2]!),
          );
          if (d < best) best = d;
        }
      }
      if (best > threshold) {
        outside++;
        outsideGradient += gradient(reference, x, y);
      }
      if (best > worst) worst = best;
    }
  }

  let overallGradient = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      overallGradient += gradient(reference, x, y);
      samples++;
    }
  }

  return {
    radiusPixels: radius,
    outsideContract: outside,
    percent: +((100 * outside) / (width * height)).toFixed(3),
    worstUnmatched: worst,
    meanGradientAtOutside: +(outsideGradient / Math.max(outside, 1)).toFixed(1),
    meanGradientOverall: +(overallGradient / samples).toFixed(1),
  };
}

/**
 * 給自動化檢查用的把手。
 *
 * 分頁不在前景時瀏覽器不會派送 `requestAnimationFrame`，所以無頭的驗證
 * 沒辦法靠動畫迴圈 —— 必須能自己推一幀。這也是「畫進使用者的 scene」
 * 這個決定的附帶好處：從外面拿到 `renderer` 就能完整重現一幀。
 */
/**
 * 量「LOD 產生有沒有卡住主執行緒」。
 *
 * 光看 `lodReady` 什麼時候 resolve 是不夠的 —— 在主執行緒上跑一樣會
 * resolve，只是期間畫面凍住。所以量的是**主執行緒的最長空窗**：持續用
 * `setTimeout(0)` 打點，記錄相鄰兩點之間最久的一次。
 *
 * worker 正常運作時那個數字是個位數毫秒；退回主執行緒時它會等於整段
 * 簡化的時間。
 */
interface LodBlockingReport {
  levels: number;
  totalMs: number;
  worstMainThreadGapMs: number;
  ticks: number;
}

let lodBlocking: LodBlockingReport | null = null;

async function measureLodBlocking(): Promise<LodBlockingReport | { skipped: string }> {
  if (!enhanced) return { skipped: '原生版沒有 LOD 產生' };

  const started = performance.now();
  let last = started;
  let worstGapMs = 0;
  let ticks = 0;
  let running = true;

  const tick = (): void => {
    const now = performance.now();
    const gap = now - last;
    if (gap > worstGapMs) worstGapMs = gap;
    last = now;
    ticks++;
    if (running) setTimeout(tick, 0);
  };
  tick();

  await (rocks as WW.InstancedMesh).lodReady;
  running = false;

  lodBlocking = {
    levels: (rocks as WW.InstancedMesh).levelCount,
    totalMs: +(performance.now() - started).toFixed(1),
    worstMainThreadGapMs: +worstGapMs.toFixed(1),
    ticks,
  };
  updateHud();
  return lodBlocking;
}

// 從一開始就量，不然等到有人呼叫時 LOD 早就產生完了 —— 那會量到 0，
// 而 0 看起來像是「完全沒有卡頓」的好消息。
if (enhanced) void measureLodBlocking();

Object.assign(window, {
  __ww: {
    renderer,
    scene,
    camera,
    rocks,
    world,
    enhanced,
    get firstFrameMs() {
      return firstFrameMs;
    },
    get totalFrames() {
      return totalFrames;
    },
    verifyQuality,
    measureStreamDrift,
    measureLodBlocking,
    step(t = 0): void {
      step(t);
      updateHud();
    },
  },
});
