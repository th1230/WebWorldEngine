import type { PerspectiveCamera } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';

/**
 * 固定的相機路徑。
 *
 * **以幀索引驅動，不以時間驅動。**
 *
 * 這是可比較性的關鍵。若相機路徑跟著 wall-clock 走，快的機器在 600 幀內繞完
 * 兩圈、慢的機器只繞了半圈 —— 兩者看到的畫面內容根本不同，量到的數字自然不能
 * 相比。用幀索引的話，每次執行的第 N 幀永遠是同一個視角。
 *
 * 代價是路徑的「速度感」會隨 FPS 改變，但 benchmark 不需要好看，需要可重現。
 */
export interface OrbitPathOptions {
  radius: number;
  height: number;
  /** 走完一整圈所需的幀數。 */
  framesPerRevolution: number;
  target?: Vector3;
  /** 上下擺動幅度，避免整段路徑都看到同一批物件。 */
  bobAmplitude?: number;
}

const scratchTarget = new Vector3();

export function applyOrbitPath(
  camera: PerspectiveCamera,
  frameIndex: number,
  options: OrbitPathOptions,
): void {
  const {
    radius,
    height,
    framesPerRevolution,
    target = scratchTarget.set(0, 0, 0),
    bobAmplitude = 0,
  } = options;

  const t = (frameIndex % framesPerRevolution) / framesPerRevolution;
  const angle = t * Math.PI * 2;

  camera.position.set(
    target.x + Math.cos(angle) * radius,
    target.y + height + Math.sin(angle * 2) * bobAmplitude,
    target.z + Math.sin(angle) * radius,
  );
  camera.lookAt(target);
  camera.updateMatrixWorld();
}

/** 直線穿越路徑，用於量測 streaming 與 overdraw 隨深度的變化。 */
export function applyFlyThroughPath(
  camera: PerspectiveCamera,
  frameIndex: number,
  totalFrames: number,
  from: Vector3,
  to: Vector3,
): void {
  const t = totalFrames <= 1 ? 0 : (frameIndex % totalFrames) / (totalFrames - 1);
  camera.position.lerpVectors(from, to, t);
  camera.lookAt(to.x, to.y, to.z - 1);
  camera.updateMatrixWorld();
}
