import { BufferAttribute, BufferGeometry } from 'three';
import { splitGeometry as splitArrays, type SplitOptions } from '@webworld/format';
import { generateLodLevels, type LodGenerationOptions } from './lod-generation.ts';
import type { GeometrySource } from './lod-chain.ts';

/**
 * 把一份很大的幾何切成 `MultiMesh` 吃得下的形狀。
 *
 * ## 它補的洞
 *
 * `MultiMesh` 量過了：420 萬個三角形的地形，整片一份幾何 11.6 ms，切成
 * 32×32 之後 5.25 ms —— **省 54.7%**，而繪製次數釘在 3。
 *
 * 但它要求呼叫端自己把 N 份相異的幾何準備好。地形是自己生的、本來就一塊
 * 一塊；而「我有一棟掃描回來的建築 / 一份很大的 GLB」的人只有一份幾何，
 * 就用不上那 54.7%。
 *
 * ```js
 * const pieces = await WW.splitWithLods(bigGeometry, { chunks: 256 });
 * scene.add(new WW.MultiMesh(pieces, material));
 * ```
 *
 * 這是 [ADR-0001](../../../specs/adr/0001-three-as-adapter.md) 說「Three 沒有、
 * 要我們自己建」的**幾何虛擬化**的第一塊。
 *
 * ## 為什麼切完一定要鎖邊界
 *
 * 相鄰兩塊共用一條邊。各自簡化的話兩邊會把那條邊化成不同的樣子，中間裂開
 * 一條縫 —— 而且只在兩塊剛好選到不同階的時候才露出來，所以它很容易在開發時
 * 完全沒出現。
 *
 * `splitWithLods` 一定會開 `lockBorder`。這不是選項 —— 切出來的東西沒有
 * 別的正確用法。
 */

export interface SplitGeometryOptions extends SplitOptions {
  /** 產生 LOD 鏈時的參數。見 `generateLodLevels`。 */
  lod?: Omit<LodGenerationOptions, 'lockBorder'>;
}

/**
 * 切成一堆 `BufferGeometry`，**不**產生 LOD。
 *
 * 每一塊都會帶著原本的全部屬性（法線、UV、切線、顏色…）—— 用的是同一份
 * 頂點對應，所以不會有「位置對了但 UV 沒跟上」那種錯。
 *
 * 只切不產生 LOD 也是有價值的：`MultiMesh` 對單階的塊照樣做逐塊剔除。
 */
export function splitGeometry(
  geometry: BufferGeometry,
  options: SplitOptions = {},
): BufferGeometry[] {
  const position = geometry.getAttribute('position');
  if (position === undefined) {
    throw new Error('WW.splitGeometry: 這份幾何沒有 position 屬性。');
  }
  const index = geometry.getIndex();

  const pieces = splitArrays(
    position.array as ArrayLike<number>,
    index === null ? null : (index.array as ArrayLike<number>),
    options,
  );

  return pieces.map((piece) => {
    const out = new BufferGeometry();
    out.setIndex(new BufferAttribute(piece.indices, 1));

    // ## 每一個屬性都用同一份對應搬過去
    //
    // 只搬 position 的話，法線與 UV 會停在原本的編號上 —— 而那不會報錯，
    // 只會讓貼圖與打光錯開。逐屬性照 itemSize 搬就不會有那個問題。
    for (const name of Object.keys(geometry.attributes)) {
      const source = geometry.getAttribute(name);
      const itemSize = source.itemSize;
      const Ctor = (source.array as { constructor: unknown }).constructor as {
        new (length: number): ArrayLike<number> & { [index: number]: number };
      };
      const array = new Ctor(piece.sourceVertices.length * itemSize);
      for (let i = 0; i < piece.sourceVertices.length; i++) {
        const from = piece.sourceVertices[i]! * itemSize;
        for (let c = 0; c < itemSize; c++) array[i * itemSize + c] = source.array[from + c]!;
      }
      out.setAttribute(
        name,
        new BufferAttribute(
          array as never,
          itemSize,
          (source as { normalized?: boolean }).normalized,
        ),
      );
    }

    return out;
  });
}

/**
 * 切塊，並且**鎖著邊界**幫每一塊產生 LOD 鏈。
 *
 * 回傳的東西可以直接丟給 `MultiMesh`。
 *
 * 鎖邊界不是選項：切出來的塊彼此相鄰，不鎖就會裂。代價是粗階粗不下去
 * （少了很多可以塌陷的邊），而那是為了不破圖必須付的。
 */
export async function splitWithLods(
  geometry: BufferGeometry,
  options: SplitGeometryOptions = {},
): Promise<GeometrySource[]> {
  const pieces = splitGeometry(geometry, options);

  return Promise.all(
    pieces.map(async (piece): Promise<GeometrySource> => {
      const index = piece.getIndex();
      // ## 全部的屬性都要交進去，不能只給 position
      //
      // 簡化完會**壓縮頂點**（把用不到的丟掉、重新編號），而壓縮是逐屬性
      // 一起做的。只給 position 的話，回來的那一階頂點數變少了，其餘屬性
      // 卻還是原本的長度 —— 兩邊對不上。
      //
      // 症狀是 `BatchedMesh.addGeometry` 丟 "offset is out of bounds"，
      // 而那個訊息完全指不到真正的原因。
      const attributes: Record<string, { array: Float32Array; itemSize: number }> = {};
      for (const name of Object.keys(piece.attributes)) {
        const attribute = piece.getAttribute(name);
        attributes[name] = { array: attribute.array as Float32Array, itemSize: attribute.itemSize };
      }

      const levels = await generateLodLevels(
        { attributes, indices: index === null ? null : (index.array as Uint32Array) } as never,
        { ...options.lod, lockBorder: true },
      );

      if (levels.length === 0) return piece;

      const lods = [piece, ...levels.map((level) => toGeometry(level))];
      return { lods, errors: [0, ...levels.map((level) => level.error)] };
    }),
  );
}

/**
 * 把產生出來的一階換回 `BufferGeometry`。
 *
 * **只用這一階自己的屬性**，不從第 0 階補 —— 壓縮過的頂點數與第 0 階不同，
 * 混著用會做出一份屬性長度對不上的幾何。
 */
function toGeometry(level: {
  attributes: Record<string, { array: ArrayLike<number>; itemSize: number }>;
  indices: ArrayLike<number> | null;
}): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of Object.keys(level.attributes)) {
    const attribute = level.attributes[name]!;
    out.setAttribute(name, new BufferAttribute(attribute.array as never, attribute.itemSize));
  }
  if (level.indices !== null) {
    out.setIndex(new BufferAttribute(level.indices as never, 1));
  }
  return out;
}
