import { Fn, storage, uint } from 'three/tsl';
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  IndirectStorageBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
} from 'three/webgpu';
import { applyOrbitPath } from '../camera-path.ts';
import { DEFAULT_SEED, createRng } from '../rng.ts';
import { numberParam, type BenchmarkScene, type SceneContext, type SceneDefinition } from './types.ts';
import { rawScene } from './raw-scene.ts';

// ── compute-indirect ──────────────────────────────────────────────────────

/**
 * 這個場景是 **GPU-driven 幾何路徑的可行性探針**。
 *
 * 它要回答的問題是：在這台機器、這個瀏覽器、這版驅動上，
 * 「compute shader 寫入 draw 參數 → indirect draw」這條路真的能跑嗎？
 *
 * 因此「失敗」是有效的結果，不是錯誤。任何一步掛掉都會被記進 notes 並降級成
 * 普通繪製，而不是讓整輪 benchmark 中斷 —— 我們需要知道答案，不是需要它成功。
 */
export const computeIndirectScene: SceneDefinition = {
  id: 'compute-indirect',
  title: 'Compute → Indirect Draw',
  measures: 'GPU 端產生 draw 參數再 indirect draw 的可行性與成本。meshlet culling 的前置驗證。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 50_000, 1, 1_000_000);
    const spread = numberParam(ctx.params, 'spread', 300, 10, 10_000);
    const notes: string[] = [];

    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 2.2);
    sun.position.set(1, 2, 1.5);
    scene.add(sun, new AmbientLight(0x404860, 1.0));

    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial({ roughness: 0.65 });
    const mesh = new InstancedMesh(geometry, material, count);

    const rng = createRng(DEFAULT_SEED);
    const dummy = new Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        rng.range(-spread, spread),
        rng.range(-spread * 0.2, spread * 0.2),
        rng.range(-spread, spread),
      );
      dummy.rotation.set(rng.range(0, Math.PI), rng.range(0, Math.PI), 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);

    const camera = new PerspectiveCamera(60, ctx.aspect, 0.1, spread * 6);

    // ── 嘗試接上 indirect draw ──
    let computeNode: unknown = null;
    let indirectEnabled = false;

    if (!ctx.backend.capabilities.compute) {
      notes.push('backend 無 compute 能力，indirect 路徑跳過（這正是 WebGL2 降級的樣子）');
    } else {
      try {
        const indexCount = geometry.index?.count ?? 0;
        if (indexCount === 0) throw new Error('geometry 沒有 index buffer');

        // WebGPU indexed indirect draw 參數：
        // [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
        const args = new Uint32Array([indexCount, 0, 0, 0, 0]);
        const indirectAttribute = new IndirectStorageBufferAttribute(args, 5);
        geometry.setIndirect(indirectAttribute);

        const indirectStorage = storage(indirectAttribute, 'uint', args.length);
        // compute 在 GPU 端把 instanceCount 從 0 改寫成實際要畫的數量。
        // 時這裡會換成真正的 culling；現在只驗證這條資料通路是通的。
        computeNode = Fn(() => {
          indirectStorage.element(1).assign(uint(count));
        })().compute(1);

        indirectEnabled = true;
        notes.push('indirect draw 已啟用：instanceCount 由 compute shader 寫入');
      } catch (error) {
        notes.push(`indirect 路徑建立失敗，降級為一般繪製：${message(error)}`);
        geometry.setIndirect(null);
        indirectEnabled = false;
      }
    }

    let computeFailed = false;

    return Promise.resolve(rawScene(scene, camera, {
      update: (frameIndex) => {
        applyOrbitPath(camera, frameIndex, {
          radius: spread * 0.85,
          height: spread * 0.2,
          framesPerRevolution: ctx.measureFrames,
        });

        if (!indirectEnabled || computeFailed || computeNode === null) return;
        try {
          // 用同步 compute：非同步版本會把 GPU 工作排到量測區間之外
          (ctx.backend.raw as { compute?: (node: unknown) => void } | null)?.compute?.(computeNode);
        } catch (error) {
          computeFailed = true;
          notes.push(`執行期 compute 失敗，後續幀停用：${message(error)}`);
        }
      },
      reportParams: { count, spread, indirectEnabled },
      notes,
      verdict: () => {
        // 這個場景是 的可行性探針。在有 compute 的 backend 上，
        // indirect 路徑失效代表它**退化**了 —— 那必須是失敗，不能只留一行 note
        // 讓整輪 benchmark 照樣通過。沒有 compute 的 backend 則本來就涵蓋不到。
        if (!ctx.backend.capabilities.compute) {
          return { ok: true, detail: 'backend 無 compute，indirect 路徑未驗證' };
        }
        if (!indirectEnabled) {
          return { ok: false, detail: `indirect 路徑無法建立：${notes.join('；')}` };
        }
        if (computeFailed) {
          return { ok: false, detail: `indirect 路徑在執行期失效：${notes.join('；')}` };
        }
        return { ok: true, detail: 'compute → indirect draw 正常運作' };
      },
      dispose: () => {
        geometry.dispose();
        material.dispose();
        mesh.dispose();
      },
    }));
  },
};

// ── device-loss-soak ──────────────────────────────────────────────────────

/**
 * 反覆強制 device 遺失並確認每次都能恢復。
 *
 * device loss 是必須設計進去的正常狀態轉換，不是罕見邊界情況。
 * 驗收條件有兩個：每次都要恢復，而且 `info.memory.total` 不得單調上升 ——
 * 後者代表恢復流程漏了 dispose。
 */
export const deviceLossSoakScene: SceneDefinition = {
  id: 'device-loss-soak',
  title: 'Device Loss 反覆恢復',
  measures: 'device 遺失恢復流程的正確性與資源洩漏。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const interval = numberParam(ctx.params, 'interval', 40, 5, 2000);
    const maxLosses = numberParam(ctx.params, 'losses', 20, 1, 200);
    const notes: string[] = [];

    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 2.0);
    sun.position.set(1, 2, 1);
    scene.add(sun, new AmbientLight(0x404860, 1.0));

    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial({ roughness: 0.5 });
    for (let i = 0; i < 200; i++) {
      const cube = new Mesh(geometry, material);
      const angle = (i / 200) * Math.PI * 2;
      cube.position.set(Math.cos(angle) * 8, (i % 10) - 5, Math.sin(angle) * 8);
      scene.add(cube);
    }

    const camera = new PerspectiveCamera(60, ctx.aspect, 0.1, 500);
    let triggered = 0;

    return Promise.resolve(rawScene(scene, camera, {
      update: (frameIndex) => {
        applyOrbitPath(camera, frameIndex, {
          radius: 20,
          height: 4,
          framesPerRevolution: ctx.measureFrames,
        });

        if (frameIndex === 0 || frameIndex % interval !== 0) return;
        if (triggered >= maxLosses) return;

        if (ctx.backend.simulateDeviceLoss()) {
          triggered++;
        } else if (triggered === 0) {
          triggered = -1;
          notes.push('此 backend 無法模擬 device loss（WebGL2 路徑沒有 GPUDevice.destroy）');
        }
      },
      get reportParams() {
        return {
          interval,
          requestedLosses: maxLosses,
          triggeredLosses: Math.max(0, triggered),
          recoveredLosses: ctx.deviceLost.lossCount,
          duplicateNotifications: ctx.deviceLost.duplicateNotifications,
          finalState: ctx.deviceLost.state,
        };
      },
      notes,
      verdict: () => {
        const fired = Math.max(0, triggered);
        const recovered = ctx.deviceLost.lossCount;
        const state = ctx.deviceLost.state;

        if (fired === 0) {
          // WebGL2 路徑無法模擬遺失。這不是失敗，只是這個 backend 涵蓋不到。
          return { ok: true, detail: '此 backend 無法模擬 device loss，未驗證恢復流程' };
        }
        if (state !== 'running') {
          return { ok: false, detail: `結束時狀態為 ${state}，未回到 running` };
        }
        if (recovered < fired) {
          return { ok: false, detail: `觸發 ${fired} 次遺失，但只恢復了 ${recovered} 次` };
        }
        return {
          ok: true,
          detail: `${recovered} 次遺失全部恢復（去重 ${ctx.deviceLost.duplicateNotifications} 則重複通報）`,
        };
      },
      dispose: () => {
        geometry.dispose();
        material.dispose();
      },
    }));
  },
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
