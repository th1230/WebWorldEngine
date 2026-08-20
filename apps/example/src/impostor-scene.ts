import * as THREE from 'three';
import * as WW from '@webworld/three';
import { readPixelsAsync } from './readback.ts';

/**
 * Impostor 對真幾何：同樣的數量、同樣的位置，只換表示法。
 *
 * ## 為什麼要有這個場景
 *
 * roadmap 曾經用「把選階壓到最粗」當 impostor 的代理去量，結論是「幾何那一側
 * 沒剩多少」。但最粗階還有幾十個三角形，impostor 是兩個 —— 代理與真東西差了
 * 一個數量級，而那次量測的符號還會翻面（落在雜訊裡）。
 *
 * 所以這裡兩邊都真的做出來，同樣的相機、同樣的擺放，只換表示法。
 *
 * ## 判準有兩個，缺一不可
 *
 * - **快多少**：GPU 時間
 * - **像不像**：impostor 是近似，快而不像不算贏
 *
 * 只看第一個的話，把東西全部畫成兩個三角形當然最快 —— 那不是優化。
 */

export interface ImpostorScene {
  root: THREE.Group;
  count: number;
  /** `true` 代表這一份是 impostor，`false` 是真幾何。 */
  impostor: boolean;
  triangles: number;
  /**
   * 從某個方位角看一幀，畫進自己的 render target。
   *
   * 方位角是 impostor 唯一會挑錯的維度 —— 挑錯格的症狀是「樹從側面看變成
   * 另一棵樹」，只有繞一圈才量得到。
   */
  render: (renderer: unknown, azimuth: number) => void;
  /** 一塊區域的平均顏色，非同步 —— 兩個後端都走得通。 */
  windowAsync: (
    renderer: unknown,
    u: number,
    v: number,
    width: number,
    height?: number,
  ) => Promise<number[]>;
  /** 整張畫面被畫到的比例，以及畫到的地方的平均顏色。 */
  statsAsync: (renderer: unknown) => Promise<number[]>;
  /** 直接讀圖集的一格：`cell` 是第幾格，回傳那一格的平均 RGB 與 alpha。 */
  atlasCellAsync: (renderer: unknown, cell: number) => Promise<number[]>;
  /** 等 WebGPU 那條路建好。 */
  nodeReady: (renderer: unknown) => Promise<void>;
}

/** 一棵簡單的樹 —— 有樹幹有樹冠，從側面看有明確的輪廓。 */
function makeTree(): THREE.Group {
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.5, 6, 12),
    new THREE.MeshBasicMaterial({ color: 0x6b4a2f }),
  );
  trunk.position.y = 3;
  tree.add(trunk);

  // 三層樹冠，讓輪廓不是一顆球 —— 球從每個角度都一樣，那樣 impostor 的
  // 「挑哪一格」就驗不出對錯了。
  for (const [y, r] of [
    [6.5, 3.2],
    [8.6, 2.4],
    [10.2, 1.5],
  ] as const) {
    const crown = new THREE.Mesh(
      new THREE.ConeGeometry(r, 3.4, 14),
      new THREE.MeshBasicMaterial({ color: 0x3f7a3f }),
    );
    crown.position.y = y;
    tree.add(crown);
  }

  // ## 一個只在一邊的紅色標記
  //
  // 樹幹與樹冠都是旋轉對稱的（圓柱加三個圓錐），而 impostor 最主要的失敗
  // 模式是**挑錯格** —— 對稱的物件上「挑錯 22.5 度」與「取樣差一點」長得
  // 一模一樣，量不出來。
  //
  // 實測就是這個形狀：兩個後端的紅色差 6–11%，而那個差既可能是挑錯一格，
  // 也可能是取樣。加一個只在 +x 那側的標記之後，挑錯格會讓紅色在畫面上
  // 整個換位置。
  {
    const mark = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 4.5, 1.2),
      new THREE.MeshBasicMaterial({ color: 0xff2020 }),
    );
    mark.position.set(2.6, 7.5, 0);
    tree.add(mark);
  }
  return tree;
}

export function makeImpostorScene(
  renderer: THREE.WebGLRenderer,
  count: number,
  spread: number,
  useImpostor: boolean,
): ImpostorScene {
  const root = new THREE.Group();
  const tree = makeTree();

  let seed = 11;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const positions: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    positions.push([(rand() - 0.5) * spread, (rand() - 0.5) * spread]);
  }


  // ## 自己的相機與 target
  //
  // 兩個後端要量同一塊畫面，而畫布大小不見得一樣。畫進固定尺寸的 target
  // 之後，「畫面的第幾個像素」在兩邊才是同一件事。
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 1, 20000);
  const target = new THREE.WebGLRenderTarget(1280, 720, { colorSpace: THREE.NoColorSpace });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(root);

  const draw = (r: unknown, azimuth: number): void => {
    const gl = r as THREE.WebGLRenderer;
    // 取景要讓樹**佔到畫面**：這一項量的是看板本身，不是剔除。
    // 第一版擺在 1210 之外，四百棵樹加起來只覆蓋畫面的 2%，而那個量對
    // 「看板有沒有朝向相機」幾乎沒有反應。
    const distance = spread * 0.55 + 60;
    camera.position.set(
      Math.sin(azimuth) * distance,
      42,
      Math.cos(azimuth) * distance,
    );
    camera.lookAt(0, 18, 0);
    camera.updateMatrixWorld(true);
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(previous);
  };

  const read = async (
    r: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<Uint8Array> =>
    (await readPixelsAsync(r, target, x, y, width, height, (n) =>
      new Uint8Array(n),
    )) as Uint8Array;

  let bakedAtlas: WW.BakedImpostor | null = null;

  const api = {
    render: draw,
    windowAsync: async (
      r: unknown,
      u: number,
      v: number,
      width: number,
      height = width,
    ): Promise<number[]> => {
      const x = Math.min(target.width - width, Math.max(0, Math.round(u * target.width) - (width >> 1)));
      const y = Math.min(
        target.height - height,
        Math.max(0, Math.round(v * target.height) - (height >> 1)),
      );
      const data = await read(r, x, y, width, height);
      const sum = [0, 0, 0];
      for (let i = 0; i < width * height; i++) {
        for (let c = 0; c < 3; c++) sum[c]! += data[i * 4 + c] ?? 0;
      }
      return sum.map((value) => value / (width * height) / 255);
    },
    statsAsync: async (r: unknown): Promise<number[]> => {
      const data = await read(r, 0, 0, target.width, target.height);
      let covered = 0;
      const sum = [0, 0, 0];
      const total = target.width * target.height;
      for (let i = 0; i < total; i++) {
        const rr = data[i * 4] ?? 0;
        const g = data[i * 4 + 1] ?? 0;
        const b = data[i * 4 + 2] ?? 0;
        if (rr + g + b > 30) {
          covered++;
          sum[0]! += rr;
          sum[1]! += g;
          sum[2]! += b;
        }
      }
      const painted = Math.max(covered, 1);
      return [
        covered / total,
        sum[0]! / painted / 255,
        sum[1]! / painted / 255,
        sum[2]! / painted / 255,
      ];
    },
    atlasCellAsync: async (r: unknown, cell: number): Promise<number[]> => {
      if (bakedAtlas === null) return [0, 0, 0, 0];
      const size = bakedAtlas.target.height;
      const data = (await readPixelsAsync(
        r,
        bakedAtlas.target,
        cell * size,
        0,
        size,
        size,
        (n) => new Uint8Array(n),
      )) as Uint8Array;
      const sum = [0, 0, 0, 0];
      for (let i = 0; i < size * size; i++) {
        for (let c = 0; c < 4; c++) sum[c]! += data[i * 4 + c] ?? 0;
      }
      return sum.map((value) => value / (size * size) / 255);
    },
    nodeReady: async (r: unknown): Promise<void> => {
      // node 材質是動態 import 進來的，而它要先被畫過一次才會開始建。
      for (let i = 0; i < 40; i++) {
        draw(r, 0);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
  };

  if (useImpostor) {
    const baked = WW.bakeImpostor(renderer, tree, { views: 16, size: 128 });
    bakedAtlas = baked;
    const batch = new WW.ImpostorBatch(baked, count);
    const m = new THREE.Matrix4();
    for (const [i, [x, z]] of positions.entries()) {
      // 看板的中心要對到樹的包圍球心，不是樹根 —— 對到樹根的話看板會有一半
      // 埋在地下。
      m.makeTranslation(x, baked.center.y, z);
      batch.setMatrixAt(i, m);
    }
    batch.instanceMatrix.needsUpdate = true;
    root.add(batch);
    return { root, count, impostor: true, triangles: count * 2, ...api };
  }

  // 真幾何那一邊用 InstancedMesh 逐 mesh 一批 —— 樹是三個 mesh，所以三批。
  let triangles = 0;
  const m = new THREE.Matrix4();
  tree.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry === undefined) return;
    const batch = new THREE.InstancedMesh(mesh.geometry, mesh.material as THREE.Material, count);
    batch.frustumCulled = false;
    for (const [i, [x, z]] of positions.entries()) {
      m.makeTranslation(x, mesh.position.y, z);
      batch.setMatrixAt(i, m);
    }
    batch.instanceMatrix.needsUpdate = true;
    root.add(batch);
    triangles += ((mesh.geometry.getIndex()?.count ?? mesh.geometry.getAttribute('position').count) / 3) * count;
  });

  return { root, count, impostor: false, triangles, ...api };
}
