import * as WW from '@webworld/three';
import { MeshStandardNodeMaterial, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { HemisphereLight, DirectionalLight, Color, Matrix4, Vector3 } from 'three/webgpu';
import { makeSkinnedRig } from './skinned.ts';

/**
 * `WW.AnimatedInstancedMesh` 在 **WebGPU** 上的驗證頁。
 *
 * ## 為什麼需要一頁獨立的
 *
 * VAT 有兩份實作：WebGL 那份注入 GLSL（`onBeforeCompile`），WebGPU 那份設
 * `positionNode`（TSL）。**兩份的失效方式一模一樣** —— 模型停在綁定姿勢、
 * 不報錯、幀時間還特別好看。
 *
 * 而主要的範例頁跑的是 `WebGLRenderer`，所以它永遠驗不到另一份。這一頁存在
 * 的唯一理由是：**讓 node 那條路也有東西可以看**。
 *
 * ## 判準是「有沒有在動」，不是「有沒有跑完」
 *
 * 所以它把兩個時間點的頂點位置都記下來，交給量測工具比 —— 兩個時間點的畫面
 * 一樣的話，就是那份實作沒接上。
 */

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;
const params = new URLSearchParams(location.search);
const COUNT = Number(params.get('count') ?? 200);

const renderer = new WebGPURenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight, false);
await renderer.init();

const scene = new Scene();
scene.background = new Color(0x0d1117);
scene.add(new HemisphereLight(0xbfd4ff, 0x202028, 2.2));
const sun = new DirectionalLight(0xffffff, 2.4);
sun.position.set(120, 200, 80);
scene.add(sun);

const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 2000);

const rig = makeSkinnedRig(8);
const baked = WW.bakeVertexAnimation(rig.mesh, rig.clip, { frames: 32 });
// **node 材質** —— 這正是 WebGL 那條路碰不到的東西。
const material = new MeshStandardNodeMaterial({ color: 0x9aa7b5, roughness: 0.7 });
const mesh = new WW.AnimatedInstancedMesh(baked, material, COUNT);
await mesh.nodeReady;

const m = new Matrix4();
let seed = 7;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
for (let i = 0; i < COUNT; i++) {
  m.makeTranslation((rand() - 0.5) * 120, 0, (rand() - 0.5) * 120);
  mesh.setMatrixAt(i, m);
}
scene.add(mesh);

let frames = 0;
function step(t: number): void {
  mesh.time = t;
  camera.position.set(Math.cos(t * 0.12) * 90, 20, Math.sin(t * 0.12) * 90);
  camera.lookAt(new Vector3(0, 2, 0));
  camera.updateMatrixWorld(true);
  renderer.render(scene, camera);
  frames++;
}

renderer.setAnimationLoop(() => {
  step(performance.now() / 1000);
  hud.textContent = `WebGPU · node 材質\ninstance ${COUNT}\n幀 ${frames}`;
});

Object.assign(window, {
  __wwgpu: {
    renderer,
    mesh,
    frames: (): number => frames,
    /**
     * 在固定的時間點畫一幀，回傳這一幀真的被送出去的三角形數。
     *
     * 動畫有沒有在動要另外看 —— 見 `sampleAt`。
     */
    async step(t: number): Promise<number> {
      renderer.setAnimationLoop(null);
      step(t);
      await renderer.renderAsync(scene, camera);
      return renderer.info.render.triangles;
    },
  },
});
