import * as WW from '@webworld/three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { HemisphereLight, DirectionalLight, Color, Matrix4, Vector3 } from 'three/webgpu';
import { makeSkinnedRig } from './skinned.ts';
import { makeGiScene, type GiScene } from './gi-scene.ts';
import { makeSkyScene, type SkyScene } from './sky-scene.ts';
import { makeContactScene, type ContactScene } from './contact-scene.ts';
import { makeDfShadowScene, type DfShadowScene } from './df-shadow-scene.ts';
import { makeFogScene, type FogScene } from './fog-scene.ts';
import {
  makeReflectionProbeScene,
  type ReflectionProbeScene,
} from './reflection-probe-scene.ts';
import { makeWaterLookScene, type WaterLookScene } from './water-look-scene.ts';
import { makeVsmScene, type VsmScene } from './vsm-scene.ts';
import { makeLodFadeScene, type LodFadeScene } from './lod-fade-scene.ts';

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
/**
 * `?contact=1` 換成接觸陰影的驗證場景。與 WebGL 那頁共用同一個
 * `makeContactScene` —— 佈置一模一樣，只有 renderer 不同。
 */
const CONTACT = params.get('contact') === '1';
/** `?dfshadow=1` 換成距離場陰影的驗證場景。與 WebGL 那頁共用同一個場景。 */
const DF_SHADOW = params.get('dfshadow') === '1';
/** `?fog=1` 換成體積霧的驗證場景。與 WebGL 那頁共用同一個場景。 */
const FOG = params.get('fog') === '1';
/** `?reflprobe=1` 換成反射探針的驗證場景（四面牆各一個顏色的房間）。 */
const REFL_PROBE = params.get('reflprobe') === '1';
/** `?waterlook=1` 換成水的外觀場景。 */
const WATER_LOOK = params.get('waterlook') === '1';
/** `?vsm=N` 換成虛擬陰影圖場景，N 是虛擬邊長的倍數。 */
const VSM = params.has('vsm') ? Math.max(1, Number(params.get('vsm'))) : 0;
/** `?lodfade=1` 換成換階淡入的場景。 */
const LOD_FADE = params.get('lodfade') === '1';

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

let lodFadeScene: LodFadeScene | null = null;
if (LOD_FADE) {
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  // node 材質 —— WebGPU 上淡入接的是它的 `maskNode`。給普通材質的話套件會
  // 在主控台大聲說「接不上」，而關卡把主控台的錯誤也當成失敗。
  lodFadeScene = makeLodFadeScene(MeshBasicNodeMaterial as never);
  // 這個場景有自己的私有 scene —— 不要把 root 加進來。
  await lodFadeScene.nodeReady(renderer);
}

let vsmScene: VsmScene | null = null;
if (VSM > 0) {
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  vsmScene = makeVsmScene(VSM);
  // 這個場景有自己的私有 scene —— 不要把 root 加進來。
  vsmScene.settle(renderer as never);
  await vsmScene.nodeReady(renderer);
}

let waterLookScene: WaterLookScene | null = null;
if (WATER_LOOK) {
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  waterLookScene = makeWaterLookScene();
  // 這個場景有自己的私有 scene —— 不要把 root 加進來。
  await waterLookScene.settle(renderer as never);
  await waterLookScene.nodeReady(renderer);
}

let reflectionProbeScene: ReflectionProbeScene | null = null;
if (REFL_PROBE) {
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  reflectionProbeScene = makeReflectionProbeScene();
  // 這個場景有自己的私有 scene —— 不要把 root 加進來。
  await reflectionProbeScene.settle(renderer as never);
  await reflectionProbeScene.nodeReady(renderer);
}

let fogScene: FogScene | null = null;
if (FOG) {
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  fogScene = makeFogScene();
  // 這個場景有自己的私有 scene —— 不要把 root 加進來。
  fogScene.settle();
  await fogScene.nodeReady(renderer);
}

let dfShadowScene: DfShadowScene | null = null;
if (DF_SHADOW) {
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  dfShadowScene = makeDfShadowScene();
  // 這個場景有自己的私有 scene —— **不要**把 root 加進來（加了會把它從
  // 私有 scene 搬走，gbuffer 就畫到空的）。
  dfShadowScene.settle();
  await dfShadowScene.nodeReady(renderer);
}

let contactScene: ContactScene | null = null;
if (CONTACT) {
  scene.remove(...scene.children.filter((o) => (o as { isLight?: boolean }).isLight === true));
  contactScene = makeContactScene();
  // ## **不要**把 root 加進這一頁的場景
  //
  // 這個場景有自己的私有 scene，而 gbuffer 畫的就是那一個。加進來會把 root
  // 從私有 scene 裡**搬走**（Three 的 add 會重新掛父節點），於是 gbuffer 畫
  // 到的是空的 —— 深度全 1、法線全 0，而效果看起來像完全沒作用。
  //
  // WebGL 那頁本來就沒有加，是我照著天空/間接光那兩個的寫法抄過來才踩到。
  // 天空與間接光可以加是因為它們畫的是這一頁的場景。
  // node 材質是非同步建的。不等的話量到的是還沒畫過的 target。
  await contactScene.nodeReady(renderer);
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
if (
  giScene === null &&
  skyScene === null &&
  contactScene === null &&
  dfShadowScene === null &&
  fogScene === null &&
  reflectionProbeScene === null &&
  waterLookScene === null &&
  vsmScene === null &&
  lodFadeScene === null
) {
  scene.add(mesh);
}

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
    lodFade:
      lodFadeScene === null
        ? null
        : {
            render: (distance: number): number =>
              lodFadeScene.render(renderer as never, distance),
            windowAsync: (
              u: number,
              v: number,
              width: number,
              height?: number,
            ): Promise<number[]> => lodFadeScene.windowAsync(renderer, u, v, width, height),
            statsAsync: (): Promise<number[]> => lodFadeScene.statsAsync(renderer),
          },
    vsm:
      vsmScene === null
        ? null
        : {
            settle: (): number => vsmScene.settle(renderer as never),
            resolve: (debug?: number): void => vsmScene.resolve(renderer as never, debug),
            sampleWindowAsync: (
              u: number,
              v: number,
              width: number,
              height?: number,
            ): Promise<number[]> => vsmScene.sampleWindowAsync(renderer, u, v, width, height),
            info: (): unknown => vsmScene.info(),
            atlasWindowAsync: (u: number, v: number, size: number): Promise<number[]> =>
              vsmScene.atlasWindowAsync(renderer, u, v, size),
          },
    waterLook:
      waterLookScene === null
        ? null
        : {
            settle: (): Promise<number> => waterLookScene.settle(renderer as never),
            render: (debug?: number): void => waterLookScene.render(renderer as never, debug),
            sampleWindowAsync: (
              u: number,
              v: number,
              width: number,
              height?: number,
            ): Promise<number[]> => waterLookScene.sampleWindowAsync(renderer, u, v, width, height),
            // CPU 的水面 —— 兩份 GPU 實作互比只知道不一樣，不知道誰不對。
            heightAt: (x: number, z: number): number => waterLookScene.heightAt(x, z),
            setRefraction: (value: number): void => waterLookScene.setRefraction(value),
          },
    reflProbe:
      reflectionProbeScene === null
        ? null
        : {
            settle: (): Promise<number> => reflectionProbeScene.settle(renderer as never),
            render: (useProbes: boolean): void =>
              reflectionProbeScene.render(renderer as never, useProbes),
            sampleWindowAsync: (x: number, z: number, size: number): Promise<number[]> =>
              reflectionProbeScene.sampleWindowAsync(renderer, x, z, size),
          },
    fog:
      fogScene === null
        ? null
        : {
            settle: (): number => fogScene.settle(),
            render: (useField: boolean): void => fogScene.render(renderer as never, useField),
            sampleWindowAsync: (u: number, v: number, size: number): Promise<number[]> =>
              fogScene.sampleWindowAsync(renderer, u, v, size),
            spots: (): unknown => fogScene.spots,
          },
    dfShadow:
      dfShadowScene === null
        ? null
        : {
            settle: (): number => dfShadowScene.settle(),
            render: (): void => dfShadowScene.render(renderer as never),
            sampleWindowAsync: (
              which: "shadow" | "open" | "behind" | "outside" | "boxTop" | "terminator",
              size: number,
            ): Promise<number> =>
              dfShadowScene.sampleWindowAsync(renderer, dfShadowScene.points[which], size),
            coverageAsync: (): Promise<number> => dfShadowScene.coverageAsync(renderer),
          },
    contact:
      contactScene === null
        ? null
        : {
            render: (): void => contactScene.render(renderer as never),
            setDebug: (mode: number): void => contactScene.setDebug(mode),
            coverageAsync: (): Promise<number> => contactScene.coverageAsync(renderer),
            probePixel: (which: "contact" | "open" | "lit" | "terminator" | "under"): unknown =>
              contactScene.probePixel(contactScene.points[which]),
            readPixelAsync: (x: number, y: number): Promise<number> =>
              contactScene.readPixelAsync(renderer, x, y),
            sampleWindowAsync: (which: "contact" | "open" | "lit" | "terminator" | "under", size: number): Promise<number> =>
              contactScene.sampleWindowAsync(renderer, contactScene.points[which], size),
            maskMapAsync: (): Promise<number[]> => contactScene.maskMapAsync(renderer),
            normalMapAsync: (): Promise<number[]> => contactScene.normalMapAsync(renderer),
            sampleNormalAsync: (which: "contact" | "open" | "lit" | "terminator" | "under"): Promise<number[]> =>
              contactScene.sampleNormalAsync(renderer, contactScene.points[which]),
            sampleAsync: (
              which: "contact" | "open" | "lit" | "terminator" | "under",
            ): Promise<number> =>
              contactScene.sampleAsync(renderer, contactScene.points[which]),
          },
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
