import * as THREE from 'three';
import * as WW from '@webworld/three';

/**
 * 間接光的證明場景：一面紅地板、一顆白箱子、一盞從上面來的光。
 *
 * ## 為什麼是這個佈置
 *
 * 要證明「間接光真的在起作用」，最容易造假的指標是**亮度** —— 隨便哪裡
 * 寫錯一個係數、或不小心多加了一盞環境光，畫面都會變亮，而「變亮了」會被
 * 讀成「間接光生效了」。
 *
 * 所以這裡量的不是亮度，是**顏色**：
 *
 * - 地板是紅的，箱子是白的，場景裡**沒有環境光、沒有 env map**。
 * - 箱子的背光面（朝下、朝暗側）拿不到任何直接光，所以沒有間接光時它是**全黑**。
 * - 有間接光時，它唯一能拿到的光是**從紅地板反彈上來的**，所以它會偏紅。
 *
 * 於是判準是「背光面的紅比藍多多少」。這個訊號只有反彈光做得出來 ——
 * 加一盞白色環境光會讓紅藍一起上去，比值不動；係數寫錯會讓它整個不亮。
 *
 * 這是 [doctrine](../../../specs/doctrine.md) 第 13 條的用法：換一把尺，
 * 讓「碰巧看起來對」變得更難。
 */

export interface GiScene {
  root: THREE.Group;
  volume: WW.IrradianceVolume;
  /** 烘一點點。回傳這一次烘了幾顆。 */
  bake(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Promise<number>;
  /** 把間接光整個關掉 —— A/B 用。node 材質那條路要重編，所以是非同步的。 */
  setEnabled(on: boolean): Promise<void>;
  stats: () => { probes: number; baked: number; materials: number };
  /** 用 CPU 那份公式在同一個位置求值 —— 拿來分辨「烘的不一樣」還是「著色的不一樣」。 */
  sampleCpu: (p: [number, number, number], n: [number, number, number]) => [number, number, number];
}

const ROOM = 40;

/**
 * 材質工廠。WebGL 那頁給 `MeshStandardMaterial`，WebGPU 那頁給
 * `MeshStandardNodeMaterial`。
 *
 * 兩條路共用**同一個場景建構函式**是刻意的：各自寫一份「差不多的場景」的話，
 * 量到的差異可能來自佈置不同而不是實作不同，而那種比較說明不了任何事。
 */
export type MaterialFactory = (color: number, roughness: number) => THREE.Material;

const defaultMaterial: MaterialFactory = (color, roughness) =>
  new THREE.MeshStandardMaterial({ color, roughness });

export function makeGiScene(
  makeMaterial: MaterialFactory = defaultMaterial,
  /**
   * 起始強度。**node 材質那條路只認這個值**（它是編譯期常數，見
   * `irradiance-node.ts`），所以 WebGPU 上的 A/B 是靠開兩次頁面做的。
   */
  intensity = 1,
): GiScene {
  const root = new THREE.Group();

  // ## 紅地板：反彈光的來源
  //
  // 顏色要飽和 —— 反彈光的強度大約是「入射光 × 反照率」，而我們要量的是
  // 紅藍**比值**，所以藍色分量越低訊號越乾淨。
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM * 2, ROOM * 2),
    makeMaterial(0xcc1010, 1),
  );
  floor.rotation.x = -Math.PI / 2;
  root.add(floor);

  // 兩面側牆讓反彈光有地方來 —— 只有地板的話探針上半球幾乎都是黑的。
  for (const [x, z, ry] of [
    [-ROOM, 0, Math.PI / 2],
    [0, -ROOM, 0],
  ] as const) {
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(ROOM * 2, ROOM),
      makeMaterial(0xcc1010, 1),
    );
    wall.position.set(x, ROOM / 2, z);
    wall.rotation.y = ry;
    root.add(wall);
  }

  // ## 白箱子：被反彈光照到的東西
  //
  // 白色是因為它不能自己帶顏色 —— 帶紅色的話「它偏紅」就證明不了任何事。
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    makeMaterial(0xffffff, 0.9),
  );
  box.position.set(0, 14, 0);
  root.add(box);

  // ## 光：只有一盞方向光，**沒有環境光**
  //
  // 有環境光的話箱子的背面本來就是亮的，那就量不到間接光了 —— 而那正是
  // 最容易不小心犯的錯：場景裡留了一盞 AmbientLight，然後把它的貢獻讀成
  // 間接光生效。
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(60, 80, 60);
  root.add(sun);

  const volume = new WW.IrradianceVolume({
    min: new THREE.Vector3(-ROOM, 0, -ROOM),
    size: new THREE.Vector3(ROOM * 2, ROOM, ROOM * 2),
    resolution: [8, 4, 8],
    intensity,
  });

  const materials = WW.applyIrradiance(volume, root);

  return {
    root,
    volume,
    bake: (renderer, scene) => WW.bakeIrradiance(renderer, scene, volume, { budgetMs: 12 }),
    setEnabled: async (on) => {
      // 強度歸零就等於沒有間接光，而且**走的是同一條 shader 路徑** ——
      // 換材質做 A/B 的話比的是兩個不同的著色器，那個比較沒有意義。
      volume.intensity = on ? 1 : 0;
      // WebGL 上這一行就夠了。node 材質（WebGPU）那條路改不動強度，所以
      // 那邊的 A/B 是開兩次頁面（見 tools/gi-check）。
    },
    stats: () => ({ probes: volume.probeCount, baked: volume.baked, materials }),
    sampleCpu: (p, n) => {
      const v = volume.sampleAt(new THREE.Vector3(...p), new THREE.Vector3(...n));
      return [v.x, v.y, v.z];
    },
  };
}
