import { BufferAttribute, BufferGeometry, IcosahedronGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { generateLodLevels } from './lod-generation.ts';
import { sphericalLodErrors } from './spherical-error.ts';

/**
 * 簡化器回報的誤差**不是真正的上界**，而整個品質契約建立在它上面。
 *
 * ## 為什麼這件事非寫成測試不可
 *
 * 契約寫的是「被選中的階，幾何誤差投影到螢幕 ≤ `errorPixels`（預設 2 像素）」。
 * 選階時比的是 `errors[level] * perMetre`，而那個 `errors` 對自動產生的階來說
 * 就是 meshoptimizer 回報的數字。
 *
 * 那個數字是**估計值**，不是最大位移的保證上界。實測（icosphere，真值用矢高
 * 算 —— 這類幾何的頂點都在同一顆球上，所以有封閉解）：
 *
 * | 產生的階 | meshopt 說 | 真值（矢高） | |
 * | ---: | ---: | ---: | --- |
 * | 250 面 | 0.0385 | 0.0556 | 低估 1.44 倍 |
 * | 124 面 | 0.0599 | 0.0672 | 低估 1.12 倍 |
 * | 50 面 | 0.1408 | 0.2079 | **低估 1.48 倍** |
 * | 20 面 | 0.3344 | 0.3779 | 低估 1.13 倍 |
 * | 12 面 | 0.3932 | 0.5305 | 低估 1.35 倍 |
 *
 * **每一階都低估。** 所以實際的契約是「≤ 大約 3 像素」，不是宣稱的 2 像素。
 *
 * ## 這是怎麼被發現的
 *
 * 不是靠讀程式碼。量到「鏈見底」之後（99.7% 的 instance 掛在最粗階，接一階
 * 更粗的下去 GPU 時間掉 61%），試著讓引擎自動接長鏈 —— 然後 `visual-check`
 * 紅了：多畫 0.769% 對門檻 0.45%。
 *
 * 一開始以為是自己把誤差湊錯了（拿「最粗階的誤差 + 新產生的誤差」相加）。
 * 改成從第 0 階直接產生、完全不湊之後**還是紅的**，才回頭去問那個數字本身
 * 準不準。
 *
 * ## 為什麼不直接乘一個安全係數了事
 *
 * 因為 1.12–1.48 這個範圍是**這一種幾何**量出來的。乘 1.5 會讓所有內容都
 * 保守，而那是拿所有人的效能去換一個沒有證明過的常數。
 *
 * 真正的修法是自己量：把產生出來的階與第 0 階做一次幾何比對，取真正的最大
 * 位移。那要在 worker 裡做，是一件獨立的工作。
 *
 * ## 這個測試在守什麼
 *
 * 它**不主張低估是對的**，它主張「低估這件事是已知的、有數字的」。哪天
 * meshopt 換演算法、或我們改成自己量，這裡會紅 —— 那時候要更新的是契約的
 * 說法，不是把測試刪掉。
 */
describe('自動產生的 LOD 誤差與真值的關係', () => {
  it('meshopt 回報的誤差目前是低估的，而契約建立在它上面', async () => {
    const level0 = new IcosahedronGeometry(1, 4);
    const position = level0.getAttribute('position');

    const levels = await generateLodLevels(
      {
        attributes: {
          position: { array: new Float32Array(position.array), itemSize: 3 },
        },
        indices: null,
      },
      { maxRelativeError: 0.5 },
    );
    expect(levels.length).toBeGreaterThan(0);

    const ratios: number[] = [];
    for (const level of levels) {
      const simplified = new BufferGeometry();
      simplified.setAttribute(
        'position',
        new BufferAttribute(level.attributes['position']!.array, 3),
      );
      simplified.setIndex(new BufferAttribute(level.indices, 1));

      // 真值：這一階的面心離球面最遠有多遠。`sphericalLodErrors` 只對
      // 「頂點都在同一顆球上」的幾何成立 —— 簡化只會塌陷到既有的頂點，
      // 所以產生出來的階仍然滿足這個條件。
      const truth = sphericalLodErrors([level0, simplified])[1]!;
      ratios.push(truth / level.error);
    }

    // 每一階都低估 —— 這不是零星的誤差，是系統性的方向。
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThan(1);
    }

    // 而且低估的幅度是有界的（實測最多 1.48 倍）。超過 2 倍的話「≤ 2 像素」
    // 就變成「≤ 4 像素以上」，那個落差大到必須先修這裡再談別的。
    expect(Math.max(...ratios)).toBeLessThan(2);
  });

  it('不會產生塌成空的階 —— 那會讓物件在遠處整個消失', async () => {
    const level0 = new IcosahedronGeometry(1, 4);
    const position = level0.getAttribute('position');

    // 誤差上限放到 1.0 時，簡化器會一路把網格塌到什麼都不剩。實測 icosphere
    // 接到第 4 階是 **0 個三角形** —— 那一階完全合法地留在鏈裡，然後在夠遠
    // 的距離被選中，於是整個物件消失。沒有錯誤、沒有警告。
    const levels = await generateLodLevels(
      {
        attributes: {
          position: { array: new Float32Array(position.array), itemSize: 3 },
        },
        indices: null,
      },
      { ratios: [0.5, 0.5, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4], maxRelativeError: 1 },
    );

    for (const level of levels) {
      // 少於 4 個三角形圍不出體積，從任何角度看都是一片或一條。
      expect(level.indices.length / 3).toBeGreaterThanOrEqual(4);
    }
  });
});
