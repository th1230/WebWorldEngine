import * as WW from '@webworld/three';
import { Matrix4, OrthographicCamera, WebGLRenderTarget } from 'three';
import { makeSkinnedField, makeSkinnedRig } from './skinned.ts';
import { makeWaterScene } from './water-scene.ts';
import { makePhysicsScene, type PhysicsScene } from './physics-scene.ts';
import { makeGiScene, type GiScene } from './gi-scene.ts';
import { makeBigMesh, type BigMeshScene } from './big-mesh.ts';
import { makeTextureHeavy, type TextureHeavyScene } from './texture-heavy.ts';
import { makeVirtualTextureScene, type VirtualTextureScene } from './virtual-texture-scene.ts';
import { makeImpostorScene, type ImpostorScene } from './impostor-scene.ts';
import { measureOccluded, occludedIds } from './occlusion-probe.ts';
import { makeTerrain, makeTerrainSystem } from './terrain.ts';
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
/**
 * `?shadows=csm` 走世界尺度的陰影（cascaded shadow maps）。
 *
 * 單一 shadow map 要罩住廣闊地形時，解析度被範圍除爛 —— 近處的陰影糊成
 * 一團。CSM 把視錐切成幾段，每段自己一張 map，近處那段的解析度就不必為了
 * 遠處犧牲。
 *
 * 這是「世界很大本身帶來的問題」，不是效能問題：範圍拉大到某個程度，
 * 單張 map 的陰影就**不成立**，而不是變慢。
 */
const useCsm = params.get('shadows') === 'csm';
const useAutoLod = params.get('autolod') === '1';
const useCooked = params.get('cooked') === '1';
const useStream = params.get('stream') === '1';
const COOKED_MANIFEST = '/cooked/assets.manifest.json';
const COOKED_MESH = params.get('mesh') ?? 'mesh:rock-large';
const COUNT = Number(params.get('count') ?? 60_000);
/**
 * 分離變因用的兩個開關。
 *
 * 強化版與原生版的畫面差異可能來自三件事：批次幾何的屬性佈局、LOD 選階、
 * 遠景合併。一次關掉一個才知道是哪一個 —— 沒有這兩個參數就只能猜。
 */
/**
 * 品質契約的門檻，像素。省略就用套件的預設（2）。
 *
 * 開成參數是為了量「契約值多少錢」。誤差改成真的量出來之後，遠景那組的
 * GPU 時間從 6.5 ms 變成 16.9 ms —— 那不是變慢了，是**以前沒有真的守住
 * 2 像素**（回報的誤差低估最多 1.48 倍，於是選到太粗的階）。
 *
 * 把門檻放寬回去應該要能拿回那個差，而那正是這個參數存在的理由：讓
 * 「契約多嚴」變成一個量得出價錢的選擇，而不是一句話。
 */
const ERROR_PIXELS = params.has('errorPixels')
  ? Number(params.get('errorPixels'))
  : undefined;

/** `?extendLod=1` 開啟引擎自己接更粗的階（套件裡預設關）。 */
const EXTEND_LOD = params.get('extendLod') === '1';

/**
 * `?skinned=N` 換成 N 個各自有骨架的 `THREE.SkinnedMesh`。
 *
 * 這是「會動的東西」那條軸的量尺：這個套件對蒙皮**完全無能為力**
 * （`BatchedMesh` 不支援），所以要先知道原生的成本怎麼隨數量成長，
 * 才知道有沒有值得做的東西、以及上限在哪。
 */
const SKINNED = params.has('skinned') ? Number(params.get('skinned')) : 0;
/** `?vat=N` 同樣的 rig，但烘成貼圖用 `WW.AnimatedInstancedMesh` 畫。 */
const VAT = params.has('vat') ? Number(params.get('vat')) : 0;
/**
 * `?rebase=N` 開原點重定位，門檻 N 單位。
 *
 * 這個開關存在的理由是它**從來沒有真的跑過**：單元測試驗得了「矩陣被平移
 * 了」，驗不了「平移之後畫面還是對的」。而它會重寫所有 instance 的矩陣、
 * 搬相機、搬遠景合併的分組中心 —— 任何一個漏掉都是畫面出事而不是報錯。
 */
const REBASE = params.has('rebase') ? Number(params.get('rebase')) : 0;
/** `?water=1` 畫一片會動的水，並讓一批球浮在上面。 */
const WATER = params.get('water') === '1';
/** `?physics=1` 有碰撞的地表 + 會掉會浮的箱子（求解器用 Rapier）。 */
const PHYSICS = params.get('physics') === '1';
/** `?gi=1` 紅房間 + 白箱子，用來證明間接光真的是反彈來的。 */
const GI = params.get('gi') === '1';
/**
 * `?bigMesh=段數` 一份很大的單一幾何。配 `?split=塊數` 用切塊工具切開；
 * `?split=0`（預設）是對照組：整片一份、一個物件。
 */
const BIG_MESH = params.has('bigMesh') ? Number(params.get('bigMesh')) : 0;
/**
 * `?textures=張數&texSize=邊長` 一堆各自不同的貼圖。
 *
 * 用來問「貼圖資料超過 VRAM 的時候今天會怎樣」—— 那是虛擬貼圖那條軸的
 * 第一步，而不是虛擬貼圖本身。
 */
const TEXTURES = params.has('textures') ? Number(params.get('textures')) : 0;
/**
 * `?trees=數量` 一片樹林。`?impostor=1` 換成看板。
 *
 * 兩邊同樣的數量、同樣的位置、同樣的相機 —— 只換表示法。
 */
const TREES = params.has('trees') ? Number(params.get('trees')) : 0;
const USE_IMPOSTOR = params.get('impostor') === '1';
const TEX_SIZE = Number(params.get('texSize') ?? 512);
/** `?texStack=1` 疊成一疊，讓每一張都被高解析度取樣（工作集 = 總量）。 */
const TEX_STACK = params.get('texStack') === '1';
const SPLIT = Number(params.get('split') ?? 0);
/** `?scatter=1` 用規則式擺放代替亂數灑點。 */
const SCATTER = params.get('scatter') === '1';
/** `?vatLod=0` 關掉 VAT 那條路的 LOD —— 要與蒙皮基準比同樣的三角形數時用。 */
const VAT_LOD = params.get('vatLod') !== '0';
/**
 * `?glb=BrainStem` 拿**真的**骨骼資產來烘，而不是程序化的圓柱。
 *
 * 程序化那根回答得了「成本怎麼隨數量成長」，回答不了「真的資產上長什麼樣」
 * ——真的資產有 4 個骨骼影響、59 個 primitive、不平均的權重。準則說
 * 「絕對吞吐量不能從程序化的內容推論」，這個參數就是去補那一塊。
 */
const GLB = params.get('glb');

/**
 * `?terrain=T` 換成一片地表，切成 T×T 塊。
 *
 * `terrain=1` 是「整塊一份幾何」（今天直接把地表丟進 Three 的樣子），
 * 大於 1 就是逐塊選階與逐塊剔除。兩者的差就是「大地表」那條軸的標價。
 */
const TERRAIN = params.has('terrain') ? Number(params.get('terrain')) : 0;
/** 每一塊切幾格。總三角形數 = terrain² × seg² × 2，兩種擺法要固定它才可比。 */
const TERRAIN_SEG = Number(params.get('terrainSeg') ?? 64);
/** `?terrainMulti=1` 把所有塊裝進同一個 `WW.MultiMesh`，而不是一塊一個物件。 */
const TERRAIN_MULTI = params.get('terrainMulti') === '1';
/** `?terrainSystem=1` 用套件的 `WW.buildTerrain`（逐塊 LOD 鏈 + 裙邊）。 */
const TERRAIN_SYSTEM = params.get('terrainSystem') === '1';

const NO_HLOD = params.get('hlod') === '0';
/** `?occlusion=1` 開遮蔽剔除。預設關 —— 它值不值得看內容有多密。 */
const OCCLUSION = params.get('occlusion') === '1';
const SINGLE_LOD = params.get('lodLevels') === '1';

/**
 * 遠景合併的記憶體預算，MB。省略就用套件的預設。
 *
 * `tools/visual-check` 會把它調大 —— 預設值下這份程序化內容的槽位遠少於
 * 可合併的格數（實測 60 對 443），於是**哪幾格是合併的每一幀都在變**，
 * 畫面比對就永遠不穩。兩種畫法都在契約內，但那讓檢查讀不出程式碼的差異。
 */
const HLOD_BUDGET_MB = params.has('hlodBudgetMB')
  ? Number(params.get('hlodBudgetMB'))
  : undefined;
/**
 * 內容鋪多大、每個多大、相機繞多遠。
 *
 * 開成參數是為了 `tools/visual-check` —— 預設那組（兩萬個又遠又小）
 * **量不出畫質退步**：每個物件在螢幕上只有幾個像素，本來就全部在最粗階，
 * 所以選階算錯也看不出來。要驗畫質就得讓物件在螢幕上很大。
 */
const SPREAD = Number(params.get('spread') ?? 900);
const SIZE = Number(params.get('size') ?? 1);
const ORBIT = Number(params.get('orbit') ?? 260);

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;

/**
 * `?verify=1` 時保留繪圖緩衝。
 *
 * `toDataURL` 讀的是繪圖緩衝，而預設情況下瀏覽器**合成完就可以把它清掉**。
 * 所以「畫完馬上讀」大多數時候讀得到，偶爾讀到空的 —— 實測掃八個角度會
 * 有一個爆掉，而且每次爆的是不同的角度。那正是這個檢查一直不穩的另一半。
 *
 * 只在驗證時開：它會讓瀏覽器多留一份緩衝，那是真實網站不需要付的成本。
 */
/**
 * `?aa=0` 關掉抗鋸齒。
 *
 * 存在的理由是一個具體的問題：`extendLodChain` 量到省 27.7%，但它預設關，
 * 因為 visual-check 的「多畫」是 0.471% 而門檻是 0.45%。roadmap 當時留下
 * 兩個都成立的解釋 ——（a）誤差還有殘餘的低估，（b）更多輪廓落在容忍邊界上，
 * 於是抗鋸齒把更多像素推到界外。
 *
 * 那兩個分得開：如果是（b），關掉抗鋸齒之後那個數字應該掉下來，而**乾淨
 * 基準不會掉一樣多**。所以這個開關不是為了跑得快，是為了問一個問題。
 */
const NO_AA = params.get('aa') === '0';

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !NO_AA,
  preserveDrawingBuffer: params.get('verify') === '1',
});
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
if (useShadows || useCsm) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // ## 太陽要放低
  //
  // 預設那個位置（120, 200, 80）幾乎在正上方，於是每個東西的影子都落在
  // 自己底下、被自己擋住 —— 畫面上「看起來沒有陰影」。
  //
  // 第一次驗 CSM 就是這樣白跑一輪：兩張截圖都沒有影子，而我差點把它讀成
  // 「CSM 沒接上」。低角度才看得到影子的形狀，也才是有陰影的世界該有的樣子。
  sun.position.set(320, 90, 200);
}
if (useShadows) {
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
/**
 * `?extraLod=1` 在鏈的尾巴多接一階（20 個三角形）。
 *
 * 這是一個**量鏈有沒有見底**的實驗開關，不是內容的一部分。遠景那組量到
 * 10,647 個 instance 裡有 10,647 個掛在最粗階 —— 那看起來像「引擎挑到最粗
 * 了」，但也可能是「鏈只有這麼粗，引擎想再粗也沒得挑」。
 *
 * 兩者的差別是後者代表**開發者給的鏈是瓶頸**，而那時引擎該做的是自己補
 * 更粗的階（它本來就有 worker 裡的簡化能力），不是什麼都不做。
 *
 * 分辨的方法就是接一階上去看它會不會被用到。
 */
const EXTRA_LOD = params.get('extraLod') === '1';

const lods = useAutoLod
  ? [new THREE.IcosahedronGeometry(1, 24)]
  : [
      new THREE.IcosahedronGeometry(1, 4),
      new THREE.IcosahedronGeometry(1, 2),
      new THREE.IcosahedronGeometry(1, 1),
      ...(EXTRA_LOD ? [new THREE.IcosahedronGeometry(1, 0)] : []),
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

/**
 * 世界尺度的陰影。Three 的 CSM addon，**不是自己寫的**。
 *
 * 接法用 `WW.applyShadows(csm, scene)`（見下面）—— 它會走完整個場景、
 * 每個材質接一次，而且把已經掛在上面的鉤子接住。手動逐材質呼叫的話，
 * 漏一個就是那個東西完全沒有陰影，而且不報錯。
 *
 * ## 為什麼 sun 要拿掉
 *
 * CSM 自己建了 `cascades` 盞平行光。原本那盞留著就是雙重光照 —— 畫面會
 * 過亮，而那看起來像「材質調錯」不像「多了一盞燈」。
 */
const csm = useCsm
  ? await (async () => {
      const { CSM } = await import('three/addons/csm/CSM.js');
      scene.remove(sun);
      const instance = new CSM({
        maxFar: 1200,
        cascades: 4,
        mode: 'practical',
        parent: scene,
        shadowMapSize: 2048,
        lightDirection: new THREE.Vector3(-0.85, -0.35, -0.4).normalize(),
        camera,
      });
      return instance;
    })()
  : null;

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

// 只留第 0 階 —— 那時選階不可能挑到別階，差異裡就沒有 LOD 這一項。
const usedSource: WW.GeometrySource = SINGLE_LOD
  ? (Array.isArray((source as { lods?: unknown[] }).lods)
      ? { lods: [(source as unknown as { lods: THREE.BufferGeometry[] }).lods[0]!], errors: [0] }
      : source)
  : source;

/**
 * 原生那條路要用的幾何 —— **強化版拿到的那條鏈的第 0 階**，不是模組頂層的
 * `lods`。
 *
 * `?cooked=1` 時強化版吃的是 cook 過的鏈，而 `lods` 是程序化的那一份。拿
 * `lods[0]` 當對照的話，兩邊畫的是**不同的模型**：實測原生 300,002 個三角形、
 * 強化版 2,188,802 個，而那個 7.3 倍會被讀成「強化版比較慢」。
 *
 * 這個坑 `verifyQuality` 那邊踩過一次、修好了，這裡是同一個坑的另一半。
 */
const nativeGeometry = Array.isArray((usedSource as { lods?: unknown[] }).lods)
  ? (usedSource as unknown as { lods: THREE.BufferGeometry[] }).lods[0]!
  : (usedSource as THREE.BufferGeometry);

const rocks = enhanced
  ? new WW.InstancedMesh(usedSource, material, COUNT, {
      ...(NO_HLOD ? { hlod: false } : {}),
      ...(HLOD_BUDGET_MB === undefined ? {} : { hlodBudgetMB: HLOD_BUDGET_MB }),
      ...(ERROR_PIXELS === undefined ? {} : { errorPixels: ERROR_PIXELS }),
      occlusion: OCCLUSION,
      ...(EXTEND_LOD ? { extendLodChain: true } : {}),
    })
  : new THREE.InstancedMesh(nativeGeometry, material, COUNT);
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
    const s = (0.6 + rand() * 2.4) * SIZE;
    scale.set(s, s, s);
    rocks.setMatrixAt(i, matrix.compose(position, quaternion, scale));
  }
}
scene.add(rocks);

/**
 * `?skinned=N` 時把石頭換掉，改放 N 個各自有骨架的 `SkinnedMesh`。
 *
 * 換掉而不是加上去：兩種內容混在同一幀裡的話，量到的是兩者的和，而這條軸
 * 要問的是「蒙皮這件事本身多貴」。
 */
const skinnedField = SKINNED > 0 ? makeSkinnedField(SKINNED, SPREAD, 8) : null;
if (skinnedField !== null) {
  rocks.visible = false;
  scene.add(skinnedField.root);
}

/**
 * 從 glTF 撈出第一個 `SkinnedMesh` 與第一段動畫。
 *
 * 真的資產通常是**很多個 primitive** 掛在同一副骨架上（BrainStem 有 59 個），
 * 而這裡只烘第一個 —— 這支是量尺不是完整的載入器，而「只烘一個 primitive」
 * 這件事要講出來，不然畫面上少了大半個模型會看起來像烘壞了。
 */
async function loadSkinnedGlb(name: string): Promise<{ mesh: THREE.SkinnedMesh; clip: THREE.AnimationClip } | null> {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().loadAsync(`/source-assets/gltf-sample/${name}.glb`);
  let found: THREE.SkinnedMesh | null = null;
  gltf.scene.traverse((o) => {
    if (found === null && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  const clip = gltf.animations[0];
  if (found === null || clip === undefined) {
    console.warn(`WW 範例：${name} 裡沒有找到 SkinnedMesh 或動畫，退回程序化的 rig。`);
    return null;
  }
  const mesh = found as THREE.SkinnedMesh;
  mesh.updateMatrixWorld(true);
  const primitives = (() => {
    let n = 0;
    gltf.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) n++;
    });
    return n;
  })();
  if (primitives > 1) {
    console.info(
      `WW 範例：${name} 有 ${primitives} 個蒙皮 primitive，這支量尺只烘第一個。` +
        '畫面上會少掉其餘的部分 —— 那是量尺的簡化，不是烘焙壞了。',
    );
  }
  return { mesh, clip };
}

const loadedRig = GLB !== null && VAT > 0 ? await loadSkinnedGlb(GLB) : null;

const physicsScene: PhysicsScene | null = PHYSICS ? await makePhysicsScene() : null;
if (physicsScene !== null) {
  scene.add(physicsScene.root);
  rocks.visible = false;
}

const impostorScene: ImpostorScene | null =
  TREES > 0 ? makeImpostorScene(renderer, TREES, SPREAD, USE_IMPOSTOR) : null;
if (impostorScene !== null) {
  scene.add(impostorScene.root);
  rocks.visible = false;
}

const textureHeavy: TextureHeavyScene | null =
  TEXTURES > 0 ? makeTextureHeavy(TEXTURES, TEX_SIZE, TEX_STACK) : null;

/**
 * `?vt=1`：虛擬貼圖的證明場景。
 *
 * 一張假裝出來的 16,384×16,384（pageSize 64 × 256 頁）鋪滿畫面，而真正
 * 配置的圖集只有 512×512。每一頁是純色，顏色由階數與座標算出來 —— 所以
 * 從畫面上讀一個像素就能反推取樣到的是誰。
 */
const vtScene: VirtualTextureScene | null = params.get('vt') === '1' ? makeVirtualTextureScene() : null;
/** 正交相機，讓那張平面剛好鋪滿畫布：UV (0,0) 在左下、(1,1) 在右上。 */
/** `?rewrite=P&rewriteCount=M`：**大約 P% 的幀**（交錯，不是定期）重寫 M 個矩陣。 */
const rewriteProbe = {
  every: Number(params.get('rewrite') ?? 0),
  count: Number(params.get('rewriteCount') ?? 20000),
  frame: 0,
  lastMs: 0,
  didWrite: false,
};
const rewriteMatrix = new Matrix4();

/**
 * 量測用的亂數：決定性的（重跑一樣），但**不是週期性的**。
 *
 * 先前用 `(frame * K) % 100` 當交錯，那看起來像亂數，其實是週期 100 的線性
 * 序列 —— 每一步固定跳同樣的量。這台機器的幀時間是雙峰的，兩個週期一對上，
 * 量到的就是相位差而不是效果（實測：A 組與 B 組的中位數剛好是那兩個峰）。
 *
 * 這條坑這個 session 踩了三次，每次形式都不一樣。
 */
let probeSeed = 0x9e3779b9;
function probeRandom(): number {
  probeSeed = (Math.imul(probeSeed, 1664525) + 1013904223) >>> 0;
  return probeSeed % 100;
}

/**
 * `?churn=P&churnCount=M`：大約 P% 的幀（交錯）走一次**真正的串流寫入路徑**。
 *
 * ## 為什麼不能用 setMatrixAt
 *
 * 上一個實驗用 `setMatrixAt` 重寫矩陣，量不到任何成本。但串流走的不是那條路
 * ——它走 `writeMatrices`，而那一支除了寫矩陣還會重算區塊表（`blocks.write`）
 * 並推一個 HLOD 的 append 操作。
 *
 * 也就是說上一個實驗**測錯了路徑**：它證明的是「寫矩陣本身不貴」，而那本來
 * 就不是串流做的全部。
 *
 * 這裡改成呼叫 `writeMatrices`，而且寫回**一模一樣的內容**（開場抄一份留著）。
 * 畫面因此完全不變，唯一多出來的就是那條路徑本身。
 */
/**
 * `?countToggle=P&countDelta=N`：大約 P% 的幀（交錯）把 `count` 減掉 N。
 *
 * ## 這是串流與前兩個實驗唯一還沒對上的差別
 *
 * 前兩個實驗證明了「寫矩陣本身不貴」（`setMatrixAt` 與 `writeMatrices` 都是）。
 * 但串流除了寫矩陣還會**改 instance 的數量** —— 而改 count 走的是另一條路：
 * 空間格失效、區塊表截斷、BatchedMesh 那側的繪製範圍改變。
 *
 * 攤得很開的場景裡 200,000 個只有約 6,600 個看得見，所以動最後 400 個
 * **畫面完全不變**（它們本來就被剔掉了）—— 變的只有那條路徑。
 */
const countProbe = {
  every: Number(params.get('countToggle') ?? 0),
  delta: Number(params.get('countDelta') ?? 400),
  frame: 0,
  full: 0,
  didToggle: false,
};

const churnProbe = {
  every: Number(params.get('churn') ?? 0),
  count: Number(params.get('churnCount') ?? 400),
  frame: 0,
  lastMs: 0,
  didChurn: false,
  /** 開場抄下來的那一段矩陣。內容不變，所以只抄一次。 */
  block: null as Float32Array | null,
};

const vtCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
/** 驗證用的離屏目標。用到才建。 */
let vtProbeTarget: WebGLRenderTarget | null = null;
vtCamera.position.z = 2;
if (vtScene !== null) {
  scene.add(vtScene.root);
  rocks.visible = false;
}
if (textureHeavy !== null) {
  scene.add(textureHeavy.root);
  rocks.visible = false;
}

const bigMesh: BigMeshScene | null =
  BIG_MESH > 0 ? await makeBigMesh(3000, BIG_MESH, SPLIT) : null;
if (bigMesh !== null) {
  scene.add(bigMesh.root);
  rocks.visible = false;
}

const giScene: GiScene | null = GI
  ? makeGiScene(undefined, 1, Number(params.get('probeFace') ?? 16), Number(params.get('probeRes') ?? 8))
  : null;
if (giScene !== null) {
  scene.add(giScene.root);
  rocks.visible = false;
  // 其餘內容在這支檔案後面才會加進場景，所以真正的清場放在最後（往下找
  // 「只留這一組東西」）。這裡先擋掉背景與環境貼圖。
  scene.background = new THREE.Color(0x000000);
  scene.environment = null;
}

const waterScene = WATER ? makeWaterScene(SPREAD * 0.9, 40) : null;
if (waterScene !== null) {
  scene.add(waterScene.root);
  rocks.visible = false;
}

/**
 * 原點重定位。**它會重寫所有 instance 的矩陣**，所以自己的東西也要跟著搬
 * —— 這裡示範的就是那一行。
 */
const rebase =
  REBASE > 0
    ? WW.worldFor(scene).rebaseOrigin({
        threshold: REBASE,
        onRebase(offset) {
          // 光源、地面、水面：套件不碰使用者的 Object3D，所以自己搬。
          WW.translateObject(sun, offset);
          WW.translateObject(ground, offset);
          if (waterScene !== null) WW.translateObject(waterScene.root, offset);
        },
      })
    : null;

const vatField = (() => {
  if (VAT <= 0) return null;
  // 與 `?skinned=N` 用同一根 rig —— 兩條路比的必須是同一個東西。
  const rig = loadedRig ?? makeSkinnedRig(8);
  // 烘焙是主執行緒上的一段同步工作 —— 量它，因為「要不要搬去 cook 時做」
  // 完全取決於這個數字。
  const bakeStarted = performance.now();
  const baked = WW.bakeVertexAnimation(rig.mesh, rig.clip, { frames: 32 });
  const bakeMs = performance.now() - bakeStarted;
  const mesh = new WW.AnimatedInstancedMesh(baked, rig.mesh.material as THREE.Material, VAT, {
    ...(VAT_LOD ? {} : { autoLod: false }),
  });
  const m = new THREE.Matrix4();
  let seed = 7;
  const r = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // `?size` 也要吃 —— 真實資產的模型尺度差很多（BrainStem 是公尺級的
  // 小模型），不給縮放的話畫面上只有幾個點，看起來像烘壞了。
  for (let i = 0; i < VAT; i++) {
    m.compose(
      new THREE.Vector3((r() - 0.5) * SPREAD, 0, (r() - 0.5) * SPREAD),
      new THREE.Quaternion(),
      new THREE.Vector3(SIZE, SIZE, SIZE),
    );
    mesh.setMatrixAt(i, m);
  }
  rocks.visible = false;
  scene.add(mesh);
  return { mesh, baked, bakeMs };
})();

const terrain =
  TERRAIN > 0
    ? TERRAIN_SYSTEM
      ? makeTerrainSystem(2400, TERRAIN, TERRAIN_SEG)
      : makeTerrain(2400, TERRAIN, TERRAIN_SEG, enhanced, TERRAIN_MULTI)
    : null;
if (terrain !== null) {
  rocks.visible = false;
  scene.add(terrain.root);
}

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

// 物理場景有自己的地表，原本那片平地會穿插在中間。
if (physicsScene !== null) ground.visible = false;

if (useShadows || useCsm) {
  rocks.castShadow = true;
  walker.castShadow = true;
  ground.receiveShadow = true;
}
// 一行接完整個場景。逐材質呼叫 `csm.setupMaterial` 很容易漏 —— 第一次接
// 就漏了地面，結果整片地板一點影子都沒有，而那看起來像「CSM 沒接上」。
if (csm !== null) WW.applyShadows(csm, scene);

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

/**
 * `?scatter=1` 改用規則式擺放。
 *
 * 手寫 `load` 是「這一格有幾個、各在哪」都自己算；`WW.scatter` 是宣告
 * 「密度多少、朝向怎麼給、縮放範圍多大」，決定性由它保證。
 *
 * 接在同一個 `stream` 上，所以兩種寫法**產出的東西是同一種** —— 那才
 * 比得出差別。
 */
const scattered = SCATTER
  && enhanced
    ? WW.scatter([
        {
          mesh: rocks as WW.InstancedMesh,
          density: PER_CELL / (CELL_SIZE * CELL_SIZE),
          scale: [0.6, 3],
        },
      ])
  : null;

/**
 * 串流時那幾幀為什麼比較慢 —— 量測用（tools/gpu-check/stream-hitch.mjs）。
 *
 * p95 22.4 ms 對 p50 9.6 ms 這個差距先前被記成「載入本身（建幾何、上傳）」
 * 然後就擱著了。而「建幾何」與「上傳」是兩件完全不同的事，解法也不同 ——
 * 前者要分攤，後者要換上傳方式。分不開就只能猜，所以這裡把回呼自己的時間
 * 與整幀的時間分開記。
 */
const streamProbe = {
  loadMs: 0,
  renderMs: 0,
  tickMs: 0,
  placed: 0,
  cells: 0,
  samples: [] as {
    frameMs: number;
    loadMs: number;
    placed: number;
    cells: number;
    cpuMs: number;
    hlodBuild: number;
    hlodMerge: number;
    hlodUpload: number;
    grid: number;
    bake: number;
    renderMs: number;
    tickMs: number;
    visible: number;
    mergedInstances: number;
    triangles: number;
    rewrote: boolean;
    rewriteMs: number;
    churned: boolean;
    churnMs: number;
    countToggled: boolean;
    merged: number;
  }[],
  recording: false,
};

if (useStream && world !== null) {
  world.stream({
    cellSize: CELL_SIZE,
    radius: 600,
    load(cx, cz, rawPlace) {
      // 回呼自己花了多久（產生矩陣 + 呼叫 place），與這一幀總共花多久
      // 是兩個數字。差額才是下游（寫入批次、上傳、重建）的成本。
      const probeStart = performance.now();
      streamProbe.cells++;
      const place: typeof rawPlace = (mesh, m) => {
        streamProbe.placed++;
        return rawPlace(mesh, m);
      };
      if (scattered !== null) {
        scattered(cx, cz, place, CELL_SIZE);
        streamProbe.loadMs += performance.now() - probeStart;
        return;
      }
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
        const size = (0.6 + rnd() * 2.4) * SIZE;
        // 刻意重複使用同一個 Matrix4 —— 那是 Three.js 的慣例，介面必須撐得住。
        place(rocks as WW.InstancedMesh, matrix.compose(position, quaternion, scale.setScalar(size)));
      }
      streamProbe.loadMs += performance.now() - probeStart;
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

let lastProbeTime = 0;
const animate = (time: number): void => {
  // ## 整個 rAF 回呼花多久
  //
  // 幀時間扣掉這個，剩下的是**瀏覽器把我們擋住的時間** —— GC、合成、
  // 驅動的背壓都在那裡。分不出這一段就會把「瀏覽器在忙」誤讀成
  // 「我們的程式碼慢」，然後去優化一個沒有問題的地方。
  const tickStart = streamProbe.recording ? performance.now() : 0;
  const t = time / 1000;
  const radius = ORBIT;
  camera.position.set(Math.cos(t * 0.12) * radius, 14 * SIZE, Math.sin(t * 0.12) * radius);
  camera.lookAt(Math.cos(t * 0.12 + 1.2) * (radius * 0.23), 8 * SIZE, Math.sin(t * 0.12 + 1.2) * (radius * 0.23));
  walker.position.set(camera.position.x * 0.9, 1.4, camera.position.z * 0.9);

  // ## 送指令的時間，不是 GPU 的時間
  //
  // 這兩個要分開：主執行緒**卡在上傳**的話，這個數字會跟著尖峰一起漲；
  // 而如果它很短但幀很長，那就是 GPU 那邊比較忙（畫的東西變多了），
  // 那是另一回事，也不該用「分攤上傳」去解。
  const renderStart = streamProbe.recording ? performance.now() : 0;
  renderFrame();
  if (streamProbe.recording) streamProbe.renderMs = performance.now() - renderStart;

  // ## 只重寫矩陣，內容完全不變
  //
  // 串流的尖峰量到的是：同樣的三角形、同樣（更少）的 JS，而下一次 rAF
  // 被押後 20–30 ms。最合理的解釋是驅動那側改寫 instance 緩衝時的同步，
  // 但那是**推論**。
  //
  // 這裡把它變成可以驗的：場景完全靜止（沒有串流、沒有內容變動），只是
  // 每 N 幀把一批矩陣**用同樣的值再寫一次**。畫面一模一樣、JS 幾乎沒變，
  // 唯一多出來的就是那次緩衝改寫。尖峰跟著出現的話，因果就成立了。
  // ## 要交錯，不能定期
  //
  // 第一版是「每 12 幀重寫一次」，量出來重寫的那幾幀比沒重寫的**快 14 ms**
  // ——那顯然不是重寫造成的。這台機器的幀時間是雙峰的，固定週期會跟那個節奏
  // 對上，於是量到的是相位差，不是效果。
  //
  // 改成用幀號的雜湊決定寫不寫：一樣是決定性的（重跑結果一樣），但不會跟
  // 任何固定週期對上。`rewrite` 因此是**百分比**，不是週期。
  const rewriteRoll = probeRandom();
  if (rewriteProbe.every > 0 && rewriteRoll < rewriteProbe.every) {
    const mesh = rocks as WW.InstancedMesh;
    const start = performance.now();
    for (let i = 0; i < rewriteProbe.count && i < mesh.count; i++) {
      mesh.getMatrixAt(i, rewriteMatrix);
      mesh.setMatrixAt(i, rewriteMatrix);
    }
    rewriteProbe.lastMs = performance.now() - start;
    rewriteProbe.didWrite = true;
  } else {
    rewriteProbe.lastMs = 0;
    rewriteProbe.didWrite = false;
  }
  rewriteProbe.frame++;

  // 真正的串流寫入路徑，交錯地跑。
  const churnRoll = probeRandom();
  if (churnProbe.every > 0 && churnRoll < churnProbe.every) {
    const mesh = rocks as WW.InstancedMesh;
    if (churnProbe.block === null) {
      const n = Math.min(churnProbe.count, mesh.count);
      const block = new Float32Array(n * 16);
      for (let i = 0; i < n; i++) {
        mesh.getMatrixAt(i, rewriteMatrix);
        block.set(rewriteMatrix.elements, i * 16);
      }
      churnProbe.block = block;
    }
    const start = performance.now();
    mesh.writeMatrices(0, churnProbe.block);
    churnProbe.lastMs = performance.now() - start;
    churnProbe.didChurn = true;
  } else {
    churnProbe.lastMs = 0;
    churnProbe.didChurn = false;
  }
  churnProbe.frame++;

  // 改 count —— 交錯，而且畫面不變（動到的是本來就被剔掉的那些）。
  if (countProbe.every > 0) {
    const mesh = rocks as WW.InstancedMesh;
    if (countProbe.full === 0) countProbe.full = mesh.count;
    const roll = probeRandom();
    countProbe.didToggle = roll < countProbe.every;
    mesh.count = countProbe.didToggle ? Math.max(0, countProbe.full - countProbe.delta) : countProbe.full;
    countProbe.frame++;
  }

  if (streamProbe.recording) {
    // **這一幀的，不是上一幀的。** 本來寫在 animate 結尾，而取樣在那之前
    // ——於是每一筆記到的都是前一幀的值。症狀很明顯卻很容易看漏：renderMs
    // 大於 tickMs，而後者本來就包著前者。
    streamProbe.tickMs = performance.now() - tickStart;
    // 幀時間用 rAF 的間隔 —— 量 renderFrame() 只量到送指令，那個坑踩過了。
    if (lastProbeTime > 0) {
      // 引擎自己的分項照抄一份 —— 尖峰跟哪一項一起動，比猜快得多。
      const st = (rocks as WW.InstancedMesh).stats;
      streamProbe.samples.push({
        frameMs: time - lastProbeTime,
        loadMs: streamProbe.loadMs,
        placed: streamProbe.placed,
        cells: streamProbe.cells,
        cpuMs: st.cpuMs,
        hlodBuild: st.hlod.buildMs,
        hlodMerge: st.hlod.mergeMs,
        hlodUpload: st.hlod.uploadMs,
        grid: st.cpuParts.grid,
        bake: st.cpuParts.bake,
        renderMs: streamProbe.renderMs,
        tickMs: streamProbe.tickMs,
        visible: st.visible,
        mergedInstances: st.mergedInstances,
        triangles: renderer.info.render.triangles,
        rewrote: rewriteProbe.didWrite,
        rewriteMs: rewriteProbe.lastMs,
        churned: churnProbe.didChurn,
        churnMs: churnProbe.lastMs,
        countToggled: countProbe.didToggle,
        merged: st.merged,
      });
    }
    lastProbeTime = time;
    streamProbe.loadMs = 0;
    streamProbe.placed = 0;
    streamProbe.cells = 0;
  }

  // 滑動視窗，不是開機以來的平均 —— 平均會把切換場景前後的兩段混在一起。
  windowFrames++;
  totalFrames++;
  if (time - windowStart >= 500) {
    fps = Math.round((windowFrames * 1000) / (time - windowStart));
    windowStart = time;
    windowFrames = 0;
    updateHud();
  }
};
renderer.setAnimationLoop(animate);

function updateHud(): void {
  const info = renderer.info.render;
  const extras = [
    usePost ? 'post' : null,
    useShadows ? 'shadows' : null,
    useCsm ? 'shadows:csm' : null,
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
let lastT = 0;

function step(t = 0): void {
  lastT = t;
  // 開串流的話走直線遠離原點 —— 繞圈永遠只碰到同一批 cell，量不出
  // 「一直載入一直卸載」會不會漏。
  if (useStream) {
    camera.position.set(t * 40, 14 * SIZE, t * 40);
    camera.lookAt(t * 40 + 100, 8 * SIZE, t * 40 + 100);
  } else if (terrain !== null) {
    // ## 地表要**貼著地面往地平線看**
    //
    // 從高處俯瞰的話整片地表離相機的距離差不多，而那正好把這條軸要問的東西
    // 消掉了：逐區域選階的價值全部來自「同一個物件橫跨很大的深度範圍」。
    //
    // 所以相機壓低、看向遠方 —— 腳下清清楚楚、地平線那端只有幾個像素。
    camera.position.set(Math.cos(t * 0.12) * 900, 40, Math.sin(t * 0.12) * 900);
    camera.lookAt(0, 10, 0);
  } else if (impostorScene !== null) {
    // 貼著地面繞一圈 —— impostor 的破綻（挑錯格、看板轉不過去）只有在
    // 相機繞著看的時候才露出來。
    // `?treeDist=` 決定相機站多遠 —— impostor 只在夠遠的地方才成立，
    // 而「多遠才算夠」正是要量的東西。
    const dist = Number(params.get('treeDist') ?? SPREAD * 0.5);
    camera.position.set(Math.cos(t * 0.15) * dist, 12 + dist * 0.08, Math.sin(t * 0.15) * dist);
    camera.lookAt(0, 6, 0);
  } else if (textureHeavy !== null) {
    // 從上方俯瞰整片 —— 要讓每一張貼圖都真的被取樣到，光是配置記憶體
    // 不會逼出換頁。
    if (TEX_STACK) {
      // 正對那片磁磚，距離讓它剛好填滿畫面。
      camera.position.set(0, 0, 104);
      camera.lookAt(0, 0, 0);
    } else {
      const side = Math.ceil(Math.sqrt(textureHeavy.textures)) * 9;
      camera.position.set(Math.cos(t * 0.15) * side * 0.6, side * 0.75, Math.sin(t * 0.15) * side * 0.6);
      camera.lookAt(0, 0, 0);
    }
  } else if (bigMesh !== null) {
    // 貼著地面看向遠方 —— 那是「同一個東西橫跨很大的深度範圍」的形狀，
    // 也是逐塊選階唯一有價值的機位。從高處俯瞰會把這條軸要問的東西消掉。
    camera.position.set(Math.cos(t * 0.1) * 900, 90, Math.sin(t * 0.1) * 900);
    camera.lookAt(0, 20, 0);
  } else if (giScene !== null) {
    // 固定機位，而且**看得到箱子的背光面**（朝 −x／−z 那兩面）—— 量的就是
    // 那裡有沒有沾到紅色。會動的相機會讓每次量到的像素都不一樣。
    camera.position.set(-34, 16, -34);
    camera.lookAt(0, 12, 0);
  } else {
    const radius = ORBIT;
    // ## 相機路徑要減掉原點
    //
    // 開了重定位之後世界會被搬回相機腳下，而這條軌道是用**絕對**座標算的
    // ——不減掉原點的話相機每幀跳回遠處，世界又被搬走一次，於是它每幀往外
    // 飄一個 offset。實測：0 次繪製、0 個三角形，**而且沒有任何錯誤**。
    //
    // 這是使用重定位時唯一要改的一行，套件也會在連續觸發時警告。
    const ox = rebase === null ? 0 : rebase.origin.x;
    const oz = rebase === null ? 0 : rebase.origin.z;
    camera.position.set(
      Math.cos(t * 0.12) * radius - ox,
      14 * SIZE,
      Math.sin(t * 0.12) * radius - oz,
    );
    camera.lookAt(
      Math.cos(t * 0.12 + 1.2) * (radius * 0.23) - ox,
      8 * SIZE,
      Math.sin(t * 0.12 + 1.2) * (radius * 0.23) - oz,
    );
  }
  // 骨頭要真的動 —— 姿勢不變的話量到的不是動畫的成本。
  skinnedField?.update(t);
  if (vatField !== null) vatField.mesh.time = t;
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
  // CSM 的每一盞光都跟著相機的視錐走，所以每幀都要更新一次。忘了的話
  // 陰影會留在開場那一幀的位置 —— 相機走遠之後整片陰影就不見了。
  csm?.update();
  waterScene?.update(lastT);
  physicsScene?.update(lastT);
  // 相機走遠了就把世界搬回它腳下。平常這裡只是一次長度比較。
  if (rebase !== null) WW.worldFor(scene).updateOrigin(camera);
  if (vtScene !== null) {
    // 這個場景要的是「UV 與畫布一一對應」，透視相機做不到。
    renderer.render(vtScene.root, vtCamera);
  } else if (composer !== null) composer.render();
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
 * 這一幀 GPU 花了多少毫秒。
 *
 * ## 為什麼需要它
 *
 * `pnpm bench` 有 GPU 計時，但它跑的是 benchmark app（WebGPU）。而
 * 而 `onBeforeCompile` 注入的東西只在 WebGL 那條路上生效 —— **實作在這邊，
 * 計時在那邊**，於是「開了省多少」量不到。`pnpm gpu-check` 用的就是這個。
 *
 * ## 為什麼不能用 performance.now 包住 render
 *
 * GPU 是非同步的：`render()` 送完就回來了，所以那樣量到的是 CPU。實測
 * 開關兩邊都是 0.13 ms，而 GPU 那邊差很多。
 *
 * `EXT_disjoint_timer_query_webgl2` 是直接問 GPU 的。它會回報 `disjoint`
 * ——那代表期間發生了會讓計時失真的事（換頻率、被搶佔），那種樣本要丟掉
 * 而不是照用。
 */
/**
 * 跑到**遠景合併不再變動**為止，不是跑固定幾幀。
 *
 * 烘焙有每幀時間預算，所以「要幾幀」取決於有幾格要烘、機器多快 —— 固定
 * 幀數在這裡就是一個作者訂的數字，而且它訂錯過：60 幀不夠烘 443 組，於是
 * 掃角度時前面幾個角度量到的是烘到一半的狀態，同一個角度換個順序就得到
 * 不同的數字。
 *
 * 判準是「這一幀有沒有在烘」，不是「合併數量有沒有變」—— 後者在烘看不見
 * 的那幾組時是不動的，於是會提早判定穩定了。
 */
function settleHlod(t: number): void {
  if (!enhanced) return;
  let quiet = 0;
  for (let i = 0; i < 900 && quiet < 10; i++) {
    step(t);
    quiet = (rocks as WW.InstancedMesh).stats.cpuParts.bake < 0.01 ? quiet + 1 : 0;
  }
}

/**
 * 這個內容是被 fragment 綁住還是被幾何綁住 —— **換解析度就問得出來**。
 *
 * ## 為什麼這個問題決定後面所有的優先順序
 *
 * 剩下的每一條軸（叢集 LOD、地表、遮蔽剔除）省的都是**幾何那一側**。如果
 * GPU 時間其實是跟著像素數走的，那它們的上限就是幾何佔的那一小塊，不管
 * 演算法多漂亮。
 *
 * Sponza 那次已經用拆解算過一次（幾何只佔 7.5%），但那是推的。這個是直接
 * 量的：把畫布縮成一半的邊長（四分之一的像素），時間怎麼變。
 *
 * | 時間變成 | 代表 |
 * | --- | --- |
 * | 約四分之一 | 被 fragment 綁住 —— 幾何那側的優化上限很低 |
 * | 幾乎不變 | 被幾何／繪製呼叫綁住 —— 那些優化有得做 |
 *
 * 改完尺寸要等合併穩定下來再量：每像素的投影比例變了，「哪幾格夠遠到可以
 * 合併」就跟著變，於是縮放完的第一幀正好落在重新烘焙的中間。
 */
async function measureFillBound(t = 0): Promise<unknown> {
  renderer.setAnimationLoop(null);
  const full = { w: renderer.domElement.width, h: renderer.domElement.height };
  const out: Record<string, unknown> = {};

  for (const [name, scale] of [
    ['full', 1],
    ['half', 0.5],
    ['quarter', 0.25],
  ] as const) {
    const w = Math.round(full.w * scale);
    const h = Math.round(full.h * scale);
    renderer.setSize(w, h, false);
    composer?.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    settleHlod(t);

    renderer.info.reset();
    step(t);
    const { triangles, calls } = renderer.info.render;
    const gpu = (await measureGpuMs(t, 1000)) as { p50?: number };
    out[name] = { pixels: w * h, ms: gpu.p50 ?? null, triangles, calls };
  }

  renderer.setSize(full.w, full.h, false);
  composer?.setSize(full.w, full.h);
  camera.aspect = full.w / full.h;
  camera.updateProjectionMatrix();
  return out;
}

/**
 * 收集迴圈的**下界**：同樣的資料量，只做「非做不可」的那幾件事。
 *
 * ## 為什麼要量這個
 *
 * W4 的條件是「附上相對天花板的位置」，而 CPU 那一格一直寫著「離下界 4.5
 * 倍」。那個下界是「把矩陣讀一遍」——但收集迴圈根本不讀矩陣（包圍球是預先
 * 算好的），所以那個比較從一開始就不對等。
 *
 * 真正的下界是：讀四個 float、寫三個陣列元素。那是任何實作都躲不掉的。
 * 剩下的（六個平面、選階）才是可以討論要不要優化的部分。
 */
function measureCollectFloor(instances = 214_000, rounds = 20): unknown {
  const spheres = new Float32Array(instances * 4);
  for (let i = 0; i < instances * 4; i++) spheres[i] = i * 0.001;
  const starts = new Int32Array(instances);
  const counts = new Int32Array(instances);
  const indirect = new Uint32Array(instances);

  const samples: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    let out = 0;
    for (let i = 0; i < instances; i++) {
      const s = i * 4;
      // 非做不可的：讀球（四個 float）、寫三個陣列。
      const radius = spheres[s + 3]!;
      const cx = spheres[s]!;
      const cy = spheres[s + 1]!;
      const cz = spheres[s + 2]!;
      if (cx + cy + cz + radius > -1e30) {
        starts[out] = s;
        counts[out] = 1;
        indirect[out] = i;
        out++;
      }
    }
    samples.push(performance.now() - t0);
    if (out === 0) throw new Error('unreachable');
  }
  samples.sort((a, b) => a - b);
  const floorMs = samples[Math.floor(rounds / 2)]!;
  return {
    instances,
    floorMs: +floorMs.toFixed(3),
    nsPerInstance: +((floorMs * 1e6) / instances).toFixed(2),
  };
}

/**
 * 把沒出現在畫面上的 instance 分成「太小」與「被擋住」。
 *
 * 投影半徑用的是與選階同一個式子：`radius / distance * (height/2) / tan(fov/2)`。
 * 不到 0.5 像素的話它連一個像素中心都蓋不到 —— 那是選階的責任範圍，
 * 遮蔽剔除再厲害也拿不走它。
 */
function hiddenBreakdown(seen: Set<number>): {
  submitted: number;
  visible: number;
  subPixel: number;
  occluded: number;
  outside: number;
  occludedIds: Set<number>;
} {
  const mesh = rocks as unknown as {
    count: number;
    getMatrixAt: (i: number, m: THREE.Matrix4) => void;
    sourceGeometry?: THREE.BufferGeometry;
    geometry: THREE.BufferGeometry;
  };
  const source = mesh.sourceGeometry ?? mesh.geometry;
  if (source.boundingSphere === null) source.computeBoundingSphere();
  const baseRadius = source.boundingSphere?.radius ?? 1;

  camera.updateMatrixWorld(true);
  const viewProjection = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  const frustum = new THREE.Frustum().setFromProjectionMatrix(viewProjection);
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const halfHeight = size.y / 2;
  const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);

  const m = new THREE.Matrix4();
  const center = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  let visible = 0;
  let subPixel = 0;
  let outside = 0;
  const occludedIdSet = new Set<number>();

  for (let i = 0; i < mesh.count; i++) {
    if (seen.has(i + 1)) {
      visible++;
      continue;
    }
    mesh.getMatrixAt(i, m);
    center.setFromMatrixPosition(m);
    scale.setFromMatrixScale(m);
    const radius = baseRadius * Math.max(scale.x, scale.y, scale.z);

    // 視錐外的根本沒送出去畫，不算在任何一邊。
    sphere.set(center, radius);
    if (!frustum.intersectsSphere(sphere)) {
      outside++;
      continue;
    }

    const distance = Math.max(camera.position.distanceTo(center), 1e-6);
    const projectedPx = (radius / distance) * (halfHeight / tanHalfFov);
    if (projectedPx < 0.5) subPixel++;
    else occludedIdSet.add(i);
  }

  return {
    submitted: visible + subPixel + occludedIdSet.size,
    visible,
    subPixel,
    occluded: occludedIdSet.size,
    outside,
    occludedIds: occludedIdSet,
  };
}

async function measureGpuMs(t = 0, budgetMs = 2000, minSamples = 20): Promise<unknown> {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null;
  if (ext === null) return { skipped: '這個瀏覽器沒有 EXT_disjoint_timer_query_webgl2' };

  // ## 動畫迴圈必須停掉，而且是在這裡停
  //
  // 下面每一顆查詢中間都有 `await`（等 GPU 回覆），而動畫迴圈會在那些空檔
  // 裡繼續跑 —— 它用的是**一直在前進的 t**，所以相機在移動、遠景在重新烘。
  // 於是量到的不是「這個狀態多貴」，是「一個一直在變的狀態」。
  //
  // 實測同一個場景（60,000 個、程序化）：**迴圈沒停 43.6 ms、停掉 14.7 ms。**
  // 三倍，而 43.6 那個數字穩定到小數第二位、看起來完全像一個真實的結果。
  //
  // 兩支工具對同一個場景給出不同的數字才發現 —— 一支停了、一支沒停。
  //
  // 停在這裡而不是叫呼叫端停：**沒有任何呼叫端會想要它開著**，而忘記停的
  // 症狀是一個看起來很正常的錯誤數字。這正是 `verifyQuality` 踩過的同一個坑。
  renderer.setAnimationLoop(null);

  const samples: number[] = [];
  let disjoint = 0;
  // ## 取樣數用時間界定，不是固定幀數
  //
  // 固定 120 幀在快的內容上是 1.5 秒，在慢的內容上是 25 秒（遠景那組原生
  // 每幀 211 ms）—— 於是整個 gate 要跑十五分鐘，而跑十五分鐘的檢查沒有人
  // 會跑。固定幀數在這裡就是那種「作者在自己的內容上調好」的常數。
  //
  // 變異數不需要那麼多樣本：遠景那組五輪量到 6.528 / 6.531 / 6.532 / 6.538
  // / 6.539，中位數穩到小數第三位。所以先給時間預算，再用 `minSamples` 保
  // 一個下限，免得極慢的內容只拿到一兩個樣本。
  const deadline = performance.now() + budgetMs;
  for (let i = 0; i < 1000; i++) {
    if (i >= minSamples && performance.now() > deadline) break;
    const query = gl.createQuery()!;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    step(t);
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    // 等這一顆查詢回來再送下一幀 —— 不等的話會累積幾百顆沒讀的查詢。
    for (let spin = 0; spin < 1000; spin++) {
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) === true) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (gl.getParameter(ext.GPU_DISJOINT_EXT) === true) {
      disjoint++;
    } else if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) === true) {
      samples.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
    }
    gl.deleteQuery(query);
  }

  if (samples.length === 0) return { skipped: '一顆查詢都沒回來', disjoint };
  samples.sort((a, b) => a - b);
  return {
    p50: +samples[Math.floor(samples.length / 2)]!.toFixed(3),
    p95: +samples[Math.floor(samples.length * 0.95)]!.toFixed(3),
    samples: samples.length,
    // 丟掉的樣本數要報出來 —— 丟太多的話中位數也不可信。
    disjoint,
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
async function verifyQuality(
  t = 2,
  radiusPixels = 2,
  threshold = 8,
  width = 1280,
  height = 720,
): Promise<unknown> {
  if (!enhanced) return { skipped: '這個模式本身就是原生版，沒有東西可以比' };

  // ## 串流的內容要先凍住
  //
  // 兩張圖之間如果還有 cell 在載入卸載，差的就不是畫質而是內容 —— 那種
  // 比對永遠會紅，然後整個檢查就會被當成雜訊忽略。
  //
  // `stopStream` 只停止載入卸載，已經在的東西留著，所以凍住之後比的
  // 仍然是一個真實的串流畫面。
  // ## 先把動畫迴圈停掉
  //
  // `capture()` 中間有 `await`（等 PNG 解碼），而動畫迴圈會在那段空檔裡
  // 繼續跑 —— 它會把相機移到別的地方、重新烘遠景、改變可見格。於是
  // 「同一個 t 量兩次」實際上量的是兩個不同的狀態。
  //
  // 實測：連續呼叫 `verifyQuality(8.0)` 三次，相機矩陣是
  // 0.235566 / 0.275634 / 0.310396 —— 每一次都不一樣。
  renderer.setAnimationLoop(null);
  if (useStream && world !== null) world.stopStream();
  // 串流時真正活著的是 `rocks.count`，不是建構時的容量。
  const live = rocks.count;

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
  // 跑到**合併不再變動**為止，不是跑固定幾幀。烘焙有每幀時間預算，所以
  // 「要幾幀」取決於有幾格要烘、機器多快 —— 固定幀數在這裡就是一個
  // 作者訂的數字，而且它訂錯了：60 幀不夠烘 443 組，於是掃角度時前面
  // 幾個角度量到的是烘到一半的狀態，同一個角度換個順序就得到不同的數字。
  // 判準是「這一幀有沒有在烘」，不是「合併數量有沒有變」—— 後者在烘
  // 看不見的那幾組時是不動的，於是會提早判定穩定了。
  settleHlod(t);

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
  // **參考影像必須用強化版拿到的那份幾何**，不是模組頂層那個 `lods`。
  //
  // `?cooked=1` 時強化版吃的是 cook 過的鏈，而 `lods` 是程序化的那一份 ——
  // 拿它當參考等於在比兩個不同的形狀。症狀是「有貼圖時差 20%」，而那看起來
  // 非常像引擎的缺陷（我差點就那樣記下去，還先排除了合併與選階）。
  //
  // `sourceGeometry` 依定義就是「強化版拿到的那條鏈的第 0 階」，所以它是
  // 唯一正確的參考。
  const referenceGeometry = (rocks as WW.InstancedMesh).sourceGeometry ?? lods[0]!;
  // **參考要用一份沒有被改過的材質。**
  //
  // `materialDetailUvPerPixel` 是掛在材質上的（`onBeforeCompile`），而參考
  // 若共用同一個材質物件，兩邊就會套到同一段 shader —— 於是**任何材質層級
  // 的改動在這個比對裡都是隱形的**。
  //
  // 實測：關掉、惰性、最大效果三個設定量出來完全同分（0%），三個一樣本來
  // 就該當成訊號。
  //
  // `clone()` 不會複製 `onBeforeCompile`，所以複本就是「原本的材質」。
  const referenceMaterial = material.clone();
  const reference = new THREE.InstancedMesh(
    referenceGeometry,
    referenceMaterial,
    Math.max(live, 1),
  );
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
  referenceMaterial.dispose();
  rocks.visible = true;

  // ## 兩個方向都要比
  //
  // 「強化版的像素在原生版找不到」抓的是**多畫了或畫錯了**；
  // 「原生版的像素在強化版找不到」抓的是**東西不見了** —— 剔除剔過頭、
  // 包圍球太小、整塊被跳過。那是這個引擎最危險的一種錯，而正向比對對它
  // 幾乎沒有反應（實測把區塊半徑縮成 0.7 倍，正向只從 0.32% 動到 0.48%）。
  const forward = compare(
    enhancedPixels.data,
    nativePixels.data,
    width,
    height,
    radiusPixels,
    threshold,
  ) as Record<string, number>;
  const backward = compare(
    nativePixels.data,
    enhancedPixels.data,
    width,
    height,
    radiusPixels,
    threshold,
  ) as Record<string, number>;

  return {
    instances: live,
    // 量完把動畫迴圈接回去，不然頁面就停在那一幀。
    ...(renderer.setAnimationLoop(animate), {}),
    streaming: useStream,
    ...forward,
    missing: backward.outsideContract,
    missingPercent: backward.percent,
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
// ## GI 模式：場景裡只留那一組東西
//
// 判準是「白箱子的背光面沾到多少紅」，而**任何其他東西都會污染它**：別的
// 光源會直接照亮那一面，別的幾何會把自己的顏色反彈進探針裡。
//
// 清場一定要放在**所有內容都加完之後**。第一版寫在建立場景的地方，那時
// 地面、地形、參考物都還沒加進來 —— 於是那段程式碼看起來清了場，實際上
// 一個都沒清到，而量到的數字一位小數都沒變。
if (giScene !== null) {
  for (const child of [...scene.children]) {
    if (child !== giScene.root) scene.remove(child);
  }
}

if (enhanced) void measureLodBlocking();

Object.assign(window, {
  __ww: {
    vt:
      vtScene === null
        ? null
        : {
            virtualSize: vtScene.virtualSize,
            atlasSize: vtScene.vt.atlas.image.width,
            levels: vtScene.vt.table.levels,
            sideAt: (level: number): number => vtScene.sideAt(level),
            maxTextureSize: renderer.capabilities.maxTextureSize,
            request: (level: number, px: number, py: number): void => {
              vtScene.vt.request(level, px, py);
            },
            update: (budget?: number): number => vtScene.vt.update(budget),
            /**
             * 讀畫面上某個比例位置的顏色。
             *
             * **在頁面裡讀，不是從外面截圖。** 預設 framebuffer 在合成之後
             * 就被清掉了，從外面 readPixels 讀到的是全黑 —— 而全黑看起來
             * 就像「shader 沒編譯成功」，兩種完全不同的問題長得一樣。
             *
             * 畫進一張 render target 再讀，時機與內容都是確定的。
             */
            sampleAt: (u: number, v: number): [number, number, number] => {
              const size = 512;
              vtProbeTarget ??= new WebGLRenderTarget(size, size);
              const previous = renderer.getRenderTarget();
              renderer.setRenderTarget(vtProbeTarget);
              renderer.render(vtScene.root, vtCamera);
              renderer.setRenderTarget(previous);
              const px = new Uint8Array(4);
              renderer.readRenderTargetPixels(
                vtProbeTarget,
                Math.min(size - 1, Math.max(0, Math.floor(u * size))),
                Math.min(size - 1, Math.max(0, Math.floor(v * size))),
                1,
                1,
                px,
              );
              return [px[0] ?? 0, px[1] ?? 0, px[2] ?? 0];
            },
            get pagesLoaded(): number {
              return vtScene.vt.pagesLoaded;
            },
            get residentCount(): number {
              return vtScene.vt.table.residentCount;
            },
          },
    /** 串流的自適應預算 —— 引擎有沒有已經在壓載入速率。 */
    get budget(): unknown {
      return world?.streaming?.budget ?? null;
    },
    streamProbe: {
      start(): void {
        streamProbe.samples.length = 0;
        lastProbeTime = 0;
        streamProbe.loadMs = 0;
        streamProbe.placed = 0;
        streamProbe.cells = 0;
        streamProbe.recording = true;
      },
      stop(): typeof streamProbe.samples {
        streamProbe.recording = false;
        return streamProbe.samples.slice();
      },
    },
    physics: (): unknown => physicsScene?.stats() ?? null,
    bigMesh: bigMesh === null ? null : { triangles: bigMesh.triangles, pieces: bigMesh.pieces },
    impostor:
      impostorScene === null
        ? null
        : {
            count: impostorScene.count,
            impostor: impostorScene.impostor,
            triangles: impostorScene.triangles,
            get calls() {
              return renderer.info.render.calls;
            },
            get drawnTriangles() {
              return renderer.info.render.triangles;
            },
          },
    textureHeavy:
      textureHeavy === null
        ? null
        : {
            textures: textureHeavy.textures,
            megabytes: textureHeavy.megabytes,
            /**
             * renderer 自己數的，**每次問都重讀**。
             *
             * 第一版寫成一般屬性，於是它是在建這個物件的當下取值的 ——
             * 那時候一幀都還沒畫，永遠是 0。而 0 看起來像「貼圖根本沒上傳」，
             * 我差點照著那個假數字去查一個不存在的 bug。
             */
            get uploaded() {
              return renderer.info.memory.textures;
            },
            get calls() {
              return renderer.info.render.calls;
            },
            get triangles() {
              return renderer.info.render.triangles;
            },
          },
    gi:
      giScene === null
        ? null
        : {
            stats: () => giScene.stats(),
            bake: () => giScene.bake(renderer, scene),
            setEnabled: (on: boolean) => giScene.setEnabled(on),
            sampleCpu: (p: [number, number, number], n: [number, number, number]) => giScene.sampleCpu(p, n),
            moveBlocker: (x: number, y: number, z: number) => giScene.moveBlocker(x, y, z),
            bakeStale: () => giScene.bakeStale(renderer, scene),
            measureScreenSpace: (rect: [number, number, number, number]) =>
              giScene.measureScreenSpace(renderer, scene, camera, rect),
            /**
             * 量畫面上一塊區域的平均顏色。
             *
             * 從 `renderer.domElement` 讀，而不是自己再畫一次 —— 讀的必須是
             * 真正送到螢幕上的那一份像素，中間每一步（色調對應、後製、
             * sRGB 轉換）都算數。
             */
            sample: (x: number, y: number, w: number, h: number) => {
              const canvas = renderer.domElement;
              const flat = document.createElement('canvas');
              flat.width = canvas.width;
              flat.height = canvas.height;
              const ctx = flat.getContext('2d')!;
              ctx.drawImage(canvas, 0, 0);
              const data = ctx.getImageData(x, y, w, h).data;
              let r = 0;
              let g = 0;
              let b = 0;
              for (let i = 0; i < data.length; i += 4) {
                r += data[i]!;
                g += data[i + 1]!;
                b += data[i + 2]!;
              }
              const n = data.length / 4;
              return { r: r / n, g: g / n, b: b / n, pixels: n };
            },
          },
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
    measureGpuMs,
    /**
     * 遮蔽剔除的上限：送出去畫的東西裡，有多少一個像素都沒留下。
     *
     * 先量再決定要不要做整條軸 —— doctrine 第 5 條。
     */
    /**
     * 完美遮蔽剔除**最多**能省多少 GPU 時間。
     *
     * ## 為什麼光看「幾個看不見」不夠
     *
     * 那個比例把「被擋住」與「小到沒蓋到像素中心」算在一起，而後者的
     * GPU 成本本來就接近零 —— 選階已經把它變成幾個三角形，遠景合併
     * 已經把它併進別人的繪製裡。
     *
     * 所以 80% 的物件看不見，不代表有 80% 的時間可以省。要問的是**時間**。
     *
     * ## 做法：裝一個作弊的完美剔除器
     *
     * 先畫一張 ID 圖知道誰真的看得見，然後把看不見的那些**搬到視錐外面**
     * ——於是引擎自己的剔除會把它們拿掉，送出去的剛好就是「一個完美的
     * 遮蔽剔除器會送的東西」。兩邊的 GPU 時間相減就是上限。
     *
     * 它作弊在：那張 ID 圖是**畫完才知道**的。真正的遮蔽剔除要在畫之前
     * 就猜出來，而且猜的成本要從省下來的裡面扣掉。所以這是上限，不是預期值。
     */
    /**
     * 把「看不見的」分成兩類，因為只有一類是遮蔽剔除能拿走的。
     *
     * | 類別 | 誰的事 |
     * | --- | --- |
     * | 投影到螢幕上不到一個像素 | **選階**的事。遮蔽剔除拿不走它 |
     * | 夠大、但被別的東西擋住 | 遮蔽剔除的事 |
     *
     * 不分開的話，「完美可見性預言機」省下來的時間會被整碗算到遮蔽剔除
     * 頭上 —— 而那正是多層 HLOD 當初差點犯的錯：**它要省的東西，別的
     * 機制可能已經拿走了**。
     */
    /**
     * 把「被擋住」的那些藏起來之後，**畫面應該一模一樣**。
     *
     * 這一條驗的是前面那整個量測本身。如果藏掉之後畫面變了，那些東西就
     * 不是被擋住的 —— 於是「省了 60%」省掉的是**看得見的內容**，那不是
     * 優化，是把東西弄不見。
     *
     * 完美剔除器省下來的時間只有在畫面不變的前提下才有意義，而那個前提
     * 到目前為止只是假設。
     */
    verifyOcclusionOracle(): unknown {
      const mesh = rocks as unknown as {
        count: number;
        getMatrixAt: (i: number, m: THREE.Matrix4) => void;
        setMatrixAt: (i: number, m: THREE.Matrix4) => void;
      };
      const total = mesh.count;
      const m = new THREE.Matrix4();
      const original = new Float32Array(total * 16);
      for (let i = 0; i < total; i++) {
        mesh.getMatrixAt(i, m);
        original.set(m.elements, i * 16);
      }

      const size = new THREE.Vector2();
      renderer.getDrawingBufferSize(size);
      const shot = (): Uint8Array => {
        step(0);
        settleHlod(0);
        step(0);
        const buffer = new Uint8Array(size.x * size.y * 4);
        const gl = renderer.getContext();
        gl.readPixels(0, 0, size.x, size.y, gl.RGBA, gl.UNSIGNED_BYTE, buffer);
        return buffer;
      };

      const before = shot();
      const seen = occludedIds(renderer, scene, camera);
      const targets = hiddenBreakdown(seen).occludedIds;
      for (const i of targets) {
        m.fromArray(original, i * 16);
        m.elements[13] = 1e6;
        mesh.setMatrixAt(i, m);
      }
      const after = shot();

      for (let i = 0; i < total; i++) {
        m.fromArray(original, i * 16);
        mesh.setMatrixAt(i, m);
      }
      settleHlod(0);

      // 逐像素比。容忍 2/255 的差 —— 合併幾何重烘之後浮點會有極小的擾動。
      let changed = 0;
      let worst = 0;
      for (let i = 0; i < before.length; i += 4) {
        const d = Math.max(
          Math.abs(before[i]! - after[i]!),
          Math.abs(before[i + 1]! - after[i + 1]!),
          Math.abs(before[i + 2]! - after[i + 2]!),
        );
        if (d > worst) worst = d;
        if (d > 2) changed++;
      }
      const pixels = before.length / 4;
      return {
        hidden: targets.size,
        pixels,
        changed,
        changedPct: +((changed / pixels) * 100).toFixed(3),
        worstChannelDelta: worst,
      };
    },
    classifyHidden(): unknown {
      step(0);
      const seen = occludedIds(renderer, scene, camera);
      const info = hiddenBreakdown(seen);
      return info;
    },
    async measureOcclusionSaving(rounds = 3, onlyOccluded = false): Promise<unknown> {
      const mesh = rocks as unknown as {
        count: number;
        getMatrixAt: (i: number, m: THREE.Matrix4) => void;
        setMatrixAt: (i: number, m: THREE.Matrix4) => void;
        stats?: { visible: number };
      };
      const total = mesh.count;

      // 原始矩陣留一份 —— 量完要還原，不然後面的量測全是壞的。
      const original = new Float32Array(total * 16);
      const m = new THREE.Matrix4();
      for (let i = 0; i < total; i++) {
        mesh.getMatrixAt(i, m);
        original.set(m.elements, i * 16);
      }

      const restore = (): void => {
        for (let i = 0; i < total; i++) {
          m.fromArray(original, i * 16);
          mesh.setMatrixAt(i, m);
        }
      };

      const hideInvisible = (seen: Set<number>): number => {
        // `onlyOccluded` 時只藏「夠大但被擋住」的那些 —— 小到不足一個像素
        // 的留著，因為遮蔽剔除本來就拿不走它們。
        const targets = onlyOccluded ? hiddenBreakdown(seen).occludedIds : null;
        let hidden = 0;
        for (let i = 0; i < total; i++) {
          if (seen.has(i + 1)) continue;
          if (targets !== null && !targets.has(i)) continue;
          m.fromArray(original, i * 16);
          // 搬到很遠的地方，讓引擎自己的視錐剔除把它拿掉。
          m.elements[13] = 1e6;
          mesh.setMatrixAt(i, m);
          hidden++;
        }
        return hidden;
      };

      const gpu = async (): Promise<number> => {
        const out = (await measureGpuMs(0, 900, 12)) as { p50?: number };
        return out.p50 ?? NaN;
      };

      const base: number[] = [];
      const oracle: number[] = [];
      let hidden = 0;
      let seenCount = 0;
      // **交錯**跑，不是跑完一組再跑另一組 —— 這台機器的量測是雙峰的。
      for (let r = 0; r < rounds; r++) {
        restore();
        settleHlod(0);
        base.push(await gpu());

        step(0);
        const seen = occludedIds(renderer, scene, camera);
        seenCount = seen.size;
        hidden = hideInvisible(seen);
        settleHlod(0);
        oracle.push(await gpu());
      }
      restore();
      settleHlod(0);

      const mid = (a: number[]): number => a.slice().sort((x, y) => x - y)[a.length >> 1]!;
      const b = mid(base);
      const o = mid(oracle);
      return {
        total,
        visible: seenCount,
        hidden,
        baseMs: +b.toFixed(3),
        oracleMs: +o.toFixed(3),
        savedPct: +(((b - o) / b) * 100).toFixed(1),
        rounds: base.map((v, i) => [+v.toFixed(2), +oracle[i]!.toFixed(2)]),
      };
    },
    measureOccluded(): unknown {
      step(0);
      // 原生那條路（?ww=0）沒有 stats，就退回 count —— 那時候送出去的就是全部。
      const submitted = (rocks as { stats?: { visible: number } }).stats?.visible ?? rocks.count;
      return measureOccluded(renderer, scene, camera, submitted);
    },
    measureFillBound,
    measureCollectFloor,
    terrain: terrain === null ? null : { tiles: terrain.tiles, triangles: terrain.triangles },
    vat:
      vatField === null
        ? null
        : {
            count: VAT,
            frames: vatField.baked.frameCount,
            vertices: vatField.baked.vertexCount,
            textureMB: +((vatField.baked.vertexCount * vatField.baked.frameCount * 16) / 1048576).toFixed(2),
            bakeMs: +vatField.bakeMs.toFixed(1),
          },
    skinned: skinnedField === null
      ? null
      : { count: SKINNED, triangles: skinnedField.triangles, bones: skinnedField.bones },
    // 任何 GPU 計時之前都要先跑它。沒跑的話量到的是**還在烘遠景合併**的
    // 那幾幀 —— 實測同一個場景 44.5 ms 對 14.7 ms，差三倍，而且看起來
    // 完全像一個真實的結果。
    settleHlod,
    verifyQuality,
    measureStreamDrift,
    measureLodBlocking,
    step(t = 0): void {
      step(t);
      updateHud();
    },
  },
});
