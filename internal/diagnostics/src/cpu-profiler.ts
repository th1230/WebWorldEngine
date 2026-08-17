import { assert } from '@ww/core';

export type ScopeId = number;

/** CPU 分類。 */
export const DEFAULT_SCOPES = [
  'Simulation',
  'Physics',
  'Animation',
  'AI',
  'Streaming',
  'RenderExtraction',
  'Render',
  'Present',
] as const;

export type DefaultScopeName = (typeof DEFAULT_SCOPES)[number];

const MAX_SCOPES = 64;
const MAX_STACK_DEPTH = 32;

/**
 * 堆疊式的 CPU scope 計時器。
 *
 * 設計上最重要的一條約束：**push 路徑不得配置任何記憶體**。
 * 如果 profiler 自己會產生垃圾，那它量到的 GC 停頓就有一部分是自己造成的，
 * 而 GC 正是要求觀察的項目之一。因此：
 *   - scope 用預先註冊的整數 id，不用字串查表
 *   - 所有累加寫進建構時就配置好的 Float64Array
 *   - 不使用 closure、不回傳物件、不用 try/finally 包裝
 */
export class CpuProfiler {
  private readonly names: string[] = [];
  /** 本幀各 scope 的累計時間。 */
  private readonly accum = new Float64Array(MAX_SCOPES);
  /** 上一幀完成的數值，供讀取。 */
  private readonly lastFrame = new Float64Array(MAX_SCOPES);
  /** 各 scope 目前這層的起始時間。 */
  private readonly openedAt = new Float64Array(MAX_SCOPES);
  /** 巢狀計數，避免同一 scope 重入時重複計時。 */
  private readonly depth = new Int32Array(MAX_SCOPES);
  private readonly stack = new Int32Array(MAX_STACK_DEPTH);
  private stackTop = -1;
  private frameStart = 0;
  private _frameMs = 0;
  private _overflowed = false;

  registerScope(name: string): ScopeId {
    const existing = this.names.indexOf(name);
    if (existing >= 0) return existing;
    assert(this.names.length < MAX_SCOPES, `scope 數量超過上限 ${MAX_SCOPES}`);
    this.names.push(name);
    return this.names.length - 1;
  }

  scopeName(id: ScopeId): string {
    return this.names[id] ?? `<unknown ${id}>`;
  }

  get scopeCount(): number {
    return this.names.length;
  }

  /** 堆疊溢位或 begin/end 不成對時為 true。代表量到的數字不可信。 */
  get overflowed(): boolean {
    return this._overflowed;
  }

  beginFrame(now = performance.now()): void {
    this.frameStart = now;
    this.accum.fill(0, 0, this.names.length);
    this.depth.fill(0, 0, this.names.length);
    this.stackTop = -1;
    this._overflowed = false;
  }

  begin(id: ScopeId): void {
    if (this.stackTop + 1 >= MAX_STACK_DEPTH) {
      this._overflowed = true;
      return;
    }
    this.stack[++this.stackTop] = id;
    // 只有最外層那次才記錄起始時間，內層重入不重複計時
    const depth = this.depth[id]!;
    this.depth[id] = depth + 1;
    if (depth === 0) {
      this.openedAt[id] = performance.now();
    }
  }

  end(id: ScopeId): void {
    if (this.stackTop < 0 || this.stack[this.stackTop] !== id) {
      this._overflowed = true;
      return;
    }
    this.stackTop--;
    const depth = this.depth[id]! - 1;
    this.depth[id] = depth;
    if (depth === 0) {
      this.accum[id] = this.accum[id]! + (performance.now() - this.openedAt[id]!);
    }
  }

  endFrame(now = performance.now()): void {
    if (this.stackTop >= 0) this._overflowed = true;
    this._frameMs = now - this.frameStart;
    this.lastFrame.set(this.accum.subarray(0, this.names.length), 0);
  }

  /** 上一幀的總時間（beginFrame 到 endFrame）。 */
  get frameMs(): number {
    return this._frameMs;
  }

  durationOf(id: ScopeId): number {
    return this.lastFrame[id] ?? 0;
  }

  /**
   * 上一幀各 scope 時間的直接視圖，索引即 ScopeId。
   * 供 FrameRecorder 讀取而不必複製 —— 呼叫端不得修改內容。
   */
  get durations(): ArrayLike<number> {
    return this.lastFrame;
  }

  /** 產生報告用。會配置記憶體，不要在 render loop 裡呼叫。 */
  toRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < this.names.length; i++) {
      out[this.names[i]!] = this.lastFrame[i]!;
    }
    return out;
  }
}
