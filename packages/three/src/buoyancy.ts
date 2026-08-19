import type { Water } from './water.ts';

/**
 * 浮力：讓東西真的浮在**那個**水面上。
 *
 * ## 這裡做的與不做的
 *
 * 求解交給 Rapier（見 ADR-0005：這個套件做調度，不做求解）。這裡算的是
 * **要施加多少力**，然後交給呼叫端丟進他的物理世界。
 *
 * 那條分界線與 `PhysicsScheduler` 是同一條：力學規則是別人寫好的、驗證過的；
 * 這裡負責的是「與這個引擎的水面一致」以及「大量物體時算得動」。
 *
 * ## 為什麼不是「y 比水面低就往上推」
 *
 * 那樣物體會在水面上**彈跳不停**：完全出水的瞬間力歸零、掉回去又滿力，
 * 於是它在水面附近震盪。真實的浮力是連續的 —— 沉多少排開多少水。
 *
 * 所以這裡算的是**沉沒比例**：把物體近似成一顆球，算球心到水面的距離佔
 * 半徑多少，夾在 0–1。半沉就是半個浮力，連續、不彈跳。
 *
 * ## 為什麼一定要配阻尼
 *
 * 只有浮力沒有阻尼的話，物體會像彈簧一樣**永遠上下振盪**：沉下去被推上來、
 * 衝過頭又落下。真實的水有黏滯阻力把那個能量吃掉。
 *
 * 不給阻尼的症狀不是「不動」，是「一直抖」—— 而那看起來像物理引擎壞了，
 * 不像少了一個參數。所以 `linearDamping` 有預設值而不是必填。
 */

export interface BuoyancyBody {
  /** 呼叫端自己的識別，原樣回傳。 */
  id: number;
  /** 球心的世界座標。 */
  x: number;
  y: number;
  z: number;
  /** 近似成球的半徑。 */
  radius: number;
  /**
   * 質量，公斤。
   *
   * 浮力與質量無關（只看排開的水），但**回傳的加速度**要除以它 —— 這裡
   * 直接回傳力，呼叫端要自己決定用 `applyImpulse` 還是 `addForce`。
   */
  mass: number;
  /** 目前的速度，用來算阻尼。沒給就當作 0。 */
  velocityX?: number;
  velocityY?: number;
  velocityZ?: number;
}

export interface BuoyancyForce {
  id: number;
  /** 要施加的合力（浮力 + 阻尼），牛頓。 */
  x: number;
  y: number;
  z: number;
  /** 沉沒比例 0–1。0 代表完全出水，這一筆可以直接跳過。 */
  submerged: number;
}

export interface BuoyancyOptions {
  /** 水的密度，kg/m³。淡水 1000、海水約 1025。 */
  density?: number;
  /** 重力加速度，m/s²。 */
  gravity?: number;
  /**
   * 線性阻尼係數。**沒有它物體會永遠上下振盪**（見檔案開頭）。
   *
   * 這個值取決於形狀與流體，沒有通用解 —— 預設取一個「看起來像水」的量級，
   * 而它是可以調的。
   */
  linearDamping?: number;
}

/**
 * 算一批物體這一刻受到的浮力與阻尼。
 *
 * ```js
 * const forces = computeBuoyancy(water, bodies, t);
 * for (const f of forces) rigidBody(f.id).addForce({ x: f.x, y: f.y, z: f.z }, true);
 * ```
 *
 * **完全出水的不會出現在結果裡** —— 一片海上大多數東西不在水裡，而回傳
 * 一堆零向量會讓呼叫端每幀白跑一次迴圈。
 */
export function computeBuoyancy(
  water: Water,
  bodies: readonly BuoyancyBody[],
  time: number,
  options: BuoyancyOptions = {},
): BuoyancyForce[] {
  const density = options.density ?? 1000;
  const gravity = options.gravity ?? 9.81;
  const damping = options.linearDamping ?? 2.5;

  const out: BuoyancyForce[] = [];
  for (const body of bodies) {
    const surface = water.heightAt(body.x, body.z, time);
    const radius = Math.max(body.radius, 1e-6);

    // 沉沒比例：球心在水面下多深，除以直徑，夾在 0–1。
    //
    // 用**連續**的比例而不是布林的「在不在水裡」—— 布林的話物體會在水面
    // 附近彈跳不停（見檔案開頭）。
    const depth = surface - (body.y - radius);
    const submerged = Math.min(Math.max(depth / (radius * 2), 0), 1);
    if (submerged <= 0) continue;

    // 排開的體積 × 密度 × 重力。球體積 = 4/3 π r³。
    const volume = (4 / 3) * Math.PI * radius * radius * radius * submerged;
    const lift = volume * density * gravity;

    // 阻尼與沉沒比例成正比：出水的部分不該有水的阻力。
    const k = damping * submerged * body.mass;
    out.push({
      id: body.id,
      x: -(body.velocityX ?? 0) * k,
      y: lift - (body.velocityY ?? 0) * k,
      z: -(body.velocityZ ?? 0) * k,
      submerged,
    });
  }
  return out;
}
