import { Matrix4, Quaternion, Vector3 } from 'three';
import type { InstancedMesh } from './instanced-mesh.ts';
import type { PlaceFn } from './streaming.ts';

/**
 * 宣告式擺放：說「哪裡可以長什麼」，而不是逐一寫出每個東西在哪。
 *
 * ## 為什麼這是「自由構建」缺的那一塊
 *
 * 串流的 `load(cx, cz, place)` 要求你自己描述每一格有什麼。第一次寫很直覺，
 * 第二個專案就會發現每次都在重寫同一種迴圈：亂數位置、避開太陡的地方、
 * 沿著某條線、密度隨高度變。
 *
 * UE 那邊對應的是 Foliage 刷子與 PCG。這裡不做編輯器（那是另一個量級），
 * 做的是**規則**：規則寫得出來，就不必逐一擺。
 *
 * ## 為什麼必須是決定性的
 *
 * 串流會把走遠的格子卸載，走回來時重新問一次。兩次答案不一樣的話，**世界
 * 會在你背後改變** —— 而那不會報錯，只會讓人覺得「剛剛那棵樹好像不在這」。
 *
 * 所以這裡的亂數是**位置的函式**，不是一個序列：同樣的 (cx, cz, i) 永遠得到
 * 同樣的值，與呼叫順序、與有沒有先載過別格都無關。
 *
 * 用 `Math.random()` 的話這件事一定會壞，而且是在最難重現的情況下壞。
 */

export interface ScatterRule {
  /** 撒哪一個 mesh。 */
  mesh: InstancedMesh;
  /**
   * 每平方單位幾個。
   *
   * 用密度而不是「每格幾個」：格子大小是串流的參數，而內容的疏密不該
   * 因為調了格子大小就變。
   */
  density: number;
  /**
   * 這個位置可不可以長，以及長多大。回傳 `null` 代表不長。
   *
   * 拿得到高度與坡度，所以「太陡的地方不長樹」「水面下不長草」這類規則
   * 直接寫得出來。
   */
  place?: (context: ScatterContext) => ScatterPlacement | null;
  /** 縮放範圍。省略就是 1。 */
  scale?: [number, number];
  /** 要不要繞 Y 軸隨機轉。預設 true —— 不轉的話一片樹會整齊得很假。 */
  rotate?: boolean;
}

export interface ScatterContext {
  x: number;
  z: number;
  /** 這一個的決定性亂數，0–1。同樣的位置永遠一樣。 */
  random: number;
}

export interface ScatterPlacement {
  /** 地面高度。 */
  y: number;
  /** 蓋過規則的縮放。 */
  scale?: number;
}

/**
 * 造一個可以直接餵給 `WorldStream.load` 的擺放函式。
 *
 * ```js
 * const scatter = WW.scatter([
 *   { mesh: trees, density: 0.002, place: ({ x, z }) => {
 *       const y = height(x, z);
 *       return slope(x, z) > 0.6 ? null : { y };   // 太陡就不長
 *     } },
 *   { mesh: grass, density: 0.05, scale: [0.6, 1.4] },
 * ]);
 *
 * WW.worldFor(scene).stream({ cellSize: 200, radius: 800, load: scatter });
 * ```
 */
export function scatter(
  rules: readonly ScatterRule[],
  options: { seed?: number } = {},
): (cellX: number, cellZ: number, place: PlaceFn, cellSize: number) => void {
  const seed = options.seed ?? 1;
  const matrix = new Matrix4();
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scaleVec = new Vector3();

  return (cellX, cellZ, place, cellSize) => {
    const area = cellSize * cellSize;
    const originX = cellX * cellSize;
    const originZ = cellZ * cellSize;

    for (const [r, rule] of rules.entries()) {
      // 數量也要是決定性的：用亂數決定「四捨五入往上還是往下」，這樣
      // 非整數的密度不會每次算出不同的數量。
      const exact = rule.density * area;
      const jitter = hash(cellX, cellZ, seed + r * 7919, 0);
      const count = Math.floor(exact) + (jitter < exact - Math.floor(exact) ? 1 : 0);

      for (let i = 0; i < count; i++) {
        const rx = hash(cellX, cellZ, seed + r * 7919, i * 3 + 1);
        const rz = hash(cellX, cellZ, seed + r * 7919, i * 3 + 2);
        const rr = hash(cellX, cellZ, seed + r * 7919, i * 3 + 3);
        const x = originX + rx * cellSize;
        const z = originZ + rz * cellSize;

        // ## `?.` 加 `??` 在這裡是錯的
        //
        // `rule.place?.(…) ?? { y: 0 }` 會把**兩件不同的事**混成一件：
        // 「沒有給 place 函式」（undefined）與「place 說這裡不要長」（null）
        // ——`??` 兩個都接，於是 `return null` 完全沒有作用。
        //
        // 症狀是「太陡的地方不長樹」這種規則被靜靜忽略，樹照長。測試當場抓到。
        let placed: ScatterPlacement | null = { y: 0 };
        if (rule.place !== undefined) placed = rule.place({ x, z, random: rr });
        if (placed === null) continue;

        const [lo, hi] = rule.scale ?? [1, 1];
        const s = placed.scale ?? lo + (hi - lo) * rr;
        position.set(x, placed.y, z);
        quaternion.setFromAxisAngle(UP, (rule.rotate ?? true) ? rr * Math.PI * 2 : 0);
        scaleVec.setScalar(s);
        place(rule.mesh, matrix.compose(position, quaternion, scaleVec));
      }
    }
  };
}

const UP = new Vector3(0, 1, 0);

/**
 * 位置的雜湊，0–1。**不是序列** —— 同樣的輸入永遠同樣的輸出。
 *
 * 這是整個決定性的地基：串流走回頭時會重新問同一格，而答案必須一模一樣。
 * 用一個帶狀態的亂數產生器的話，答案會取決於「之前載過哪幾格」，於是
 * 世界在你背後改變。
 */
function hash(cx: number, cz: number, seed: number, index: number): number {
  let h = Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cz | 0, 0x165667b1);
  h = Math.imul(h ^ (seed | 0), 0x85ebca6b);
  h = Math.imul(h ^ (index | 0), 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  // 轉成 [0, 1)。`>>> 0` 讓它變成無號數 —— 少了它會有一半的值是負的。
  return (h >>> 0) / 4294967296;
}
