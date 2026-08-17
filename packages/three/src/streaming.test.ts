import { BoxGeometry, Matrix4, MeshBasicMaterial, PerspectiveCamera, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { InstancedMesh } from './instanced-mesh.ts';
import { worldFor, type World } from './world.ts';

/**
 * 串流的正確性條件不是「跑得快」，而是**走出去再走回來，世界還是同一個
 * 樣子，而且記憶體沒有長大**。那兩件事在幀時間上完全看不出來。
 */

function mesh(count = 4): InstancedMesh {
  return new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial(), count, {
    autoLod: false,
  });
}

function camera(): PerspectiveCamera {
  return new PerspectiveCamera(60, 16 / 9, 0.1, 5000);
}

/** 直接推一次 scene.onBeforeRender，模擬 Three.js 每次 render 做的事。 */
function tick(scene: Scene, cam: PerspectiveCamera, x: number, z: number): void {
  cam.position.set(x, 0, z);
  cam.updateMatrixWorld(true);
  scene.onBeforeRender(null as never, scene, cam, null as never, null as never, null as never);
}

/** 每格固定 `perCell` 個，位置由 (cx, cz) 決定 —— 決定性的。 */
function makeWorld(
  perCell: number | ((cx: number, cz: number) => number),
  options: { radius?: number; cellSize?: number } = {},
): { scene: Scene; world: World; rocks: InstancedMesh; cam: PerspectiveCamera; loads: number[] } {
  const countAt = typeof perCell === 'function' ? perCell : (): number => perCell;
  const scene = new Scene();
  const rocks = mesh();
  scene.add(rocks);
  const world = worldFor(scene);
  const loads: number[] = [];
  const m = new Matrix4();

  world.stream({
    cellSize: options.cellSize ?? 100,
    radius: options.radius ?? 150,
    load: (cx, cz, place) => {
      loads.push(cx * 1000 + cz);
      // 位置直接編碼 (cx, cz, i)，這樣從矩陣就讀得出「這個 instance 是
      // 哪一格的第幾個」—— 沒有這個，測試就只能檢查數量，而數量對得上
      // 但內容錯掉正是壓洞失敗的樣子。
      //
      // 而且刻意**重複使用同一個 `Matrix4`** —— 那是 Three.js 的慣例，
      // 介面必須撐得住。
      for (let i = 0; i < countAt(cx, cz); i++) place(rocks, m.makeTranslation(cx, cz, i));
    },
  });

  return { scene, world, rocks, cam: camera(), loads };
}

/** 讀出 `[0, count)` 裡每一格各有幾個 instance。 */
function contentByCell(mesh: InstancedMesh): Map<string, number> {
  const read = new Matrix4();
  const counts = new Map<string, number>();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, read);
    const key = `${read.elements[12]},${read.elements[13]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('World.stream', () => {
  it('相機周圍的 cell 會被載入，內容進到 mesh 裡', async () => {
    const { scene, rocks, cam } = makeWorld(3);

    tick(scene, cam, 0, 0);
    await Promise.resolve();
    tick(scene, cam, 0, 0);

    expect(rocks.count).toBeGreaterThan(0);
    expect(rocks.count % 3).toBe(0);
  });

  it('容量不夠時自己長大，不是丟例外也不是靜默截斷', async () => {
    // 建構時只給 4 個位子，但一格就有 50 個 —— 使用者不可能事先猜得到
    // 「同時常駐幾個」，那是相機走到哪裡決定的。
    const { scene, rocks, cam } = makeWorld(50);
    expect(rocks.capacity).toBe(4);

    for (let i = 0; i < 5; i++) {
      tick(scene, cam, 0, 0);
      await Promise.resolve();
    }

    expect(rocks.capacity).toBeGreaterThanOrEqual(rocks.count);
    expect(rocks.count).toBeGreaterThanOrEqual(50);
  });

  it('走遠之後那些 cell 會被卸載，instance 數回落', async () => {
    const { scene, rocks, cam } = makeWorld(5);

    for (let i = 0; i < 6; i++) {
      tick(scene, cam, 0, 0);
      await Promise.resolve();
    }
    const near = rocks.count;
    expect(near).toBeGreaterThan(0);

    // 走到很遠的地方：舊的全部超出卸載半徑
    for (let i = 0; i < 12; i++) {
      tick(scene, cam, 10_000, 10_000);
      await Promise.resolve();
    }

    expect(rocks.count).toBeGreaterThan(0);
    expect(rocks.count).toBeLessThanOrEqual(near);
  });

  it('**走出去再走回來，數量完全一樣** —— 這是串流唯一重要的正確性條件', async () => {
    const { scene, rocks, cam } = makeWorld(7);

    const settle = async (x: number, z: number): Promise<void> => {
      for (let i = 0; i < 30; i++) {
        tick(scene, cam, x, z);
        await Promise.resolve();
      }
    };

    await settle(0, 0);
    const before = contentByCell(rocks);
    expect(before.size).toBeGreaterThan(0);

    await settle(5_000, 5_000);
    await settle(0, 0);

    // 數量與**內容**都要一樣。只比數量的話，內容換成別格的也會過。
    expect(contentByCell(rocks)).toEqual(before);
    expect(rocks.count % 7).toBe(0);
  });

  it('**卸載留下的洞被壓掉了** —— 每格數量不同才驗得出來', async () => {
    // 洞沒壓掉的話，被釋放的區塊後面那些區塊的位置就過期了，新載入的
    // 內容會蓋到還活著的 instance 上。畫面是「有東西留在原地、有東西
    // 沒出現」，而 count、resident、幀時間全部正常。
    //
    // **每一格數量相同的話這個檢查驗不出來**：卸載一格、載入一格，兩邊
    // 剛好一樣大，錯位互相抵銷。第一版就是這樣，注入缺陷照樣全綠。
    // 所以這裡的每格數量刻意隨座標變動。
    const perCell = (cx: number, cz: number): number => 2 + (((cx + cz) % 4) + 4) % 4;
    const { scene, world, rocks, cam } = makeWorld(perCell, { radius: 350 });

    const settle = async (x: number, z: number): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        tick(scene, cam, x, z);
        await Promise.resolve();
      }
    };

    await settle(0, 0);
    await settle(400, 0);
    await settle(400, 400);

    const byCell = contentByCell(rocks);
    expect(byCell.size).toBe(world.streaming!.stats.resident);
    for (const [key, n] of byCell) {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      expect(`${key} → ${n}`).toBe(`${key} → ${perCell(cx, cz)}`);
    }
  });

  it('同一個 cell 不會被重複載入', async () => {
    const { scene, cam, loads } = makeWorld(2);

    for (let i = 0; i < 40; i++) {
      tick(scene, cam, 0, 0);
      await Promise.resolve();
    }

    expect(new Set(loads).size).toBe(loads.length);
  });

  it('不呼叫 stream() 的話一切照常 —— 內容全部常駐', () => {
    const scene = new Scene();
    const rocks = mesh(16);
    scene.add(rocks);
    const world = worldFor(scene);

    expect(world.streaming).toBeNull();
    expect(rocks.count).toBe(16);

    // scene.onBeforeRender 沒有被接管
    tick(scene, camera(), 0, 0);
    expect(rocks.count).toBe(16);
  });

  it('原本掛在 scene.onBeforeRender 上的處理函式會被接續呼叫，不是覆蓋', async () => {
    const scene = new Scene();
    const rocks = mesh();
    scene.add(rocks);
    let calls = 0;
    scene.onBeforeRender = (): void => {
      calls++;
    };

    worldFor(scene).stream({
      cellSize: 100,
      radius: 150,
      load: (_cx, _cz, place) => place(rocks, new Matrix4()),
    });

    tick(scene, camera(), 0, 0);
    await Promise.resolve();

    expect(calls).toBe(1);
  });

  it('重複 stream() 會丟例外，而不是靜靜地疊兩層', () => {
    const { world, rocks } = makeWorld(1);
    expect(() =>
      world.stream({ cellSize: 100, radius: 150, load: (_cx, _cz, place) => place(rocks, new Matrix4()) }),
    ).toThrow(/已經在串流/);
  });

  it('**幀預算是量出來的，不是猜的**', async () => {
    // 作者猜的任何數字都是替某一台機器調校：16.7 ms 在 60 Hz 桌機上對，
    // 在 144 Hz 上太鬆，在弱機器上永遠達不到。對的值是這台機器安靜時的
    // 幀間隔，而那只有跑起來才量得到。
    const { scene, world, cam } = makeWorld(2);
    const stream = world.streaming!;

    expect(stream.budget.baselineMs).toBe(0); // 還沒觀察過

    for (let i = 0; i < 20; i++) {
      tick(scene, cam, 0, 0);
      await Promise.resolve();
    }

    expect(stream.budget.baselineMs).toBeGreaterThan(0);
    expect(stream.budget.budgetMs).toBeCloseTo(stream.budget.baselineMs * 1.5, 6);
    expect(stream.budget.loadRate).toBeGreaterThan(0);
  });

  it('明確傳了 frameBudgetMs 就用那個，不再自己量', async () => {
    const scene = new Scene();
    const rocks = mesh();
    scene.add(rocks);
    const stream = worldFor(scene).stream({
      cellSize: 100,
      radius: 150,
      frameBudgetMs: 33,
      load: (_cx, _cz, place) => place(rocks, new Matrix4()),
    });

    for (let i = 0; i < 10; i++) {
      tick(scene, camera(), 0, 0);
      await Promise.resolve();
    }

    expect(stream.budget.budgetMs).toBe(33);
    expect(stream.budget.baselineMs).toBe(0);
  });

  it('stats 說得出目前常駐幾個 cell', async () => {
    const { scene, world, cam } = makeWorld(2);

    for (let i = 0; i < 30; i++) {
      tick(scene, cam, 0, 0);
      await Promise.resolve();
    }

    const stats = world.streaming!.stats;
    expect(stats.resident).toBeGreaterThan(0);
    expect(stats.totalLoads).toBeGreaterThan(0);
    expect(stats.failedLoads).toBe(0);
  });
});
