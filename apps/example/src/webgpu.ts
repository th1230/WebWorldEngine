import * as WW from '@webworld/three';
import { MeshStandardNodeMaterial, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { HemisphereLight, DirectionalLight, Color, Matrix4, Vector3 } from 'three/webgpu';
import { makeSkinnedRig } from './skinned.ts';
import { makeGiScene, type GiScene } from './gi-scene.ts';
import { makeSkyScene, type SkyScene } from './sky-scene.ts';

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
/**
 * `?gi=1` 換成間接光的驗證場景。
 *
 * 與 WebGL 那頁**共用同一個 `makeGiScene`** —— 只有材質工廠不同。各自寫
 * 一份「差不多的場景」的話，量到的差異可能來自佈置不同而不是實作不同。
 */
const GI = params.get('gi') === '1';
/**
 * `?giOff=1` 把間接光的強度設成 0。
 *
 * node 材質那條路的強度是**編譯期常數**，改不動（實測：JS 這一側改了、
 * 畫面一個位元都沒動）。所以這條路的 A/B 是**開兩次頁面**：同一個場景、
 * 同一組相機、同一份著色器，只有那個常數不同。
 */
const GI_OFF = params.get('giOff') === '1';
/**
 * `?sky=1` 換成天空的驗證場景。
 *
 * 與 WebGL 那頁**共用同一個 `makeSkyScene`** —— 場景一模一樣，只有 renderer
 * 不同。跨後端比對的前提就是這個：量到的差異只能來自實作，不能來自佈置。
 */
const SKY = params.get('sky') === '1';

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

let giScene: GiScene | null = null;
if (GI) {
  // 間接光的判準要求場景裡**沒有其他環境光源** —— 半球光會讓箱子的背面
  // 本來就是亮的，那就證明不了光是從紅牆反彈過來的。
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  scene.background = new Color(0x000000);
  giScene = makeGiScene(
    (color, roughness) => new MeshStandardNodeMaterial({ color, roughness }),
    GI_OFF ? 0 : 1,
  );
  scene.add(giScene.root);
  // node 材質那條路是**非同步**接上的（動態 import three/tsl）。不等的話
  // 前幾幀還沒有間接光，而量測會剛好落在那幾幀裡。
  await WW.irradianceNodeReady();

}

let skyScene: SkyScene | null = null;
if (SKY) {
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  skyScene = makeSkyScene();
  scene.add(skyScene.root);
  // node 那條路是非同步建起來的。不等的話前幾幀還沒有天空，而量測會剛好
  // 落在那幾幀裡 —— 讀到全黑，看起來像「WebGPU 上沒有天空」。
  await skyScene.nodeReady(renderer);
}

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
if (giScene === null && skyScene === null) scene.add(mesh);

let frames = 0;
function step(t: number): void {
  mesh.time = t;
  if (giScene !== null) {
    // 固定機位，與 WebGL 那頁**同一組數字** —— 兩邊量的必須是同一塊畫面。
    camera.position.set(-34, 16, -34);
    camera.lookAt(new Vector3(0, 12, 0));
  } else {
    camera.position.set(Math.cos(t * 0.12) * 90, 20, Math.sin(t * 0.12) * 90);
    camera.lookAt(new Vector3(0, 2, 0));
  }
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
    sky:
      skyScene === null
        ? null
        : {
            setSun: (elevation: number): boolean =>
              skyScene.setSun(elevation, renderer as never),
            sampleFaceAsync: (face: number): Promise<[number, number, number]> =>
              skyScene.sampleFaceAsync(renderer, face),
            bakes: (): number => skyScene.bakes(),
          },
    renderer,
    mesh,
    frames: (): number => frames,
    /**
     * 在固定的時間點畫一幀，回傳這一幀真的被送出去的三角形數。
     *
     * 動畫有沒有在動要另外看 —— 見 `sampleAt`。
     */
    gi:
      giScene === null
        ? null
        : {
            stats: () => giScene.stats(),
            bake: () => giScene.bake(renderer as never, scene as never),
            setEnabled: (on: boolean) => giScene.setEnabled(on),
            sampleCpu: (p: [number, number, number], n: [number, number, number]) => giScene.sampleCpu(p, n),
            sample: (x: number, y: number, w: number, h: number) => {
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
    async step(t: number): Promise<number> {
      renderer.setAnimationLoop(null);
      step(t);
      await renderer.renderAsync(scene, camera);
      return renderer.info.render.triangles;
    },
  },
});
