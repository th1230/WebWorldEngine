import { assert } from './assert.ts';

/**
 * 固定容量的 Float64 環形緩衝區。
 *
 * Profiler 每幀都會 push，所以 push() 必須是零配置的 —— 否則 profiler 自己就會
 * 污染它要量測的 JavaScript GC 那一欄。所有記憶體在建構時一次配置完。
 */
export class Float64RingBuffer {
  readonly capacity: number;
  private readonly data: Float64Array;
  /** 下一個寫入位置。 */
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    assert(Number.isInteger(capacity) && capacity > 0, 'capacity 必須是正整數');
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /** 熱路徑：不得配置記憶體、不得取模除法。 */
  push(value: number): void {
    this.data[this.head] = value;
    const next = this.head + 1;
    this.head = next === this.capacity ? 0 : next;
    if (this.count < this.capacity) this.count++;
  }

  /** index 0 為最舊的樣本。 */
  at(index: number): number {
    assert(
      index >= 0 && index < this.count,
      `RingBuffer index ${index} 超出範圍 (size=${this.count})`,
    );
    const start = this.count === this.capacity ? this.head : 0;
    return this.data[(start + index) % this.capacity]!;
  }

  last(): number {
    assert(this.count > 0, 'RingBuffer 是空的');
    return this.data[(this.head + this.capacity - 1) % this.capacity]!;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /**
   * 依時間順序（最舊 → 最新）複製出內容。
   * 這會配置記憶體，只在產生報告時呼叫，不要放進 render loop。
   */
  toArray(out?: Float64Array): Float64Array {
    const target =
      out !== undefined && out.length >= this.count ? out : new Float64Array(this.count);
    const start = this.count === this.capacity ? this.head : 0;
    for (let i = 0; i < this.count; i++) {
      target[i] = this.data[(start + i) % this.capacity]!;
    }
    return target;
  }
}
