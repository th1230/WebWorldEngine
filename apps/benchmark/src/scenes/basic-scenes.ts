import {
  AmbientLight,
  BatchedMesh,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three/webgpu';
import { applyOrbitPath } from '../camera-path.ts';
import { DEFAULT_SEED, createRng } from '../rng.ts';
import { numberParam, type BenchmarkScene, type SceneContext, type SceneDefinition } from './types.ts';
import { rawScene } from './raw-scene.ts';

function makeCamera(aspect: number, far = 4000): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, aspect, 0.1, far);
  camera.position.set(0, 0, 10);
  return camera;
}

function addStandardLights(scene: Scene): void {
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(1, 2, 1.5);
  scene.add(sun, new AmbientLight(0x404860, 1.0));
}

// ── baseline-empty ────────────────────────────────────────────────────────

export const baselineEmptyScene: SceneDefinition = {
  id: 'baseline-empty',
  title: '空場景',
  measures: 'present 與瀏覽器合成的成本地板。所有其他場景的數字都要扣掉這個底。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const scene = new Scene();
    const camera = makeCamera(ctx.aspect);

    return Promise.resolve(rawScene(scene, camera, {
      update: () => {
        // 刻意什麼都不做：這個場景量的就是「什麼都不畫」要花多少時間
      },
      reportParams: {},
      notes: [],
      dispose: () => {},
    }));
  },
};

// ── instancing ────────────────────────────────────────────────────────────

export const instancingScene: SceneDefinition = {
  id: 'instancing',
  title: 'InstancedMesh 吞吐',
  measures: '單一 geometry + 大量 transform 的 instance 吞吐與 culling 成本。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const count = numberParam(ctx.params, 'count', 200_000, 1, 3_000_000);
    const spread = numberParam(ctx.params, 'spread', 600, 10, 20_000);

    const scene = new Scene();
    addStandardLights(scene);

    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial({ roughness: 0.7, metalness: 0.05 });
    const mesh = new InstancedMesh(geometry, material, count);

    const rng = createRng(DEFAULT_SEED);
    const dummy = new Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        rng.range(-spread, spread),
        rng.range(-spread * 0.25, spread * 0.25),
        rng.range(-spread, spread),
      );
      dummy.rotation.set(rng.range(0, Math.PI), rng.range(0, Math.PI), 0);
      const s = rng.range(0.6, 2.4);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);

    const camera = makeCamera(ctx.aspect, spread * 6);

    return Promise.resolve(rawScene(scene, camera, {
      update: (frameIndex) => {
        applyOrbitPath(camera, frameIndex, {
          radius: spread * 0.9,
          height: spread * 0.2,
          framesPerRevolution: ctx.measureFrames,
          bobAmplitude: spread * 0.1,
        });
      },
      reportParams: { count, spread },
      notes: [],
      dispose: () => {
        geometry.dispose();
        material.dispose();
        mesh.dispose();
      },
    }));
  },
};

// ── batching ──────────────────────────────────────────────────────────────

export const batchingScene: SceneDefinition = {
  id: 'batching',
  title: 'BatchedMesh multi-draw',
  measures: '多種不同 geometry 共用同一材質時的 multi-draw 吞吐與 per-object culling。',
  create(ctx: SceneContext): Promise<BenchmarkScene> {
    const instances = numberParam(ctx.params, 'count', 20_000, 1, 200_000);
    const spread = numberParam(ctx.params, 'spread', 300, 10, 10_000);

    const scene = new Scene();
    addStandardLights(scene);

    // 五種形狀模擬「城市建築零件」那種同材質、異幾何的情境。
    //
    // BatchedMesh 要求所有 geometry 的 index 有無必須一致，混用會在 addGeometry
    // 時丟例外。Polyhedron 系列（Icosahedron/Tetrahedron）是非索引的，所以這裡
    // 全部選用有索引的 primitive，並在下面實際檢查一次而不是憑記憶假設。
    const candidates: BufferGeometry[] = [
      new BoxGeometry(1, 2, 1),
      new ConeGeometry(0.7, 2, 8),
      new CylinderGeometry(0.5, 0.5, 2, 8),
      new SphereGeometry(0.8, 8, 6),
      new TorusGeometry(0.8, 0.3, 6, 10),
    ];

    const notes: string[] = [];
    const shapes = candidates.filter((g) => g.index !== null);
    const dropped = candidates.length - shapes.length;
    if (dropped > 0) {
      for (const g of candidates) if (g.index === null) g.dispose();
      notes.push(`${dropped} 個非索引 geometry 已排除：BatchedMesh 要求索引狀態一致`);
    }

    const totalVertices = shapes.reduce((sum, g) => sum + g.attributes['position']!.count, 0);
    const totalIndices = shapes.reduce((sum, g) => sum + (g.index?.count ?? 0), 0);

    const material = new MeshStandardMaterial({ roughness: 0.6 });
    const batched = new BatchedMesh(instances, totalVertices, totalIndices, material);
    batched.perObjectFrustumCulled = true;

    const geometryIds = shapes.map((g) => batched.addGeometry(g));

    const rng = createRng(DEFAULT_SEED);
    const matrix = new Matrix4();
    const dummy = new Object3D();
    for (let i = 0; i < instances; i++) {
      const geometryId = geometryIds[i % geometryIds.length]!;
      const instanceId = batched.addInstance(geometryId);
      dummy.position.set(
        rng.range(-spread, spread),
        rng.range(-spread * 0.15, spread * 0.15),
        rng.range(-spread, spread),
      );
      dummy.rotation.set(0, rng.range(0, Math.PI * 2), 0);
      dummy.scale.setScalar(rng.range(0.8, 3.0));
      dummy.updateMatrix();
      matrix.copy(dummy.matrix);
      batched.setMatrixAt(instanceId, matrix);
    }
    scene.add(batched);

    const camera = makeCamera(ctx.aspect, spread * 6);

    return Promise.resolve(rawScene(scene, camera, {
      update: (frameIndex) => {
        applyOrbitPath(camera, frameIndex, {
          radius: spread * 0.8,
          height: spread * 0.25,
          framesPerRevolution: ctx.measureFrames,
        });
      },
      reportParams: { count: instances, shapes: shapes.length, spread },
      notes,
      dispose: () => {
        for (const g of shapes) g.dispose();
        material.dispose();
        batched.dispose();
      },
    }));
  },
};
