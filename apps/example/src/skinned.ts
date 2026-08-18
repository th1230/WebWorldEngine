import * as THREE from 'three';

/**
 * 「會動的東西」那條軸的**量尺**，不是功能。
 *
 * ## 為什麼這條軸得先量
 *
 * 這個引擎的每一項優化都建立在兩個假設上：矩陣大致不動（所以空間分割划算）、
 * 幾何共用且不變（所以 `BatchedMesh`、LOD 鏈、遠景合併都成立）。
 *
 * **骨骼蒙皮把第二個假設整個打掉**：每個 instance 有自己的姿勢，所以頂點
 * 逐 instance 不同。`THREE.BatchedMesh` 不支援蒙皮，所以這個套件現在對它
 * 完全無能為力 —— 而那句話需要一個數字撐著，不是一句「做不到」。
 *
 * ## 為什麼用程序化的網格，以及它的限制
 *
 * 這裡量的是**成本怎麼隨數量成長**，不是「這個模型跑多快」。逐 instance 的
 * 繪製呼叫與骨骼矩陣上傳跟模型長什麼樣無關，所以一根蒙皮圓柱就足以量出那條
 * 曲線，而且不必牽扯資產管線（cook 也還不處理蒙皮）。
 *
 * **但絕對吞吐量不能拿這個推論** —— 那要用真的資產（`assets/source/gltf-sample`
 * 裡有 22 個有動畫的，其中 BrainStem 61,666 個三角形／18 根骨頭）。準則說
 * 「先造內容再量」會讓內容決定結論，所以這裡刻意只回答「怎麼成長」這一個問題。
 */

export interface SkinnedField {
  root: THREE.Group;
  /** 每一幀要呼叫，讓骨頭動起來 —— 不動的話量到的不是動畫的成本。 */
  update: (t: number) => void;
  triangles: number;
  bones: number;
}

/**
 * 一根分成 `segments` 段的蒙皮圓柱，`count` 份散在一片方格上。
 *
 * 每一份都是獨立的 `SkinnedMesh` + 獨立的 `Skeleton` —— 那正是今天用
 * Three.js 做一群會動的東西時的樣子，也就是要被量的基準。
 */
export function makeSkinnedField(count: number, spread: number, boneCount = 8): SkinnedField {
  const height = 4;
  const geometry = new THREE.CylinderGeometry(0.5, 0.5, height, 8, boneCount * 2);
  const position = geometry.getAttribute('position');

  // 依高度分配骨骼權重：每個頂點綁在它上下兩根骨頭之間線性內插。
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const segment = height / boneCount;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i) + height / 2;
    const bone = Math.min(Math.floor(y / segment), boneCount - 1);
    const blend = (y % segment) / segment;
    skinIndices.push(bone, Math.min(bone + 1, boneCount - 1), 0, 0);
    skinWeights.push(1 - blend, blend, 0, 0);
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));

  const material = new THREE.MeshStandardMaterial({ color: 0x9aa7b5, roughness: 0.7 });
  const root = new THREE.Group();
  const skeletons: THREE.Bone[][] = [];

  let seed = 7;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    // 每一份都要自己的骨架 —— 共用的話所有 instance 會擺出同一個姿勢，
    // 而那正好把「逐 instance 的骨骼矩陣」這筆成本給省掉了，也就是量錯。
    const bones: THREE.Bone[] = [];
    let parent: THREE.Bone | null = null;
    for (let b = 0; b < boneCount; b++) {
      const bone = new THREE.Bone();
      bone.position.y = b === 0 ? -height / 2 : segment;
      if (parent === null) root.add(bone);
      else parent.add(bone);
      bones.push(bone);
      parent = bone;
    }

    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.add(bones[0]!);
    mesh.bind(new THREE.Skeleton(bones));
    mesh.position.set((rand() - 0.5) * spread, 0, (rand() - 0.5) * spread);
    root.add(mesh);
    skeletons.push(bones);
  }

  return {
    root,
    update(t: number): void {
      // 讓每一根骨頭都真的在動。姿勢不變的話 Three 仍然會上傳骨骼矩陣，
      // 但快取與分支的行為會跟真實情況不一樣。
      for (let i = 0; i < skeletons.length; i++) {
        const bones = skeletons[i]!;
        const phase = i * 0.37;
        for (let b = 1; b < bones.length; b++) {
          bones[b]!.rotation.z = Math.sin(t * 1.5 + phase + b * 0.4) * 0.18;
        }
      }
    },
    triangles: (geometry.getIndex()?.count ?? position.count) / 3,
    bones: boneCount,
  };
}
