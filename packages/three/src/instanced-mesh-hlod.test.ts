import {
  IcosahedronGeometry,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Vector2,
  type WebGLRenderer,
} from 'three';
import { describe, expect, it } from 'vitest';
import { InstancedMesh } from './instanced-mesh.ts';
import { sphericalLodErrors } from './spherical-error.ts';

/**
 * 遠景合併的失效方式全都**看不出來**：
 *
 * - 完全沒生效 → 畫面一模一樣，只是慢
 * - 太早生效（近處也合併）→ 近處變粗，靜靜違反品質契約
 * - 合併之後沒跳過原本那些 instance → 東西畫了兩次，畫面正常但更慢
 *
 * 所以這裡驗的是 `stats.merged` 與繪製次數，不是「有沒有跑完」。
 */

const LODS = [4, 2, 1].map((d) => new IcosahedronGeometry(1, d));
const ERRORS = sphericalLodErrors(LODS);

/** 最小的假 renderer：`onBeforeRender` 只用到這三個東西。 */
function fakeRenderer(height = 900): WebGLRenderer {
  return {
    getRenderTarget: () => null,
    getDrawingBufferSize: (target: Vector2) => target.set(1600, height),
  } as unknown as WebGLRenderer;
}

/**
 * 一片鋪在 XZ 平面上的 instance。
 *
 * **刻意給一個寬鬆的記憶體預算。** 這裡的最粗階是 `IcosahedronGeometry(1, 1)`
 * —— 80 個三角形而且**非索引**，也就是 240 個頂點；cook 過的真實資產是 4 個
 * 三角形、12 個頂點。所以同一個預算在這份內容上只放得下二十分之一的槽位。
 *
 * 這幾個測試要驗的是合併的**機制**（有沒有生效、會不會太早、會不會畫兩次），
 * 不是預設預算夠不夠。預算本身由 `hlodBudgetMB` 那兩個測試單獨驗。
 */
function build(count: number, spread: number, options = {}): InstancedMesh {
  const mesh = new InstancedMesh({ lods: LODS, errors: ERRORS }, new MeshBasicMaterial(), count, {
    instancesPerCell: 64,
    hlodBudgetMB: 256,
    ...options,
  });
  const matrix = new Matrix4();
  // 固定的擺放，不用亂數 —— 合不合併必須是可重現的。
  const side = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const x = ((i % side) / side - 0.5) * spread;
    const z = (Math.floor(i / side) / side - 0.5) * spread;
    mesh.setMatrixAt(i, matrix.makeTranslation(x, 0, z));
  }
  return mesh;
}

/** 把相機放在遠處往內容看，跑一次 `onBeforeRender`。 */
function renderFrom(mesh: InstancedMesh, distance: number, frames = 1): void {
  const scene = new Scene();
  scene.add(mesh);
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, distance * 10);
  camera.position.set(0, distance * 0.35, distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
  // 合併幾何是**惰性烘**的：收集時登記，之後在每幀的時間預算內處理。
  // 只畫一幀的話一格都還沒烘好 —— 那是設計而不是 bug（停下來等它烘完
  // 會變成一次卡頓）。所以要驗合併就必須畫到它暖起來。
  for (let i = 0; i < frames; i++) {
    mesh.onBeforeRender(
      fakeRenderer(),
      scene,
      camera,
      mesh.geometry,
      mesh.material as MeshBasicMaterial,
    );
  }
}

/** 畫到合併穩定下來。 */
const WARM = 40;

describe('遠景合併', () => {
  it('遠到整格都挑最粗階時，一格只送一次繪製', () => {
    const mesh = build(4096, 400);
    renderFrom(mesh, 6000, WARM);

    const stats = mesh.stats;
    expect(stats.merged).toBeGreaterThan(0);
    // 可見的繪製次數要遠少於可見的 instance 數 —— 那正是合併的意義。
    expect(stats.visible).toBeLessThan(stats.tested / 4);
  });

  it('誤差預算收緊之後就不合併，畫質契約優先', () => {
    // 0.01 像素的預算下，幾乎沒有東西遠到可以用最粗階 —— 那時合併必須
    // 整個關掉。硬合併的話畫面只是「有點粗」，沒有任何東西會報錯。
    const strict = build(4096, 400, { errorPixels: 0.01 });
    renderFrom(strict, 400, WARM);

    expect(strict.stats.merged).toBe(0);
  });

  it('越遠合併得越多', () => {
    const near = build(4096, 400);
    renderFrom(near, 300, WARM);
    const far = build(4096, 400);
    renderFrom(far, 6000, WARM);

    // 合併是距離的函數。反過來或不隨距離變，代表判斷根本沒看距離。
    expect(far.stats.merged).toBeGreaterThan(near.stats.merged);
  });

  it('合併過的格子不會再逐一送一次', () => {
    const mesh = build(4096, 400);
    renderFrom(mesh, 6000, WARM);

    const stats = mesh.stats;
    // 每一格合併成一次，其餘的逐一送。畫兩次的話 visible 會超過 tested。
    expect(stats.visible).toBeLessThanOrEqual(stats.tested);
    expect(stats.merged).toBeLessThanOrEqual(stats.visible);
  });

  it('只要還有 instance 該用細階，那一格就不合併', () => {
    // **這是遠景合併唯一不能違反的性質。** 一整格只有在裡面每一個都遠到
    // 該用最粗階時才可以合併 —— 否則就是靜靜降級，畫面只是「遠處提早變粗」。
    //
    // 用單一一格（instance 數剛好等於一格的目標值）掃距離：只要逐一判斷
    // 還有人不在最粗階，合併就必須是 0。
    //
    // 掃距離是必要的。單一距離測不出來 —— 合併判斷漏掉 instance 縮放時，
    // 只有在某一段距離裡兩者才會分岔，而那正是實測抓到的 bug。
    const buildOne = (hlod: boolean, scale: number): InstancedMesh => {
      const mesh = new InstancedMesh({ lods: LODS, errors: ERRORS }, new MeshBasicMaterial(), 64, {
        instancesPerCell: 64,
        hlod,
      });
      const matrix = new Matrix4();
      const size = new Vector3(scale, scale, scale);
      for (let i = 0; i < 64; i++) {
        matrix.makeTranslation(
          ((i % 8) - 3.5) * scale * 3,
          0,
          (Math.floor(i / 8) - 3.5) * scale * 3,
        );
        matrix.scale(size);
        mesh.setMatrixAt(i, matrix);
      }
      return mesh;
    };

    const coarsest = LODS.length - 1;
    let sawMixed = false;
    for (const distance of [200, 400, 800, 1600, 3200, 6400, 12_800]) {
      const off = buildOne(false, 20);
      renderFrom(off, distance, WARM);
      const finer = Array.from(off.stats.levels).reduce(
        (sum, n, level) => (level < coarsest ? sum + n : sum),
        0,
      );
      if (finer === 0) continue;

      sawMixed = true;
      const on = buildOne(true, 20);
      renderFrom(on, distance, WARM);
      expect(on.stats.merged, `距離 ${distance} 還有 ${finer} 個該用細階`).toBe(0);
    }
    // 每個距離都已經全在最粗階的話，這個測試什麼都沒驗到。
    expect(sawMixed).toBe(true);
  });

  it('合併不會把該用細階的 instance 降到最粗', () => {
    // **這是遠景合併唯一不能違反的性質。** 開啟之後最粗階的數量若變多，
    // 就代表有 instance 被降級了 —— 畫面只是「遠處提早變粗」，沒有任何
    // 東西會報錯。
    //
    // 實測抓到過一次：合併判斷漏掉了 instance 的縮放，於是把物件當成小了
    // 25 倍。關掉時 366 個 instance 用中間階，開啟後只剩 22 個。
    const scaledPlacement = (mesh: InstancedMesh, count: number): void => {
      const matrix = new Matrix4();
      const scale = new Vector3(20, 20, 20);
      const side = Math.ceil(Math.sqrt(count));
      for (let i = 0; i < count; i++) {
        matrix.makeTranslation(
          ((i % side) / side - 0.5) * 3000,
          0,
          (Math.floor(i / side) / side - 0.5) * 3000,
        );
        matrix.scale(scale);
        mesh.setMatrixAt(i, matrix);
      }
    };
    const make = (hlod: boolean): InstancedMesh => {
      const mesh = new InstancedMesh(
        { lods: LODS, errors: ERRORS },
        new MeshBasicMaterial(),
        1024,
        {
          instancesPerCell: 64,
          hlod,
        },
      );
      scaledPlacement(mesh, 1024);
      renderFrom(mesh, 2500, WARM);
      return mesh;
    };

    const off = make(false);
    const on = make(true);
    const coarsest = LODS.length - 1;

    expect(on.stats.merged).toBeGreaterThan(0);
    expect(on.stats.levels[coarsest]).toBeLessThanOrEqual(off.stats.levels[coarsest]!);
  });

  it('關掉就真的沒有', () => {
    const mesh = build(4096, 400, { hlod: false });
    renderFrom(mesh, 6000, WARM);

    expect(mesh.stats.merged).toBe(0);
  });

  it('連一格都放不下時明確不啟用', () => {
    // 預算小到一定放不下。這條路要**明確不啟用**，不是烘到一半爆掉。
    const mesh = build(4096, 400, { hlodBudgetMB: 0.0001 });
    renderFrom(mesh, 6000, WARM);

    expect(mesh.stats.merged).toBe(0);
  });

  it('預算不夠時用到為止，不是整個關掉', () => {
    // **這是一道實測抓到的懸崖。** 原本的預算是全有或全無：250,000 個
    // instance 幀 p50 是 9.30 ms，一百萬個變成 100.85 ms —— 不是硬體撐不住，
    // 是合併被自己的預算整個關掉，掉回 45 萬次繪製。
    //
    // 現在是一格一格花，花完就停，沒合併到的照原本逐一送。
    const full = build(4096, 400);
    renderFrom(full, 6000, WARM);

    // 4 MB：這份內容一個槽位 0.54 MB（最粗階 80 個三角形、非索引，
    // 64 個 instance 一格），所以放得下幾個但放不下全部 64 個。
    const partial = build(4096, 400, { hlodBudgetMB: 4 });
    renderFrom(partial, 6000, WARM);

    // 部分合併：比完整的少，但**不是零**。
    expect(partial.stats.merged).toBeGreaterThan(0);
    expect(partial.stats.merged).toBeLessThan(full.stats.merged);
    // 而且繪製次數要介於兩者之間 —— 掉回完全不合併就是懸崖又回來了。
    expect(partial.stats.visible).toBeGreaterThan(full.stats.visible);
    expect(partial.stats.visible).toBeLessThan(4096);
  });

  it('合併的格子依 order 位置排序', () => {
    // 挑格子是按 instance 數排的，但熱迴圈用一個不回頭的游標往前走。
    // 交回去之前沒有重新依位置排序的話，大部分格子會被跳過 —— 合併看起來
    // 只生效了一部分，而畫面完全正常。
    const mesh = build(4096, 400);
    renderFrom(mesh, 6000, WARM);

    // 排序壞掉時合併數會遠低於可用的格子數。
    expect(mesh.stats.merged).toBeGreaterThan(mesh.stats.cells * 0.9);
  });

  it('連續多幀之後空間分割仍然開著', () => {
    const mesh = build(4096, 400);
    // 合併本身也要寫一次矩陣。走到會讓空間格失效的那條路的話，就變成
    // 「每幀都在改矩陣」，於是整個空間分割會被當成動態內容關掉 ——
    // 而畫面完全正常，只是變慢。這是真的發生過的 bug，一兩幀的測試看不到。
    renderFrom(mesh, 6000, 60);

    expect(mesh.stats.spatial).toBe(true);
    expect(mesh.stats.merged).toBeGreaterThan(0);
    // 而且合併要一直有效，不是只在第一幀。
    expect(mesh.stats.visible).toBeLessThan(4096 / 4);
  });

  it('setMatrixAt 之後包圍球快取要跟著更新', () => {
    // 剔除與選階讀的是**預先算好**的世界空間包圍球。`setMatrixAt` 不會動
    // `instanceMatrix.version`，所以快取若只看版本號就永遠不會更新 ——
    // 物件變大了，選階卻還在用原本的大小，於是遠處該變細的沒變。
    //
    // 這裡只改**縮放**不改位置：空間格是依位置分格的，位置一動整格會重建，
    // 那條路會蓋過快取的問題，測不到要測的東西。
    const mesh = build(256, 200, { hlod: false });
    renderFrom(mesh, 800, WARM);
    const before = Array.from(mesh.stats.levels);

    const matrix = new Matrix4();
    const scale = new Vector3(40, 40, 40);
    const side = 16;
    for (let i = 0; i < 256; i++) {
      matrix.makeTranslation(
        ((i % side) / side - 0.5) * 200,
        0,
        (Math.floor(i / side) / side - 0.5) * 200,
      );
      matrix.scale(scale);
      mesh.setMatrixAt(i, matrix);
    }
    renderFrom(mesh, 800, WARM);

    // 大了 40 倍，螢幕誤差也大 40 倍，該有東西往細階移動。
    expect(Array.from(mesh.stats.levels)).not.toEqual(before);
  });

  it('矩陣改過之後重新烘，不會愈積愈多', () => {
    const mesh = build(1024, 400);
    renderFrom(mesh, 6000, WARM);
    const first = mesh.stats.merged;
    expect(first).toBeGreaterThan(0);

    // 動一個矩陣就會讓空間格失效 → 合併要重建。舊的沒拆掉的話，
    // 幾何會一份一份疊上去，而畫面完全正常。
    const matrix = new Matrix4();
    mesh.setMatrixAt(0, matrix.makeTranslation(1, 0, 1));
    mesh.instanceMatrix.needsUpdate = true;
    renderFrom(mesh, 6000, WARM);

    expect(mesh.stats.merged).toBe(first);
  });
});

describe('遠景合併 — 串流的區塊路徑', () => {
  /**
   * 串流走的是區塊表而不是空間格，所以分組是另一條程式碼路徑。**同樣三個
   * 失效方式全都看不出來**，所以這裡驗的還是同一組性質，只是內容改成整段
   * 寫進來的。
   */
  const streamed = (
    cells: number,
    perCell: number,
    spread: number,
    options = {},
  ): InstancedMesh => {
    const mesh = new InstancedMesh(
      { lods: LODS, errors: ERRORS },
      new MeshBasicMaterial(),
      cells * perCell,
      {
        instancesPerCell: 64,
        hlodBudgetMB: 256,
        ...options,
      },
    );
    const matrix = new Matrix4();
    const side = Math.ceil(Math.sqrt(cells));
    for (let c = 0; c < cells; c++) {
      const block = new Float32Array(perCell * 16);
      const cellX = ((c % side) / side - 0.5) * spread;
      const cellZ = (Math.floor(c / side) / side - 0.5) * spread;
      for (let i = 0; i < perCell; i++) {
        matrix.makeTranslation(
          cellX + ((i % 8) / 8) * (spread / side),
          0,
          cellZ + (Math.floor(i / 8) / 8) * (spread / side),
        );
        matrix.toArray(block, i * 16);
      }
      mesh.writeMatrices(c * perCell, block);
    }
    mesh.count = cells * perCell;
    return mesh;
  };

  it('遠景一樣併成一次繪製，而且不必建空間格', () => {
    const mesh = streamed(64, 64, 400);
    renderFrom(mesh, 6000, WARM);

    const stats = mesh.stats;
    expect(stats.merged).toBeGreaterThan(0);
    expect(stats.visible).toBeLessThan(stats.tested / 4);
    // 這條路的重點：分割是現成的，所以一次格子都沒建。
    expect(stats.cells).toBe(0);
  });

  it('合併過的不會再逐一送一次', () => {
    const mesh = streamed(64, 64, 400);
    renderFrom(mesh, 6000, WARM);

    const stats = mesh.stats;
    expect(stats.visible).toBeLessThanOrEqual(stats.tested);
    expect(stats.merged).toBeLessThanOrEqual(stats.visible);
  });

  it('近到還有東西該用細階時就不合併', () => {
    // 品質契約在這條路上一樣不能違反。掃距離 —— 單一距離測不出來。
    const coarsest = LODS.length - 1;
    let sawMixed = false;
    for (const distance of [20, 40, 80, 120, 160, 240, 320]) {
      const off = streamed(16, 64, 400, { hlod: false });
      renderFrom(off, distance, WARM);
      const finer = Array.from(off.stats.levels).reduce(
        (sum, n, level) => (level < coarsest ? sum + n : sum),
        0,
      );
      if (finer === 0) continue;

      sawMixed = true;
      const on = streamed(16, 64, 400);
      renderFrom(on, distance, WARM);
      expect(on.stats.levels[coarsest], `距離 ${distance}`).toBeLessThanOrEqual(
        off.stats.levels[coarsest]! + on.stats.mergedInstances,
      );
    }
    expect(sawMixed).toBe(true);
  });

  it('一路卸載之後合併仍然成立，而且沒有東西被畫兩次', () => {
    // 分組的編號在卸載之後整個位移，而槽位記的是「我裝的是第幾組」。
    //
    // **這個測試看得到的只有「還在不在」與「有沒有畫兩次」。** 槽位指到
    // 別人身上的那種錯（遠景畫成別的地方的東西）從 `stats` 看不出來 ——
    // 數量、繪製次數全都正常。那一段只能靠程式碼本身撐著。
    const mesh = streamed(64, 64, 400);
    renderFrom(mesh, 6000, WARM);
    expect(mesh.stats.merged).toBeGreaterThan(0);

    for (let i = 0; i < 8; i++) {
      const live = mesh.count;
      mesh.moveInstances(64, 0, live - 64);
      mesh.count = live - 64;
      renderFrom(mesh, 6000, 6);
      expect(mesh.stats.mergedInstances, `第 ${i} 次卸載`).toBeLessThanOrEqual(mesh.count);
      expect(mesh.stats.visible).toBeLessThanOrEqual(mesh.stats.tested);
      // 每個 instance 最多送一次。合併之後沒跳過原本那些的話會超過。
      const drawn = Array.from(mesh.drawnInstances);
      expect(new Set(drawn).size).toBe(drawn.length);
    }
    // 卸載掉八格之後仍然有東西在合併 —— 全垮掉的話這裡會是 0。
    expect(mesh.stats.merged).toBeGreaterThan(0);
  });
});
