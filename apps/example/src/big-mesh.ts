import * as THREE from 'three';
import * as WW from '@webworld/three';

/**
 * 一份**很大的單一幾何**，用來量 `splitWithLods` 值多少。
 *
 * ## 為什麼要另外做一個場景
 *
 * `MultiMesh` 那條軸的量測是「一塊一塊生出來的地形」—— 它從來沒有經過
 * 「一份大幾何」這個狀態，所以它證明不了切塊工具本身有沒有用。
 *
 * 而「我有一份很大的幾何」正是這個工具存在的理由：掃描回來的建築、一整份
 * GLB、別人給的地形。那些人手上就是一份。
 *
 * 所以這裡刻意先造出一份完整的大幾何，再讓工具去切 —— 走的是使用者真正
 * 會走的那條路。
 */

export interface BigMeshScene {
  root: THREE.Group;
  triangles: number;
  pieces: number;
}

/** 一片起伏的地面，整片是**一份**幾何。 */
function makeHeightfield(size: number, segments: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(
      i,
      Math.sin(x * 0.004) * 60 + Math.cos(z * 0.0055) * 45 + Math.sin((x + z) * 0.013) * 12,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * @param chunks 0 代表**不切** —— 整片一份幾何，一個物件。那是對照組。
 */
export async function makeBigMesh(
  size: number,
  segments: number,
  chunks: number,
): Promise<BigMeshScene> {
  const root = new THREE.Group();
  const geometry = makeHeightfield(size, segments);
  const triangles = (geometry.getIndex()?.count ?? 0) / 3;
  const material = new THREE.MeshStandardMaterial({ color: 0x8a9a6b, roughness: 0.9 });

  if (chunks <= 0) {
    // 對照組：整片一份，一個 Mesh。選階與剔除都只能整片一起做。
    root.add(new THREE.Mesh(geometry, material));
    return { root, triangles, pieces: 1 };
  }

  const sources = await WW.splitWithLods(geometry, { chunks, minTriangles: 256 });
  root.add(new WW.MultiMesh(sources, material));
  return { root, triangles, pieces: sources.length };
}
