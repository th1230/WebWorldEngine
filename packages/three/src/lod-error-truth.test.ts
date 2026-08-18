import { BufferAttribute, BufferGeometry, IcosahedronGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { generateLodLevels } from './lod-generation.ts';
import { sphericalLodErrors } from './spherical-error.ts';

/**
 * 品質契約整個建立在「每一階的誤差」那個數字上，所以那個數字必須是**上界**。
 *
 * ## 這裡守的是什麼
 *
 * 契約寫的是「被選中的階，幾何誤差投影到螢幕 ≤ `errorPixels`（預設 2 像素）」。
 * 選階比的是 `errors[level] * perMetre`。**只要 `errors` 偏小，契約就是假的**
 * ——而且不會有任何東西報錯，只是畫面比宣稱的糊。
 *
 * 所以這一支拿有封閉解的幾何（icosphere，頂點都在同一顆球上）當標準答案，
 * 檢查回報值不低於它。
 *
 * ## 為什麼會有這一支：它抓到過一次
 *
 * 原本的實作直接用 meshoptimizer `simplify()` 回傳的誤差。那是**估計值，不是
 * 上界**，實測每一階都低估：
 *
 * | 產生的階 | meshopt 說 | 真值（矢高） | |
 * | ---: | ---: | ---: | --- |
 * | 250 面 | 0.0385 | 0.0556 | 低估 1.44 倍 |
 * | 124 面 | 0.0599 | 0.0672 | 低估 1.12 倍 |
 * | 50 面 | 0.1408 | 0.2079 | **低估 1.48 倍** |
 * | 20 面 | 0.3344 | 0.3779 | 低估 1.13 倍 |
 * | 12 面 | 0.3932 | 0.5305 | 低估 1.35 倍 |
 *
 * 也就是實際的契約一直是「≤ 大約 3 像素」而不是宣稱的 2 像素。
 *
 * ## 這是怎麼被發現的
 *
 * 不是靠讀程式碼。量到「鏈見底」之後（99.7% 的 instance 掛在最粗階，接一階
 * 更粗的下去 GPU 時間掉 61%），試著讓引擎自動接長鏈 —— 然後 `visual-check`
 * 紅了：多畫 0.769% 對門檻 0.45%。
 *
 * 先怪自己湊誤差的方式（拿「最粗階的誤差 + 新產生的誤差」相加），改成從第 0
 * 階直接產生、完全不湊之後**還是紅的**，才回頭去問那個數字本身準不準。
 *
 * ## 修法不是乘一個安全係數
 *
 * 1.12–1.48 這個範圍是**這一種幾何**量出來的。乘 1.5 會讓所有內容都保守，
 * 那是拿所有人的效能換一個沒有證明過的常數。
 *
 * 現在是真的去量（`geometric-error.ts`）：原始頂點到簡化表面的最大距離，
 * 用空間格把它壓到 O(頂點數)。
 */
describe('自動產生的 LOD 誤差與真值的關係', () => {
  it('回報的誤差不低於真值 —— 低估就是靜靜違反品質契約', async () => {
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
      // 矢高差是一個**下界**：它比的是兩階各自的矢高之差，而輪廓是由頂點
      // 決定的，所以真正的表面偏離比它大。回報值低於它就一定是錯的。
      const lowerBound = sphericalLodErrors([level0, simplified])[1]!;
      ratios.push(level.error / lowerBound);
    }

    // 每一階都不低於下界。**低估是危險的方向** —— 選到太粗的階，畫面比
    // 宣稱的糊，而沒有任何東西會報錯。
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThanOrEqual(1);
    }

    // 也不能保守到沒用：高估太多等於永遠挑太細的階，把效能白白丟掉。
    // 實測落在 1.0–1.3 倍。
    expect(Math.max(...ratios)).toBeLessThan(1.6);
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
