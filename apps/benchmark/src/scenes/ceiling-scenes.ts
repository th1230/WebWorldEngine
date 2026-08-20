import { InstancedMesh as WWInstancedMesh, sphericalLodErrors } from '@web-world-engine/three';
import {
  AmbientLight,
  BatchedMesh,
  DirectionalLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  type BufferGeometry,
} from 'three/webgpu';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
 * 天花板：**CPU 與 GPU 各自單獨的上限。**
 *
 * ## 為什麼這是 W4 的前提而不是結果
 *
 * 場景時間是兩端相加。要說任何一端「到了極限」，必須先有它單獨的上限
 * 數字 —— 沒有那兩個數字，「還能不能更快」就只能用感覺回答，而每一個
 * 優化提案也就沒有判準。
 *
 * 這三個場景**刻意什麼都不平衡**：每一個都把一端壓到零，量另一端。
 * 它們的幀時間本身沒有意義，有意義的是「每毫秒能處理多少」。
 */

function lights(scene: Scene): void {
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(1, 2, 1.5);
  scene.add(sun, new AmbientLight(0x404860, 1.0));
}

// ── CPU 天花板 ────────────────────────────────────────────────────────

export const cpuCeilingScene: SceneDefinition = {
  id: 'ceiling-cpu',
  title: '天花板：CPU（完全不畫）',
  measures: '剔除＋選階每毫秒能處理多少 instance。物件不在場景裡，GPU 完全不參與。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 200_000, 1, 4_000_000);
    const spread = numberParam(ctx.params, 'spread', 2000, 10, 50_000);

    const scene = new Scene();
    const camera = new PerspectiveCamera(60, ctx.aspect, 0.5, spread * 4);
    camera.position.set(0, spread * 0.02, 0);

    const lods: BufferGeometry[] = [4, 2, 1].map((d) => new IcosahedronGeometry(1, d));
    const material = new MeshStandardMaterial();
    // **刻意不 `scene.add`。** 加進去就會被畫，量到的就變成兩端相加。
    const mesh = new WWInstancedMesh({ lods, errors: sphericalLodErrors(lods) }, material, count);

    const rng = createRng(DEFAULT_SEED);
    const dummy = new Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set(rng.range(-spread, spread), 0, rng.range(-spread, spread));
      dummy.rotation.set(0, rng.range(0, Math.PI * 2), 0);
      dummy.scale.setScalar(rng.range(0.6, 2.4));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }

    // renderer 只有 `getDrawingBufferSize` 與 `getRenderTarget` 會被用到。
    const fakeRenderer = {
      getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) => {
        target.set(1920, 1080);
        return target;
      },
      getRenderTarget: () => null,
    } as never;

    let frames = 0;
    let cpuSum = 0;
    let testedSum = 0;
    let rawSum = 0;

    /**
     * 同一批矩陣，**只做無論如何都躲不掉的事**：把 64 個位元組讀進來。
     *
     * ## 為什麼需要這個
     *
     * 「剔除＋選階每毫秒幾個」量的是**我們自己的實作**，所以拿它當天花板
     * 是循環論證 —— 永遠 100%。真正的問題是「這件事最快能多快」，而它的
     * 下界是把資料讀過一遍的成本。
     *
     * 兩個數字的比值就是機制層還剩多少空間。
     */
    const matrices = mesh.instanceMatrix.array;
    function rawPass(n: number): number {
      const started = performance.now();
      let sink = 0;
      for (let i = 0; i < n; i++) {
        const b = i * 16;
        sink += matrices[b + 12]! + matrices[b + 13]! + matrices[b + 14]! + matrices[b]!;
      }
      // 讓最佳化器不能整段丟掉
      if (sink === 1e308) throw new Error('unreachable');
      return performance.now() - started;
    }

    return Promise.resolve(
      rawScene(scene, camera, {
        update: (frameIndex) => {
          // 相機轉一圈，讓剔除率掃過整個範圍而不是停在一個角度。
          const angle = (frameIndex / ctx.measureFrames) * Math.PI * 2;
          camera.rotation.set(0, angle, 0);
          camera.updateMatrixWorld(true);
          camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
          mesh.updateMatrixWorld(true);
          mesh.onBeforeRender(fakeRenderer, scene, camera, mesh.geometry, material as never);

          if (frameIndex > 0) {
            frames++;
            cpuSum += mesh.stats.cpuMs;
            testedSum += mesh.stats.tested;
            rawSum += rawPass(mesh.stats.tested);
          }
        },
        reportParams: { count, spread },
        notes: ['物件不在場景裡：這一格的 GPU 時間等於空場景。'],
        verdict: (): SceneVerdict => {
          const cpuMs = cpuSum / Math.max(frames, 1);
          const rawMs = rawSum / Math.max(frames, 1);
          const tested = testedSum / Math.max(frames, 1);
          const perNs = (cpuMs * 1e6) / Math.max(tested, 1);
          const rawNs = (rawMs * 1e6) / Math.max(tested, 1);
          return {
            ok: frames > 0 && cpuMs > 0,
            detail:
              `剔除+選階 ${Math.round(tested / Math.max(cpuMs, 1e-6)).toLocaleString()} instance/ms` +
              `（${perNs.toFixed(0)} ns 一個）｜` +
              `純讀取下界 ${Math.round(tested / Math.max(rawMs, 1e-6)).toLocaleString()} instance/ms` +
              `（${rawNs.toFixed(0)} ns）｜還差 ${(perNs / Math.max(rawNs, 1e-9)).toFixed(1)} 倍` +
              `｜平均逐一測試 ${Math.round(tested).toLocaleString()}`,
          };
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

// ── GPU 天花板：三角形吞吐 ────────────────────────────────────────────

export const gpuTriangleCeilingScene: SceneDefinition = {
  id: 'ceiling-gpu-triangles',
  title: '天花板：GPU 三角形吞吐',
  measures: '每毫秒能吃多少三角形與多少頂點。矩陣只上傳一次，CPU 每幀幾乎不做事。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 20_000, 1, 500_000);
    const detail = numberParam(ctx.params, 'detail', 8, 0, 40);
    const spread = numberParam(ctx.params, 'spread', 120, 5, 5_000);
    // 預設**索引**。`IcosahedronGeometry` 出廠是非索引的，那讓每個三角形
    // 帶三個獨立頂點 —— 於是這個場景量到的其實是頂點吞吐，卻被當成三角形
    // 吞吐報出去。實測差 2.6 倍，而方向是**低估硬體**：後續每一個
    // 「離極限還有多遠」都會顯得比實際接近，然後停在不該停的地方。
    //
    // 真實資產一律是索引的（Avocado 682 個三角形只有 406 個頂點）。
    const indexed = (ctx.params.get('indexed') ?? '1') !== '0';

    const scene = new Scene();
    lights(scene);
    const camera = new PerspectiveCamera(60, ctx.aspect, 0.5, spread * 8);
    camera.position.set(0, 0, spread * 2.4);

    const raw = new IcosahedronGeometry(1, detail);
    const geometry = indexed ? mergeVertices(raw) : raw;
    if (geometry !== raw) raw.dispose();
    const material = new MeshStandardMaterial({ roughness: 0.8 });
    const mesh = new InstancedMesh(geometry, material, count);

    const rng = createRng(DEFAULT_SEED);
    const dummy = new Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        rng.range(-spread, spread),
        rng.range(-spread, spread),
        rng.range(-spread, spread),
      );
      dummy.scale.setScalar(0.5);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // 全部畫出來：這裡量的是吞吐，不是剔除。
    mesh.frustumCulled = false;
    scene.add(mesh);

    const triangles = (geometry.getIndex()?.count ?? geometry.getAttribute('position').count) / 3;
    const vertices = geometry.getAttribute('position').count;

    return Promise.resolve(
      rawScene(scene, camera, {
        update: () => {
          // 相機不動：內容固定才量得到吞吐。
        },
        reportParams: {
          count,
          detail,
          spread,
          indexed,
          trianglesPerInstance: triangles,
          verticesPerInstance: vertices,
        },
        notes: [
          `全部 ${(count * triangles).toLocaleString()} 個三角形、` +
            `${(count * vertices).toLocaleString()} 個頂點每幀都畫，沒有剔除。`,
          // **兩個數字都要報。** 只報三角形的話，換一份頂點／三角形比不同的
          // 幾何就會得出完全不同的「天花板」，而看的人不會知道差在哪裡。
          `幾何是${indexed ? '索引' : '非索引'}的，每個三角形 ` +
            `${(vertices / triangles).toFixed(2)} 個頂點。`,
          '天花板 = 三角形數 ÷ gpuRenderMs，以及頂點數 ÷ gpuRenderMs。',
        ],
        verdict: (): SceneVerdict => {
          const perTriangle = vertices / triangles;
          const detail = `每個三角形 ${perTriangle.toFixed(2)} 個頂點（${
            indexed ? '索引' : '非索引'
          }）`;
          // 焊接失敗會**靜靜地**把這個場景變回量頂點吞吐，而數字看起來
          // 完全正常 —— 只是天花板低了 2.6 倍，然後每一個「離極限還有多遠」
          // 都跟著錯。非索引的比值恰好是 3.00。
          if (indexed && perTriangle > 2.5) {
            return { ok: false, detail: `焊接沒有生效，量到的是頂點吞吐。${detail}` };
          }
          if (!indexed && perTriangle < 2.5) {
            return { ok: false, detail: `indexed=0 卻拿到索引幾何。${detail}` };
          }
          return { ok: true, detail };
        },
        dispose: () => {
          geometry.dispose();
          material.dispose();
          mesh.dispose();
        },
      }),
    );
  },
};

// ── GPU 天花板：繪製呼叫 ──────────────────────────────────────────────

export const gpuDrawCallCeilingScene: SceneDefinition = {
  id: 'ceiling-gpu-drawcalls',
  title: '天花板：GPU 繪製呼叫',
  measures: '同樣的幾何與數量，用 N 次繪製對一次 instanced 繪製。差額就是繪製呼叫的價碼。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 30_000, 1, 500_000);
    const spread = numberParam(ctx.params, 'spread', 120, 5, 5_000);
    /**
     * `many`（預設）：`BatchedMesh`，每個 instance 一次 `drawIndexed`。
     * `one`：`InstancedMesh`，同樣的幾何與數量，**一次**繪製。
     *
     * ## 為什麼一定要有對照組
     *
     * 「每毫秒幾次繪製」單獨看不成立 —— 那個時間裡也包含頂點、光柵化與
     * present。要知道繪製呼叫**自己**值多少錢，只能拿同一份工作量在兩種
     * 送法之間相減。
     *
     * 而這正是 W4 機制層要問的：`WW.InstancedMesh` 的所有 instance 共用同一份
     * 來源幾何，只有 LOD 階不同，所以理論上 N 次繪製可以收斂成「階數」次。
     * 值不值得做，看的就是這個差額。
     */
    const mode = (ctx.params.get('mode') ?? 'many') === 'one' ? 'one' : 'many';

    const scene = new Scene();
    const camera = new PerspectiveCamera(60, ctx.aspect, 0.5, spread * 8);
    camera.position.set(0, 0, spread * 2.4);

    // 兩個三角形。三角形成本壓到最低，剩下的就是「送一次繪製」要多少錢。
    const geometry = new PlaneGeometry(0.4, 0.4);
    const material = new MeshBasicMaterial();
    const vertices = geometry.getAttribute('position').count;
    const indices = geometry.getIndex()!.count;

    // 兩種送法**共用同一段擺放**：位置不同的話比的就不是送法了。
    const place = (
      target: { setMatrixAt(i: number, m: Matrix4): unknown },
      id: (i: number) => number,
    ): void => {
      const rng = createRng(DEFAULT_SEED);
      const dummy = new Object3D();
      const matrix = new Matrix4();
      for (let i = 0; i < count; i++) {
        dummy.position.set(
          rng.range(-spread, spread),
          rng.range(-spread, spread),
          rng.range(-spread, spread),
        );
        dummy.updateMatrix();
        target.setMatrixAt(id(i), matrix.copy(dummy.matrix));
      }
    };

    let object: BatchedMesh | InstancedMesh;
    if (mode === 'one') {
      const instanced = new InstancedMesh(geometry, material, count);
      place(instanced, (i) => i);
      instanced.instanceMatrix.needsUpdate = true;
      object = instanced;
    } else {
      const batched = new BatchedMesh(count, vertices, indices, material);
      const geometryId = batched.addGeometry(geometry);
      // Three.js 自己的逐 instance 剔除會在每幀走訪全部 instance 並讀矩陣 ——
      // 那是 CPU 的成本，會污染這個量測。
      batched.perObjectFrustumCulled = false;
      batched.sortObjects = false;
      const ids = Array.from({ length: count }, () => batched.addInstance(geometryId));
      place(batched, (i) => ids[i]!);
      object = batched;
    }
    object.frustumCulled = false;
    scene.add(object);

    const draws = mode === 'one' ? 1 : count;

    return Promise.resolve(
      rawScene(scene, camera, {
        update: () => {
          // 相機不動。
        },
        reportParams: { count, spread, mode, draws, trianglesPerInstance: indices / 3 },
        notes: [
          `${draws.toLocaleString()} 次繪製、共 ${count.toLocaleString()} 個 instance、` +
            `每個 ${indices / 3} 個三角形。`,
          mode === 'one'
            ? '對照組：同樣的工作量，一次 instanced 繪製。'
            : '天花板 = 繪製次數 ÷ gpuRenderMs；扣掉 mode=one 才是繪製呼叫自己的成本。',
        ],
        dispose: () => {
          geometry.dispose();
          material.dispose();
          object.dispose();
        },
      }),
    );
  },
};
