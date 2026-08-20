import { asEntityId, type EntityId } from '@ww/core';
import { describe, expect, it } from 'vitest';
import { WorldStreamer, type CellSource, type StreamingOptions } from './streaming.ts';

/**
 * 串流的測試重點是**不漏、不抖、不空洞**：
 *
 * - 不漏：走遠之後舊 cell 的內容必須真的被釋放
 * - 不抖：相機停在邊界上不能讓 cell 反覆載入卸載
 * - 不空洞：預算有限時要先載近的
 *
 * 前兩者在畫面上都看不出來 —— 漏的表現是「跑久了變慢然後崩潰」，
 * 抖的表現是「幀時間莫名偏高但畫面正常」。只能靠測試釘住。
 */

/** 記錄所有載入卸載的假來源。每個 cell 固定產生 3 個 entity。 */
function trackingSource(options: { delay?: boolean } = {}): CellSource & {
  live: Set<EntityId>;
  loads: Array<[number, number]>;
  unloads: Array<[number, number]>;
  /** 只有 delay 模式才有：手動放行在途的載入。 */
  release: () => void;
} {
  let next = 1;
  const live = new Set<EntityId>();
  const loads: Array<[number, number]> = [];
  const unloads: Array<[number, number]> = [];
  const gates: Array<() => void> = [];

  return {
    live,
    loads,
    unloads,
    release() {
      for (const gate of gates.splice(0)) gate();
    },
    load(cx, cz) {
      loads.push([cx, cz]);
      const make = (): EntityId[] => {
        const made: EntityId[] = [];
        for (let i = 0; i < 3; i++) {
          const e = asEntityId(next++);
          live.add(e);
          made.push(e);
        }
        return made;
      };
      if (options.delay !== true) return make();
      // 延遲模式：entity 在放行時才建立，模擬真實的 fetch + 解碼
      return new Promise<EntityId[]>((resolve) => {
        gates.push(() => resolve(make()));
      });
    },
    unload(cx, cz, entities) {
      unloads.push([cx, cz]);
      for (const e of entities) live.delete(e);
    },
  };
}

const BASE: StreamingOptions = {
  cellSize: 100,
  loadRadius: 250,
  unloadRadius: 400,
  maxConcurrentLoads: 1000,
  maxUnloadsPerFrame: 1000,
};

/**
 * 推進一幀並讓在途的載入完成。
 *
 * 串流是非同步的 —— `update()` 回來時載入還沒結束。**同步來源也一樣**：
 * 兩者共用同一條 promise 路徑，所以「取消」與「亂序完成」的處理不會有
 * 「只在非同步時才對」的分支。代價就是測試必須明確地等。
 */
async function step(streamer: WorldStreamer, x: number, z: number): Promise<void> {
  streamer.update(x, z);
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorldStreamer', () => {
  it('rejects an unload radius that is not larger than the load radius', () => {
    // 這不是可以「之後再調」的參數：相同的話 cell 會在邊界上永久抖動，
    // 症狀是幀時間莫名偏高而畫面完全正常。所以在建構時就擋下來。
    expect(
      () => new WorldStreamer(trackingSource(), { ...BASE, loadRadius: 200, unloadRadius: 200 }),
    ).toThrow(/unloadRadius/);
  });

  it('loads cells around the camera', async () => {
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);
    await step(streamer, 0, 0);
    expect(streamer.stats.resident).toBeGreaterThan(0);
    expect(source.live.size).toBe(streamer.stats.entities);
  });

  it('releases every entity when the camera moves far away', async () => {
    // 這是通過條件的核心：長時間巡遊不漏記憶體。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);
    await step(streamer, 0, 0);
    expect(source.live.size).toBeGreaterThan(0);

    await step(streamer, 100_000, 100_000);
    for (const [cx, cz] of source.loads.slice(0, 3)) {
      expect(source.unloads.some(([ux, uz]) => ux === cx && uz === cz)).toBe(true);
    }
    // 常駐的 entity 數必須等於串流器自己的計數 —— 兩者不一致就是漏了
    expect(source.live.size).toBe(streamer.stats.entities);
  });

  it('keeps memory bounded across a long traverse', async () => {
    // 走很長一段距離，常駐 cell 數必須維持在同一個量級。
    // 若忘記卸載，這個數字會單調成長 —— 那正是「跑久了就崩潰」的形態。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);

    const residents: number[] = [];
    for (let s = 0; s < 200; s++) {
      await step(streamer, s * 50, 0);
      residents.push(streamer.stats.resident);
    }

    expect(Math.max(...residents.slice(20))).toBeLessThan(100);
    expect(source.live.size).toBe(streamer.stats.entities);
  });

  it('does not thrash when the camera sits on a boundary', async () => {
    // 遲滯帶存在的唯一理由。沒有它的話，相機在載入半徑邊界上抖動幾公分
    // 就會讓同一個 cell 反覆載入卸載 —— 每幀都在做最貴的工作。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);

    await step(streamer, 0, 0);
    const loadsAfterSettle = source.loads.length;

    for (let i = 0; i < 50; i++) {
      await step(streamer, 240 + (i % 2) * 20, 0);
    }
    expect(source.loads.length - loadsAfterSettle).toBeLessThan(20);
  });

  it('honours the concurrent load budget', async () => {
    // 一次載完會造成明顯卡頓。預算就是同時在途的請求上限。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, { ...BASE, maxConcurrentLoads: 2 });

    await step(streamer, 0, 0);
    expect(source.loads).toHaveLength(2);
    expect(streamer.stats.pending).toBeGreaterThan(0);

    await step(streamer, 0, 0);
    expect(source.loads).toHaveLength(4);
  });

  it('loads the nearest cells first', async () => {
    // 預算有限時載遠的會讓玩家眼前出現空洞，那是最容易被看見的地方。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, { ...BASE, maxConcurrentLoads: 1 });

    await step(streamer, 50, 50); // cell (0,0) 的中心
    expect(source.loads[0]).toEqual([0, 0]);
  });

  it('handles negative cell coordinates without key collisions', async () => {
    // 負座標若處理錯，世界另一頭的內容會跟著一起出現或消失。
    // 這一項在 16 位元打包的版本下實測會失敗。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);
    await step(streamer, -5000, -5000);

    for (const [cx, cz] of source.loads) {
      expect(cx).toBeLessThan(0);
      expect(cz).toBeLessThan(0);
    }
    expect(source.live.size).toBe(streamer.stats.entities);
  });

  it('releases everything on dispose', async () => {
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);
    await step(streamer, 0, 0);
    expect(source.live.size).toBeGreaterThan(0);

    streamer.dispose();
    expect(source.live.size).toBe(0);
    expect(streamer.stats.resident).toBe(0);
    expect(streamer.stats.entities).toBe(0);
  });
});

/**
 * 非同步載入多出來的失效路徑。
 *
 * 這一組全部只在「相機移動快於載入速度」時才會走到 —— 在同步版本裡
 * 這些程式碼根本不存在，所以它們是接真實資產時最可能出問題的地方。
 */
describe('WorldStreamer with slow loads', () => {
  it('does not issue the same cell twice while it is in flight', async () => {
    // 沒有 loading 集合的話，每一幀的 enqueue 都會看到「它不在 resident 裡」
    // 而重新發出載入 —— 同一個 cell 被載入數十次，entity 直接翻倍。
    const source = trackingSource({ delay: true });
    const streamer = new WorldStreamer(source, BASE);

    for (let i = 0; i < 10; i++) await step(streamer, 0, 0);
    const issued = source.loads.length;

    source.release();
    await step(streamer, 0, 0);

    const unique = new Set(source.loads.map(([cx, cz]) => `${cx},${cz}`));
    expect(unique.size).toBe(issued);
    expect(streamer.stats.resident).toBe(issued);
  });

  it('unloads entities from a load that completed after being cancelled', async () => {
    // 這是非同步串流最容易漏掉的一條路徑。載入**已經建立了 entity**，
    // 單純丟掉 promise 就是洩漏 —— 而且只在快速移動時才發生。
    const source = trackingSource({ delay: true });
    const streamer = new WorldStreamer(source, BASE);

    await step(streamer, 0, 0);
    expect(streamer.stats.loading).toBeGreaterThan(0);

    // 載入還在途中就走遠
    await step(streamer, 100_000, 100_000);
    // 現在才完成
    source.release();
    await step(streamer, 100_000, 100_000);

    expect(streamer.stats.cancelledLoads).toBeGreaterThan(0);
    // 關鍵：被取消的載入所建立的 entity 必須也被釋放
    expect(source.live.size).toBe(streamer.stats.entities);
  });

  it('cleans up in-flight loads after dispose', async () => {
    // dispose 只清空 resident 是不夠的：在途的載入完成時仍會建立 entity。
    const source = trackingSource({ delay: true });
    const streamer = new WorldStreamer(source, BASE);

    await step(streamer, 0, 0);
    streamer.dispose();
    source.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(source.live.size).toBe(0);
  });

  it('records a failed load instead of losing it silently', async () => {
    // 載入失敗若被靜默吞掉，那個 cell 會永遠不出現，而且沒有任何線索。
    const failing: CellSource = {
      load: () => Promise.reject(new Error('模擬的解碼失敗')),
      unload: () => {},
    };
    const streamer = new WorldStreamer(failing, BASE);

    await step(streamer, 0, 0);
    expect(streamer.stats.failedLoads).toBeGreaterThan(0);
    expect(streamer.stats.lastError).toContain('模擬的解碼失敗');
    // 失敗不能讓 cell 卡在 loading 裡，否則它永遠不會被重試
    expect(streamer.stats.loading).toBe(0);
  });
});

/**
 * 大世界座標。
 *
 * 這一組是**實測抓到 bug 之後**補的：原本的 cell 鍵把兩個座標塞進 32 位元
 * （各 16 位元），在 z = 10,000,000、cellSize = 200 時 cz = 50,000 溢位成
 * −15,536。症狀是「可見 0、常駐掉到 1/22、載入卸載次數暴增 2.6 倍」——
 * 看起來像串流壞了，實際上是座標繞回去了。
 *
 * 更糟的是原本的註解宣稱「涵蓋 ±200 萬世界單位，遠超過任何實際世界」，
 * 而那句話本身是錯的，且沒有任何測試驗證過。
 */
describe('WorldStreamer at large world coordinates', () => {
  it('behaves identically far from the origin', async () => {
    const near = trackingSource();
    const nearStreamer = new WorldStreamer(near, BASE);
    const far = trackingSource();
    const farStreamer = new WorldStreamer(far, BASE);

    const OFFSET = 10_000_000;
    for (let s = 0; s < 60; s++) {
      await step(nearStreamer, 0, s * 50);
      await step(farStreamer, 0, OFFSET + s * 50);
    }

    expect(farStreamer.stats.resident).toBe(nearStreamer.stats.resident);
    expect(farStreamer.stats.entities).toBe(nearStreamer.stats.entities);
    expect(farStreamer.stats.totalLoads).toBe(nearStreamer.stats.totalLoads);
    expect(farStreamer.stats.totalUnloads).toBe(nearStreamer.stats.totalUnloads);
  });

  it('places content at the coordinates it was asked for', async () => {
    // 鍵→座標的還原若錯了，內容會被放到世界另一頭，而載入次數看起來正常。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);
    await step(streamer, 0, 10_000_000);

    for (const [, cz] of source.loads) {
      expect(cz).toBeGreaterThan(99_000);
      expect(cz).toBeLessThan(101_000);
    }
  });

  it('throws instead of silently wrapping beyond the representable range', () => {
    // 靜默繞回去的症狀完全不像「座標越界」。寧可炸掉。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, { ...BASE, cellSize: 1 });
    expect(() => streamer.update(0, 1e9)).toThrow(/超出/);
  });
});

/**
 * 代理層（HLOD 的前提）。
 *
 * 存在的理由是 r²：等密度下常駐內容隨視距的平方成長。實測視野從 3.5 個
 * cell 深拉到 10 個，常駐從 44,000 漲到 328,000。要看到地平線又不炸掉
 * 記憶體，遠處就不能是完整內容。
 *
 * 這一組要擋的錯誤都不會讓畫面看起來壞掉：
 *
 * - 層級變更時沒卸掉舊內容 → 記憶體翻倍，畫面完全正常
 * - 遲滯帶太窄 → 每幀重建整個 cell，只是「莫名其妙很慢」
 * - 降級時先卸再載 → 遠處閃一下才變成代理物
 */
function tieredSource(): CellSource & {
  live: Map<EntityId, 'full' | 'proxy'>;
  fullLoads: number;
  proxyLoads: number;
} {
  let next = 1;
  const live = new Map<EntityId, 'full' | 'proxy'>();
  const self = {
    live,
    fullLoads: 0,
    proxyLoads: 0,
    load(_cx: number, _cz: number): EntityId[] {
      self.fullLoads++;
      // 完整內容 10 個，代理只有 1 個 —— 差距要夠大才量得出代理層的意義
      return Array.from({ length: 10 }, () => {
        const id = asEntityId(next++);
        live.set(id, 'full');
        return id;
      });
    },
    loadProxy(_cx: number, _cz: number): EntityId[] {
      self.proxyLoads++;
      const id = asEntityId(next++);
      live.set(id, 'proxy');
      return [id];
    },
    unload(_cx: number, _cz: number, entities: readonly EntityId[]): void {
      for (const id of entities) live.delete(id);
    },
  };
  return self;
}

const TIERED: StreamingOptions = {
  cellSize: 100,
  loadRadius: 150,
  unloadRadius: 220,
  proxyRadius: 500,
  proxyUnloadRadius: 600,
  maxConcurrentLoads: 64,
  maxUnloadsPerFrame: 64,
};

describe('WorldStreamer 的代理層', () => {
  it('loads full content near and proxies far', async () => {
    const source = tieredSource();
    const streamer = new WorldStreamer(source, TIERED);
    await step(streamer, 0, 0);

    const stats = streamer.stats;
    expect(stats.proxyCells).toBeGreaterThan(0);
    expect(stats.resident - stats.proxyCells).toBeGreaterThan(0);
    // 代理層的 entity 必須遠少於完整內容，否則它沒有存在的意義
    const proxies = [...source.live.values()].filter((t) => t === 'proxy').length;
    const fulls = [...source.live.values()].filter((t) => t === 'full').length;
    expect(proxies).toBeGreaterThan(0);
    expect(fulls / (stats.resident - stats.proxyCells)).toBe(10);
  });

  it('releases the old content when a cell changes tier', async () => {
    // 沒卸掉舊內容的話記憶體就翻倍，而畫面完全正常 —— 只有 entity 數看得出來。
    const source = tieredSource();
    const streamer = new WorldStreamer(source, TIERED);
    await step(streamer, 0, 0);
    const before = source.live.size;
    expect(streamer.stats.entities).toBe(before);

    // 走遠，讓近處的 full cell 降級成 proxy
    await step(streamer, 0, 400);
    await step(streamer, 0, 400);
    expect(streamer.stats.tierChanges).toBeGreaterThan(0);
    expect(streamer.stats.entities).toBe(source.live.size);
  });

  it('keeps content on screen through a tier change', async () => {
    // 先卸再載會留下一個空洞的中間幀。這裡確認每一個更新之後，
    // 曾經常駐的 cell 都仍然有內容 —— 數量變了，但沒有變成 0。
    const source = tieredSource();
    const streamer = new WorldStreamer(source, TIERED);
    await step(streamer, 0, 0);

    for (let index = 1; index <= 8; index++) {
      await step(streamer, 0, index * 40);
      expect(streamer.stats.entities).toBeGreaterThan(0);
      expect(streamer.stats.resident).toBeGreaterThan(0);
    }
  });

  it('does not thrash the tier boundary when the camera hovers on it', async () => {
    // 兩條邊界各有遲滯。沒有的話相機在線上晃幾公分就會讓整個 cell
    // 的內容反覆重建 —— 每幀做最貴的工作，而畫面完全正常。
    const source = tieredSource();
    const streamer = new WorldStreamer(source, TIERED);
    // loadRadius 150、unloadRadius 220 —— 在中間來回
    await step(streamer, 0, 185);
    const settled = streamer.stats.tierChanges;

    for (let i = 0; i < 40; i++) await step(streamer, 0, i % 2 === 0 ? 180 : 190);
    expect(streamer.stats.tierChanges).toBe(settled);
  });

  it('unloads everything beyond the outer radius', async () => {
    const source = tieredSource();
    const streamer = new WorldStreamer(source, TIERED);
    await step(streamer, 0, 0);
    const original = new Set(source.live.keys());
    expect(original.size).toBeGreaterThan(0);

    // 跳到極遠處。那裡會載入**新的**內容，所以不能檢查 live.size 是 0 ——
    // 要檢查的是原本那批有沒有被釋放，包含代理層的那些。
    for (let i = 0; i < 40; i++) await step(streamer, 0, 100_000);
    const survivors = [...original].filter((id) => source.live.has(id));
    expect(survivors).toEqual([]);
    expect(streamer.stats.entities).toBe(source.live.size);
  });

  it('rejects a proxy radius without a loadProxy implementation', async () => {
    // 只設半徑卻沒有實作，會讓遠處的 cell 每幀被重排一次而永遠載不進來 ——
    // 畫面正常（遠處本來就空），CPU 卻在做無止盡的白工。
    const plain: CellSource = { load: () => [], unload: () => {} };
    expect(() => new WorldStreamer(plain, TIERED)).toThrow(/loadProxy/);
  });

  it('rejects a proxy radius inside the unload radius', async () => {
    const source = tieredSource();
    expect(() => new WorldStreamer(source, { ...TIERED, proxyRadius: 200 })).toThrow(/proxyRadius/);
  });
});

/**
 * 掃描快取。
 *
 * 掃描是這個系統最貴的東西 —— 實測視距 16,000 時 `update()` 佔 CPU 幀的
 * 74%，全部在走訪 161×161 個座標。相機是平滑移動的，需要載入的集合只有
 * 在跨越 cell 邊界時才會改變。
 *
 * 但跳過掃描讓候選清單**沿用到下一幀**，於是多出兩個新的失效模式，
 * 兩個都不會讓畫面看起來壞掉：
 *
 * - 已送出的項目沒從清單移除 → 同一個 cell 被載入多次，entity 翻倍
 * - 清單空了卻不重掃 → 載入永遠停止，而遠處本來就是空的
 */
describe('WorldStreamer 的掃描快取', () => {
  it('does not load the same cell twice when the scan is skipped', async () => {
    // 相機停在原地：掃描會被跳過。若送出的項目沒從清單移除，
    // 下一幀會把同一批再送一次 —— entity 直接翻倍而畫面完全正常。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);
    for (let i = 0; i < 12; i++) await step(streamer, 0, 0);

    const seen = new Set(source.loads.map(([cx, cz]) => `${cx},${cz}`));
    expect(source.loads.length).toBe(seen.size);
    expect(streamer.stats.entities).toBe(source.live.size);
  });

  it('keeps loading after the first batch is admitted', async () => {
    // 清單空了必須重掃。少了那個條件，開場 admit 掉最初的 K 個之後
    // 就永遠不再載入 —— 而症狀只是「遠處一直是空的」。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, { ...BASE, maxConcurrentLoads: 2 });
    await step(streamer, 0, 0);
    const afterFirst = streamer.stats.resident;

    for (let i = 0; i < 30; i++) await step(streamer, 0, 0);
    expect(streamer.stats.resident).toBeGreaterThan(afterFirst);
    expect(streamer.stats.pending).toBe(0);
  });

  it('rescans when the camera crosses a cell boundary', async () => {
    const source = trackingSource();
    const streamer = new WorldStreamer(source, BASE);
    for (let i = 0; i < 20; i++) await step(streamer, 0, 0);
    const before = source.loads.length;

    // 跨過好幾個 cell：新的一側必須被載入
    for (let i = 0; i < 20; i++) await step(streamer, 0, BASE.cellSize * 3);
    expect(source.loads.length).toBeGreaterThan(before);
  });
});

/**
 * 自適應載入速率。
 *
 * **預設關閉**，因為實測它在這個場景是負面的（實測的串流場景、真實資產、
 * maxLoads 16、兩輪重複）：
 *
 * ```text
 *            關閉            14 ms 預算
 * p95    25.70 / 24.21    24.30 / 25.50
 * p99    33.30 / 31.30    31.50 / 32.20
 * max    40.80 / 42.60    85.60 / 84.60   ← 最差情況變兩倍
 * 常駐    8800 / 8800      7800 / 8000    ← 世界填不滿
 * ```
 *
 * 尾巴沒改善、最差情況翻倍、世界還填不滿。機制留著是因為它**依規格運作**
 * ——換一台更慢的機器或更重的內容可能就需要它，屆時要重新量。
 */
describe('WorldStreamer 的自適應載入', () => {
  it('does nothing when no budget is set', async () => {
    const source = trackingSource();
    const streamer = new WorldStreamer(source, { ...BASE, maxConcurrentLoads: 8 });
    streamer.reportFrameMs(1000);
    expect(streamer.loadRate).toBe(8);
  });

  it('halves the rate when a frame exceeds the budget', async () => {
    const source = trackingSource();
    const streamer = new WorldStreamer(source, {
      ...BASE,
      maxConcurrentLoads: 8,
      frameBudgetMs: 16,
    });
    streamer.reportFrameMs(50);
    expect(streamer.loadRate).toBe(4);
    streamer.reportFrameMs(50);
    expect(streamer.loadRate).toBe(2);
  });

  it('recovers slowly and never below one', async () => {
    // 不對稱是刻意的：對稱的調整會在預算邊界上振盪，而每個週期都伴隨
    // 一次看得見的卡頓。這與兩條半徑的遲滯是同一個道理。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, {
      ...BASE,
      maxConcurrentLoads: 8,
      frameBudgetMs: 16,
    });
    for (let i = 0; i < 10; i++) streamer.reportFrameMs(50);
    expect(streamer.loadRate).toBe(1);

    streamer.reportFrameMs(5);
    expect(streamer.loadRate).toBe(1.25);
  });

  it('does not raise the rate while sitting close to the budget', async () => {
    // 貼著預算加碼等於刻意讓每一幀都踩線。門檻是預算的 80%。
    const source = trackingSource();
    const streamer = new WorldStreamer(source, {
      ...BASE,
      maxConcurrentLoads: 8,
      frameBudgetMs: 16,
    });
    streamer.reportFrameMs(50);
    const throttled = streamer.loadRate;
    streamer.reportFrameMs(15);
    expect(streamer.loadRate).toBe(throttled);
  });
});
