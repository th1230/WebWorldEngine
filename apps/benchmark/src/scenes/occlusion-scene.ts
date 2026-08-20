import { load, loadMaterial } from '@webworld/three';
import {
  AmbientLight,
  DirectionalLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  type MeshStandardMaterial,
} from 'three/webgpu';
import {
  numberParam,
  type BenchmarkScene,
  type SceneContext,
  type SceneDefinition,
  type SceneVerdict,
} from './types.ts';

/**
 * 遮擋到底值多少錢。
 *
 * ## 要問的不是「遮擋剔除快不快」
 *
 * 是**這個場景有多少東西畫了卻看不見**。沒有那個數字就沒有依據 ——
 * 而先前否決遮擋剔除的那次，用的正是一片散開的石頭：那種內容裡沒有東西
 * 擋住東西，量出來當然是「沒有價值」。那是拿錯內容量出來的結論。
 *
 * ## 為什麼是 Sponza
 *
 * 它是圖學界的標準遮擋測試場景：室內、有牆、有柱子、有二樓。站在中庭時
 * 牆後面整片幾何都在畫，而使用者一個像素都看不到。散開的石頭永遠不會有
 * 這個性質。
 *
 * ## 怎麼量「遮擋值多少錢」
 *
 * 拆解：三角形數 ÷ 三角形天花板、繪製次數 ÷ 繪製天花板，剩下的就是
 * fragment 與材質。而**被擋住的片段早就被硬體的 early-Z 丟掉了**（Three
 * 對不透明物件由近到遠排序，正好餵給 early-Z）。
 *
 * 所以遮擋剔除能省的只有幾何那一側 —— 而那一側佔多少，拆解就看得到。
 *
 * 曾經試過用深度預繪製當探針，但它慢了 5.82 ms，遠超過一趟幾何該有的
 * 0.54 ms，代表慢的原因不只是「多畫一趟」（ 可能讓每個
 * 物件重建 pipeline）。原因沒查清楚的量測不留在儀器裡 —— 一條自己都不信
 * 的數字比沒有數字更糟。
 */

const MANIFEST = '/cooked-sponza/assets.manifest.json';

/** Sponza 中庭的高度，相機站在這裡往柱廊看。 */
const EYE_HEIGHT = 2.5;

export const occlusionScene: SceneDefinition = {
  id: 'occlusion-sponza',
  title: '遮擋：Sponza 中庭',
  measures: '深度預繪製開／關。差額就是被浪費在看不見的像素上的成本。',
  async create(ctx: SceneContext): Promise<BenchmarkScene> {
    const angle = numberParam(ctx.params, 'angle', 0, 0, 360);

    const scene = new Scene();
    scene.add(new DirectionalLight(0xffffff, 2.0), new AmbientLight(0x404860, 1.2));

    const manifestUrl = MANIFEST;
    let manifest: { meshes: Record<string, unknown> };
    try {
      manifest = (await (await fetch(manifestUrl)).json()) as { meshes: Record<string, unknown> };
    } catch (error) {
      throw new Error('Sponza 載不到。先執行 pnpm cook:sponza —— assets/source/ 不進版控。', {
        cause: error,
      });
    }

    // 每個 primitive 一個 Mesh。Sponza 的每一塊都是獨一無二的幾何，
    // 不是同一個東西複製很多份 —— 所以這裡**刻意不用** `WW.InstancedMesh`。
    // 它解決的是「同一份幾何很多份」，而這個場景是另一個問題。
    const ids = Object.keys(manifest.meshes);
    const meshes: Mesh[] = [];
    let triangles = 0;
    for (const id of ids) {
      const [chain, material] = await Promise.all([
        load(manifestUrl, id),
        loadMaterial(manifestUrl, id).catch(() => null),
      ]);
      const geometry = chain.lods[0]!;
      const mesh = new Mesh(geometry, (material ?? undefined) as MeshStandardMaterial | undefined);
      triangles += geometry.getIndex()!.count / 3;
      scene.add(mesh);
      meshes.push(mesh);
    }

    // Sponza 的單位是公分等級的大場景；用內容自己的包圍盒決定相機，
    // 不要寫死座標 —— 換一份資產就會全錯。
    scene.updateMatrixWorld(true);
    let radius = 1;
    for (const mesh of meshes) {
      mesh.geometry.computeBoundingSphere();
      const sphere = mesh.geometry.boundingSphere;
      if (sphere !== null) radius = Math.max(radius, sphere.center.length() + sphere.radius);
    }

    const camera = new PerspectiveCamera(70, ctx.aspect, radius * 0.002, radius * 4);
    const eye = radius * 0.02;
    const theta = (angle * Math.PI) / 180;
    camera.position.set(
      Math.cos(theta) * radius * 0.25,
      eye * EYE_HEIGHT,
      Math.sin(theta) * radius * 0.05,
    );
    camera.lookAt(-Math.cos(theta) * radius, eye * EYE_HEIGHT, -Math.sin(theta) * radius * 0.2);

    return {
      update: () => {
        // 相機不動：遮擋的比例由視角決定，動了就在比不同的東西。
      },
      render: (backend) => {
        backend.submitRaw(scene, camera);
      },
      resize: (width: number, height: number) => {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      },
      precompile: async (backend) => {
        await backend.precompileRaw(scene, camera);
      },
      reportParams: { angle, meshes: ids.length, triangles },
      notes: [
        `Sponza：${ids.length} 個 primitive、${triangles.toLocaleString()} 個三角形。`,
        '拆解：三角形 ÷ 天花板、繪製次數 ÷ 天花板，剩下的是 fragment 與材質。',
        '被擋住的片段已經被硬體的 early-Z 丟掉，所以遮擋剔除能省的只有幾何那一側。',
      ],
      verdict: (): SceneVerdict => ({
        ok: ids.length > 0 && triangles > 0,
        detail: `${ids.length} 個 primitive、${triangles.toLocaleString()} 個三角形`,
      }),
      dispose: () => {
        for (const mesh of meshes) mesh.geometry.dispose();
      },
    };
  },
};
