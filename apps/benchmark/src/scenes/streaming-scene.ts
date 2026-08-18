import {
  InstancedMesh as WWInstancedMesh,
  load,
  loadMaterial,
  worldFor,
  type LodChain,
} from '@webworld/three';
import {
  AmbientLight,
  DirectionalLight,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  type MeshStandardMaterial,
} from 'three/webgpu';
import { rawScene } from './raw-scene.ts';
import {
  numberParam,
  type BenchmarkScene,
  type SceneContext,
  type SceneDefinition,
  type SceneVerdict,
} from './types.ts';

/**
 * 移動中串流：載入的同時還撐不撐得住空間剔除。
 *
 * ## 為什麼非有這一組不可
 *
 * 現有的量測全部是**一次擺完的靜態場景** —— 包括 1M 那次容量掃描。那種
 * 場景裡空間格建一次就用到最後，於是「格子重建多貴」這件事在儀器上是隱形的。
 *
 * 而串流每載入一格就寫一批矩陣，格子每次都得整份重建。實測（2026-08-17，
 * 單元測試裡的 17 幀累計）：
 *
 * | instance 數 | 每幀整份重建 | 省下的走訪 |
 * | ---: | ---: | ---: |
 * | 10,000 | 16.30 ms | 0.83 ms |
 * | 160,000 | 267.64 ms | 16.63 ms |
 *
 * 帳算不過來，所以載入中格子會被暫停 —— 逐 instance 走訪。**畫面完全正常，
 * 只有幀時間差**，正是最難發現的那種退化。
 *
 * 這個場景就是把那件事變成一個數字：`spatial%`。
 *
 * ## 量的是什麼
 *
 * | | 為什麼 |
 * | --- | --- |
 * | `spatial%` | 有多少比例的幀真的用到空間格。**這一組存在的理由** |
 * | 平均逐一測試 / 常駐數 | 沒用到格子時走訪量會跳回全部 |
 * | 空間格 CPU | 重建與更新花掉多少 |
 * | `pending` | 載入追不上移動速度的話，量到的就不是穩態 |
 *
 * ## 為什麼相機走直線而不是繞圈
 *
 * 繞圈會一直回到同一批 cell，於是穩態之後就沒有新的載入了 —— 那量到的
 * 是靜態場景，不是串流。直線前進保證每一幀都在接近新的 cell。
 *
 * 折返（來回走）而不是無限往前：無限往前會讓世界座標越來越大，而浮點精度
 * 的損失會混進數字裡。折返點刻意不落在 cell 邊界上，避免在邊界上反覆
 * 載入卸載 —— 那是另一個問題，不該汙染這一組。
 */

const MANIFEST = '/cooked-real/assets.manifest.json';

/** 與 `ab-*-real` 同一個資產，這樣兩組的差異只在「有沒有串流」。 */
const DEFAULT_MESH = 'mesh:Avocado.glb:Avocado#0';

/** 決定性的雜湊 → 同樣的 cell 永遠長出同樣的內容。 */
function cellRng(cx: number, cz: number): () => number {
  let s = ((cx * 73_856_093) ^ (cz * 19_349_663)) >>> 0;
  return (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
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

function normalizingScale(chain: LodChain): number {
  const geometry = chain.lods[0];
  if (geometry === undefined) return 1;
  geometry.computeBoundingSphere();
  const radius = geometry.boundingSphere?.radius ?? 1;
  return radius > 0 ? 1 / radius : 1;
}

export const streamingScene: SceneDefinition = {
  id: 'streaming-move',
  title: '移動中串流：載入時還有沒有空間剔除',
  measures: 'spatial%、走訪量、空間格 CPU。靜態場景量不到這件事。',
  async create(ctx: SceneContext): Promise<BenchmarkScene> {
    const cellSize = numberParam(ctx.params, 'cellSize', 120, 10, 5000);
    const radius = numberParam(ctx.params, 'radius', 600, 50, 20_000);
    const perCell = numberParam(ctx.params, 'perCell', 400, 1, 100_000);
    // 每幀前進多少世界單位。預設是「一格的十分之一」—— 也就是每十幀跨一格，
    // 保證載入是持續發生的而不是偶發的。
    const speed = numberParam(ctx.params, 'speed', Math.max(cellSize / 10, 1), 1, 10_000);
    const meshId = ctx.params.get('mesh') ?? DEFAULT_MESH;

    const { chain, material } = await loadAsset(meshId);
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(1, 2, 1.5);
    scene.add(sun, new AmbientLight(0x404860, 1.0));
    const camera = new PerspectiveCamera(60, ctx.aspect, 0.5, radius * 2);

    // 容量從 0 開始 —— 串流會自己長大。給一個大的初始值等於偷偷把
    // 「配置」這件事排除在量測外，而那正是串流最貴的部分之一。
    const scale = normalizingScale(chain);
    const rocks = new WWInstancedMesh(chain, material, 1);
    scene.add(rocks);

    const world = worldFor(scene);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scaleVec = new Vector3();
    const matrix = new Matrix4();
    const stream = world.stream({
      cellSize,
      radius,
      load(cx, cz, place) {
        const rnd = cellRng(cx, cz);
        for (let i = 0; i < perCell; i++) {
          position.set((cx + rnd()) * cellSize, 0, (cz + rnd()) * cellSize);
          quaternion.setFromAxisAngle(new Vector3(0, 1, 0), rnd() * Math.PI * 2);
          scaleVec.setScalar((0.6 + rnd() * 2.4) * scale);
          place(rocks, matrix.compose(position, quaternion, scaleVec));
        }
      },
    });

    let frames = 0;
    let spatialFrames = 0;
    let visibleSum = 0;
    let testedSum = 0;
    let countSum = 0;
    let gridSum = 0;
    let collectSum = 0;
    let pendingPeak = 0;
    // 有格子的那幾幀要另外累計。把兩種幀混在一起平均，會讓「格子有用的
    // 時候到底有多有用」完全看不出來 —— 而那正是要判斷的東西。
    let testedOn = 0;
    let countOn = 0;
    let gridOn = 0;
    let collectOn = 0;
    let hlodBuildOn = 0;
    let spheresOn = 0;
    let spheresAll = 0;
    let mergedSum = 0;
    let mergedInstSum = 0;

    // 折返點刻意不是 cell 邊界的倍數（×3.7），否則會停在邊界上反覆載入卸載。
    const legFrames = Math.max(Math.round((cellSize * 3.7 * 8) / speed), 2);

    return rawScene(scene, camera, {
      update: (frameIndex) => {
        // 三角波：走出去再走回來。以幀索引驅動，所以每次執行的第 N 幀
        // 都是同一個位置。
        const phase = frameIndex % (legFrames * 2);
        const leg = phase < legFrames ? phase : legFrames * 2 - phase;
        const z = leg * speed;
        camera.position.set(0, cellSize * 0.15, z);
        camera.lookAt(0, cellSize * 0.15, z + 1);
        camera.updateMatrixWorld();

        if (frameIndex > 0) {
          const stats = rocks.stats;
          frames++;
          if (stats.spatial) {
            spatialFrames++;
            testedOn += stats.tested;
            countOn += rocks.count;
            gridOn += stats.cpuParts.grid;
            collectOn += stats.cpuParts.collect;
            hlodBuildOn += stats.hlod.buildMs;
            spheresOn += stats.cpuParts.spheres;
          }
          visibleSum += stats.visible;
          testedSum += stats.tested;
          countSum += rocks.count;
          gridSum += stats.cpuParts.grid;
          collectSum += stats.cpuParts.collect;
          spheresAll += stats.cpuParts.spheres;
          mergedSum += stats.merged;
          mergedInstSum += stats.mergedInstances;
          pendingPeak = Math.max(pendingPeak, stream.stats.pending);
        }
      },
      reportParams: { cellSize, radius, perCell, speed, mesh: meshId },
      notes: [
        `真實資產：${meshId}，LOD ${chain.lods.map((g) => g.getIndex()!.count / 3).join('/')}。`,
        `相機每幀前進 ${speed} 單位（一格 ${cellSize}），所以載入是持續發生的。`,
      ],
      verdict: (): SceneVerdict => {
        const spatialPct = frames === 0 ? 0 : (spatialFrames / frames) * 100;
        const avgVisible = frames === 0 ? 0 : Math.round(visibleSum / frames);
        const avgTested = frames === 0 ? 0 : Math.round(testedSum / frames);
        const avgCount = frames === 0 ? 0 : Math.round(countSum / frames);
        const s = stream.stats;
        const detail =
          `spatial ${spatialPct.toFixed(1)}%（${spatialFrames}/${frames} 幀），` +
          `平均可見 ${avgVisible}，逐一測試 ${avgTested} / 常駐 ${avgCount}，` +
          `空間格 ${(gridSum / Math.max(frames, 1)).toFixed(3)}ms + 走訪 ${(collectSum / Math.max(frames, 1)).toFixed(3)}ms（其中包圍球 ${(spheresAll / Math.max(frames, 1)).toFixed(3)}），` +
          `[有格子時] 走訪 ${Math.round(testedOn / Math.max(spatialFrames, 1))} / ${Math.round(countOn / Math.max(spatialFrames, 1))}，` +
          `空間格 ${(gridOn / Math.max(spatialFrames, 1)).toFixed(3)}ms（其中 HLOD 分組 ${(hlodBuildOn / Math.max(spatialFrames, 1)).toFixed(3)}）` +
          ` + 走訪 ${(collectOn / Math.max(spatialFrames, 1)).toFixed(3)}ms（其中包圍球 ${(spheresOn / Math.max(spatialFrames, 1)).toFixed(3)}），` +
          `合併 ${Math.round(mergedSum / Math.max(frames, 1))} 次涵蓋 ${Math.round(mergedInstSum / Math.max(frames, 1))} 個（槽位 ${rocks.stats.hlod.slots} / 可合併 ${rocks.stats.hlod.groups}），` +
          `載入 ${s.totalLoads} 卸載 ${s.totalUnloads} 常駐 ${s.resident} 佇列峰值 ${pendingPeak}`;

        // 內容沒進來的話所有數字都是零，而場景會顯得非常快。
        if (s.totalLoads === 0 || avgCount === 0) {
          return { ok: false, detail: `一格都沒載入 —— 這一組沒有量到任何東西。${detail}` };
        }
        // 內容進來了卻一個都沒畫 —— 幀時間會非常漂亮，而畫面是空的。
        // 這一條抓到過一次真的 bug：BatchedMesh 快取的包圍球過期，整個
        // 物件被 Three 的視錐測試剔掉。
        if (avgVisible === 0) {
          return { ok: false, detail: `常駐 ${avgCount} 個卻一個都沒畫。${detail}` };
        }
        // 載入追不上移動速度時量到的是「一直在追」，不是穩態。
        if (s.failedLoads > 0) {
          return { ok: false, detail: `有 ${s.failedLoads} 格載入失敗：${s.lastError}。${detail}` };
        }
        return { ok: true, detail };
      },
      dispose: () => {
        world.stopStream();
        rocks.dispose();
      },
    });
  },
};
