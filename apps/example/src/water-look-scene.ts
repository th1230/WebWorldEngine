import * as THREE from 'three';
import * as WW from '@webworld/three';
import { readPixelsAsync } from './readback.ts';

/**
 * 水的外觀證明場景：一個從深到淺的斜坡水底，水面蓋在上面。
 *
 * ## 為什麼水底要是斜的
 *
 * 這一節每一個主張都跟「水有多深」有關：
 *
 * - 水色隨深度變（吸收）
 * - 岸邊的泡沫（水深趨近 0）
 * - 折射的強弱
 *
 * 平底的水池裡這些全部是常數，量出來每個點都一樣 —— 那不是效果沒用，是場景
 * 裡沒有那個變化。斜坡讓「深」與「淺」同時在同一張畫面上。
 *
 * ## 為什麼水底左右分成兩半
 *
 * 折射把畫面推開，而「推開了多少」在一片均勻的水底上完全看不出來。中間一條
 * 筆直的明暗交界之後，那條線在水裡會**歪**，歪多少就是折射多少。
 */

const HALF = 150;
/** 水底在 z = −HALF 最深，到 z = +HALF 露出水面。 */
const DEEP = -24;
const SHALLOW = 6;

export interface WaterLookScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** 烘反射探針。 */
  settle: (renderer: THREE.WebGLRenderer) => Promise<number>;
  /** 畫一次。`debug` 見 `WaterSurface` 的除錯模式。 */
  render: (renderer: THREE.WebGLRenderer, debug?: number, withWater?: boolean) => void;
  /** 螢幕比例位置的顏色。 */
  sampleAt: (renderer: THREE.WebGLRenderer, u: number, v: number) => [number, number, number];
  /** 掃一段列，回傳水底那條明暗交界落在第幾行（找不到回 −1）。 */
  edgeColumns: (renderer: THREE.WebGLRenderer, rows: number) => number[];
  /** 某個世界 x/z 的水面高度，CPU 算的。 */
  heightAt: (x: number, z: number) => number;
  /** 某一點周圍一小塊的平均顏色，非同步 —— 兩個後端都走得通。 */
  /**
   * 某一塊的平均顏色，非同步 —— 兩個後端都走得通。
   *
   * 寬高分開給：水面上「跨後端該不該一致」的量要**橫向**平均掉浪的震盪，
   * 又要保住上下的深淺分層，所以要的是又寬又扁的一條。
   */
  sampleWindowAsync: (
    renderer: unknown,
    u: number,
    v: number,
    width: number,
    height?: number,
  ) => Promise<number[]>;
  /** 等 WebGPU 那條路建好。 */
  nodeReady: (renderer: unknown) => Promise<void>;
  /** 折射的強度。給 0 就是「同一片水，只是不折射」的對照組。 */
  setRefraction: (value: number) => void;
  /** 這一刻的時間 —— CPU 與 GPU 要用同一個。 */
  time: number;
  /** 水面在畫面上佔的比例，確定它真的畫出來了。 */
  coverage: (renderer: THREE.WebGLRenderer) => number;
}

export function makeWaterLookScene(): WaterLookScene {
  const root = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(root);

  const time = 3.5;
  const water = new WW.Water({ level: 0 });

  // ── 水底：斜坡，左右兩半不同亮度 ──────────────────────────────
  //
  // 用兩片各自的幾何而不是一片加貼圖：貼圖要處理取樣與 mipmap，而那會讓
  // 「交界在哪」變成一個帶著過渡的問題。兩片實心的顏色，交界是精確的。
  const slope = (z: number): number => DEEP + ((z + HALF) / (HALF * 2)) * (SHALLOW - DEEP);
  const bottomHalf = (x0: number, x1: number, color: number): THREE.Mesh => {
    const geometry = new THREE.PlaneGeometry(x1 - x0, HALF * 2, 1, 64);
    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      // PlaneGeometry 躺平之前是 xy 平面，y 之後會變成 −z。
      const z = -position.getY(i);
      position.setZ(i, slope(z));
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.x = (x0 + x1) / 2;
    mesh.updateMatrixWorld(true);
    root.add(mesh);
    return mesh;
  };
  bottomHalf(-HALF, 0, 0x0e0e0e);
  bottomHalf(0, HALF, 0xdadada);

  // ── 水面 ────────────────────────────────────────────────────
  const probes = (() => {
    const volume = new WW.IrradianceVolume({
      // 底部貼著水面下一點 —— 水面會上下起伏，探針體積要蓋得住。
      min: new THREE.Vector3(-HALF, -6, -HALF),
      size: new THREE.Vector3(HALF * 2, 80, HALF * 2),
      resolution: [3, 2, 3],
    });
    return { volume, probes: new WW.ReflectionProbes(volume, { tileSize: 16 }) };
  })();

  const surface = new WW.WaterSurface({
    water,
    // ## 回退色與天空**不能是同一個顏色**
    //
    // 天空罩是紫紅的，而這個 sky 是「打不到探針時退回去用的」。兩個給同一個
    // 顏色的話，「有沒有真的用到探針」就量不出來 —— 開跟關長得一模一樣。
    //
    // 給綠色：水面反射出紫紅代表走的是探針，反射出綠代表回退了。
    sky: new THREE.Color(0x00c000),
    sunDirection: new THREE.Vector3(0.3, 0.5, -0.8).normalize(),
    // ## 散射色刻意用**中性灰**，不是真實的藍綠
    //
    // 這個場景要問的是「紅比藍衰減得快嗎」。散射色偏藍的話，深處的紅/藍
    // 下降有一半是散射色造成的 —— 實測把三個通道的吸收係數改成同一個
    // （也就是完全不分波長），關卡照樣全綠。
    //
    // 水底是灰的、散射色也是灰的之後，紅/藍會下降就**只可能**來自吸收。
    // 真實的水當然不是這樣，而這裡要的是把變因減到一個。
    scatter: new THREE.Color(0x555555),
    foamDepth: 2.5,
  });
  surface.setTime(time);
  const waterMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2, HALF * 2, 256, 256),
    surface.material,
  );
  waterMesh.rotation.x = -Math.PI / 2;
  waterMesh.updateMatrixWorld(true);
  root.add(waterMesh);

  // 天空罩：探針要拍得到「天空」，而場景裡沒有天空就只有黑。
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(400, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xff00c0, side: THREE.BackSide }),
  );
  root.add(dome);

  // ── 相機 ────────────────────────────────────────────────────
  //
  // 貼著水面斜看過去：畫面上同時有掠射角（遠處，反射為主）與接近正對
  // （近處，折射為主）—— 菲涅耳的對比就在同一張畫面上。
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 900);
  camera.position.set(0, 14, 120);
  camera.lookAt(0, 0, -60);
  camera.updateMatrixWorld(true);

  const target = new THREE.WebGLRenderTarget(1280, 720, {
    colorSpace: THREE.NoColorSpace,
    type: THREE.FloatType,
  });
  const pixel = new Float32Array(4);

  const draw = (renderer: THREE.WebGLRenderer, debug = 0, withWater = true): void => {
    // ## 每幀都換一次材質
    //
    // WebGPU 那份是非同步建起來的，所以「建好了」與「換上去了」是兩件事。
    // 只在建好的那一刻換一次的話，時序上很容易錯過 —— 而錯過的症狀是
    // 「WebGPU 上水面完全沒畫出來」，看起來像移植失敗。換材質很便宜。
    surface.setDebug(debug);
    // `materialFor` 在 WebGPU 上還沒建好時回 null —— 那時整個不要畫水，
    // 因為把 ShaderMaterial 交給 WebGPURenderer 會讓整個場景畫不出來。
    const material = surface.materialFor(renderer) as THREE.ShaderMaterial | null;
    if (material !== null) waterMesh.material = material;
    waterMesh.visible = withWater && material !== null;
    surface.setTime(time);
    surface.capture(renderer, scene, camera, waterMesh);
    renderer.setRenderTarget(target);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    waterMesh.visible = true;
  };

  return {
    root,
    camera,
    time,
    settle: async (renderer) => {
      // 探針拍的時候水面要在（它反射得到水），但水面自己還沒有探針可用 ——
      // 第一輪拍到的水面是天空色，那就夠了：這裡要的是天空與水底，不是
      // 水面反射水面。
      waterMesh.visible = false;
      let baked = 0;
      for (let round = 0; round < 200; round++) {
        const done = await WW.bakeIrradiance(renderer, scene, probes.volume, {
          budgetMs: 1000,
          faceSize: 16,
          reflection: probes.probes,
        });
        if (done === 0) break;
        baked += done;
      }
      waterMesh.visible = true;
      surface.setProbes(probes.probes);
      return baked;
    },
    sampleWindowAsync: async (renderer, u, v, width, height = width) => {
      const x = Math.min(
        target.width - width,
        Math.max(0, Math.round(u * target.width) - (width >> 1)),
      );
      const y = Math.min(
        target.height - height,
        Math.max(0, Math.round(v * target.height) - (height >> 1)),
      );
      const data = await readPixelsAsync(
        renderer,
        target,
        x,
        y,
        width,
        height,
        (n) => new Float32Array(n),
      );
      const sum = [0, 0, 0];
      for (let i = 0; i < width * height; i++) {
        for (let c = 0; c < 3; c++) sum[c]! += data[i * 4 + c] ?? 0;
      }
      return sum.map((value) => value / (width * height));
    },
    nodeReady: async (renderer) => {
      // node 材質是動態 import 進來的 —— 要等**真的時間**，microtask 不夠。
      for (let i = 0; i < 60; i++) {
        draw(renderer as THREE.WebGLRenderer);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
    setRefraction: (value) => {
      surface.setParams({ refraction: value });
    },
    render: draw,
    sampleAt: (renderer, u, v) => {
      const x = Math.min(target.width - 1, Math.max(0, Math.round(u * target.width)));
      const y = Math.min(target.height - 1, Math.max(0, Math.round(v * target.height)));
      renderer.readRenderTargetPixels(target, x, y, 1, 1, pixel);
      return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
    },
    edgeColumns: (renderer, rows) => {
      const width = target.width;
      const buffer = new Float32Array(width * 4);
      const columns: number[] = [];
      // ## 掃哪一段
      //
      // 太下面是泡沫帶（白的，會把邊界偵測整個帶走），太上面水底已經被吸收
      // 到看不見。0.19 起算的 48 列對應水深約 4 到 7 —— 水底還很清楚，而且
      // 已經離開泡沫。
      const startRow = Math.floor(target.height * 0.19);
      for (let i = 0; i < rows; i++) {
        renderer.readRenderTargetPixels(target, 0, startRow + i, width, 1, buffer);
        // ## 找**梯度最大**的位置，不是第一個超過門檻的位置
        //
        // 水底那條交界在深處被吸收壓得很暗：實測跳幅只有 0.18，而固定門檻
        // 訂 0.15 就是邊緣情況 —— 開折射抓到 18 列、關折射抓到 35 列，兩組
        // 量的根本不是同一批東西，比出來的數字沒有意義。
        //
        // 取最大梯度沒有絕對門檻，深處淺處一樣找得到。窗寬 4 是為了不被
        // 單一像素的雜訊帶走。
        const window = 4;
        let found = -1;
        let best = 0;
        for (let x = window; x < width - window; x++) {
          let left = 0;
          let right = 0;
          for (let k = 0; k < window; k++) {
            left += buffer[(x - 1 - k) * 4 + 1] ?? 0;
            right += buffer[(x + k) * 4 + 1] ?? 0;
          }
          const gradient = (right - left) / window;
          if (gradient > best) {
            best = gradient;
            found = x;
          }
        }
        // 看**綠**通道，不是紅。
        //
        // 天空罩是紫紅的（綠 = 0），而水底是灰的（三通道相等）。看紅通道的話
        // 水面反射的天空會隨著波浪在同一列裡劇烈起伏，而那個起伏跟水底那條
        // 邊一樣大 —— 實測偵測器整個被帶走，開關折射的殘差都是 200 像素。
        //
        // 綠通道裡天空幾乎不貢獻，剩下的就只有水底。
        // 太平的一列代表那裡根本看不到水底 —— 回 −1 讓呼叫端排除，而不是
        // 回一個雜訊的位置。
        columns.push(best > 0.02 ? found : -1);
      }
      return columns;
    },
    heightAt: (x, z) => water.heightAt(x, z, time),
    coverage: (renderer) => {
      const buffer = new Float32Array(target.width * target.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, buffer);
      let lit = 0;
      const total = target.width * target.height;
      for (let i = 0; i < buffer.length; i += 4) {
        if ((buffer[i] ?? 0) + (buffer[i + 1] ?? 0) + (buffer[i + 2] ?? 0) > 0.01) lit++;
      }
      return lit / total;
    },
  };
}
