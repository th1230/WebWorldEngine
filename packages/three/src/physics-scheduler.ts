import type { Vector3 } from 'three';
import type { Rebasable } from './origin.ts';

/**
 * 大世界裡的物理調度：**誰現在該算**。
 *
 * ## 這裡刻意不碰求解
 *
 * 見 ADR-0005。剛體求解要正確、穩定、而且決定性，那是 Rapier 這種東西
 * 花好幾年做到的。自己寫一份「數學上也對但跟別人不一致」的，症狀是細微
 * 的抖動與穿透，而且不報錯。
 *
 * **所以這個檔案沒有 import 任何物理函式庫，一行都沒有。** 它處理的是
 * 「哪些東西該進求解器」——那是一個關於位置與預算的問題，與求解器是誰無關。
 *
 * 副作用是它可以完全用單元測試驗，不必啟動任何 WASM。
 *
 * ## 為什麼這是必要的而不是方便
 *
 * 大世界裡剛體的數量遠超過任何求解器能每幀算完的量。UE 用 physics budget
 * 與距離門檻處理，而那個判斷需要知道「世界多大、相機在哪、什麼被串流進來」
 * —— 求解器不知道那些，只有引擎知道。
 *
 * 這正好是這個套件在渲染那側已經做過的事：
 *
 * | 渲染 | 物理 |
 * | --- | --- |
 * | 視錐剔除：不在畫面裡就不畫 | 不在範圍裡就不算 |
 * | LOD：遠的用粗的 | 遠的用簡化碰撞體或不算 |
 * | 串流：走遠就卸載 | 走遠就從求解器移掉 |
 * | 原點重定位 | **同一個洞**，見下 |
 *
 * ## 邊界要有遲滯，理由與串流完全相同
 *
 * 進入與離開用同一條線的話，站在邊界上會**每幀加入又移除** —— 而建立剛體
 * 是求解器裡最貴的操作之一。畫面完全正常，只是每幀都在做最貴的工作。
 *
 * 串流那邊已經踩過這個坑（`unloadRadius` 的說明），所以這裡直接把它設成
 * 有下限的參數，而不是「隨便給」。
 */

export interface PhysicsSchedulerOptions {
  /**
   * 離焦點多遠以內要交給求解器算。世界單位。
   *
   * **這個數字沒有推導得出來的值** —— 它取決於玩法：一個要撿地上東西的遊戲
   * 需要幾公尺，一個開車的需要幾百公尺。所以它是宣告的，不是猜的。
   */
  activeRadius: number;
  /**
   * 超過多遠才拿掉。預設是 `activeRadius` 的 1.25 倍。
   *
   * 兩者相同的話，站在邊界上會每幀加入又移除，而建立剛體是求解器裡最貴的
   * 操作之一 —— 畫面完全正常，只是每幀都在做最貴的工作。串流那邊踩過同一個坑。
   */
  sleepRadius?: number;
  /**
   * 同時最多幾個。超過就**留最近的**。
   *
   * 沒有上限的話，一走進密集區就會有幾千個剛體同時進求解器，那一幀直接卡住。
   * 有上限的話最遠的那些會被延後 —— 那是安全的方向：遠的東西動了也看不見。
   *
   * 省略代表不設限（範圍內全部都算）。
   */
  maxActive?: number;
  /** 這個 id 要進求解器了。在這裡建立剛體。 */
  onActivate: (id: number) => void;
  /** 這個 id 要離開求解器了。在這裡移除剛體。 */
  onDeactivate: (id: number) => void;
}

export interface PhysicsStats {
  /** 登記在案的總數。 */
  tracked: number;
  /** 現在交給求解器的數量。 */
  active: number;
  /** 因為 `maxActive` 而被擋在外面的數量。**持續不為 0 代表預算不夠**。 */
  deferred: number;
  totalActivations: number;
  totalDeactivations: number;
}

/**
 * 依距離與預算決定哪些剛體該存在。
 *
 * ```js
 * const physics = new WW.PhysicsScheduler({
 *   activeRadius: 120,
 *   maxActive: 400,
 *   onActivate: (id) => bodies.set(id, world.createRigidBody(descOf(id))),
 *   onDeactivate: (id) => { world.removeRigidBody(bodies.get(id)); bodies.delete(id); },
 * });
 *
 * physics.add(id, x, y, z);
 * // 每幀
 * physics.update(camera.position);
 * ```
 */
export class PhysicsScheduler implements Rebasable {
  private readonly ids: number[] = [];
  private readonly at = new Map<number, number>();
  /** xyz 連續排列，與 `ids` 同索引。 */
  private positions: Float64Array = new Float64Array(0);
  private readonly activeSet = new Set<number>();

  private readonly activeRadius: number;
  private readonly sleepRadius: number;
  private readonly maxActive: number;
  private readonly onActivate: (id: number) => void;
  private readonly onDeactivate: (id: number) => void;

  private _deferred = 0;
  private _activations = 0;
  private _deactivations = 0;
  /** 排序用的暫存，重複使用 —— 每幀配置一個陣列會餵飽 GC。 */
  private readonly ranking: Array<{ id: number; d2: number }> = [];

  constructor(options: PhysicsSchedulerOptions) {
    this.activeRadius = options.activeRadius;
    // 下限而不是隨便給：兩條線太近就等於沒有遲滯。
    this.sleepRadius = Math.max(options.sleepRadius ?? options.activeRadius * 1.25, options.activeRadius * 1.05);
    this.maxActive = options.maxActive ?? Infinity;
    this.onActivate = options.onActivate;
    this.onDeactivate = options.onDeactivate;
  }

  /**
   * 登記一個位置。`id` 是呼叫端自己的編號 —— 這裡不發號，因為那會逼使用者
   * 再維護一張對照表。
   */
  add(id: number, x: number, y: number, z: number): void {
    if (this.at.has(id)) {
      this.move(id, x, y, z);
      return;
    }
    const index = this.ids.length;
    this.at.set(id, index);
    this.ids.push(id);
    this.ensure(index + 1);
    this.positions[index * 3] = x;
    this.positions[index * 3 + 1] = y;
    this.positions[index * 3 + 2] = z;
  }

  /** 位置變了。會動的東西每次移動都要講，不然它會用舊位置判斷距離。 */
  move(id: number, x: number, y: number, z: number): void {
    const index = this.at.get(id);
    if (index === undefined) return;
    this.positions[index * 3] = x;
    this.positions[index * 3 + 1] = y;
    this.positions[index * 3 + 2] = z;
  }

  /**
   * 不再追蹤。若它正在求解器裡，會先通知移除 —— 不然那個剛體會留在世界裡
   * 而沒有任何東西記得它。
   */
  remove(id: number): void {
    const index = this.at.get(id);
    if (index === undefined) return;
    if (this.activeSet.delete(id)) {
      this._deactivations++;
      this.onDeactivate(id);
    }

    // 用最後一個填洞 —— 與串流壓洞同一個做法，維持緊密排列。
    const last = this.ids.length - 1;
    if (index !== last) {
      const moved = this.ids[last]!;
      this.ids[index] = moved;
      this.at.set(moved, index);
      this.positions.copyWithin(index * 3, last * 3, last * 3 + 3);
    }
    this.ids.pop();
    this.at.delete(id);
  }

  /**
   * 依焦點重算誰該在求解器裡。每幀呼叫。
   *
   * 焦點通常是相機，但不一定 —— 第三人稱遊戲裡那應該是角色而不是鏡頭。
   */
  update(focus: Vector3): void {
    const activeR2 = this.activeRadius * this.activeRadius;
    const sleepR2 = this.sleepRadius * this.sleepRadius;
    const ranking = this.ranking;
    ranking.length = 0;
    this._deferred = 0;

    for (const [index, id] of this.ids.entries()) {
      const dx = this.positions[index * 3]! - focus.x;
      const dy = this.positions[index * 3 + 1]! - focus.y;
      const dz = this.positions[index * 3 + 2]! - focus.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const on = this.activeSet.has(id);

      // 遲滯：已經在裡面的用比較寬的那條線，還沒進來的用比較嚴的。
      if (on ? d2 > sleepR2 : d2 > activeR2) {
        if (on) {
          this.activeSet.delete(id);
          this._deactivations++;
          this.onDeactivate(id);
        }
        continue;
      }
      ranking.push({ id, d2 });
    }

    if (ranking.length > this.maxActive) {
      // 超過預算就留最近的。遠的東西動了也看不見，所以那是安全的方向。
      ranking.sort((a, b) => a.d2 - b.d2);
      for (let i = this.maxActive; i < ranking.length; i++) {
        const id = ranking[i]!.id;
        if (this.activeSet.delete(id)) {
          this._deactivations++;
          this.onDeactivate(id);
        }
      }
      this._deferred = ranking.length - this.maxActive;
      ranking.length = this.maxActive;
    }

    for (const { id } of ranking) {
      if (this.activeSet.has(id)) continue;
      this.activeSet.add(id);
      this._activations++;
      this.onActivate(id);
    }
  }

  /**
   * 原點重定位：把記著的位置一起搬。
   *
   * **這是與渲染同一個洞。** 不搬的話，世界搬過去之後物理還在用舊座標判斷
   * 距離 —— 於是腳邊的東西不算、幾百單位外的東西在算。而畫面完全正常，
   * 因為畫面是另一套座標。
   *
   * 求解器裡那些剛體的位置要由呼叫端在 `onRebase` 裡搬 —— 那些是它建立的，
   * 這裡碰不到。
   */
  translateInstances(offset: Vector3): void {
    for (let i = 0; i < this.ids.length; i++) {
      this.positions[i * 3]! += offset.x;
      this.positions[i * 3 + 1]! += offset.y;
      this.positions[i * 3 + 2]! += offset.z;
    }
  }

  get stats(): PhysicsStats {
    return {
      tracked: this.ids.length,
      active: this.activeSet.size,
      deferred: this._deferred,
      totalActivations: this._activations,
      totalDeactivations: this._deactivations,
    };
  }

  private ensure(count: number): void {
    if (this.positions.length >= count * 3) return;
    // 倍增：一個一個長會在載入一整格時變成 O(n²) 次複製。
    const next = new Float64Array(Math.max(count * 3, this.positions.length * 2, 96));
    next.set(this.positions);
    this.positions = next;
  }
}
