import { describe, expect, it } from 'vitest';
import { PageTable, virtualTextureSize } from './virtual-texture.ts';

describe('虛擬貼圖的頁表', () => {
  it('假裝出來的解析度可以超過硬體上限，實體的沒有', () => {
    // 這是整個東西存在的理由。不是「比較快」，是**單張貼圖配置不出來**。
    const size = virtualTextureSize({ pageSize: 128, pagesPerSide: 1024, atlasPages: 16 });
    expect(size.virtualSize).toBe(131072);
    expect(size.atlasSize).toBe(2048);
    // 常見的硬體上限是 16384。
    expect(size.virtualSize).toBeGreaterThan(16384);
    expect(size.atlasSize).toBeLessThanOrEqual(16384);
  });

  it('pagesPerSide 不是 2 的次方直接擋下來', () => {
    // 不是的話 mip 每一階的邊界對不齊，回退就查到隔壁頁 —— 而症狀是接縫處
    // 出現別的地方的內容，看起來像貼圖壞掉而不是像設定錯。
    expect(() => new PageTable({ pagesPerSide: 12 })).toThrow('2 的次方');
  });

  it('一開始每一格都指到最粗那一階 —— 糊，但畫得出來', () => {
    // 沒有這條保證的話，還沒載到任何東西的那一瞬間著色器會查到垃圾。
    const table = new PageTable({ pagesPerSide: 8, atlasPages: 4 });
    for (const [px, py] of [
      [0, 0],
      [3, 5],
      [7, 7],
    ] as const) {
      const at = table.lookup(px, py);
      expect(at.level).toBe(table.levels - 1);
      expect(at.slotX).toBe(0);
      expect(at.slotY).toBe(0);
    }
  });

  it('要到的頁搬進來之後，那一格就指到細的', () => {
    const table = new PageTable({ pagesPerSide: 8, atlasPages: 4 });
    table.request(0, 3, 5);
    const loads = table.commit();
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ level: 0, px: 3, py: 5 });

    const at = table.lookup(3, 5);
    expect(at.level).toBe(0);
    // 隔壁沒要，所以還是回退到最粗那階。
    expect(table.lookup(4, 5).level).toBe(table.levels - 1);
  });

  it('中間階住著的話回退停在中間，不會一路掉到最粗', () => {
    // 回退要找**最好的**祖先，不是最差的。找最差的話畫面會比實際擁有的糊，
    // 而那是白白浪費已經搬進來的頁。
    const table = new PageTable({ pagesPerSide: 8, atlasPages: 4 });
    table.request(1, 1, 2); // 蓋住最細階的 (2..3, 4..5)
    table.commit();

    const at = table.lookup(2, 4);
    expect(at.level).toBe(1);
    // 不在那一頁蓋住的範圍內就還是最粗。
    expect(table.lookup(6, 4).level).toBe(table.levels - 1);
  });

  it('預算限制一次搬幾頁', () => {
    // 一次搬完是一次看得見的卡頓；分次搬那幾幀是糊的，而糊是安全的。
    const table = new PageTable({ pagesPerSide: 8, atlasPages: 4 });
    for (let i = 0; i < 6; i++) table.request(0, i, 0);
    expect(table.commit(2)).toHaveLength(2);
    expect(table.commit(2)).toHaveLength(0); // 登記在 commit 時清掉，要重新要
  });

  it('圖集滿了會踢掉最久沒用的', () => {
    const table = new PageTable({ pagesPerSide: 8, atlasPages: 2 }); // 4 格，一格釘住
    table.request(0, 0, 0);
    table.commit();
    table.request(0, 1, 0);
    table.commit();
    table.request(0, 2, 0);
    table.commit();
    expect(table.residentCount).toBe(4);

    // (0,0) 最久沒被要到，所以它該被踢掉。
    table.request(0, 1, 0);
    table.request(0, 2, 0);
    table.commit();
    table.request(0, 3, 0);
    table.commit();

    expect(table.lookup(0, 0).level).toBe(table.levels - 1); // 掉回粗階
    expect(table.lookup(3, 0).level).toBe(0);
  });

  it('這一輪要用的頁不會被踢掉 —— 否則會來回搬同樣那幾頁', () => {
    // 顛簸的症狀是「畫面一直糊而且一直在載入」，比少載幾頁糟得多。
    const table = new PageTable({ pagesPerSide: 8, atlasPages: 2 }); // 3 格可用
    for (let i = 0; i < 6; i++) table.request(0, i, 0);
    const loads = table.commit(10);
    // 只有 3 格可用，所以最多搬 3 頁 —— 而不是搬 6 頁把自己踢光。
    expect(loads.length).toBeLessThanOrEqual(3);
    expect(loads.length).toBeGreaterThan(0);
  });

  it('釘住的那一頁永遠不會被踢掉 —— 它是回退鏈的底', () => {
    // ## 這條測試原本驗不到東西
    //
    // 第一版只檢查「還查得到一個階數」，而回退鏈斷掉時 `rebuildIndirection`
    // 會退回 slot 0 —— 階數看起來正常，指到的卻是別人的頁。也就是**畫面上
    // 是垃圾而數字上完全正常**。
    //
    // 把「釘住」改成不釘（真的去改原始碼試），11 條照樣全綠。所以改成檢查
    // 第四個位元組：0 代表這一格沒有任何祖先住著。
    const table = new PageTable({ pagesPerSide: 16, atlasPages: 2 });
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 4; i++) table.request(0, (round * 4 + i) % 16, round % 16);
      table.commit(4);
    }
    // 折騰 20 輪之後，每一格都還要找得到祖先。
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        expect(table.indirection[(py * 16 + px) * 4 + 3]).toBe(255);
      }
    }
  });

  it('每一格都有東西可以指 —— 頁表裡沒有洞', () => {
    // 有洞的話那幾個 fragment 讀到的是未初始化的記憶體，畫面上是雜訊。
    const table = new PageTable({ pagesPerSide: 8, atlasPages: 4 });
    table.request(0, 1, 1);
    table.commit();
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        expect(table.indirection[(py * 8 + px) * 4 + 3]).toBe(255);
      }
    }
  });

  it('超出範圍的請求安靜忽略，不會壞掉頁表', () => {
    const table = new PageTable({ pagesPerSide: 8, atlasPages: 4 });
    table.request(0, -1, 0);
    table.request(0, 99, 0);
    table.request(99, 0, 0);
    expect(table.commit()).toHaveLength(0);
    expect(table.residentCount).toBe(1);
  });
});
