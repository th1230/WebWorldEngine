import { describe, expect, it } from 'vitest';
import { computeBuoyancy } from './buoyancy.ts';
import { DEFAULT_WAVES, Water } from './water.ts';

/**
 * 這一支要守的第一件事是**兩邊算的是同一個水面**。
 *
 * 水面在畫面上是 vertex shader 推出來的，浮力是 CPU 算的。兩份對不起來的
 * 症狀是東西浮在錯的高度 —— 船陷進浪裡或飄在半空，而且不會報錯，只是
 * 「看起來怪怪的」。那正是這個模組存在的理由，所以它必須被驗到。
 */

describe('水面的波形', () => {
  it('平的水：沒有波的時候處處等於水位', () => {
    const water = new Water({ level: 3, waves: [] });
    for (const [x, z] of [[0, 0], [100, -50], [-7.5, 12.25]]) {
      expect(water.heightAt(x!, z!, 1.5)).toBeCloseTo(3, 9);
    }
  });

  it('陡峭度 0 時就是純正弦 —— 有封閉解可以比', () => {
    // 陡峭度 0 代表沒有水平位移，所以反推迭代不該改變任何東西，
    // 高度就是 a·sin(k·x − ωt)。這是唯一能與解析式逐點比的情況。
    const wave = {
      directionX: 1,
      directionZ: 0,
      length: 10,
      amplitude: 2,
      speed: 0.5,
      steepness: 0,
    };
    const water = new Water({ level: 0, waves: [wave] });
    const k = (Math.PI * 2) / 10;
    const omega = k * 0.5 * 10;

    for (const x of [0, 1.3, -4.7, 25]) {
      for (const t of [0, 0.7, 2.4]) {
        expect(water.heightAt(x, 0, t)).toBeCloseTo(2 * Math.sin(k * x - omega * t), 6);
      }
    }
  });

  it('波峰不超過振幅總和 —— 疊起來也不會爆掉', () => {
    const water = new Water({ level: 0 });
    const max = DEFAULT_WAVES.reduce((sum, w) => sum + w.amplitude, 0);
    for (let i = 0; i < 400; i++) {
      const h = water.heightAt(i * 0.37, i * 0.71, i * 0.013);
      expect(Math.abs(h)).toBeLessThanOrEqual(max + 1e-9);
    }
  });

  it('陡峭度超過 1 會被夾住，而不是讓水面自己交叉破掉', () => {
    // 那個參數是開發者填的。填 5 不該變成破圖 —— 夾住是「有界的降級」，
    // 破圖是「壞掉」。
    const wild = new Water({
      waves: [{ directionX: 1, directionZ: 0, length: 8, amplitude: 1, speed: 1, steepness: 5 }],
    });
    const tame = new Water({
      waves: [{ directionX: 1, directionZ: 0, length: 8, amplitude: 1, speed: 1, steepness: 1 }],
    });
    for (const x of [0, 2, 5.5, -3]) {
      expect(wild.heightAt(x, 0, 0.4)).toBeCloseTo(tame.heightAt(x, 0, 0.4), 9);
    }
  });

  it('同一個時間點問兩次，答案完全一樣', () => {
    // 決定性是浮力能不能穩定的前提 —— 每幀抖一點的水面會讓物體一直震。
    const water = new Water();
    for (const [x, z, t] of [[1, 2, 3], [-40.5, 17.25, 0.125]]) {
      expect(water.heightAt(x!, z!, t!)).toBe(water.heightAt(x!, z!, t!));
    }
  });

  it('法線在平水面上朝正上方', () => {
    const water = new Water({ waves: [] });
    const [nx, ny, nz] = water.normalAt(5, -3, 2);
    expect(nx).toBeCloseTo(0, 9);
    expect(ny).toBeCloseTo(1, 9);
    expect(nz).toBeCloseTo(0, 9);
  });

  it('法線在斜坡上朝上坡方向傾斜', () => {
    // 正弦波上升段的法線該往 −x 傾（指向低的那一側的反面）。
    const water = new Water({
      level: 0,
      waves: [{ directionX: 1, directionZ: 0, length: 20, amplitude: 1, speed: 0, steepness: 0 }],
    });
    // x = 0 是上升段最陡的地方（sin' 最大）。
    const [nx, ny] = water.normalAt(0, 0, 0);
    expect(nx).toBeLessThan(0);
    expect(ny).toBeGreaterThan(0);
  });
});

describe('CPU 與 GPU 用的是同一組參數', () => {
  it('產生的 GLSL 裡的常數，與 CPU 那份逐一對得上', () => {
    // **這是這個模組存在的理由。** 兩邊各寫一份的話東西會浮在錯的高度，
    // 而且不報錯。所以這裡把 shader 裡的數字挖出來，跟 CPU 的參數比。
    const waves = [
      { directionX: 1, directionZ: 0, length: 16, amplitude: 0.75, speed: 0.5, steepness: 0.5 },
      { directionX: 0, directionZ: 1, length: 4, amplitude: 0.2, speed: 2, steepness: 0.25 },
    ];
    const water = new Water({ level: 1.5, waves });
    const glsl = water.displacementGLSL();

    for (const w of waves) {
      const k = (Math.PI * 2) / w.length;
      const omega = k * w.speed * w.length;
      // 波數與角頻率都必須出現在 shader 裡，而且是同一個值。
      expect(glsl, `波長 ${w.length} 的波數`).toContain(k.toPrecision(9));
      expect(glsl, `波長 ${w.length} 的角頻率`).toContain(omega.toPrecision(9));
      expect(glsl, `振幅 ${w.amplitude}`).toContain(w.amplitude.toPrecision(9));
    }
    // 水位也要進去 —— 漏掉的話畫出來的水面整片偏移，而浮力是對的。
    expect(glsl).toContain((1.5).toPrecision(9));
  });

  it('GLSL 是合法的 float 字面值 —— 不能出現 `1` 這種整數', () => {
    // GLSL 不接受把 int 當 float 用。產生出 `1` 而不是 `1.0` 的話整支
    // shader 編不過，而畫面上是那個材質的東西整個不見。
    const water = new Water({
      level: 0,
      waves: [{ directionX: 1, directionZ: 0, length: 1, amplitude: 1, speed: 1, steepness: 1 }],
    });
    const glsl = water.displacementGLSL();
    // 每一個數字字面值都要有小數點或指數。
    for (const literal of glsl.match(/(?<![\w.])\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []) {
      expect(literal, `字面值 ${literal}`).toMatch(/[.e]/);
    }
  });

  it('函式名稱可以換 —— 同一個場景可能有兩片不同的水', () => {
    const water = new Water();
    expect(water.displacementGLSL('oceanA')).toContain('vec3 oceanA( vec2 p, float t )');
  });
});

describe('浮力', () => {
  const flat = new Water({ level: 0, waves: [] });

  it('完全出水的不回傳 —— 一片海上大多數東西不在水裡', () => {
    const forces = computeBuoyancy(flat, [{ id: 1, x: 0, y: 50, z: 0, radius: 1, mass: 10 }], 0);
    expect(forces).toEqual([]);
  });

  it('完全沉沒時是 ρVg，與質量無關', () => {
    // 浮力只看排開多少水。這一條擋的是「把質量寫進浮力」那種錯 ——
    // 症狀是重的東西浮不起來，而那看起來像「參數要調」。
    const radius = 2;
    const volume = (4 / 3) * Math.PI * radius ** 3;
    const expected = volume * 1000 * 9.81;

    for (const mass of [1, 500]) {
      const [f] = computeBuoyancy(flat, [{ id: 1, x: 0, y: -10, z: 0, radius, mass }], 0);
      expect(f!.submerged).toBe(1);
      expect(f!.y).toBeCloseTo(expected, 3);
    }
  });

  it('半沉就是半個浮力 —— 連續，所以不會在水面彈跳', () => {
    // 用「在不在水裡」的布林判斷會讓物體在水面附近震盪不停：出水瞬間力
    // 歸零、掉回去又滿力。這一條驗的就是它是連續的。
    const radius = 1;
    const full = (4 / 3) * Math.PI * radius ** 3 * 1000 * 9.81;
    const [f] = computeBuoyancy(flat, [{ id: 1, x: 0, y: 0, z: 0, radius, mass: 1 }], 0);
    expect(f!.submerged).toBeCloseTo(0.5, 9);
    expect(f!.y).toBeCloseTo(full * 0.5, 3);
  });

  it('沉沒比例隨高度單調變化，中間沒有跳階', () => {
    const radius = 1;
    let previous = 1;
    for (let y = -1.5; y <= 1.5; y += 0.05) {
      const [f] = computeBuoyancy(flat, [{ id: 1, x: 0, y, z: 0, radius, mass: 1 }], 0);
      const submerged = f?.submerged ?? 0;
      expect(submerged).toBeLessThanOrEqual(previous + 1e-9);
      previous = submerged;
    }
    expect(previous).toBe(0);
  });

  it('阻尼與速度反向 —— 沒有它物體會永遠上下振盪', () => {
    const [f] = computeBuoyancy(
      flat,
      [{ id: 1, x: 0, y: -5, z: 0, radius: 1, mass: 2, velocityX: 3, velocityY: 4, velocityZ: -1 }],
      0,
      { linearDamping: 1 },
    );
    expect(f!.x).toBeLessThan(0);
    expect(f!.z).toBeGreaterThan(0);
    // y 是浮力減阻尼，浮力大得多，所以仍然向上。
    expect(f!.y).toBeGreaterThan(0);
  });

  it('浮力跟著波動的水面走，不是跟著靜水位', () => {
    // 這是「水面只有一份」在浮力這一側的意思：波峰底下的東西沉得更多。
    const sea = new Water({
      level: 0,
      waves: [{ directionX: 1, directionZ: 0, length: 20, amplitude: 2, speed: 0, steepness: 0 }],
    });
    // x = 5 是 sin(2π·5/20)=sin(π/2)=1 的波峰，水面 +2。
    const crest = computeBuoyancy(sea, [{ id: 1, x: 5, y: 0, z: 0, radius: 1, mass: 1 }], 0);
    // x = 15 是波谷，水面 −2，物體完全出水。
    const trough = computeBuoyancy(sea, [{ id: 1, x: 15, y: 0, z: 0, radius: 1, mass: 1 }], 0);

    expect(crest[0]!.submerged).toBe(1);
    expect(trough).toEqual([]);
  });
});
