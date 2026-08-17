import { SphereGeometry } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeometryData } from './lod-generation.ts';
import type { LodResponse } from './lod-worker.ts';
import { requestLodLevels, resetLodService } from './lod-service.ts';

/**
 * worker 這條路的失效方式很特別：**它不會報錯**。
 *
 * worker 起不來的時候（CSP 擋掉 blob:、檔案沒被部署、瀏覽器太舊），畫面
 * 完全正常，只是簡化跑到了主執行緒 —— 使用者剛打開頁面時卡住幾百毫秒，
 * 而卡頓沒有 stack trace。所以這裡驗的不是「有沒有例外」，是**這件事到底
 * 在哪個執行緒做的、以及退路還能不能走**。
 *
 * Node 沒有 `Worker`，真實的 worker 在這裡跑不起來。用一個可控的假 worker
 * 換掉它，才問得出「它沒報到的時候會怎樣」。
 */

type Behaviour = 'ready' | 'silent' | 'error';

let behaviour: Behaviour = 'ready';
const workers: FakeWorker[] = [];

class FakeWorker {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  terminated = false;
  /** 真的被送進來的請求。用來確認「沒報到就不會拿到資料」。 */
  readonly received: unknown[] = [];

  constructor() {
    workers.push(this);
    // 真的 worker 是**非同步**報到的。同步 emit 會讓監聽器還沒掛上就錯過，
    // 那等於在測試裡把要驗的那個時序抹平。
    queueMicrotask(() => {
      if (behaviour === 'ready') this.emit('message', { data: { ready: true } });
      if (behaviour === 'error') this.emit('error', { message: '' });
    });
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.received.push(message);
    // 模擬轉移：真的 postMessage 會當場把緩衝區抽離主執行緒。不模擬的話
    // 「資料還在不在」這件事在測試裡就永遠是對的。
    for (const item of transfer ?? []) {
      if (item instanceof ArrayBuffer) structuredClone(item, { transfer: [item] });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  /** 從 worker 那一側回一個結果。 */
  reply(response: LodResponse): void {
    this.emit('message', { data: response });
  }

  private emit(type: string, event: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

vi.mock('./lod-worker.ts?worker&inline', () => ({ default: FakeWorker }));

function sphereData(): GeometryData {
  const geometry = new SphereGeometry(1, 24, 16);
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (index === null) throw new Error('測試資料應該是索引幾何');
  return {
    attributes: {
      position: { array: Float32Array.from(position.array), itemSize: 3 },
    },
    indices: Uint32Array.from(index.array),
  };
}

/** 緩衝區被轉移走之後 `byteLength` 會變成 0。 */
function isDetached(data: GeometryData): boolean {
  return data.attributes['position']?.array.buffer.byteLength === 0;
}

/** 最後一個被建立的假 worker。這些測試都只會用到一個。 */
function current(): FakeWorker {
  const last = workers.at(-1);
  if (last === undefined) throw new Error('還沒有建立任何 worker');
  return last;
}

beforeEach(() => {
  resetLodService();
  behaviour = 'ready';
  workers.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  resetLodService();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LOD worker 的握手', () => {
  it('報到之後才把幾何交出去，簡化算在 worker 頭上', async () => {
    const source = sphereData();
    const promise = requestLodLevels(source, {});

    await vi.waitFor(() => expect(current().received).toHaveLength(1));
    // worker 活著時**刻意**轉移，省掉一次完整的幾何複製。
    expect(isDetached(source)).toBe(true);

    const request = current().received[0] as { id: number };
    current().reply({ id: request.id, ok: true, levels: [], elapsedMs: 12.5 });

    const result = await promise;
    expect(result.offMainThread).toBe(true);
    expect(result.elapsedMs).toBe(12.5);
  });

  it('worker 沒報到就不交出幾何，資料完好地退回主執行緒', async () => {
    behaviour = 'silent';
    vi.useFakeTimers();
    const source = sphereData();

    const promise = requestLodLevels(source, {});
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();

    const result = await promise;

    // 這幾條是同一件事的幾個面向，少一條就漏掉整個 bug：
    expect(current().received).toHaveLength(0); // 沒把資料送給死掉的 worker
    expect(isDetached(source)).toBe(false); // 所以資料還在
    expect(result.offMainThread).toBe(false); // 於是退路走得成
    expect(result.levels.length).toBeGreaterThan(0); // 而且真的產出了階
    expect(current().terminated).toBe(true); // 起不來的 worker 要收掉
  });

  it('worker 報到前就出錯，一樣退回主執行緒且資料完好', async () => {
    behaviour = 'error';
    const source = sphereData();

    const result = await requestLodLevels(source, {});

    expect(current().received).toHaveLength(0);
    expect(isDetached(source)).toBe(false);
    expect(result.offMainThread).toBe(false);
    expect(result.levels.length).toBeGreaterThan(0);
  });

  it('worker 起不來之後不再重試', async () => {
    behaviour = 'error';
    await requestLodLevels(sphereData(), {});
    const afterFirst = workers.length;

    await requestLodLevels(sphereData(), {});

    // 每個 mesh 都重試一次的話，失敗的環境要付 N 倍的啟動成本 —— 而那些
    // 環境本來就已經在走比較慢的那條路了。
    expect(workers).toHaveLength(afterFirst);
  });

  it('同時來的請求共用同一個 worker', async () => {
    const sources = [sphereData(), sphereData(), sphereData()];
    void Promise.all(sources.map((data) => requestLodLevels(data, {})));

    await vi.waitFor(() => expect(current().received).toHaveLength(3));
    expect(workers).toHaveLength(1);
  });
});
