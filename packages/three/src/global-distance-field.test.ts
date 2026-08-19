import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Matrix4, Vector3 } from 'three';
import { DistanceFieldVolume } from './distance-field-gi.ts';
import { GlobalDistanceField } from './global-distance-field.ts';
import { IrradianceVolume } from './irradiance.ts';

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

describe('全域距離場：追蹤回傳的是顏色，不只是擋不擋', () => {
  /** 一個有顏色的盒子。 */
  function colouredBox(
    x: number,
    y: number,
    z: number,
    albedo: [number, number, number],
  ): { volume: DistanceFieldVolume; matrixWorld: Matrix4 } {
    return {
      volume: new DistanceFieldVolume(new BoxGeometry(10, 10, 10), {
        resolution: 16,
        padding: 0.5,
        albedo,
      }),
      matrixWorld: new Matrix4().makeTranslation(x, y, z),
    };
  }

  /** 到處都一樣亮的白光，讓測試量到的差別只可能來自表面。 */
  const whiteLight = (): Vector3 => new Vector3(1, 1, 1);

  it('打到紅牆回來的是紅光 —— 這是整件事的重點', () => {
    // 只有遮蔽的話一面紅牆與一面白牆是一樣的。有顏色才叫反彈。
    const field = new GlobalDistanceField({ resolution: 32, extent: 100 });
    field.add(colouredBox(0, 0, -20, [1, 0, 0]));
    settle(field, new Vector3(0, 0, 0));

    const light = field.radianceAlong(new Vector3(0, 0, 0), new Vector3(0, 0, -1), whiteLight);
    expect(light.x).toBeGreaterThan(0.5);
    expect(light.y).toBeLessThan(0.1);
    expect(light.z).toBeLessThan(0.1);
  });

  it('同一點、不同方向，顏色不一樣', () => {
    // 兩邊一樣的話它就只是一個環境色常數 —— 那沒有用。
    const field = new GlobalDistanceField({ resolution: 32, extent: 100 });
    field.add(colouredBox(0, 0, -20, [1, 0, 0]));
    field.add(colouredBox(0, 0, 20, [0, 0, 1]));
    settle(field, new Vector3(0, 0, 0));

    const back = field.radianceAlong(new Vector3(0, 0, 0), new Vector3(0, 0, -1), whiteLight, 40);
    const front = field.radianceAlong(new Vector3(0, 0, 0), new Vector3(0, 0, 1), whiteLight, 40, new Vector3());
    expect(back.x).toBeGreaterThan(back.z);
    expect(front.z).toBeGreaterThan(front.x);
  });

  it('射向空的地方回來是 0，不是黑色的表面', () => {
    // 差別是實質的：0 代表那個方向沒有東西（該由天空補），黑色的表面代表
    // 那裡有東西而且不反光。混在一起的話天空會被吃掉。
    const field = new GlobalDistanceField({ resolution: 32, extent: 100 });
    field.add(colouredBox(0, 0, -20, [1, 0, 0]));
    settle(field, new Vector3(0, 0, 0));

    const up = field.radianceAlong(new Vector3(0, 0, 0), new Vector3(0, 1, 0), whiteLight, 20);
    expect(up.length()).toBeCloseTo(0, 5);
  });

  it('那一點越亮，反彈回來的越多 —— 反照率乘的是收到的光', () => {
    // 存反照率而不是存算好的光照，理由就在這裡：光變了這份快取不用重烘，
    // 乘一次就跟上了。
    const field = new GlobalDistanceField({ resolution: 32, extent: 100 });
    field.add(colouredBox(0, 0, -20, [1, 1, 1]));
    settle(field, new Vector3(0, 0, 0));

    const dim = field.radianceAlong(new Vector3(0, 0, 0), new Vector3(0, 0, -1), () => new Vector3(0.2, 0.2, 0.2));
    const bright = field.radianceAlong(
      new Vector3(0, 0, 0),
      new Vector3(0, 0, -1),
      () => new Vector3(1, 1, 1),
      25,
      new Vector3(),
    );
    expect(bright.x).toBeGreaterThan(dim.x * 3);
  });

  it('接得上真的探針體積 —— 兩半合起來才是一次反彈', () => {
    // 這一條測的是**介面對得上**，不是數學。分開寫的兩個東西各自測過還是
    // 可能接不起來（一個吃法線一個不吃、一個回 Color 一個回 Vector3），而
    // 那種錯只有真的接一次才看得到。
    const probes = new IrradianceVolume({
      min: new Vector3(-50, -50, -50),
      size: new Vector3(100, 100, 100),
      resolution: [2, 2, 2],
    });
    // 均勻輻照度 2：L0 乘上 0.886227 就是輻照度。
    const l0 = 2 / 0.886227;
    for (let i = 0; i < probes.probeCount; i++) {
      probes.setProbe(i, [
        { x: l0, y: l0, z: l0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
      ]);
    }

    const field = new GlobalDistanceField({ resolution: 32, extent: 100 });
    field.add(colouredBox(0, 0, -20, [1, 0, 0]));
    settle(field, new Vector3(0, 0, 0));

    const light = field.radianceAlong(new Vector3(0, 0, 0), new Vector3(0, 0, -1), (point, normal) =>
      probes.sampleAt(point, normal),
    );
    // 紅牆 × 亮度 2 → 紅色通道大約 2，另外兩個是 0。
    expect(light.x).toBeCloseTo(2, 1);
    expect(light.y).toBeCloseTo(0, 5);
    expect(light.z).toBeCloseTo(0, 5);
  });

  it('問輻照度的時候法線是朝著光線來的方向', () => {
    // 朝反了的話牆會拿到牆背面的光 —— 症狀是背光的牆亮得莫名其妙。
    const field = new GlobalDistanceField({ resolution: 32, extent: 100 });
    field.add(colouredBox(0, 0, -20, [1, 1, 1]));
    settle(field, new Vector3(0, 0, 0));

    let seen: Vector3 | null = null;
    field.radianceAlong(new Vector3(0, 0, 0), new Vector3(0, 0, -1), (_point, normal) => {
      seen = normal.clone();
      return new Vector3(1, 1, 1);
    });
    expect(seen).not.toBeNull();
    expect((seen as unknown as Vector3).z).toBeCloseTo(1, 5);
  });
});
