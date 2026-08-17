/**
 * 最小的 4×4 矩陣與四元數運算，column-major（與 WebGPU / Three.js 一致）。
 *
 * ## 為什麼不用 Three.js 的 Matrix4
 *
 * 最初的規劃是「Vector、Matrix、Quaternion 一律用 Three.js」，但那與
 * [ADR 0001](../../../specs/adr/0001-three-as-adapter.md) 直接衝突：引擎核心
 * 每幀都要計算 transform，若為此依賴 three，`@ww/engine` 就得 import three，
 * 邊界隨即瓦解 —— 而且是從最熱、最難再抽離的那條路徑瓦解。
 *
 * 需要的運算其實很少，自己寫比破壞架構便宜。渲染端仍然使用 Three.js 的數學。
 *
 * 所有函式都**寫入呼叫端提供的緩衝區**、不配置記憶體，因為它們位於每幀對
 * 數十萬個 物件 執行的路徑上。
 */

/** 單位矩陣寫入 `out` 的 `offset` 位置。 */
export function mat4Identity(out: Float32Array, offset = 0): void {
  out[offset] = 1;
  out[offset + 1] = 0;
  out[offset + 2] = 0;
  out[offset + 3] = 0;
  out[offset + 4] = 0;
  out[offset + 5] = 1;
  out[offset + 6] = 0;
  out[offset + 7] = 0;
  out[offset + 8] = 0;
  out[offset + 9] = 0;
  out[offset + 10] = 1;
  out[offset + 11] = 0;
  out[offset + 12] = 0;
  out[offset + 13] = 0;
  out[offset + 14] = 0;
  out[offset + 15] = 1;
}

/**
 * 由位移、旋轉（四元數）、縮放組成矩陣，寫入 `out[offset..offset+16)`。
 *
 * 這是抽取階段最熱的一段程式：每個可見 instance 每幀執行一次。
 */
export function mat4Compose(
  out: Float32Array,
  offset: number,
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  out[offset] = (1 - (yy + zz)) * sx;
  out[offset + 1] = (xy + wz) * sx;
  out[offset + 2] = (xz - wy) * sx;
  out[offset + 3] = 0;

  out[offset + 4] = (xy - wz) * sy;
  out[offset + 5] = (1 - (xx + zz)) * sy;
  out[offset + 6] = (yz + wx) * sy;
  out[offset + 7] = 0;

  out[offset + 8] = (xz + wy) * sz;
  out[offset + 9] = (yz - wx) * sz;
  out[offset + 10] = (1 - (xx + yy)) * sz;
  out[offset + 11] = 0;

  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

/**
 * `out = a × b`，皆為 column-major。
 * `out` 可以與 `a` 或 `b` 相同（內部先讀進區域變數）。
 */
export function mat4Multiply(
  out: Float32Array,
  outOffset: number,
  a: Float32Array,
  aOffset: number,
  b: Float32Array,
  bOffset: number,
): void {
  const a00 = a[aOffset]!;
  const a01 = a[aOffset + 1]!;
  const a02 = a[aOffset + 2]!;
  const a03 = a[aOffset + 3]!;
  const a10 = a[aOffset + 4]!;
  const a11 = a[aOffset + 5]!;
  const a12 = a[aOffset + 6]!;
  const a13 = a[aOffset + 7]!;
  const a20 = a[aOffset + 8]!;
  const a21 = a[aOffset + 9]!;
  const a22 = a[aOffset + 10]!;
  const a23 = a[aOffset + 11]!;
  const a30 = a[aOffset + 12]!;
  const a31 = a[aOffset + 13]!;
  const a32 = a[aOffset + 14]!;
  const a33 = a[aOffset + 15]!;

  for (let column = 0; column < 4; column++) {
    const base = bOffset + column * 4;
    const b0 = b[base]!;
    const b1 = b[base + 1]!;
    const b2 = b[base + 2]!;
    const b3 = b[base + 3]!;
    const target = outOffset + column * 4;
    out[target] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[target + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[target + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[target + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
}

/** 四元數相乘 `out = a × b`，順序與旋轉的複合一致。 */
export function quatMultiply(
  out: Float32Array,
  outOffset: number,
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
): void {
  out[outOffset] = aw * bx + ax * bw + ay * bz - az * by;
  out[outOffset + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[outOffset + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[outOffset + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/**
 * 球面線性內插。
 *
 * Simulation 與 rendering 解耦之後，畫面上的旋轉必須在兩個 tick 之間內插，
 * 否則 60Hz 的 simulation 在 165Hz 的螢幕上會看起來一格一格的。
 */
export function quatSlerp(
  out: Float32Array,
  outOffset: number,
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
  t: number,
): void {
  let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;

  // 取較短的那條弧。少了這一步，旋轉會偶爾繞遠路轉一大圈。
  let sx = bx;
  let sy = by;
  let sz = bz;
  let sw = bw;
  if (cosHalfTheta < 0) {
    cosHalfTheta = -cosHalfTheta;
    sx = -bx;
    sy = -by;
    sz = -bz;
    sw = -bw;
  }

  // 幾乎共線時退回線性內插：sin(halfTheta) 趨近 0 會讓除法失去精度
  if (cosHalfTheta > 0.9995) {
    const inv = 1 - t;
    let x = ax * inv + sx * t;
    let y = ay * inv + sy * t;
    let z = az * inv + sz * t;
    let w = aw * inv + sw * t;
    // 明確的 sqrt 而非 Math.hypot：hypot 要處理溢位與下溢，成本高出數倍，
    // 而四元數的分量都在 [-1,1]，那些保護在這裡毫無用處。
    const length = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    x /= length;
    y /= length;
    z /= length;
    w /= length;
    out[outOffset] = x;
    out[outOffset + 1] = y;
    out[outOffset + 2] = z;
    out[outOffset + 3] = w;
    return;
  }

  const halfTheta = Math.acos(cosHalfTheta);
  const sinHalfTheta = Math.sin(halfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

  out[outOffset] = ax * ratioA + sx * ratioB;
  out[outOffset + 1] = ay * ratioA + sy * ratioB;
  out[outOffset + 2] = az * ratioA + sz * ratioB;
  out[outOffset + 3] = aw * ratioA + sw * ratioB;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
