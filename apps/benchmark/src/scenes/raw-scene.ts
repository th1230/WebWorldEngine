import type { ThreeRenderBackend } from '@ww/render-three';
import type { PerspectiveCamera, Scene } from 'three/webgpu';
import type { BenchmarkScene } from './types.ts';

/**
 * 把「自備 Three.js 場景樹」的 benchmark 包成 BenchmarkScene。
 *
 * 的八個場景量的都是 **renderer 特性**（instance 吞吐、shader 編譯停頓、
 * 貼圖記憶體、indirect draw 可行性），不是引擎特性。把它們改寫成 ECS 會在
 * 量測與被量測對象之間多墊一層 extraction，而且**會讓 建立的所有基準失效**。
 *
 * 所以它們維持原樣，走 `submitRaw`。引擎層級的量測由 `ecs-*` 場景負責。
 */
export type RawSceneParts = Omit<BenchmarkScene, 'render' | 'resize' | 'precompile'>;

export function rawScene(
  scene: Scene,
  camera: PerspectiveCamera,
  parts: RawSceneParts,
): BenchmarkScene {
  return {
    ...parts,
    render: (backend: ThreeRenderBackend) => {
      backend.submitRaw(scene, camera);
    },
    resize: (width: number, height: number) => {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
    precompile: async (backend: ThreeRenderBackend) => {
      await backend.precompileRaw(scene, camera);
    },
  };
}
