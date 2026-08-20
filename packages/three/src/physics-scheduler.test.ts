import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { PhysicsScheduler, type PhysicsSchedulerOptions } from './physics-scheduler.ts';

/**
 * 調度的失效方式都是**看不見**的：該算的沒算（穿過地板）、不該算的在算
 * （幀時間變差但畫面正常）、邊界上反覆進出（每幀做最貴的工作）。
 *
 * 所以測試驗的是「誰在裡面」，不是「有沒有跑完」。
 */

function make(options: Partial<PhysicsSchedulerOptions> = {}): {
  scheduler: PhysicsScheduler;
  live: Set<number>;
} {
  const live = new Set<number>();
  const scheduler = new PhysicsScheduler({
    activeRadius: 100,
    onActivate: (id) => live.add(id),
    onDeactivate: (id) => live.delete(id),
    ...options,
  });
  return { scheduler, live };
}

describe('物理調度', () => {
  it('範圍內的進求解器，範圍外的不進', () => {
    const { scheduler, live } = make();
    scheduler.add(1, 0, 0, 0);
    scheduler.add(2, 50, 0, 0);
    scheduler.add(3, 500, 0, 0);

    scheduler.update(new Vector3(0, 0, 0));
    expect([...live].sort()).toEqual([1, 2]);
  });

  it('邊界上不會每幀進進出出 —— 建立剛體是求解器裡最貴的操作', () => {
    // 進出用同一條線的話，站在邊界上就是每幀加入又移除。畫面完全正常，
    // 只是每幀都在做最貴的工作。串流那邊踩過同一個坑。
    const { scheduler, live } = make({ activeRadius: 100, sleepRadius: 150 });
    scheduler.add(1, 120, 0, 0);

    // 120 在啟用線外 → 不進。
    scheduler.update(new Vector3(0, 0, 0));
    expect(live.has(1)).toBe(false);

    // 走近到 90 → 進。
    scheduler.update(new Vector3(30, 0, 0));
    expect(live.has(1)).toBe(true);

    // 退回原處：120 仍在**睡眠線**內，所以留著，不是一出線就踢掉。
    scheduler.update(new Vector3(0, 0, 0));
    expect(live.has(1)).toBe(true);

    // 真的走遠才踢。
    scheduler.update(new Vector3(-40, 0, 0));
    expect(live.has(1)).toBe(false);
  });

  it('超過預算時留最近的，而且說得出被擋了幾個', () => {
    // 沒有上限的話，走進密集區會有幾千個剛體同時進求解器，那一幀直接卡住。
    const { scheduler, live } = make({ maxActive: 2 });
    scheduler.add(1, 10, 0, 0);
    scheduler.add(2, 20, 0, 0);
    scheduler.add(3, 30, 0, 0);
    scheduler.add(4, 40, 0, 0);

    scheduler.update(new Vector3(0, 0, 0));
    expect([...live].sort()).toEqual([1, 2]);
    // 悶著擋掉是最糟的 —— 開發者無從得知預算不夠。
    expect(scheduler.stats.deferred).toBe(2);
  });

  it('東西移動之後用新位置判斷', () => {
    const { scheduler, live } = make();
    scheduler.add(1, 500, 0, 0);
    scheduler.update(new Vector3(0, 0, 0));
    expect(live.has(1)).toBe(false);

    scheduler.move(1, 10, 0, 0);
    scheduler.update(new Vector3(0, 0, 0));
    expect(live.has(1)).toBe(true);
  });

  it('移除時若還在求解器裡要先通知 —— 不然那個剛體會變成孤兒', () => {
    const { scheduler, live } = make();
    scheduler.add(1, 0, 0, 0);
    scheduler.update(new Vector3(0, 0, 0));
    expect(live.has(1)).toBe(true);

    scheduler.remove(1);
    // 沒通知的話，那個剛體會永遠留在求解器裡，而沒有任何東西記得它。
    expect(live.has(1)).toBe(false);
    expect(scheduler.stats.tracked).toBe(0);
  });

  it('壓洞之後其餘的 id 仍然對得上自己的位置', () => {
    // 用最後一個填洞是為了維持緊密排列，但填錯的話某個 id 會拿到別人的
    // 座標 —— 而症狀是「有東西在錯的地方有碰撞」，畫面上完全看不出來。
    const { scheduler, live } = make({ activeRadius: 15 });
    scheduler.add(1, 0, 0, 0);
    scheduler.add(2, 1000, 0, 0);
    scheduler.add(3, 10, 0, 0);

    scheduler.remove(1); // 3 會被搬到 1 的位置
    scheduler.update(new Vector3(0, 0, 0));

    // 3 在 10 的地方，仍然該在範圍內；2 在 1000，不該。
    expect([...live].sort()).toEqual([3]);
  });

  it('原點重定位時位置跟著搬 —— 與渲染同一個洞', () => {
    // 不搬的話世界搬過去之後物理還在用舊座標判斷距離：腳邊的不算、
    // 幾百單位外的在算。而畫面完全正常，因為畫面是另一套座標。
    const { scheduler, live } = make();
    scheduler.add(1, 5000, 0, 0);

    scheduler.update(new Vector3(5000, 0, 0));
    expect(live.has(1)).toBe(true);

    // 世界搬回原點：物件與焦點都平移 -5000。
    scheduler.translateInstances(new Vector3(-5000, 0, 0));
    scheduler.update(new Vector3(0, 0, 0));
    // 相對關係沒變，所以它必須還在。
    expect(live.has(1)).toBe(true);
  });

  it('睡眠半徑至少比啟用半徑大一點 —— 給得太近等於沒有遲滯', () => {
    const { scheduler, live } = make({ activeRadius: 100, sleepRadius: 100 });
    scheduler.add(1, 99, 0, 0);
    scheduler.update(new Vector3(0, 0, 0));
    expect(live.has(1)).toBe(true);

    // 99 → 剛好在 100 外一點點。有下限的話它還不該被踢掉。
    scheduler.update(new Vector3(-2, 0, 0));
    expect(live.has(1)).toBe(true);
  });
});
