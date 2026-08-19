import * as THREE from 'three';
import * as WW from '@webworld/three';

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

  if (useImpostor) {
    const baked = WW.bakeImpostor(renderer, tree, { views: 16, size: 128 });
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
    return { root, count, impostor: true, triangles: count * 2 };
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

  return { root, count, impostor: false, triangles };
}
