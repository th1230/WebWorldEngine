/**
 * 視錐平面：`nx·x + ny·y + nz·z + d ≥ 0` 為內側。
 *
 * 刻意在這裡自己定義而不是從 `@ww/engine` 匯入 —— 那是**內部套件，不會
 * 發布到 npm**。型別若引用它，發布出去的 `.d.ts` 會指向一個使用者裝不到
 * 的東西。一個兩行的介面不值得為它破壞這條界線。
 */
export interface Frustum {
  /** 6 個平面 × 4 個分量（nx, ny, nz, d）。 */
  readonly planes: Float32Array;
}

export function createFrustum(): Frustum {
  return { planes: new Float32Array(6 * 4) };
}


import { Frustum as ThreeFrustum, Matrix4, type Camera, type Matrix4 as Mat4, type Vector3 } from 'three';

const clip = new Matrix4();
const source = new ThreeFrustum();

/**
 * 由 Three.js 相機取得**相對於相機**的視錐平面。
 *
 * ## 為什麼不自己從 fov 導平面
 *
 * 引擎內部的 `updateFrustum()` 是那樣做的，而且更快。但它綁死了三個慣例：
 * 相機朝 +Z、透視投影、WebGL 的 z ∈ [−1, 1]。Three.js 的相機朝 **−Z**，
 * 而且 WebGPU 的裁切空間是 z ∈ [0, 1]、還有 `reversedDepth`。
 *
 * 猜錯任何一個的症狀都是**近平面剔錯**：離相機最近的東西消失，而所有
 * 時間指標完全正常。所以這裡讓 Three.js 自己萃取（它知道自己的慣例），
 * 我們只做座標系的平移。每幀 6 個平面，成本可以忽略。
 *
 * ## 為什麼在物件的區域空間裡做
 *
 * instance 矩陣是**相對於這個 `Object3D`** 的。把它們一一轉到世界空間
 * 等於每幀多做一次 4×4 乘法 × instance 數，而且完全沒必要 —— 把視錐
 * 轉進來就好，那是每幀一次。Three.js 自己的 `BatchedMesh` 也是這樣做的。
 *
 * 附帶好處：物件本身的縮放在螢幕誤差的計算裡會自動約掉（誤差與距離
 * 同時被縮放），所以區域空間算出來的像素數就是世界空間的像素數。
 * **非等比縮放不成立** —— 那時距離與尺寸的縮放係數不同。
 *
 * ## 為什麼要平移成相對座標
 *
 * 大世界的世界座標是 f64，而剔除用 f32。距離原點幾公里之後，f32 的
 * 尾數不足以區分相鄰的 cell 邊界，邊界上的東西會隨機閃爍。
 *
 * 平面 `n·p + c ≥ 0` 代入 `p = 觀察點 + rel` 得 `n·rel + (c + n·觀察點) ≥ 0`，
 * 所以只要改 `d`，法線不變。這是恆等變換，不是近似。
 *
 * @param objectMatrixWorld 物件的世界矩陣。平面會被轉進它的區域空間。
 * @param viewPoint 相機在**該區域空間**裡的位置。
 */
export function frustumFromCamera(
  out: Frustum,
  camera: Camera,
  objectMatrixWorld: Mat4,
  viewPoint: Vector3,
): void {
  clip
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .multiply(objectMatrixWorld);
  source.setFromProjectionMatrix(clip, camera.coordinateSystem, camera.reversedDepth);

  const planes = out.planes;
  for (let i = 0; i < 6; i++) {
    const plane = source.planes[i]!;
    const n = plane.normal;
    planes[i * 4] = n.x;
    planes[i * 4 + 1] = n.y;
    planes[i * 4 + 2] = n.z;
    planes[i * 4 + 3] = plane.constant + n.dot(viewPoint);
  }
}


