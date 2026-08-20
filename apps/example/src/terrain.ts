import * as WW from '@webworld/three';
import * as THREE from 'three';

/**
 * 「大地表」與「一個極細物件」兩條軸的量尺。
 *
 * ## 為什麼這兩條軸其實是同一個問題
 *
 * 一個從外面看的密物件，整顆離相機的距離差不多，所以「整顆挑一階」已經接近
 * 最佳解 —— 叢集 LOD 在那種內容上賺不到什麼。
 *
 * 真正需要逐區域選階的是**跨越很大深度範圍**的東西：腳下的地表清清楚楚、
 * 地平線那端只有幾個像素，而它們是同一個物件。地表是這個形狀的標準案例，
 * 掃描的建物、城市也是。
 *
 * 所以這裡只造一種內容，同時回答兩條軸。
 *
 * ## 為什麼程序化的高度場是誠實的
 *
 * 準則警告過「先造內容再量」——造出來的東西會決定量到什麼。但地表**本來就是
 * 程序化生成的**，這不是拿一個方便的形狀去代表真實資產，這就是那個資產。
 *
 * 它不能回答的是「有貼圖、有植被的真實地表多貴」。這裡只問一件事：
 * **整塊一階 vs 逐塊選階，差多少。**
 *
 * ## 為什麼分塊這件事今天做不到
 *
 * `WW.InstancedMesh(geometry, material, count)` 的前提是**所有 instance 共用
 * 同一份幾何**。而地表每一塊的高度都不一樣 —— 那是 N 份**相異**的幾何，
 * 不是同一份的 N 個副本。
 *
 * 底層的 `BatchedMesh` 其實裝得下相異幾何（LOD 鏈就是這樣塞的），所以擋住的
 * 是 API 的形狀，不是機制。這支量的就是那個缺口值多少。
 */

export interface Terrain {
  root: THREE.Group;
  triangles: number;
  /** 分成幾塊。1 代表整塊一份幾何。 */
  tiles: number;
}

/** 兩個八度的值雜訊。決定性的 —— 兩種擺法必須拿到一模一樣的地形。 */
function height(x: number, z: number): number {
  const h = (px: number, pz: number): number => {
    const n = Math.sin(px * 12.9898 + pz * 78.233) * 43758.5453;
    return n - Math.floor(n);
  };
  const smooth = (px: number, pz: number): number => {
    const x0 = Math.floor(px);
    const z0 = Math.floor(pz);
    const fx = px - x0;
    const fz = pz - z0;
    const ex = fx * fx * (3 - 2 * fx);
    const ez = fz * fz * (3 - 2 * fz);
    const a = h(x0, z0);
    const b = h(x0 + 1, z0);
    const c = h(x0, z0 + 1);
    const d = h(x0 + 1, z0 + 1);
    return (a + (b - a) * ex) * (1 - ez) + (c + (d - c) * ex) * ez;
  };
  return smooth(x * 0.04, z * 0.04) * 26 + smooth(x * 0.16, z * 0.16) * 5;
}

/**
 * 一塊 `size` 見方的地表，切成 `tiles`×`tiles` 塊，每塊 `segments`×`segments` 格。
 *
 * `tiles = 1` 就是「整塊一份幾何」—— 也就是今天直接把地表丟進 Three 的樣子。
 */
/**
 * 用套件的 `WW.buildTerrain` 蓋一片地表。
 *
 * 與下面那個手工版的差別是**逐塊還有自己的 LOD 鏈**，而且接縫有裙邊擋著。
 * 手工那份是這條軸的量尺（整片一階 vs 逐塊選階），這份是真正要交出去的東西。
 */
export function makeTerrainSystem(size: number, tiles: number, segments: number): Terrain {
  const built = WW.buildTerrain({ size, tiles, segments, height });
  const material = new THREE.MeshStandardMaterial({ color: 0x6f7a63, roughness: 0.95 });
  const mesh = new WW.MultiMesh(built.chains, material);
  const m = new THREE.Matrix4();
  built.centers.forEach(([x, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, 0, z)));

  const root = new THREE.Group();
  root.add(mesh);
  return { root, triangles: built.triangles, tiles: tiles * tiles };
}

export function makeTerrain(
  size: number,
  tiles: number,
  segments: number,
  enhanced: boolean,
  /** 用 `WW.MultiMesh` 把所有塊裝進**同一個批次**，而不是一塊一個物件。 */
  multi = false,
): Terrain {
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x6f7a63, roughness: 0.95 });
  const tileSize = size / tiles;
  let triangles = 0;
  const pieces: THREE.BufferGeometry[] = [];
  const offsets: [number, number][] = [];

  for (let tz = 0; tz < tiles; tz++) {
    for (let tx = 0; tx < tiles; tx++) {
      const originX = -size / 2 + tx * tileSize;
      const originZ = -size / 2 + tz * tileSize;
      const geometry = new THREE.PlaneGeometry(tileSize, tileSize, segments, segments);
      geometry.rotateX(-Math.PI / 2);
      const position = geometry.getAttribute('position');
      // 高度用**世界座標**算，所以切幾塊都拿到同一片地形 —— 兩種擺法比的
      // 才是同一個東西。
      for (let i = 0; i < position.count; i++) {
        const wx = position.getX(i) + originX + tileSize / 2;
        const wz = position.getZ(i) + originZ + tileSize / 2;
        position.setY(i, height(wx, wz));
      }
      geometry.computeVertexNormals();
      triangles += (geometry.getIndex()?.count ?? 0) / 3;

      // 每一塊都是一份**相異**的幾何，所以只能一塊一個物件 —— 這正是
      // `InstancedMesh(geometry, material, count)` 的形狀接不住的地方。
      if (multi) {
        // 全部收起來，最後一次交給 MultiMesh —— 那才是「一個批次」。
        pieces.push(geometry);
        offsets.push([originX + tileSize / 2, originZ + tileSize / 2]);
        continue;
      }

      const mesh = enhanced
        ? new WW.InstancedMesh(geometry, material, 1)
        : new THREE.Mesh(geometry, material);
      if (enhanced) {
        (mesh as WW.InstancedMesh).setMatrixAt(
          0,
          new THREE.Matrix4().makeTranslation(originX + tileSize / 2, 0, originZ + tileSize / 2),
        );
      } else {
        mesh.position.set(originX + tileSize / 2, 0, originZ + tileSize / 2);
      }
      root.add(mesh);
    }
  }

  if (multi) {
    const mesh = new WW.MultiMesh(pieces, material);
    const m = new THREE.Matrix4();
    for (const [i, [x, z]] of offsets.entries())
      mesh.setPieceMatrixAt(i, m.makeTranslation(x, 0, z));
    root.add(mesh);
  }

  return { root, triangles, tiles: tiles * tiles };
}
