/**
 * device-lost 恢復流程。
 *
 *   Running → Lost → Reacquiring → Rebuilding → Restoring → Running
 *
 * WebGPU 的 device 隨時可能因為驅動重置、GPU process 崩潰、或 OOM 而遺失。
 * 這不是罕見的邊界情況，是必須設計進去的正常狀態轉換。
 *
 * 原則：CPU-side 的世界狀態一律保留，只重建 GPU-side 資源。
 */

export type DeviceLifecycleState =
  | 'running'
  | 'lost'
  | 'reacquiring'
  | 'rebuilding'
  | 'restoring'
  | 'failed';

export interface DeviceResourceOwner {
  readonly id: string;
  /** 丟棄所有 GPU 端參考。**不要**在這裡丟棄 CPU 端資料。 */
  onDeviceLost(): void;
  /** 重新上傳 / 重建 GPU 資源。 */
  onDeviceRestored(): void | Promise<void>;
}

export interface DeviceLostEvent {
  state: DeviceLifecycleState;
  detail: string;
  lossCount: number;
  attempt: number;
}

export interface DeviceLostManagerOptions {
  /**
   * 由 render backend 提供：重新取得 adapter/device 並重建 renderer。
   * 成功回傳，失敗丟例外。
   */
  reacquire: () => Promise<void>;
  maxAttempts?: number | undefined;
  retryDelayMs?: number | undefined;
  onStateChange?: ((event: DeviceLostEvent) => void) | undefined;
  /** 注入用，方便測試不必真的等待。 */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 補齊預設值後的設定。刻意不用 Required<> —— 它拿不掉明確寫出的 `| undefined`。 */
interface ResolvedOptions {
  reacquire: () => Promise<void>;
  maxAttempts: number;
  retryDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  onStateChange: ((event: DeviceLostEvent) => void) | undefined;
}

export class DeviceLostManager {
  private readonly options: ResolvedOptions;
  /** 用陣列而非 Set：註冊順序決定重建順序，而重建有相依性。 */
  private readonly owners: DeviceResourceOwner[] = [];
  private _state: DeviceLifecycleState = 'running';
  private _lossCount = 0;
  private _duplicateNotifications = 0;
  private recovering = false;
  private disposed = false;

  constructor(options: DeviceLostManagerOptions) {
    this.options = {
      reacquire: options.reacquire,
      maxAttempts: options.maxAttempts ?? 3,
      retryDelayMs: options.retryDelayMs ?? 250,
      sleep: options.sleep ?? defaultSleep,
      onStateChange: options.onStateChange,
    };
  }

  get state(): DeviceLifecycleState {
    return this._state;
  }

  get lossCount(): number {
    return this._lossCount;
  }

  /**
   * `renderer.onDeviceLost` 與原生 `device.lost` 會為了同一次遺失各觸發一次。
   * 這個計數確認去重有生效。
   */
  get duplicateNotifications(): number {
    return this._duplicateNotifications;
  }

  get isRecovering(): boolean {
    return this.recovering;
  }

  register(owner: DeviceResourceOwner): () => void {
    this.owners.push(owner);
    return () => {
      const index = this.owners.indexOf(owner);
      if (index >= 0) this.owners.splice(index, 1);
    };
  }

  /**
   * 通報 device 遺失。可以被重複呼叫（renderer callback 與 device.lost promise
   * 兩個來源），重複的呼叫會被忽略而不是觸發第二次恢復。
   */
  async notifyLost(detail: string): Promise<void> {
    if (this.disposed) return;
    if (this.recovering) {
      this._duplicateNotifications++;
      return;
    }

    this.recovering = true;
    this._lossCount++;
    try {
      this.setState('lost', detail, 0);

      // 反向釋放：後註冊的通常依賴先註冊的
      for (let i = this.owners.length - 1; i >= 0; i--) {
        this.safely(() => this.owners[i]!.onDeviceLost(), this.owners[i]!.id, 'onDeviceLost');
      }

      const reacquired = await this.reacquireWithRetry(detail);
      if (!reacquired) {
        this.setState('failed', `${this.options.maxAttempts} 次嘗試後仍無法取得 device`, 0);
        return;
      }

      this.setState('restoring', '重建子系統資源', 0);
      for (const owner of this.owners) {
        try {
          await owner.onDeviceRestored();
        } catch (error) {
          console.error(`[DeviceLostManager] ${owner.id}.onDeviceRestored 失敗`, error);
        }
      }

      this.setState('running', '恢復完成', 0);
    } finally {
      this.recovering = false;
    }
  }

  private async reacquireWithRetry(detail: string): Promise<boolean> {
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      if (this.disposed) return false;
      this.setState('reacquiring', detail, attempt);
      try {
        await this.options.reacquire();
        this.setState('rebuilding', 'device 已取得，pipeline 重建中', attempt);
        return true;
      } catch (error) {
        console.warn(`[DeviceLostManager] 第 ${attempt} 次取得 device 失敗`, error);
        if (attempt < this.options.maxAttempts) {
          // 線性退避：GPU process 重啟需要時間，立刻重試只會再失敗一次
          await this.options.sleep(this.options.retryDelayMs * attempt);
        }
      }
    }
    return false;
  }

  private safely(fn: () => void, ownerId: string, phase: string): void {
    try {
      fn();
    } catch (error) {
      // 一個子系統釋放失敗不能中斷其他子系統的釋放
      console.error(`[DeviceLostManager] ${ownerId}.${phase} 失敗`, error);
    }
  }

  private setState(state: DeviceLifecycleState, detail: string, attempt: number): void {
    this._state = state;
    this.options.onStateChange?.({ state, detail, lossCount: this._lossCount, attempt });
  }

  dispose(): void {
    this.disposed = true;
    this.owners.length = 0;
  }
}
