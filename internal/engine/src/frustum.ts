
/**
 * 視錐剔除。
 *
 * ## 這是整個引擎最大的單一效能槓桿
 *
 * 在開放世界裡，任何一刻鏡頭能看到的內容都只是世界的一小部分。沒有剔除
 * 的話，畫面朝北時，南邊整片世界仍然會被完整送進 GPU —— 頂點著色、
 * 三角形設定、光柵化前的裁切全部照做，只是最後被丟掉。
 *
 * 一個 40,000 instance、1,340 萬三角形的場景在沒有剔除時 GPU 要 46 ms，
 * 其中絕大多數根本不在畫面上。
 *
 * ## 為什麼在相機空間做
 *
 * 世界座標是 f64（大世界需要），但剔除若也用 f64 會很慢。這裡的做法是
 * **先減去相機位置再降成 f32** —— 與 render extraction 的 camera-relative
 * 是同一個手法。相機附近的相對座標在 f32 下精度綽綽有餘，而遠處的物件
 * 就算誤差幾公分也不影響「它在不在畫面裡」的判斷。
 *
 * 因此六個平面裡有四個（上下左右）**通過相機原點**，`d` 為 0。
 *
 * ## 為什麼用包圍球而不是包圍盒
 *
 * 球對旋轉免疫：物件轉動時半徑不變，不必每幀重算。盒子更貼合（剔除更多），
 * 但要嘛跟著旋轉（每幀重算八個角），要嘛用軸對齊的保守版（比球還鬆）。
 *
 * 球會保守一點 —— 有些其實看不見的東西會被判定為看得見。**這個方向是對的**：
 * 錯判成看不見會讓物件在畫面上憑空消失，那是不可接受的；錯判成看得見
 * 只是少省一點。
 */

/** 平面：`nx·x + ny·y + nz·z + d ≥ 0` 為內側。法線朝視錐內部。 */
export interface Frustum {
  /** 6 個平面 × 4 個分量（nx, ny, nz, d），依序為 左右下上近遠。 */
  readonly planes: Float32Array;
}

export function createFrustum(): Frustum {
  return { planes: new Float32Array(6 * 4) };
}

/**
 * 包圍球是否與視錐相交。`x/y/z` 是**相對於相機**的球心座標。
 *
 * 任何一個平面判定球體完全在外側就可以立刻回傳 —— 這個早退對大世界
 * 特別有效，因為絕大多數物件都是被第一或第二個平面剔掉的。
 */
export function sphereInFrustum(
  frustum: Frustum,
  x: number,
  y: number,
  z: number,
  radius: number,
): boolean {
  const p = frustum.planes;
  for (let i = 0; i < 6; i++) {
    const base = i * 4;
    if (p[base]! * x + p[base + 1]! * y + p[base + 2]! * z + p[base + 3]! < -radius) {
      return false;
    }
  }
  return true;
}

/**
 * 軸對齊盒是否與視錐相交。座標同樣是**相對於相機**。
 *
 * 給 world cell 用。cell 是盒子，若改用外接球會鬆掉一整個半對角線 ——
 * 64 單位見方的 cell 就是 45 單位的誤差，邊界上一整排 cell 會白白通過。
 *
 * 用的是標準的 **p-vertex** 手法：對每個平面，只需要檢查盒子八個角裡
 * **最靠近平面正向的那一個**。若連它都在平面外側，整個盒子必然在外側。
 * 那個角可以直接由法線的正負號選出來，不必列舉八個角。
 */
export function aabbInFrustum(
  frustum: Frustum,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  const p = frustum.planes;
  for (let i = 0; i < 6; i++) {
    const base = i * 4;
    const nx = p[base]!;
    const ny = p[base + 1]!;
    const nz = p[base + 2]!;
    // 法線為正就取 max、為負就取 min —— 這就是 p-vertex
    const px = nx >= 0 ? maxX : minX;
    const py = ny >= 0 ? maxY : minY;
    const pz = nz >= 0 ? maxZ : minZ;
    if (nx * px + ny * py + nz * pz + p[base + 3]! < 0) return false;
  }
  return true;
}

/**
 * AABB 與視錐的關係：`0` 完全在外、`1` 相交、`2` **完全在內**。
 *
 * ## 為什麼需要「完全在內」這個答案
 *
 * 一個 cell 整個落在視錐裡的話，裡面每一個物件都必然可見 —— 那時逐一去測
 * 那六個平面（每個 instance 24 次乘加）是**純粹的白工**。
 *
 * 收集迴圈本來就有這條捷徑（`skipPlanes`），但只有串流的區塊表回報得出
 * 「整段在內側」。格子這條路（也就是靜態內容，最常見的那種）從來沒回報過，
 * 於是實測**跳過率是 0.0%** —— 那條捷徑寫在那裡，一次都沒生效過。
 *
 * ## 成本
 *
 * 與 `aabbInFrustum` 完全一樣的迴圈，只是多比一次 n-vertex。它是**逐 cell**
 * 的，而省下來的是**逐 instance** 的 —— 一個 cell 裡有幾十到幾百個物件。
 */
export function aabbFrustumRelation(
  frustum: Frustum,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): 0 | 1 | 2 {
  const p = frustum.planes;
  let fully = true;
  for (let i = 0; i < 6; i++) {
    const base = i * 4;
    const nx = p[base]!;
    const ny = p[base + 1]!;
    const nz = p[base + 2]!;
    const d = p[base + 3]!;
    // p-vertex：法線方向上最遠的角。它在外面就代表整個盒子都在外面。
    const px = nx >= 0 ? maxX : minX;
    const py = ny >= 0 ? maxY : minY;
    const pz = nz >= 0 ? maxZ : minZ;
    if (nx * px + ny * py + nz * pz + d < 0) return 0;
    // n-vertex：法線方向上最近的角。它還在裡面才叫「整個盒子都在裡面」。
    if (fully) {
      const qx = nx >= 0 ? minX : maxX;
      const qy = ny >= 0 ? minY : maxY;
      const qz = nz >= 0 ? minZ : maxZ;
      if (nx * qx + ny * qy + nz * qz + d < 0) fully = false;
    }
  }
  return fully ? 2 : 1;
}
