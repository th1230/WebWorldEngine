/**
 * 把使用者給的 `BufferGeometry` 整理成 LOD 那條路吃得下的樣子。
 *
 * 四個純函式，一個狀態都沒有 —— 它們與 `InstancedMesh` 之間唯一的關係是
 * 「建構的時候會叫一次」。放在本體裡只是讓那個檔案更長。
 */
import { BufferAttribute, BufferGeometry as ThreeBufferGeometry } from 'three';
import type { BufferGeometry } from 'three';
import type { GeneratedLevel, GeometryData } from './lod-generation.ts';

/**
 * 有骨骼權重就大聲說出來 —— **這個類別不會蒙皮**。
 *
 * ## 為什麼這是 warn 不是 info
 *
 * 它底層是 `BatchedMesh`，而 `BatchedMesh` 沒有蒙皮這回事：`skinIndex` 與
 * `skinWeight` 會被當成兩個沒人讀的 attribute 帶著走。於是畫面上是
 * **綁定姿勢的靜止模型**，動畫完全不發生。
 *
 * 沒有錯誤、沒有例外、幀時間還特別好看 —— 使用者看到的是「我的角色不會動」，
 * 而最不可能被懷疑的就是那一行 `THREE.SkinnedMesh` → `WW.InstancedMesh`。
 *
 * 原本唯一會講話的是 LOD 那條路（「不能自動產生 LOD（有骨骼權重）」），
 * 而那句話講的是**別的事**，會讓人以為只是少了 LOD。
 *
 * ## 為什麼不是丟例外
 *
 * 「用了更好，不用也能動」的另一面是**不要在使用者的既有程式裡丟例外**。
 * 他可能正在遷移、正在試、或那個網格根本不會播動畫。所以照畫，但把話講死。
 *
 * 這條軸的量測結果與 VAT 的計畫寫在 specs/roadmap.md。
 */
export function warnSkinned(geometries: readonly BufferGeometry[]): void {
  const skinned = geometries.some(
    (geometry) =>
      geometry.getAttribute('skinIndex') !== undefined ||
      geometry.getAttribute('skinWeight') !== undefined,
  );
  if (!skinned) return;
  console.warn(
    [
      'WW.InstancedMesh: 這份幾何有骨骼權重，而這個類別**不會蒙皮** ——',
      '它底層是 THREE.BatchedMesh，而 BatchedMesh 沒有蒙皮。畫面上會是',
      '綁定姿勢的靜止模型，動畫不會發生，而且不會有任何錯誤。',
      '會動的東西目前請繼續用 THREE.SkinnedMesh。',
    ].join('\n'),
  );
}

/**
 * 抽出 worker 需要的資料，並且**複製**每一個緩衝區。
 *
 * 複製是必要的：`postMessage` 的轉移會把來源緩衝區抽走，而那是**使用者的**
 * `BufferGeometry` —— 被抽走之後畫面直接空掉。複製一份幾百 KB 的幾何遠比
 * 簡化本身便宜。
 *
 * @returns 不能處理時回傳原因字串。
 */
export function toGeometryData(geometry: BufferGeometry): GeometryData | string {
  if (geometry.morphAttributes !== undefined && Object.keys(geometry.morphAttributes).length > 0) {
    return '有 morph target';
  }

  const attributes: Record<string, { array: Float32Array; itemSize: number }> = {};
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if ((attribute as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
      return `attribute "${name}" 是交錯的`;
    }
    if (name === 'skinIndex' || name === 'skinWeight') return '有骨骼權重';
    const array = attribute.array;
    if (!(array instanceof Float32Array)) {
      // 正規化整數 attribute 直接轉成 float 會改變語意，而那個錯誤是
      // 顏色或法線靜靜地變掉 —— 寧可不做。
      return `attribute "${name}" 不是 Float32Array`;
    }
    attributes[name] = { array: new Float32Array(array), itemSize: attribute.itemSize };
  }

  if (attributes['position'] === undefined) return '沒有 position attribute';

  const index = geometry.getIndex();
  return {
    attributes,
    indices: index === null ? null : Uint32Array.from(index.array),
  };
}

export function toBufferGeometry(level: GeneratedLevel): BufferGeometry {
  const geometry = new ThreeBufferGeometry();
  for (const [name, attribute] of Object.entries(level.attributes)) {
    geometry.setAttribute(name, new BufferAttribute(attribute.array, attribute.itemSize));
  }
  geometry.setIndex(new BufferAttribute(level.indices, 1));
  return geometry;
}

/**
 * `BatchedMesh` 要求同一批的幾何全部有索引或全部沒有。
 *
 * 混用的話 `addGeometry` 會丟例外，而使用者拿到的是一句看不懂的
 * 「Batched geometry attributes do not match」—— 所以這裡直接補齊。
 * 補索引只在建構時做一次，成本不進每幀路徑。
 *
 * @param forceIndex 自動 LOD 會產生**有索引**的階（簡化的前提就是索引），
 *   所以待補鏈的批次一定要是索引的，即使第 0 階原本不是。
 */
export function unifyIndexing(geometries: BufferGeometry[], forceIndex = false): BufferGeometry[] {
  const anyIndexed = forceIndex || geometries.some((g) => g.getIndex() !== null);
  if (!anyIndexed) return geometries;

  return geometries.map((geometry) => {
    if (geometry.getIndex() !== null) return geometry;
    const vertices = geometry.getAttribute('position')!.count;
    const array =
      vertices > 65535 ? new Uint32Array(vertices) : (new Uint16Array(vertices) as Uint16Array);
    for (let i = 0; i < vertices; i++) array[i] = i;
    const clone = geometry.clone();
    clone.setIndex(new BufferAttribute(array, 1));
    return clone;
  });
}
