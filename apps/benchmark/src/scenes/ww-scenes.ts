import { InstancedMesh as WWInstancedMesh, sphericalLodErrors, worldFor } from '@webworld/three';
import {
  AmbientLight,
  DirectionalLight,
  IcosahedronGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  type BufferGeometry,
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
 * W1 的通過條件第 2 條：**同樣的內容，換一個字之後幀時間如何？**
 *
 * ## 為什麼是兩個 scene id 而不是一個帶參數的
 *
 * runner 的迴圈是 `for 每一輪 { for 每個場景 }`，所以同一輪裡相鄰註冊的
 * 兩個場景會**背靠背執行**，輪與輪之間交替。這台機器的量測是雙峰的
 * （同一份程式碼落在兩個相差近兩倍的狀態），連續跑完一組再跑另一組會得出
 * 完全相反的結論 —— 兩邊拿的是不同母體。
 *
 * 一個帶 `?mode=` 的場景就辦不到：runner 一次只跑註冊清單裡的東西，
 * 參數變體要人手動跑兩次，而那正是「連續跑完一組」。
 *
 * ## 為什麼用 Icosahedron 而不是 Box
 *
 * LOD 要有東西可以簡化。立方體沒有可簡化的細節，用它會讓「LOD 省下多少」
 * 這個問題根本問不出來。細分球的每一階誤差可以**從幾何本身量出來**
 * （`sphericalLodErrors`），不必猜 —— 猜出來的誤差會讓品質契約整個失效，
 * 而且是靜靜地失效。
 */

/** 500 / 180 / 80 個三角形。`IcosahedronGeometry` 的 detail 是每邊切幾段減一。 */
const DETAILS = [4, 2, 1] as const;

/** 兩個變體共用的燈光與相機。差異必須只有那一個類別。 */
function buildCommon(aspect: number, spread: number): { scene: Scene; camera: PerspectiveCamera } {
  const scene = new Scene();
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(1, 2, 1.5);
  scene.add(sun, new AmbientLight(0x404860, 1.0));

  const camera = new PerspectiveCamera(60, aspect, 0.5, spread * 6);
  return { scene, camera };
}

/** 兩個變體共用的擺放：同一個種子 → 同一批矩陣，兩邊畫的是同一件事。 */
function place(
  target: { setMatrixAt(index: number, matrix: Object3D['matrix']): unknown },
  count: number,
  spread: number,
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
    dummy.scale.setScalar(rng.range(0.6, 2.4));
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

// ── A：原生 ───────────────────────────────────────────────────────────────

export const nativeInstancingScene: SceneDefinition = {
  id: 'ab-native-instanced',
  title: 'A/B 對照組：THREE.InstancedMesh',
  measures: '原生 InstancedMesh 的幀時間。與 ab-ww-instanced 成對，必須交錯執行。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 60_000, 1, 2_000_000);
    const spread = numberParam(ctx.params, 'spread', 900, 10, 20_000);
    const { scene, camera } = buildCommon(ctx.aspect, spread);

    const geometry = new IcosahedronGeometry(1, DETAILS[0]);
    const material = new MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    const mesh = new InstancedMesh(geometry, material, count);
    place(mesh, count, spread);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);

    return Promise.resolve(
      rawScene(scene, camera, {
        update: (frameIndex) => orbit(camera, frameIndex, spread, ctx.measureFrames),
        reportParams: { count, spread, variant: 'native', lodLevels: 1 },
        notes: [
          '對照組：沒有剔除、沒有 LOD。與 ab-ww-instanced 是同一份矩陣、同一條相機路徑。',
        ],
        dispose: () => {
          geometry.dispose();
          material.dispose();
          mesh.dispose();
        },
      }),
    );
  },
};

// ── B：強化版 ─────────────────────────────────────────────────────────────

export const wwInstancingScene: SceneDefinition = {
  id: 'ab-ww-instanced',
  title: 'A/B 實驗組：WW.InstancedMesh',
  measures: '換一個字之後的幀時間、可見數、逐一測試數與 LOD 分佈。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 60_000, 1, 2_000_000);
    const spread = numberParam(ctx.params, 'spread', 900, 10, 20_000);
    const errorPixels = numberParam(ctx.params, 'errorPixels', 2, 1, 64);
    const { scene, camera } = buildCommon(ctx.aspect, spread);

    const lods: BufferGeometry[] = DETAILS.map((d) => new IcosahedronGeometry(1, d));
    const errors = sphericalLodErrors(lods);

    const material = new MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    const mesh = new WWInstancedMesh({ lods, errors }, material, count, { errorPixels });
    place(mesh, count, spread);
    scene.add(mesh);

    const world = worldFor(scene);
    // 只記錄「最後一幀」會被單一取樣騙。累計之後除以幀數才是這條路徑上的平均。
    let frames = 0;
    let visibleSum = 0;
    let testedSum = 0;
    let cpuSum = 0;

    return Promise.resolve(
      rawScene(scene, camera, {
        update: (frameIndex) => {
          orbit(camera, frameIndex, spread, ctx.measureFrames);
          const stats = mesh.stats;
          // 第 0 幀還沒 render 過，統計是初始值 —— 記進去會把平均往下拉。
          if (frameIndex > 0) {
            frames++;
            visibleSum += stats.visible;
            testedSum += stats.tested;
            cpuSum += stats.cpuMs;
          }
        },
        reportParams: {
          count,
          spread,
          variant: 'ww',
          lodLevels: lods.length,
          errorPixels,
          errorL1: +errors[1]!.toFixed(5),
          errorL2: +errors[2]!.toFixed(5),
        },
        notes: [
          `LOD 誤差由細分球的矢高算出，不是猜的：${errors.map((e) => e.toFixed(4)).join(' / ')}`,
        ],
        verdict: (): SceneVerdict => {
          const stats = mesh.stats;
          const avgVisible = frames === 0 ? 0 : Math.round(visibleSum / frames);
          const avgTested = frames === 0 ? 0 : Math.round(testedSum / frames);
          const avgCpu = frames === 0 ? 0 : cpuSum / frames;
          const detail =
            `平均可見 ${avgVisible} / ${count}，平均逐一測試 ${avgTested}` +
            `（空間分割省下 ${count - avgTested}），` +
            `cell ${world.stats.visibleCells}/${world.stats.cells}，` +
            `LOD 分佈 ${Array.from(stats.levels).join('/')}，` +
            // 這是**剔除與選階自己**的時間，不含 renderer 送繪製呼叫的成本。
            // 兩者的優化方向相反，加在一起看會修錯地方。
            `剔除+選階 ${avgCpu.toFixed(3)}ms（${((avgCpu * 1e6) / Math.max(avgTested, 1)).toFixed(0)}ns/instance）`;

          // 三個都可能靜默失效，而且失效的樣子都是「數字很漂亮」：
          // 剔除沒生效 → 可見數 = 全部；空間格退回逐一走訪 → tested = 全部；
          // 全部落在最細階 → LOD 等於沒開。
          if (!stats.spatial) {
            return { ok: false, detail: `空間分割已被停用（矩陣被判定為動態）。${detail}` };
          }
          if (avgTested >= count) {
            return { ok: false, detail: `空間分割沒有省下任何走訪。${detail}` };
          }
          if (avgVisible >= count) {
            return { ok: false, detail: `剔除沒有生效。${detail}` };
          }
          return { ok: true, detail };
        },
        dispose: () => {
          for (const g of lods) g.dispose();
          material.dispose();
          mesh.dispose();
        },
      }),
    );
  },
};
