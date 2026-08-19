import { describe, expect, it } from 'vitest';
import { DataTexture, MeshBasicMaterial, NearestFilter, RGBAFormat, UnsignedByteType } from 'three';
import { VirtualTexture } from './virtual-texture.ts';

/** 一頁純色，顏色由階數決定 —— 測試要靠它分辨圖集裡裝的是誰。 */
function solid(level: number, size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = 10 + level * 10;
    data[i * 4 + 1] = 200;
    data[i * 4 + 2] = 100;
    data[i * 4 + 3] = 255;
  }
  return data;
}

const make = (over: Partial<{ pagesPerSide: number; pageSize: number; atlasPages: number; border: number }> = {}) =>
  new VirtualTexture({
    pageSize: over.pageSize ?? 16,
    pagesPerSide: over.pagesPerSide ?? 16,
    atlasPages: over.atlasPages ?? 4,
    border: over.border ?? 2,
    page: (level, _px, _py, size) => solid(level, size),
  });

describe('虛擬貼圖', () => {
  it('假裝出來的解析度是頁數乘頁的大小', () => {
    const vt = make({ pageSize: 64, pagesPerSide: 512 });
    expect(vt.virtualSize).toBe(32768);
    expect(vt.atlas.image.width).toBe(64 * 4);
    vt.dispose();
  });

  it('頁表必須是 NEAREST', () => {
    // ## 這是一條屬性檢查，不是畫面檢查 —— 而那件事要說清楚
    //
    // 內插兩個頁位址會得到第三個不存在的位址，畫面上是隨機碎塊。但那個症狀
    // **只出現在頁邊界的一個 texel 之內**：512 頁的配置下，一頁跨 64 個頁表
    // texel，所以錯誤的帶寬是 1/512 的 UV —— 在任何實用解析度下都是次像素。
    //
    // 也就是說畫面關卡**構不到它**（實測：把它改成 LINEAR，關卡十一條全過）。
    // 硬去取那一個像素會變成一條 ±1 px 的斷言，而那種會隨機紅的關卡不算關卡
    // （doctrine 第 17 條）。所以這裡誠實地驗屬性，並且說明為什麼只能驗屬性。
    const vt = make();
    expect(vt.indirection.minFilter).toBe(NearestFilter);
    expect(vt.indirection.magFilter).toBe(NearestFilter);
    vt.dispose();
  });

  it('圖集不做 mipmap —— 相鄰兩格是不相干的兩頁', () => {
    // 做了的話遠處會出現兩塊不相干的內容糊在一起的顏色。
    const vt = make();
    expect(vt.atlas.generateMipmaps).toBe(false);
    expect(vt.indirection.generateMipmaps).toBe(false);
    vt.dispose();
  });

  it('最粗那一頁在建構的當下就搬進圖集了', () => {
    // 頁表建構時就把它標成住著的（它是回退鏈的底），但那只是登記 —— 不主動
    // 搬的話圖集那一格是全 0，而還沒載細頁時整張畫面就是黑的。
    // 那個黑跟「shader 沒編譯成功」長得一模一樣。
    const vt = make();
    const data = vt.atlas.image.data as Uint8Array;
    expect(data[0]).toBe(10 + (vt.table.levels - 1) * 10);
    expect(data[3]).toBe(255);
    expect(vt.pagesLoaded).toBe(1);
    vt.dispose();
  });

  it('搬進來的頁寫在圖集裡對的那一格', () => {
    const vt = make();
    vt.request(0, 5, 7);
    expect(vt.update()).toBe(1);
    // 第 0 格是釘住的根，所以這一頁去第 1 格。
    const size = vt.table.pageSize;
    const atlasWidth = vt.atlas.image.width;
    const data = vt.atlas.image.data as Uint8Array;
    expect(data[size * 4]).toBe(10); // 第 1 格的左上角，level 0
    // 而根那一格沒有被蓋掉。
    expect(data[0]).toBe(10 + (vt.table.levels - 1) * 10);
    expect(atlasWidth).toBe(size * vt.table.atlasPages);
    vt.dispose();
  });

  it('沒有 map 的材質直接擋下來，不要等 shader 編不過', () => {
    // 取樣接在 <map_fragment> 上，而 Three 只有在有 map 時才宣告 vMapUv。
    // 沒擋的話失敗的樣子是畫面全黑加主控台一行紅字。
    const vt = make();
    expect(() => vt.apply(new MeshBasicMaterial())).toThrow('沒有 map');
    vt.dispose();
  });

  it('有 map 就接得上，而且會標記材質要重編', () => {
    const vt = make();
    const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    const material = new MeshBasicMaterial({ map });
    expect(() => vt.apply(material)).not.toThrow();
    expect(material.version).toBeGreaterThan(0);
    vt.dispose();
  });

  it('邊比頁還寬直接擋下來', () => {
    expect(() => make({ pageSize: 8, border: 4 })).toThrow('吃掉了整頁');
  });

  it('requestRegion 把一塊 UV 換成那一階的所有頁', () => {
    const vt = make({ pagesPerSide: 16, atlasPages: 8 });
    // 第 1 階一邊 8 頁（一頁 0.125 寬）。[0.01, 0.2] 蓋到第 0 與第 1 頁，
    // 兩個方向都是 —— 4 頁。
    vt.requestRegion(0.01, 0.01, 0.2, 0.2, 1);
    expect(vt.update(16)).toBe(4);

    // 邊界剛好落在頁的接縫上時**往外多要一頁**，那是刻意的：少要的話
    // 接縫那一條會用粗階畫，而那正好是最容易被看見的地方。
    const edge = make({ pagesPerSide: 16, atlasPages: 8 });
    edge.requestRegion(0, 0, 0.25, 0.25, 1);
    expect(edge.update(16)).toBe(9);
    edge.dispose();
    vt.dispose();
  });

  it('頁給得不夠大直接講清楚 —— 而且是在建構的當下', () => {
    // 少給的話 blit 會讀到 undefined，而 set() 把它變成 0 —— 畫面上是一條
    // 黑邊，看起來像 UV 算錯而不是像資料短少。
    //
    // 根頁在建構時就搬，所以錯的 provider **當場**就爆，不必等到第一次
    // 有人要細頁。早一點爆比較好：那時候堆疊上還看得到是誰建的。
    expect(
      () =>
        new VirtualTexture({
          pageSize: 16,
          pagesPerSide: 4,
          atlasPages: 4,
          page: () => new Uint8Array(10),
        }),
    ).toThrow('位元組');
  });
});
