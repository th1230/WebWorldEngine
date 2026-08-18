import { MeshoptSimplifier } from 'meshoptimizer/simplifier';

/**
 * 執行期產生 LOD 鏈。
 *
 * ## 為什麼這是必要的而不是方便
 *
 * 沒有這一段，「要 LOD 就得先 cook」就是一道門檻，而這個專案的核心約束是
 * **用了更好，不用也能動**。UE 讓你把檔案拖進去就能用，優化是它替你做，
 * 不是它跟你要。
 *
 * cook 過的路徑仍然更快（更小的下載量、零啟動成本），但那是加速，不是前提。
 *
 * ## 這裡不做的事
 *
 * - **不重算法線。** 簡化後沿用原本的頂點法線，那是 meshopt 的慣例，
 *   在中等簡化率下夠用。極端簡化的視覺誤差是真的存在的，而且**位置誤差
 *   的上限管不到它** —— 見 doctrine.md「契約要連它管不到的東西一起寫」。
 * - **不處理 morph target 與 skinning。** 有那些的幾何目前會被原樣退回
 *   單一階，並且說出來。
 */

export interface AttributeData {
  array: Float32Array;
  itemSize: number;
}

export interface GeometryData {
  attributes: Record<string, AttributeData>;
  /** null 代表非索引幾何，這裡會先熔接。 */
  indices: Uint32Array | null;
}

export interface GeneratedLevel extends GeometryData {
  indices: Uint32Array;
  /** 相對第 0 階的幾何誤差，**世界單位**。 */
  error: number;
}

export interface LodGenerationOptions {
  /** 每一階相對前一階保留的三角形比例。 */
  ratios?: readonly number[];
  /** 相對誤差上限；超過就停止產生更粗的階。 */
  maxRelativeError?: number;
}

/**
 * 預設的簡化比例。
 *
 * ## 為什麼誤差上限可以放到 0.2
 *
 * 直覺上「20% 幾何誤差」聽起來很粗糙，但 LOD **選擇**是依螢幕空間誤差的：
 * 只有當該階的誤差投影到螢幕上 ≤ `errorPixels`（預設 2 像素）時才會被選中。
 * 所以加入誤差更大的階**不會降低畫質** —— 它在近處根本不會被選到。
 *
 * 上限訂太低反而是白白留下效能。
 *
 * ## 為什麼還是有上限
 *
 * 不設上限的話簡化器會一路把網格塌陷到失去形狀。那些階仍然「合法」
 * （選擇器不會在近處用它們），但佔記憶體、佔產生時間，而極遠處真正該用的
 * 是 impostor 而不是 20 個三角形的爛網格。
 */
/**
 * 與 cooker 的 `DEFAULT_LOD_OPTIONS` 一致，刻意的。
 *
 * 第一版只有三階（`[0.5, 0.4, 0.4]`），最粗只到 408 個三角形；同一份資產
 * cook 出來有七階，最粗 32 個 —— **遠處的 instance 差 12.75 倍**。
 * 而多產生三階在 worker 裡只多花約 7 ms（實測三階 6.9 ms）。
 *
 * 兩邊的預設一樣，「cook 過的更快」這句話才是在比 build 時 vs runtime，
 * 而不是在比兩組不同的參數。
 */
export const DEFAULT_RATIOS = [0.5, 0.5, 0.4, 0.4, 0.4, 0.4] as const;
export const DEFAULT_MAX_RELATIVE_ERROR = 0.2;

/**
 * 由第 0 階產生後續各階。**回傳的不含第 0 階**，呼叫端已經有了。
 *
 * 誤差以世界單位回報。simplifier 給的是相對值，乘上 `getScale()` 才能
 * 拿去做螢幕投影 —— 相對值算不出像素。
 */
export async function generateLodLevels(
  source: GeometryData,
  options: LodGenerationOptions = {},
): Promise<GeneratedLevel[]> {
  const ratios = options.ratios ?? DEFAULT_RATIOS;
  const maxRelativeError = options.maxRelativeError ?? DEFAULT_MAX_RELATIVE_ERROR;

  const welded = source.indices === null ? weld(source) : source;
  const position = welded.attributes['position'];
  if (position === undefined) {
    throw new Error('LOD 產生需要 position attribute。');
  }

  await MeshoptSimplifier.ready;
  const scale = MeshoptSimplifier.getScale(position.array, position.itemSize);

  const levels: GeneratedLevel[] = [];
  const base = welded.indices!;
  let previousLength = base.length;
  let fraction = 1;

  for (const ratio of ratios) {
    fraction *= ratio;
    const target = Math.floor((base.length * fraction) / 3) * 3;
    // 剩不到一個三角形就沒有意義了
    if (target < 3) break;

    // **每一階都從第 0 階簡化，不是從上一階。**
    //
    // 兩個理由，第二個是被實際的 bug 逼出來的：
    //
    // 1. `simplify()` 回傳的誤差是「相對於傳進去的那個網格」。串接的話
    //    第 2 階拿到的是「相對第 1 階」的增量，而選階要的是**相對第 0 階**
    //    —— 品質契約講的是「跟原始幾何差幾個像素」。實測（cooker 那邊的
    //    icosphere(3)）串接會低估最多 23%，也就是在太近的距離挑到太粗的階。
    // 2. 串接需要把上一階的索引留著當下一次的輸入，但 `compact()` 是
    //    **原地改寫**索引的。第一版就踩到了：下一輪餵給簡化器的索引已經
    //    被改成壓縮後的編號，卻配上原始的頂點陣列 —— 等於餵了一個亂掉的
    //    網格進去。症狀是誤差序列不遞增（第 1 階 0.0257、第 2 階 0.0082），
    //    於是更粗的階看起來更精確。**沒有任何東西會報錯。**
    //
    // 從第 0 階開始就兩個問題都沒有，代價是簡化器多走幾趟完整網格 ——
    // 而這整段在 worker 裡。
    const [simplified, relativeError] = MeshoptSimplifier.simplify(
      base,
      position.array,
      position.itemSize,
      target,
      maxRelativeError,
    );

    // simplifier 達不到目標時會原樣回傳。再往下產生只是白佔記憶體，
    // 而且會產生一個「存在但與上一階完全相同」的階 —— 那比沒有更糟，
    // 因為統計上看起來 LOD 有在運作。
    if (simplified.length >= previousLength) break;

    // ## 塌成 0 個三角形的階要丟掉，而且要 break 不是 continue
    //
    // 誤差上限放鬆之後（接鏈尾巴那條路用 1.0），simplifier 會把網格一路
    // 塌到什麼都不剩。實測 icosphere 的鏈接到第 4 階時是 **0 個三角形**。
    //
    // 那一階完全合法地留在鏈裡，然後在夠遠的距離被選中 —— **整個物件消失**，
    // 沒有錯誤、沒有警告，只有「那邊本來有東西」。這正是這個專案最怕的
    // 那一類失效。
    //
    // 用 4 當下限而不是 1：少於 4 個三角形圍不出體積，從任何角度看都是
    // 一片或一條，那不是「很粗的模型」而是破圖。
    if (simplified.length < 4 * 3) break;

    previousLength = simplified.length;

    const level = { ...compact(welded, simplified), error: relativeError * scale };
    const last = levels.at(-1);

    // **丟掉被支配的階。**
    //
    // 簡化器對每個目標三角形數各做一次貪婪選擇，所以誤差不保證隨階數
    // 遞增：實測球體的第 5 階 0.3888（80 個三角形）比第 6 階 0.3709
    // （32 個）還大。那代表第 5 階**同時比第 6 階多三角形又比它不準** ——
    // 留著它只是佔記憶體。
    //
    // 選階本身不會因此出錯（它挑的是誤差夠小的最粗一階），所以這是浪費
    // 而不是 bug —— 但誤差不遞增會讓「更粗 = 更不準」這個所有下游都在
    // 假設的性質不成立，而那遲早會咬人。
    if (last !== undefined && level.error <= last.error) levels[levels.length - 1] = level;
    else levels.push(level);
  }

  return levels;
}

/**
 * 只留下被索引參照到的頂點，並重新編號。
 *
 * ## 為什麼不共用同一份頂點
 *
 * meshoptimizer 的設計是所有階共用頂點緩衝、只換索引 —— 切換 LOD 不必
 * 重傳頂點。但 `THREE.BatchedMesh` 的 `addGeometry` 是逐幾何複製的，
 * 沒有「共用頂點範圍」的公開介面。不壓縮就等於**每一階都存一份完整的
 * 頂點資料**，三階就是三倍。
 *
 * 壓縮之後大約是 1 + 0.55 + 0.3 ≈ 1.85 倍，而且那正是一份正常的 LOD 資產
 * 該有的樣子。
 */
function compact(
  source: GeometryData,
  indices: Uint32Array,
): { attributes: Record<string, AttributeData>; indices: Uint32Array } {
  const position = source.attributes['position']!;
  const vertexCount = position.array.length / position.itemSize;

  const remap = new Int32Array(vertexCount).fill(-1);
  const used = new Uint32Array(indices.length);
  let next = 0;
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i]!;
    let mapped = remap[vertex]!;
    if (mapped < 0) {
      mapped = next++;
      remap[vertex] = mapped;
      used[mapped] = vertex;
    }
    indices[i] = mapped;
  }

  const attributes: Record<string, AttributeData> = {};
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const { array, itemSize } = attribute;
    const packed = new Float32Array(next * itemSize);
    for (let v = 0; v < next; v++) {
      const src = used[v]! * itemSize;
      const dst = v * itemSize;
      for (let c = 0; c < itemSize; c++) packed[dst + c] = array[src + c]!;
    }
    attributes[name] = { array: packed, itemSize };
  }

  return { attributes, indices };
}

/**
 * 把非索引幾何熔接成索引幾何。
 *
 * ## 為什麼不能跳過
 *
 * 簡化的機制是**塌陷邊**，而邊要存在就必須有頂點被多個三角形共用。
 * 非索引幾何裡每個三角形都有自己的三個頂點 —— 一條邊都沒有，簡化器
 * 會原樣回傳。
 *
 * 那個失效**不會報錯**：你會拿到一條「產生成功」的 LOD 鏈，每一階都跟
 * 第 0 階一模一樣，統計上看起來 LOD 有在運作。這正是本專案最常見的
 * 失效形態，所以熔接是必要的而不是最佳化。
 *
 * 只熔接**所有分量都完全相同**的頂點 —— 法線或 UV 不同就是不同的頂點，
 * 合併它們會把硬邊磨掉、把貼圖接縫扯開。
 */
function weld(source: GeometryData): GeometryData {
  const names = Object.keys(source.attributes).sort();
  const position = source.attributes['position']!;
  const vertexCount = position.array.length / position.itemSize;

  const lookup = new Map<string, number>();
  const indices = new Uint32Array(vertexCount);
  const kept: number[] = [];
  const key: number[] = [];

  for (let v = 0; v < vertexCount; v++) {
    key.length = 0;
    for (const name of names) {
      const { array, itemSize } = source.attributes[name]!;
      const base = v * itemSize;
      for (let c = 0; c < itemSize; c++) key.push(array[base + c]!);
    }
    const hash = key.join(',');
    let mapped = lookup.get(hash);
    if (mapped === undefined) {
      mapped = kept.length;
      lookup.set(hash, mapped);
      kept.push(v);
    }
    indices[v] = mapped;
  }

  const attributes: Record<string, AttributeData> = {};
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const { array, itemSize } = attribute;
    const packed = new Float32Array(kept.length * itemSize);
    for (let v = 0; v < kept.length; v++) {
      const src = kept[v]! * itemSize;
      const dst = v * itemSize;
      for (let c = 0; c < itemSize; c++) packed[dst + c] = array[src + c]!;
    }
    attributes[name] = { array: packed, itemSize };
  }

  return { attributes, indices };
}

/** `postMessage` 要轉移的緩衝區清單。轉移比複製省一次記憶體搬移。 */
export function transferablesOf(levels: readonly GeneratedLevel[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const level of levels) {
    buffers.push(level.indices.buffer as ArrayBuffer);
    for (const attribute of Object.values(level.attributes)) {
      buffers.push(attribute.array.buffer as ArrayBuffer);
    }
  }
  return buffers;
}
