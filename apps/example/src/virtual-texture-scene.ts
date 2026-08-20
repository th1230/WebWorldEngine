import * as WW from '@webworld/three';
import {
  DataTexture,
  Mesh,
  MeshBasicMaterial,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  WebGLRenderTarget,
} from 'three';
import { readPixelsAsync } from './readback.ts';
import type { Group, Object3D } from 'three';
import { Group as ThreeGroup } from 'three';

/**
 * 虛擬貼圖的證明場景：一張**大到配置不下**的貼圖，鋪滿整個畫面。
 *
 * ## 每一頁的顏色就是它的身分證
 *
 * 每一頁填成純色，而顏色**由階數與頁座標算出來**。於是從畫面上讀一個像素
 * 就能反推「這裡取樣到的是第幾階的哪一頁」——不必相信任何內部數字。
 *
 * 這一點是刻意的：這個專案有過「shader 根本沒編譯成功，但省了 95.5% 印得
 * 好好的，畫面全黑」的紀錄。從畫面反推是唯一不會被自己騙的做法。
 */

/**
 * 一頁的顏色 —— 階數與座標算出來的，所以看到顏色就知道取樣到誰。
 *
 * ## 三個通道都不會低於 30
 *
 * 第一版是 `255 - level * 40`，而九階的最粗那階算出來剛好是 0 —— 也就是
 * **黑的，跟「什麼都沒畫出來」長得一模一樣**。那條斷言於是驗不出差別。
 *
 * 驗證用的顏色不可以撞上失敗時的顏色。
 */
export function pageColor(level: number, px: number, py: number): [number, number, number] {
  return [40 + level * 20, 30 + ((px * 37 + 20) % 200), 30 + ((py * 61 + 40) % 200)];
}

export interface VirtualTextureScene {
  root: Group;
  vt: WW.VirtualTexture;
  virtualSize: number;
  /** 這一階一邊幾頁。測試要靠它算螢幕位置。 */
  sideAt: (level: number) => number;
  /** 把整片地形畫進自己的 render target —— 兩個後端才量得到同一塊畫面。 */
  render: (renderer: unknown) => void;
  /** 某個 UV 附近一小塊的平均顏色，非同步。 */
  windowAsync: (renderer: unknown, u: number, v: number, size: number) => Promise<number[]>;
  /** 等 WebGPU 那條路建好。 */
  nodeReady: (renderer: unknown) => Promise<void>;
}

/**
 * 材質的建構子由呼叫端給。
 *
 * WebGPU 上取樣接的是 node 材質的 `colorNode`，而 `MeshBasicMaterial` 在
 * WebGPU 上**也不是** node 材質 —— 換掉是 `WebGPURenderer` 內部做的。
 *
 * 參數在這裡給，一模一樣 —— 兩邊各寫一份會分岔。
 */
export function makeVirtualTextureScene(
  pagesPerSide = 512,
  pageSize = 64,
  MaterialClass: new (params: { map: DataTexture }) => MeshBasicMaterial = MeshBasicMaterial,
): VirtualTextureScene {
  const border = 4;

  const vt = new WW.VirtualTexture({
    pageSize,
    pagesPerSide,
    atlasPages: 8,
    border,
    page(level, px, py, size) {
      const [r, g, b] = pageColor(level, px, py);
      const data = new Uint8Array(size * size * 4);
      const usable = size - 2 * border;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // ## 右上那一象限把 G 與 B 對調
          //
          // 純色的頁**驗不出頁裡面的 UV 對不對** —— 取樣到頁裡的哪一點都是
          // 同一個顏色。實測：把著色器裡的階數縮放寫死成 1.0（等於算錯頁內
          // 座標），八條斷言全過。
          //
          // 有了這個記號，取樣到頁內的錯位置就會拿到對調過的顏色。
          const u = (x - border) / usable;
          const v = (y - border) / usable;
          const swapped = u > 0.5 && v > 0.5;
          const i = (y * size + x) * 4;
          data[i] = r;
          data[i + 1] = swapped ? b : g;
          data[i + 2] = swapped ? g : b;
          data[i + 3] = 255;
        }
      }
      return data;
    },
  });

  // ## 佔位用的 1×1
  //
  // 取樣接在 `<map_fragment>` 上，而 Three 只有在有 map 的時候才宣告
  // `vMapUv`。內容會被虛擬貼圖整個蓋掉，要的只是那個 define。
  const placeholder = new DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    RGBAFormat,
    UnsignedByteType,
  );
  placeholder.needsUpdate = true;

  const material = new MaterialClass({ map: placeholder });
  vt.apply(material);

  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  const root: Group = new ThreeGroup();
  root.add(mesh as Object3D);

  // ## 自己的相機與 target
  //
  // 平面是 2×2、正交相機剛好框住它，所以畫面的 UV 就是貼圖的 UV —— 量到
  // 的顏色與「這一格該是什麼顏色」對得起來，不必再換算。
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const scene = new Scene();
  scene.add(root);
  const target = new WebGLRenderTarget(1024, 1024, { colorSpace: NoColorSpace });

  const draw = (r: unknown): void => {
    const gl = r as {
      getRenderTarget: () => unknown;
      setRenderTarget: (t: unknown) => void;
      render: (s: unknown, c: unknown) => void;
    };
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(target);
    gl.render(scene, camera);
    gl.setRenderTarget(previous);
  };

  return {
    root,
    vt,
    virtualSize: vt.virtualSize,
    sideAt: (level: number) => Math.max(1, pagesPerSide >> level),
    render: draw,
    windowAsync: async (r, u, v, size) => {
      const x = Math.min(
        target.width - size,
        Math.max(0, Math.round(u * target.width) - (size >> 1)),
      );
      const y = Math.min(
        target.height - size,
        Math.max(0, Math.round(v * target.height) - (size >> 1)),
      );
      const data = await readPixelsAsync(r, target, x, y, size, size, (n) => new Uint8Array(n));
      const sum = [0, 0, 0];
      for (let i = 0; i < size * size; i++) {
        for (let c = 0; c < 3; c++) sum[c]! += data[i * 4 + c] ?? 0;
      }
      return sum.map((value) => value / (size * size) / 255);
    },
    nodeReady: async (r) => {
      // node 材質是動態 import 進來的 —— 要等**真的時間**，microtask 不夠。
      await vt.nodeReady;
      for (let i = 0; i < 20; i++) {
        draw(r);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    },
  };
}
