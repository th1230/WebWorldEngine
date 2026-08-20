import * as THREE from 'three';
import * as WW from '@web-world-engine/three';
import { readPixelsAsync } from './readback.ts';

/**
 * 換階淡入：兩個階在一段距離內用抖動交叉，而不是硬跳。
 *
 * ## 場景
 *
 * 一片攤開的石頭，相機沿著 z 推遠。推到某個距離時會有一批 instance 正在
 * 過渡 —— 那一批同時被畫兩次（細階一次、粗階一次），靠 4×4 的有序抖動
 * 各留一半的像素。
 *
 * ## 覆蓋率量不到淡入，所以每一階塗不同的顏色
 *
 * 兩半的抖動條件是**互補的** —— 物件內部的每個像素剛好被畫到一次。所以
 * 「有幾個像素被畫到」這個量對淡入完全免疫：整個關掉，覆蓋率一模一樣。
 *
 * 每階一個顏色之後，過渡中的那一片是兩個顏色的一半一半，而淡入沒接上的話
 * 畫面上只有後畫的那一階的顏色。畫面的平均顏色因此直接量得到它。
 *
 * ## 判準
 *
 * | 主張 | 怎麼量 |
 * | --- | --- |
 * | 真的有東西在過渡 | `fadingInstances > 0` |
 * | 抖動真的在混兩階 | 過渡距離上畫面的平均顏色是兩階的混色 |
 * | 抖動互補、不破洞 | 覆蓋率隨距離單調下降，過渡處不塌陷 |
 * | 兩個後端算出同一片 | 覆蓋率與平均顏色逐項比對 |
 */
export interface LodFadeScene {
  root: THREE.Group;
  /** 把相機推到某個距離並畫一幀。回傳這一幀有幾個 instance 在過渡。 */
  render: (renderer: unknown, distance: number) => number;
  /** 一塊區域的平均亮度，非同步 —— 兩個後端都走得通。 */
  windowAsync: (
    renderer: unknown,
    u: number,
    v: number,
    width: number,
    height?: number,
  ) => Promise<number[]>;
  /**
   * 整張畫面的統計：被畫到的比例，以及畫到的地方的平均顏色。
   *
   * 顏色才是淡入的判準 —— 覆蓋率對它免疫，見場景裡的說明。
   */
  statsAsync: (renderer: unknown) => Promise<number[]>;
  /** 等 WebGPU 那條路建好。 */
  nodeReady: (renderer: unknown) => Promise<void>;
}

/** 過渡帶的寬度，兩個頁面共用 —— 不同的話兩邊在不同的距離過渡。 */
const FADE_BAND = 0.35;

/**
 * 材質的建構子由呼叫端給。
 *
 * WebGPU 上換階淡入接的是 node 材質的 `maskNode`，而 `MeshBasicMaterial`
 * 在 WebGPU 上**也不是** node 材質 —— 換掉是 `WebGPURenderer` 內部做的，呼叫端
 * 手上那個物件的 `isNodeMaterial` 一直是 false。
 *
 * 所以兩個頁面給不同的建構子，但**參數在這裡給**，一模一樣 —— 兩邊各寫
 * 一份參數的話會分岔，而分岔的症狀是「顏色不一樣」。
 */
export function makeLodFadeScene(
  MaterialClass: new (params: {
    color: number;
    vertexColors: boolean;
  }) => THREE.Material = THREE.MeshBasicMaterial,
): LodFadeScene {
  const root = new THREE.Group();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(root);

  // 三角形數量隨階數掉一個量級，誤差按投影面積給。
  const DETAILS = [12, 6, 3, 1];
  const ERRORS = [0, 0.02, 0.08, 0.3];

  // ## 每一階塗**不同的顏色**
  //
  // 覆蓋率量不到抖動：兩半的條件是互補的，所以物件內部的每個像素無論如何
  // 都剛好被畫到一次 —— 淡入整個關掉，覆蓋率也一模一樣。那是「判準借了別的
  // 東西的力」的標準形狀。
  //
  // 每階一個顏色之後，過渡中的那一片是**兩個顏色的一半一半**，而淡入沒接上
  // 的話畫面上只會有後畫的那一階的顏色。畫面的平均顏色因此直接量得到它。
  const LEVEL_COLOURS = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 1, 0],
  ];
  const source = {
    lods: DETAILS.map((detail, level) => {
      const geometry = new THREE.IcosahedronGeometry(1, detail);
      const count = geometry.getAttribute('position').count;
      const colours = new Float32Array(count * 3);
      const [r, g, b] = LEVEL_COLOURS[level] ?? [1, 1, 1];
      for (let i = 0; i < count; i++) {
        colours[i * 3] = r!;
        colours[i * 3 + 1] = g!;
        colours[i * 3 + 2] = b!;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      return geometry;
    }),
    errors: ERRORS,
  };
  // 不吃光 —— 這個場景要量的是覆蓋率與混色，不是明暗。
  const material = new MaterialClass({ color: 0xffffff, vertexColors: true });

  // 固定亂數：兩個後端要是同一片石頭。
  let seed = 20260220;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const COUNT = 900;
  // HLOD 關掉：它把一整格合成一個幾何，而合出來的那份沒有 color 屬性
  // （Three 的 BatchedMesh 會直接丟「All geometries must have consistent
  // attributes」）。這個場景要驗的是逐 instance 的換階，不是 HLOD。
  const mesh = new WW.InstancedMesh(source, material, COUNT, {
    lodFadeBand: FADE_BAND,
    hlod: false,
  });
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < COUNT; i++) {
    position.set((next() - 0.5) * 120, (next() - 0.5) * 8, (next() - 0.5) * 120);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  root.add(mesh);

  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 2000);

  const target = new THREE.WebGLRenderTarget(1280, 720, { colorSpace: THREE.NoColorSpace });

  const draw = (renderer: THREE.WebGLRenderer, distance: number): number => {
    camera.position.set(0, 30, distance);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previous);
    return mesh.fadingInstances;
  };

  const readWindow = async (
    renderer: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<number[]> => {
    const data = await readPixelsAsync(
      renderer,
      target,
      x,
      y,
      width,
      height,
      (n) => new Uint8Array(n),
    );
    const sum = [0, 0, 0];
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++) sum[c]! += data[i * 4 + c] ?? 0;
    }
    return sum.map((value) => value / (width * height) / 255);
  };

  return {
    root,
    render: (renderer, distance) => draw(renderer as THREE.WebGLRenderer, distance),
    windowAsync: async (renderer, u, v, width, height = width) => {
      const x = Math.min(
        target.width - width,
        Math.max(0, Math.round(u * target.width) - (width >> 1)),
      );
      const y = Math.min(
        target.height - height,
        Math.max(0, Math.round(v * target.height) - (height >> 1)),
      );
      return readWindow(renderer, x, y, width, height);
    },
    statsAsync: async (renderer) => {
      // ## 覆蓋率要**逐像素**數，不是取平均
      //
      // 平均會把「一半的像素全亮」與「全部的像素半亮」混成同一個數字，而
      // 抖動交叉正是前者 —— 不互補的破洞在平均上看不出來。
      const data = await readPixelsAsync(
        renderer,
        target,
        0,
        0,
        target.width,
        target.height,
        (n) => new Uint8Array(n),
      );
      let covered = 0;
      const sum = [0, 0, 0];
      const total = target.width * target.height;
      for (let i = 0; i < total; i++) {
        const r = data[i * 4] ?? 0;
        const g = data[i * 4 + 1] ?? 0;
        const b = data[i * 4 + 2] ?? 0;
        if (r + g + b > 30) {
          covered++;
          sum[0]! += r;
          sum[1]! += g;
          sum[2]! += b;
        }
      }
      // 顏色是**畫到的地方**的平均，不是整張的 —— 整張的話背景會把它稀釋掉，
      // 而稀釋的倍率隨距離變，混色的訊號就被距離蓋過去。
      const painted = Math.max(covered, 1);
      return [
        covered / total,
        sum[0]! / painted / 255,
        sum[1]! / painted / 255,
        sum[2]! / painted / 255,
      ];
    },
    nodeReady: async (renderer) => {
      // node 材質是動態 import 進來的 —— 要等**真的時間**，microtask 不夠。
      // 而它要先被畫過一次才會開始建（材質是在第一次繪製時才接上的）。
      for (let i = 0; i < 40; i++) {
        draw(renderer as THREE.WebGLRenderer, 200);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      await mesh.lodFadeNodeReady;
    },
  };
}
