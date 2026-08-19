import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Matrix4, Vector3 } from 'three';
import { DistanceFieldVolume } from './distance-field-gi.ts';
import { GlobalDistanceField } from './global-distance-field.ts';

/** 一個放在指定位置的盒子距離場。 */
function boxAt(x: number, y: number, z: number): { volume: DistanceFieldVolume; matrixWorld: Matrix4 } {
  return {
    volume: new DistanceFieldVolume(new BoxGeometry(10, 10, 10), { resolution: 16, padding: 0.5 }),
    matrixWorld: new Matrix4().makeTranslation(x, y, z),
  };
}

/** 一直跑到場算完為止。 */
function settle(field: GlobalDistanceField, camera: Vector3): number {
  let frames = 0;
  while (field.pendingCells > 0 && frames < 500) {
    field.update(camera);
    frames++;
  }
  return frames;
}

describe('全域距離場：把很多個合成一個', () => {
  it('合成之後拿到的是**最近的那一個**', () => {
    // 距離場合成的定義就是取 min。取錯（例如取平均）的話遠處的東西會把近處
    // 的距離拉大，光線就會一步跨過近處那個物件 —— 而症狀是遮蔽時有時無。
    const field = new GlobalDistanceField({ resolution: 16, extent: 200 });
    field.add(boxAt(-40, 0, 0));
    field.add(boxAt(40, 0, 0));
    settle(field, new Vector3(0, 0, 0));

    // 靠近左邊那個盒子時，距離要跟著左邊那個走。
    const nearLeft = field.distanceAt(new Vector3(-30, 0, 0));
    const middle = field.distanceAt(new Vector3(0, 0, 0));
    expect(nearLeft).toBeLessThan(middle);
  });

  it('盒子裡面是負的、空曠處是正的（格子要比盒子細）', () => {
    // 一格 200/16 = 12.5 比盒子（10）還大的話，格心全落在盒子外面 —— 那個
    // 盒子在這份場裡等於不存在。那是解析度的本質，而 `add` 會為此警告。
    const field = new GlobalDistanceField({ resolution: 32, extent: 100 });
    field.add(boxAt(0, 0, 0));
    settle(field, new Vector3(0, 0, 0));
    expect(field.distanceAt(new Vector3(0, 0, 0))).toBeLessThan(0);
    expect(field.distanceAt(new Vector3(80, 0, 0))).toBeGreaterThan(0);
  });

  it('**另一個物件**也擋得住光 —— 這是單一物件的場做不到的', () => {
    // 這一條是整個類別存在的理由。單一物件的場只知道自己，所以一個站在
    // 旁邊的東西擋不擋得住它完全不知道。
    const field = new GlobalDistanceField({ resolution: 24, extent: 200 });
    field.add(boxAt(0, 0, 0));
    settle(field, new Vector3(0, 0, 0));

    const from = new Vector3(30, 0, 0);
    const toward = field.occlusionAlong(from, new Vector3(-1, 0, 0), 60);
    const away = field.occlusionAlong(from, new Vector3(1, 0, 0), 60);
    expect(toward).toBeGreaterThan(away);
  });

  it('分幀算 —— 一次算完會是一次看得見的卡頓', () => {
    const field = new GlobalDistanceField({ resolution: 16, extent: 200, budget: 256 });
    field.add(boxAt(0, 0, 0));
    const built = field.update(new Vector3(0, 0, 0));
    expect(built).toBe(256);
    expect(field.pendingCells).toBeGreaterThan(0);
  });

  it('相機沒動就不重算', () => {
    const field = new GlobalDistanceField({ resolution: 16, extent: 200 });
    field.add(boxAt(0, 0, 0));
    const camera = new Vector3(5, 0, 5);
    settle(field, camera);
    expect(field.update(camera)).toBe(0);
  });

  it('相機動不到一格就不重算 —— 對齊整數格的理由', () => {
    // 不對齊的話相機動一點點所有格子的世界座標就全變了，增量等於沒做。
    const field = new GlobalDistanceField({ resolution: 16, extent: 200 });
    field.add(boxAt(0, 0, 0));
    const camera = new Vector3(0, 0, 0);
    settle(field, camera);
    // 一格是 200/16 = 12.5，動 1 個單位不該觸發。
    expect(field.update(new Vector3(1, 0, 0))).toBe(0);
    // 動一整格就要。
    expect(field.update(new Vector3(13, 0, 0))).toBeGreaterThan(0);
  });

  it('加東西進去會讓場重算', () => {
    const field = new GlobalDistanceField({ resolution: 16, extent: 200 });
    field.add(boxAt(0, 0, 0));
    settle(field, new Vector3(0, 0, 0));
    expect(field.pendingCells).toBe(0);
    field.add(boxAt(40, 0, 0));
    expect(field.pendingCells).toBeGreaterThan(0);
  });

  it('物件比一格還小的時候會警告 —— 否則它靜靜地不擋光', () => {
    // 全域場是低頻的：一格只存一個距離。物件比一格小的話格心會全部落在
    // 它外面 —— 那個物件在這份場裡等於不存在，而畫面上看不出原因。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const field = new GlobalDistanceField({ resolution: 8, extent: 400 });
    field.add(boxAt(0, 0, 0));
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("比一格");
    warn.mockRestore();
  });

  it('物件夠大的時候不會亂吼', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const field = new GlobalDistanceField({ resolution: 32, extent: 100 });
    field.add(boxAt(0, 0, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('場外面的物件不會被當成貼在邊緣', () => {
    // 直接查一個遠在場外的物件會被夾到邊緣值，而邊緣值對遠處是嚴重低估 ——
    // 看起來像那裡有東西擋著，畫面上是憑空多出來的陰影。
    const field = new GlobalDistanceField({ resolution: 16, extent: 200 });
    field.add(boxAt(500, 0, 0));
    settle(field, new Vector3(0, 0, 0));
    // 原點附近應該是空曠的。
    expect(field.distanceAt(new Vector3(0, 0, 0))).toBeGreaterThan(50);
  });
});
