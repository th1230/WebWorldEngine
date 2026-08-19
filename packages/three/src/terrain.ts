import { BufferAttribute, BufferGeometry } from 'three';
import type { LodChain } from './lod-chain.ts';

/**
 * 高度場地表：切塊、逐塊選階、接縫不裂。
 *
 * ## 為什麼地表不能用 `InstancedMesh`
 *
 * 那個類別的前提是**所有 instance 共用同一份幾何**，而地表每一塊的高度都
 * 不一樣 —— 那是 N 份**相異**的幾何。`MultiMesh` 就是為此存在的，而這裡
 * 負責產出餵給它的東西。
 *
 * ## 為什麼要逐塊選階
 *
 * 地表是「跨越很大深度範圍」的標準案例：腳下那塊清清楚楚，地平線那端只有
 * 幾個像素，而它們是同一片地。整片一階的話，不是近處太糊就是遠處太貴。
 *
 * 實測（420 萬三角形）：整片一份幾何 11.606 ms，切塊之後 5.253 ms。
 *
 * ## 為什麼降階是「隔一個取一個」而不是丟給簡化器
 *
 * 通用簡化器對規則網格是浪費的，而且它回報的誤差是估計值。高度場降階只要
 * **隔一個取一個**：格數減半、結構保持規則，而且誤差算得出**精確值** ——
 * 拿每一個細階頂點跟粗階曲面在同一個 (x, z) 上的高度比，取最大差。
 *
 * 那個數字不是估計，是真值。品質契約整個建立在誤差上，所以能算精確就不該估。
 *
 * ## 接縫：為什麼是裙邊而不是縫合
 *
 * 相鄰兩塊挑到不同階時，邊界上的頂點對不起來，於是出現一條**看得到背景的
 * 裂縫**。兩種解法：
 *
 * | | 怎麼做 | 為什麼這裡不行／可以 |
 * | --- | --- | --- |
 * | 縫合 | 把邊界的解析度改成配合鄰居 | 選階是**每幀**依螢幕誤差決定的，縫合要在那時重建幾何 —— 做不到 |
 * | 裙邊 | 邊緣往下垂一圈，用它擋住裂縫 | 不需要知道鄰居挑了哪階，建構時就固定 |
 *
 * 所以是裙邊。而**垂多深是算出來的**：裂縫的高度差最多是兩塊各自的誤差相加，
 * 而每一階的誤差上面已經算出精確值了，所以取「最粗那階的誤差 × 2」就一定夠。
 *
 * 猜一個「看起來夠深」的數字在別的地形上就是錯的 —— 那正是準則裡「作者在
 * 自己的內容上調好」的那種常數。
 */

export interface TerrainOptions {
  /** 整片地表多大，世界單位。 */
  size: number;
  /** 切成幾塊乘幾塊。 */
  tiles: number;
  /**
   * 每一塊在第 0 階有幾格。**必須是 2 的冪**，不然隔一個取一個會除不盡，
   * 而除不盡的症狀是最後一排格子被默默丟掉 —— 地表邊緣缺一條。
   */
  segments: number;
  /** 這個 (x, z) 的高度。世界座標。 */
  height: (x: number, z: number) => number;
  /**
   * 每一塊產生幾階。預設一路降到剩 2 格。
   *
   * 降到 1 格沒有意義：那時整塊只剩兩個三角形，而它與真實地形的誤差已經
   * 大到只有在螢幕上小於幾個像素時才選得到 —— 那時整塊本來就該被合併掉。
   */
  levels?: number;
}

export interface TerrainTiles {
  /** 每一塊一條 LOD 鏈，直接餵給 `WW.MultiMesh`。 */
  chains: LodChain[];
  /** 每一塊的中心，世界座標。用來設 `setMatrixAt`。 */
  centers: Array<[number, number]>;
  /** 第 0 階全部加起來有幾個三角形。 */
  triangles: number;
  /** 裙邊往下垂多深。算出來的，見檔案開頭。 */
  skirtDepth: number;
}

/**
 * 把一個高度函式變成一組可以直接畫的地表塊。
 *
 * ```js
 * const terrain = WW.buildTerrain({ size: 2400, tiles: 16, segments: 64, height });
 * const mesh = new WW.MultiMesh(terrain.chains, material);
 * terrain.centers.forEach(([x, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, 0, z)));
 * scene.add(mesh);
 * ```
 */
export function buildTerrain(options: TerrainOptions): TerrainTiles {
  const { size, tiles, segments, height } = options;
  if (!Number.isInteger(Math.log2(segments))) {
    throw new Error(
      `WW.buildTerrain: segments 必須是 2 的冪，收到 ${segments}。\n` +
        '不是的話降階時除不盡，最後一排格子會被默默丟掉 —— 地表邊緣缺一條。',
    );
  }
  if (tiles < 1 || segments < 2) {
    throw new Error(`WW.buildTerrain: tiles 至少 1、segments 至少 2，收到 ${tiles} / ${segments}。`);
  }

  const maxLevels = Math.log2(segments); // 降到剩 2 格為止
  const levels = Math.max(1, Math.min(options.levels ?? maxLevels, maxLevels));
  const tileSize = size / tiles;

  // ## 兩趟：先把每一塊的誤差全部算出來，才知道裙邊要多深
  //
  // 第一版只拿中間那塊當樣本推裙邊深度。**那是錯的** —— 地形起伏不均勻，
  // 別的塊誤差可能更大，而那些塊的裙邊就蓋不住自己的裂縫。
  //
  // 症狀只在「那一塊剛好與鄰居挑到不同階」時出現，也就是**偶爾某處有一條
  // 縫**。測試當場抓到（量到的深度 46.8，需要的是 53.1）。
  //
  // 誤差本來就要逐塊算，所以這一趟不是額外成本，只是把順序排對。
  const centers: Array<[number, number]> = [];
  const errorsPerTile: number[][] = [];
  for (let tz = 0; tz < tiles; tz++) {
    for (let tx = 0; tx < tiles; tx++) {
      const cx = -size / 2 + (tx + 0.5) * tileSize;
      const cz = -size / 2 + (tz + 0.5) * tileSize;
      centers.push([cx, cz]);
      errorsPerTile.push(tileErrors(cx, cz, tileSize, segments, levels, height));
    }
  }

  // 裂縫的高度差最多是兩塊各自的誤差相加，所以「全場最大的那個誤差 × 2」
  // 對任何一對鄰居都夠。
  const worst = Math.max(...errorsPerTile.map((e) => e[e.length - 1]!));
  const skirtDepth = worst * 2;

  const chains: LodChain[] = [];
  let triangles = 0;
  for (const [tile, [cx, cz]] of centers.entries()) {
    const lods: BufferGeometry[] = [];
    for (let level = 0; level < levels; level++) {
      const step = 1 << level;
      const geometry = tileGeometry(cx, cz, tileSize, segments / step, height, skirtDepth);
      lods.push(geometry);
      if (level === 0) triangles += (geometry.getIndex()?.count ?? 0) / 3;
    }
    chains.push({ lods, errors: errorsPerTile[tile]! });
  }

  return { chains, centers, triangles, skirtDepth };
}

/**
 * 每一階相對第 0 階的**精確**誤差：細階的每個頂點，與粗階曲面在同一個
 * (x, z) 上的高度差，取最大。
 *
 * 粗階曲面用雙線性內插求值 —— 那正是光柵化在三角形內部做的事，所以這個
 * 差就是螢幕上真的會看到的偏離。
 */
function tileErrors(
  cx: number,
  cz: number,
  tileSize: number,
  segments: number,
  levels: number,
  height: (x: number, z: number) => number,
): number[] {
  const errors = [0];
  const half = tileSize / 2;
  const fine = segments;

  for (let level = 1; level < levels; level++) {
    const step = 1 << level;
    const coarse = segments / step;
    const cell = tileSize / coarse;
    let worst = 0;

    for (let iz = 0; iz <= fine; iz++) {
      for (let ix = 0; ix <= fine; ix++) {
        const x = cx - half + (ix / fine) * tileSize;
        const z = cz - half + (iz / fine) * tileSize;
        // 這個點落在粗階的哪一格裡，以及格內的位置。
        const gx = (x - (cx - half)) / cell;
        const gz = (z - (cz - half)) / cell;
        const x0 = Math.min(Math.floor(gx), coarse - 1);
        const z0 = Math.min(Math.floor(gz), coarse - 1);
        const fx = gx - x0;
        const fz = gz - z0;

        const hx = (i: number, j: number): number =>
          height(cx - half + i * cell, cz - half + j * cell);
        const interpolated =
          hx(x0, z0) * (1 - fx) * (1 - fz) +
          hx(x0 + 1, z0) * fx * (1 - fz) +
          hx(x0, z0 + 1) * (1 - fx) * fz +
          hx(x0 + 1, z0 + 1) * fx * fz;

        const gap = Math.abs(height(x, z) - interpolated);
        if (gap > worst) worst = gap;
      }
    }
    errors.push(worst);
  }
  return errors;
}

/**
 * 一塊地表，含裙邊。頂點是**相對塊中心**的 —— 位置交給 instance 矩陣。
 *
 * 相對而不是絕對：世界可以很大，而頂點是 `Float32Array`。在原點外十萬單位
 * 處直接烘絕對座標會讓頂點開始互相塌陷，而症狀是「遠方的地表看起來髒髒的」，
 * 不是報錯。（與遠景合併同一個理由。）
 */
function tileGeometry(
  cx: number,
  cz: number,
  tileSize: number,
  segments: number,
  height: (x: number, z: number) => number,
  skirtDepth: number,
): BufferGeometry {
  const side = segments + 1;
  const half = tileSize / 2;
  // ## 裙邊要有**自己的一整份**頂點，包含上緣那一排
  //
  // 直覺的做法是讓裙邊的上緣直接用表面的邊界頂點（省一半），但那樣
  // `computeVertexNormals()` 會把表面的法線與裙邊那面垂直牆的法線平均起來
  // ——於是每一條塊邊界上的頂點法線都被拉歪，畫面上是**每塊邊界一條深色摺痕**。
  //
  // 那個症狀不是裂縫、不報錯，看起來像地形本身就有溝。第一版就是這樣，
  // 而且是拿去跟參考版比對截圖才看出來的：參考版乾乾淨淨，這版滿是暗線。
  //
  // 多出來的頂點是 8 × side，相對 side² 可以忽略。
  const surfaceCount = side * side;
  const skirtCount = side * 8;
  const positions = new Float32Array((surfaceCount + skirtCount) * 3);

  for (let iz = 0; iz < side; iz++) {
    for (let ix = 0; ix < side; ix++) {
      const at = (iz * side + ix) * 3;
      const localX = -half + (ix / segments) * tileSize;
      const localZ = -half + (iz / segments) * tileSize;
      positions[at] = localX;
      positions[at + 1] = height(cx + localX, cz + localZ);
      positions[at + 2] = localZ;
    }
  }

  // 裙邊：把四條邊的頂點複製一份、往下垂 `skirtDepth`。
  const edges: Array<(i: number) => number> = [
    (i) => i, // 北：iz = 0
    (i) => (side - 1) * side + i, // 南
    (i) => i * side, // 西
    (i) => i * side + (side - 1), // 東
  ];
  // 每條邊兩排：上緣（複製表面的位置）與下緣（往下垂）。
  for (const [e, indexOf] of edges.entries()) {
    for (let i = 0; i < side; i++) {
      const from = indexOf(i) * 3;
      const top = (surfaceCount + e * side * 2 + i) * 3;
      const low = top + side * 3;
      positions[top] = positions[from]!;
      positions[top + 1] = positions[from + 1]!;
      positions[top + 2] = positions[from + 2]!;
      positions[low] = positions[from]!;
      positions[low + 1] = positions[from + 1]! - skirtDepth;
      positions[low + 2] = positions[from + 2]!;
    }
  }

  const quads = segments * segments;
  const indices = new Uint32Array(quads * 6 + segments * 4 * 6);
  let at = 0;
  for (let iz = 0; iz < segments; iz++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iz * side + ix;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices[at++] = a;
      indices[at++] = c;
      indices[at++] = b;
      indices[at++] = b;
      indices[at++] = c;
      indices[at++] = d;
    }
  }
  // 每條邊接一圈朝外的面。繞序要讓裙邊從外面看得見 —— 反了的話它會被
  // 背面剔除掉，於是裂縫照樣看得到，而且完全沒有跡象顯示裙邊沒生效。
  const flip = [false, true, true, false];
  for (const [e] of edges.entries()) {
    for (let i = 0; i < segments; i++) {
      const base = surfaceCount + e * side * 2;
      const top0 = base + i;
      const top1 = base + i + 1;
      const low0 = base + side + i;
      const low1 = low0 + 1;
      const tri = flip[e]
        ? [top0, low0, top1, top1, low0, low1]
        : [top0, top1, low0, top1, low1, low0];
      for (const v of tri) indices[at++] = v;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 給物理引擎用的高度場，**與畫出來的地表取樣自同一個函式**。
 *
 * ## 為什麼這一定要由套件出，不能讓呼叫端自己取樣
 *
 * 物理的高度場與畫面的地表對不起來時，角色會**浮在空中或陷進地裡** ——
 * 而且不報錯，只是「腳沒踩到地上」。
 *
 * 而對不起來幾乎是預設結果：呼叫端要自己決定取樣的原點在哪、格距多少、
 * 列與行哪個是 x、有沒有差半格。任何一個猜錯就是靜靜地錯位，而那個錯
 * 要走到那一塊地形上才看得到。
 *
 * 這裡用**同一個 `height` 函式、同一個範圍**取樣，所以兩邊在定義上就一致。
 *
 * ## 輸出的排列是給 Rapier 的
 *
 * Rapier 的 `ColliderDesc.heightfield(nrows, ncols, heights, scale)` 吃的是
 * **column-major**（先走 row，再走 column），而且高度是**相對於中心**、
 * 由 `scale` 縮放的。這裡直接產出那個形狀：
 *
 * ```js
 * const field = WW.terrainHeightfield({ size: 2400, samples: 256, height });
 * const desc = RAPIER.ColliderDesc.heightfield(
 *   field.rows - 1, field.columns - 1, field.heights, field.scale,
 * );
 * ```
 *
 * 傳錯 major order 的症狀是地形**沿對角線鏡射** —— 山長在錯的地方，而
 * 畫面上的地表是對的。那種錯很難歸因，所以這裡直接給對的排列。
 */
export interface TerrainHeightfield {
  /** 取樣的列數（z 方向）。 */
  rows: number;
  /** 取樣的行數（x 方向）。 */
  columns: number;
  /** 高度，column-major。 */
  heights: Float32Array;
  /** 餵給 Rapier 的縮放。`y` 是 1 —— 高度已經是世界單位了。 */
  scale: { x: number; y: number; z: number };
}

export interface TerrainHeightfieldOptions {
  /** 整片地表多大，世界單位。**要與 `buildTerrain` 的 `size` 相同。** */
  size: number;
  /**
   * 每邊取樣幾點。
   *
   * 與畫面的解析度**不必相同** —— 碰撞通常可以粗一點，那是記憶體與精度的
   * 取捨，屬於開發者。但它必須蓋住同一個範圍，所以 `size` 不能不一樣。
   */
  samples: number;
  /** 高度函式。**要與 `buildTerrain` 用同一個。** */
  height: (x: number, z: number) => number;
}

export function terrainHeightfield(options: TerrainHeightfieldOptions): TerrainHeightfield {
  const { size, samples, height } = options;
  if (!Number.isInteger(samples) || samples < 2) {
    throw new Error(`WW.terrainHeightfield: samples 要是 ≥ 2 的整數，收到 ${samples}。`);
  }

  const heights = new Float32Array(samples * samples);
  const half = size / 2;
  const step = size / (samples - 1);

  // **column-major**：外層走 column（x），內層走 row（z）。
  //
  // 寫成 row-major 的話地形會沿對角線鏡射 —— 山長在錯的地方，而畫面上的
  // 地表是對的。那個錯不會報，也很難歸因到「排列順序」上。
  for (let c = 0; c < samples; c++) {
    const x = -half + c * step;
    for (let r = 0; r < samples; r++) {
      const z = -half + r * step;
      heights[c * samples + r] = height(x, z);
    }
  }

  return {
    rows: samples,
    columns: samples,
    heights,
    // y 是 1：高度已經是世界單位，再乘一次就會把地形拉高。
    scale: { x: size, y: 1, z: size },
  };
}
