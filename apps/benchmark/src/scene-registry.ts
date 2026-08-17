import { baselineEmptyScene, batchingScene, instancingScene } from './scenes/basic-scenes.ts';
import { computeIndirectScene, deviceLossSoakScene } from './scenes/gpu-driven-scenes.ts';
import {
  materialComplexityScene,
  shaderCompileScene,
  textureLoadScene,
} from './scenes/shader-scenes.ts';
import { cpuCeilingScene, gpuDrawCallCeilingScene, gpuTriangleCeilingScene } from './scenes/ceiling-scenes.ts';
import { textureConformanceScene } from './scenes/texture-conformance.ts';
import { occlusionScene } from './scenes/occlusion-scene.ts';
import { nativeRealAssetScene, wwRealAssetScene } from './scenes/real-asset-scenes.ts';
import { nativeInstancingScene, wwInstancingScene } from './scenes/ww-scenes.ts';
import type { SceneDefinition } from './scenes/types.ts';

/**
 * 多數場景使用合成資料，量到的是**硬體與 backend 的上限**，不是真實場景效能。
 *
 * `ab-*-real` 是例外：它們載入 cook 過的真實資產（先跑 `pnpm cook:real`）。
 * 合成內容在兩個方向上都不具代表性，而且錯的方向相反 —— `IcosahedronGeometry`
 * 是非索引的（幾何看起來貴 3.35 倍），而且沒有貼圖（材質看起來免費，真實
 * PBR 是 1.72 倍）。只用它量出來的 CPU/GPU 佔比會把後續每一個決策帶往錯的方向。
 */
export const SCENES: readonly SceneDefinition[] = [
  baselineEmptyScene,
  instancingScene,
  // ── A/B 對照 ────────────────────────────────────────────────────────────
  // **這兩個必須相鄰**。runner 的迴圈是 `for 每一輪 { for 每個場景 }`，
  // 所以相鄰註冊代表同一輪裡背靠背執行、輪與輪之間交替。這台機器的量測是
  // 雙峰的，連續跑完一組再跑另一組會得出完全相反的結論。
  nativeInstancingScene,
  wwInstancingScene,
  // 同一個實驗換成真實資產。同樣必須相鄰，理由同上。
  nativeRealAssetScene,
  wwRealAssetScene,
  // 遮擋：唯一有東西擋住東西的場景。散開的石頭量不出遮擋的價值。
  occlusionScene,
  // 天花板：兩端各自的上限。W4 的前提，不是結果。
  cpuCeilingScene,
  gpuTriangleCeilingScene,
  gpuDrawCallCeilingScene,
  batchingScene,
  materialComplexityScene,
  textureLoadScene,
  computeIndirectScene,
  shaderCompileScene,
  deviceLossSoakScene,
  textureConformanceScene,
];

export const DEFAULT_SCENE_ID = baselineEmptyScene.id;

export function findScene(id: string): SceneDefinition | undefined {
  return SCENES.find((s) => s.id === id);
}
