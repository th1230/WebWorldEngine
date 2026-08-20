import { loadTsl, loadWebGPU } from './fullscreen-node.ts';

/**
 * 法線 pass 在 WebGPU 上用的材質。
 *
 * ## 為什麼不能直接用 `MeshNormalMaterial`
 *
 * 它在兩個後端**寫進去的東西不一樣**，而那是 Three 自己的不一致：
 *
 * | | 寫進 render target 的值 |
 * | --- | --- |
 * | `MeshNormalMaterial`（WebGL） | `normal * 0.5 + 0.5`，直接寫 |
 * | `MeshNormalNodeMaterial`（WebGPU） | 同一個值，但**再經過一次 sRGB → 線性** |
 *
 * 那一行在 Three 的原始碼裡是：
 *
 * ```js
 * diffuseColor.assign( colorSpaceToWorking( vec4( packNormalToRGB( normalView ), … ), SRGBColorSpace ) );
 * ```
 *
 * 後果不是「法線有點暗」——**方向整個歪掉**。實測同一點：WebGL 解出
 * (0.004, 0.953, 0.302)（朝上的地面，合理），WebGPU 解出 (−0.984, −0.718, 0.114)，
 * 連單位向量都不是。
 *
 * 而它會**靜靜地**污染每一個吃這個 gbuffer 的效果：接觸陰影、距離場陰影、
 * 反射、體積霧、水。實測的症狀是「接觸陰影在 WebGPU 上完全沒有遮蔽」，
 * 而中間值一路查下去（深度對、投影往返對、參數對、迴圈跑滿）才追到這裡。
 *
 * ## 所以這裡自己寫
 *
 * 就是 `normal * 0.5 + 0.5`，不轉換 —— 與 WebGL 那份逐字相同。編碼寫在自己
 * 手上，兩邊就不可能因為上游的慣例差異而分岔。
 */
export async function createNormalNodeMaterial(): Promise<unknown> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const { vec4, normalView } = tsl;

  const material = new webgpu.NodeMaterial();
  // 與 `MeshNormalMaterial` 的 `packNormalToRGB` 逐字相同，少掉那次色彩空間轉換。
  material.fragmentNode = vec4(normalView.mul(0.5).add(0.5), 1);
  return material;
}
