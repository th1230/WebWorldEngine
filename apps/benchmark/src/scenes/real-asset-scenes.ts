import {
  InstancedMesh as WWInstancedMesh,
  load,
  loadMaterial,
  type LodChain,
} from '@webworld/three';
import {
  AmbientLight,
  DirectionalLight,
  InstancedMesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  type CompressedTexture,
  type MeshStandardMaterial,
  type Texture,
} from 'three/webgpu';
import { applyOrbitPath } from '../camera-path.ts';
import { DEFAULT_SEED, createRng } from '../rng.ts';
import { rawScene } from './raw-scene.ts';
import {
  numberParam,
  type BenchmarkScene,
  type SceneContext,
  type SceneDefinition,
  type SceneVerdict,
} from './types.ts';

/**
 * 與 `ww-scenes.ts` **同一個實驗，換成真實資產**。
 *
 * ## 為什麼非有這一組不可
 *
 * 合成內容在兩個方向上都不具代表性，而且錯的方向相反：`IcosahedronGeometry`
 * 是**非索引**的（每個三角形三個獨立頂點 → 幾何看起來貴 3.35 倍），而且
 * **沒有貼圖**（材質看起來免費 → 真實 PBR 是 1.72 倍）。
 *
 * 在那種內容上量到的「GPU 沒問題、CPU 是瓶頸」，會讓每一個後續決策往錯方向
 * 走 —— 這個專案已經因此連續好幾輪只修 CPU，還用同樣的理由否決了遮擋剔除
 * 與 GPU 驅動繪製。
 *
 * ## 變的只有內容
 *
 * 數量、擺放種子、相機路徑、燈光全部與程序化那一組相同。差別只有：
 *
 * | | 程序化 | 真實 |
 * | --- | --- | --- |
 * | 幾何 | `IcosahedronGeometry(1, 4)`，500 個三角形 | Avocado，682 個 |
 * | LOD | 3 階，誤差由矢高算出 | cook 好的 7 階 |
 * | 材質 | `MeshStandardMaterial`，**沒有貼圖** | albedo + normal + ORM，各 1024² BC |
 *
 * 三角形數刻意挑成接近的（500 vs 682），這樣兩組的差異主要落在**材質**上。
 * 幾何量本身的影響由 `?mesh=` 換一個更重的資產（DamagedHelmet，15,452 個
 * 三角形）單獨看。
 *
 * ## 資產不存在時的行為
 *
 * `assets/source/` 不進版控（二進位美術檔），所以這一組在沒跑過
 * `pnpm cook:real` 的機器上**沒有資產可用**。那時場景會明確失敗而不是
 * 退回程序化內容 —— 靜靜換掉內容正是這一組要防的那件事。
 */

const MANIFEST = '/cooked-real/assets.manifest.json';

/** 682 個三角形、7 階、完整 PBR 貼圖。挑它是因為三角形數最接近程序化那一組。 */
const DEFAULT_MESH = 'mesh:Avocado.glb:Avocado#0';

function buildCommon(aspect: number, spread: number): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(1, 2, 1.5);
  scene.add(sun, new AmbientLight(0x404860, 1.0));
  return { scene, camera: new PerspectiveCamera(60, aspect, 0.5, spread * 6) };
}

/** 與程序化那一組**同一個種子、同一段程式**：兩邊畫的必須是同一件事。 */
function place(
  target: { setMatrixAt(index: number, matrix: Object3D['matrix']): unknown },
  count: number,
  spread: number,
  scale: number,
): void {
  const rng = createRng(DEFAULT_SEED);
  const dummy = new Object3D();
  for (let i = 0; i < count; i++) {
    dummy.position.set(
      rng.range(-spread, spread),
      rng.range(-spread * 0.05, spread * 0.05),
      rng.range(-spread, spread),
    );
    dummy.rotation.set(rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2), 0);
    dummy.scale.setScalar(rng.range(0.6, 2.4) * scale);
    dummy.updateMatrix();
    target.setMatrixAt(i, dummy.matrix);
  }
}

function orbit(camera: PerspectiveCamera, frameIndex: number, spread: number, frames: number): void {
  applyOrbitPath(camera, frameIndex, {
    radius: spread * 0.45,
    height: spread * 0.03,
    framesPerRevolution: frames,
    bobAmplitude: spread * 0.01,
  });
}

/**
 * 真實資產的尺寸差了好幾個數量級（Avocado 高 0.08 世界單位，DamagedHelmet 是 2）。
 * 不正規化的話，換一個資產等於同時換了「螢幕上多大」，而那會直接改變
 * LOD 選階與填充率 —— 兩個都是這裡要量的東西。
 */
function normalizingScale(chain: LodChain): number {
  const geometry = chain.lods[0];
  if (geometry === undefined) return 1;
  geometry.computeBoundingSphere();
  const radius = geometry.boundingSphere?.radius ?? 1;
  return radius > 0 ? 1 / radius : 1;
}

/** 材質有哪幾張貼圖、多大、什麼格式。寫進 verdict 才看得出量的是什麼。 */
function describeMaterial(material: MeshStandardMaterial): string {
  const size = (t: Texture | null): string => {
    if (t === null) return '無';
    // 壓縮貼圖的尺寸記在 `mipmaps[0]`，`image` 只是個佔位物件。
    const level0 = (t as CompressedTexture).mipmaps?.[0];
    return `${level0?.width ?? '?'}²/fmt${(t as CompressedTexture).format}`;
  };
  return (
    `材質 albedo ${size(material.map)}、normal ${size(material.normalMap)}、` +
    `orm ${size(material.roughnessMap)}`
  );
}

/**
 * 材質缺了什麼。
 *
 * 只檢查「該有的有沒有」，不檢查像素內容 —— 內容對不對是 cook 那一側的
 * 責任（`validateTexture` 會擋掉長度不符的資料）。
 */
function materialProblems(material: MeshStandardMaterial): string[] {
  const problems: string[] = [];
  if (material.map === null) problems.push('沒有 albedo');
  if (material.normalMap === null) problems.push('沒有 normal');
  if (material.roughnessMap === null) problems.push('沒有 orm');
  // ORM 兩個插槽必須是同一個實例，否則同一份位元組付了兩次頻寬。
  if (material.roughnessMap !== null && material.aoMap !== material.roughnessMap) {
    problems.push('aoMap 與 roughnessMap 不是同一張');
  }
  // 各階 mip 是 cook 好的。讓 GPU 自己重算等於把壓縮貼圖再解一次。
  if (material.map !== null && material.map.generateMipmaps) {
    problems.push('albedo 在 runtime 重算 mip');
  }
  return problems;
}

async function loadAsset(
  meshId: string,
): Promise<{ chain: LodChain; material: MeshStandardMaterial }> {
  try {
    const [chain, material] = await Promise.all([
      load(MANIFEST, meshId),
      loadMaterial(MANIFEST, meshId),
    ]);
    return { chain, material };
  } catch (error) {
    throw new Error(
      `真實資產載不到（${meshId}）。先執行 pnpm cook:real —— ` +
        'assets/source/ 不進版控，需要先放進真實的 .glb。',
      { cause: error },
    );
  }
}

// ── A：原生 ───────────────────────────────────────────────────────────────

export const nativeRealAssetScene: SceneDefinition = {
  id: 'ab-native-real',
  title: 'A/B 對照組（真實資產）：THREE.InstancedMesh',
  measures: '真實幾何與真實 PBR 貼圖下，原生 InstancedMesh 的幀時間。與 ab-ww-real 成對。',
  async create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 60_000, 1, 2_000_000);
    const spread = numberParam(ctx.params, 'spread', 900, 10, 20_000);
    const meshId = ctx.params.get('mesh') ?? DEFAULT_MESH;

    const { chain, material } = await loadAsset(meshId);
    const { scene, camera } = buildCommon(ctx.aspect, spread);

    // 對照組只拿第 0 階 —— 原生 InstancedMesh 本來就沒有 LOD。
    const geometry = chain.lods[0]!;
    const scale = normalizingScale(chain);
    const mesh = new InstancedMesh(geometry, material, count);
    place(mesh, count, spread, scale);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);

    const triangles = geometry.getIndex()!.count / 3;

    return rawScene(scene, camera, {
      update: (frameIndex) => orbit(camera, frameIndex, spread, ctx.measureFrames),
      reportParams: { count, spread, variant: 'native', mesh: meshId, lodLevels: 1, triangles },
      notes: [
        `真實資產：${meshId}，LOD0 ${triangles} 個三角形，材質含 albedo/normal/ORM 貼圖。`,
        '對照組：沒有剔除、沒有 LOD。與 ab-ww-real 是同一份矩陣、同一條相機路徑。',
      ],
      dispose: () => {
        mesh.dispose();
      },
    });
  },
};

// ── B：強化版 ─────────────────────────────────────────────────────────────

export const wwRealAssetScene: SceneDefinition = {
  id: 'ab-ww-real',
  title: 'A/B 實驗組（真實資產）：WW.InstancedMesh',
  measures: '真實內容下換一個字之後的幀時間、可見數與 LOD 分佈。',
  async create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 60_000, 1, 2_000_000);
    const spread = numberParam(ctx.params, 'spread', 900, 10, 20_000);
    const errorPixels = numberParam(ctx.params, 'errorPixels', 2, 1, 64);
    // 遠景合併的 A/B。預設開，--param hlod=0 關掉當對照組。
    const hlod = (ctx.params.get('hlod') ?? '1') !== '0';
    // 0 = 預設（槽位大小 = 最大那一格）。其他值 = 槽位裝得下幾個 instance。
    const hlodSlot = numberParam(ctx.params, 'hlodSlot', 0, 0, 100_000);
    // 0 = 不指定，讓套件由內容決定。
    const hlodBudgetMB = numberParam(ctx.params, 'hlodBudgetMB', 0, 0, 8192);
    const meshId = ctx.params.get('mesh') ?? DEFAULT_MESH;

    const { chain, material } = await loadAsset(meshId);
    const { scene, camera } = buildCommon(ctx.aspect, spread);

    const scale = normalizingScale(chain);
    const mesh = new WWInstancedMesh(chain, material, count, {
      errorPixels,
      hlod,
      ...(hlodBudgetMB > 0 ? { hlodBudgetMB } : {}),
      ...(hlodSlot > 0 ? { hlodSlotInstances: hlodSlot } : {}),
    });
    place(mesh, count, spread, scale);
    scene.add(mesh);

    const triangles = chain.lods[0]!.getIndex()!.count / 3;

    let frames = 0;
    let visibleSum = 0;
    let testedSum = 0;
    let cpuSum = 0;
    let gridSum = 0;
    let collectSum = 0;
    let bakeSum = 0;

    return rawScene(scene, camera, {
      update: (frameIndex) => {
        orbit(camera, frameIndex, spread, ctx.measureFrames);
        const stats = mesh.stats;
        if (frameIndex > 0) {
          frames++;
          visibleSum += stats.visible;
          testedSum += stats.tested;
          cpuSum += stats.cpuMs;
          gridSum += stats.cpuParts.grid;
          collectSum += stats.cpuParts.collect;
          bakeSum += stats.cpuParts.bake;
        }
      },
      reportParams: {
        count,
        spread,
        variant: 'ww',
        mesh: meshId,
        lodLevels: chain.lods.length,
        errorPixels,
        triangles,
        hlod,
      },
      notes: [
        `真實資產：${meshId}，LOD ${chain.lods.map((g) => g.getIndex()!.count / 3).join('/')}。`,
        `誤差是 cook 時量的，不是猜的：${chain.errors.map((e) => e.toFixed(4)).join(' / ')}`,
      ],
      verdict: (): SceneVerdict => {
        const stats = mesh.stats;
        const avgVisible = frames === 0 ? 0 : Math.round(visibleSum / frames);
        const avgTested = frames === 0 ? 0 : Math.round(testedSum / frames);
        const avgCpu = frames === 0 ? 0 : cpuSum / frames;
        const detail =
          `${describeMaterial(material)}，` +
          `平均可見 ${avgVisible} / ${count}，平均逐一測試 ${avgTested}，` +
          `合併 ${stats.merged} 格（槽位 ${stats.hlod.slots} / 可合併 ${stats.hlod.groups}，最大一格 ${stats.hlod.cellMax} 個；合併 ${stats.hlod.mergeMs.toFixed(2)} + 上傳 ${stats.hlod.uploadMs.toFixed(2)} ms），` +
          `LOD 分佈 ${Array.from(stats.levels).join('/')}，` +
          `CPU ${avgCpu.toFixed(3)}ms` +
          `（空間格 ${(gridSum / Math.max(frames, 1)).toFixed(3)}` +
          ` + 走訪 ${(collectSum / Math.max(frames, 1)).toFixed(3)}` +
          ` + 烘焙 ${(bakeSum / Math.max(frames, 1)).toFixed(3)}）`;

        // 貼圖沒接上的話畫面只是變成純色 —— 沒有例外、沒有紅字，而效能
        // 數字會顯得漂亮，因為少了三次取樣。這一組存在的理由就是量真實
        // 材質的成本，接不上等於整組數字沒有意義。
        const missing = materialProblems(material);
        if (missing.length > 0) {
          return { ok: false, detail: `材質不完整（${missing.join('、')}）。${detail}` };
        }

        if (!stats.spatial) {
          return { ok: false, detail: `空間分割已被停用。${detail}` };
        }
        if (avgTested >= count) {
          return { ok: false, detail: `空間分割沒有省下任何走訪。${detail}` };
        }
        if (avgVisible >= count) {
          return { ok: false, detail: `剔除沒有生效。${detail}` };
        }
        // 真實資產的 LOD 鏈是 cook 出來的，階數依網格而異 —— 但只有一階就
        // 代表這條路根本沒生效，而畫面看起來完全正常。
        if (chain.lods.length <= 1) {
          return { ok: false, detail: `資產只有一階幾何，LOD 沒有東西可選。${detail}` };
        }
        return { ok: true, detail };
      },
      dispose: () => {
        mesh.dispose();
      },
    });
  },
};
