import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceLostManager,
  type DeviceLifecycleState,
  type DeviceResourceOwner,
} from './device-lost-manager.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function owner(
  id: string,
  log: string[],
  hooks: Partial<DeviceResourceOwner> = {},
): DeviceResourceOwner {
  return {
    id,
    onDeviceLost: () => {
      log.push(`${id}:lost`);
    },
    onDeviceRestored: () => {
      log.push(`${id}:restored`);
    },
    ...hooks,
  };
}

const noSleep = () => Promise.resolve();

describe('DeviceLostManager', () => {
  beforeEach(() => {
    // 恢復流程刻意會把子系統的錯誤記到 console；測試裡不需要看到
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in the running state', () => {
    const m = new DeviceLostManager({ reacquire: () => Promise.resolve(), sleep: noSleep });
    expect(m.state).toBe('running');
    expect(m.lossCount).toBe(0);
  });

  it('releases in reverse registration order and restores in forward order', async () => {
    // 後註冊的通常依賴先註冊的，所以釋放要反向、重建要正向
    const log: string[] = [];
    const m = new DeviceLostManager({ reacquire: () => Promise.resolve(), sleep: noSleep });
    m.register(owner('a', log));
    m.register(owner('b', log));
    m.register(owner('c', log));

    await m.notifyLost('test');

    expect(log).toEqual(['c:lost', 'b:lost', 'a:lost', 'a:restored', 'b:restored', 'c:restored']);
    expect(m.state).toBe('running');
    expect(m.lossCount).toBe(1);
  });

  it('walks the full state machine', async () => {
    const states: DeviceLifecycleState[] = [];
    const m = new DeviceLostManager({
      reacquire: () => Promise.resolve(),
      sleep: noSleep,
      onStateChange: (e) => states.push(e.state),
    });

    await m.notifyLost('driver reset');

    expect(states).toEqual(['lost', 'reacquiring', 'rebuilding', 'restoring', 'running']);
  });

  it('deduplicates the second notification for the same loss', async () => {
    // renderer.onDeviceLost 與原生 device.lost 會各觸發一次；只能恢復一次
    const gate = deferred<void>();
    let reacquireCalls = 0;
    const m = new DeviceLostManager({
      reacquire: async () => {
        reacquireCalls++;
        await gate.promise;
      },
      sleep: noSleep,
    });

    const first = m.notifyLost('renderer callback');
    expect(m.isRecovering).toBe(true);

    await m.notifyLost('native device.lost');
    expect(m.duplicateNotifications).toBe(1);

    gate.resolve();
    await first;

    expect(reacquireCalls).toBe(1);
    expect(m.lossCount).toBe(1);
    expect(m.state).toBe('running');
  });

  it('retries reacquisition with backoff before giving up', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const m = new DeviceLostManager({
      reacquire: () => {
        attempts++;
        return attempts < 3
          ? Promise.reject(new Error('GPU process still down'))
          : Promise.resolve();
      },
      maxAttempts: 4,
      retryDelayMs: 100,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    await m.notifyLost('crash');

    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]); // 線性退避
    expect(m.state).toBe('running');
  });

  it('ends in the failed state when every attempt fails', async () => {
    const m = new DeviceLostManager({
      reacquire: () => Promise.reject(new Error('no adapter')),
      maxAttempts: 2,
      sleep: noSleep,
    });

    await m.notifyLost('permanent failure');

    expect(m.state).toBe('failed');
    // 失敗後仍可再次嘗試，不會永久卡在 recovering
    expect(m.isRecovering).toBe(false);
  });

  it('keeps releasing other owners when one throws', async () => {
    const log: string[] = [];
    const m = new DeviceLostManager({ reacquire: () => Promise.resolve(), sleep: noSleep });
    m.register(owner('good-1', log));
    m.register(
      owner('bad', log, {
        onDeviceLost: () => {
          throw new Error('release failed');
        },
      }),
    );
    m.register(owner('good-2', log));

    await m.notifyLost('test');

    expect(log).toContain('good-1:lost');
    expect(log).toContain('good-2:lost');
    expect(m.state).toBe('running');
  });

  it('keeps restoring other owners when one rejects', async () => {
    const log: string[] = [];
    const m = new DeviceLostManager({ reacquire: () => Promise.resolve(), sleep: noSleep });
    m.register(
      owner('bad', log, { onDeviceRestored: () => Promise.reject(new Error('rebuild failed')) }),
    );
    m.register(owner('good', log));

    await m.notifyLost('test');

    expect(log).toContain('good:restored');
    expect(m.state).toBe('running');
  });

  it('awaits asynchronous restore hooks before reporting running', async () => {
    const log: string[] = [];
    const m = new DeviceLostManager({ reacquire: () => Promise.resolve(), sleep: noSleep });
    m.register(
      owner('slow', log, {
        onDeviceRestored: async () => {
          await Promise.resolve();
          log.push('slow:restored');
        },
      }),
    );

    await m.notifyLost('test');

    expect(log).toEqual(['slow:lost', 'slow:restored']);
    expect(m.state).toBe('running');
  });

  it('stops notifying an unregistered owner', async () => {
    const log: string[] = [];
    const m = new DeviceLostManager({ reacquire: () => Promise.resolve(), sleep: noSleep });
    const unregister = m.register(owner('temp', log));
    unregister();

    await m.notifyLost('test');

    expect(log).toEqual([]);
  });

  it('survives repeated losses, as the soak scene requires', async () => {
    const log: string[] = [];
    const m = new DeviceLostManager({ reacquire: () => Promise.resolve(), sleep: noSleep });
    m.register(owner('a', log));

    for (let i = 0; i < 20; i++) {
      await m.notifyLost(`loss ${i}`);
    }

    expect(m.lossCount).toBe(20);
    expect(m.state).toBe('running');
    expect(log.filter((l) => l === 'a:restored')).toHaveLength(20);
  });

  it('ignores notifications after dispose', async () => {
    const log: string[] = [];
    const m = new DeviceLostManager({ reacquire: () => Promise.resolve(), sleep: noSleep });
    m.register(owner('a', log));
    m.dispose();

    await m.notifyLost('test');

    expect(log).toEqual([]);
    expect(m.lossCount).toBe(0);
  });
});
