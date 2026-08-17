import type { MeshEntry, TextureEntry } from '@webworld/format';
import type { DecodedLod, DecodedTexture } from '@ww/assets-runtime';
import type { DecodeRequest, DecodeResponse } from './asset-decode.worker.ts';

/**
 * Worker 解碼的主執行緒端。
 *
 * 每個請求配一個遞增的 id，因為 worker 的回應順序不保證與送出順序相同
 * （不同大小的資產解碼時間差很多）。用 id 對應而非佇列，才不會把
 * A 的結果當成 B 的。
 */
export class AssetDecoder {
  private readonly worker: Worker;
  private readonly pending = new Map<
    string,
    { resolve: (value: DecodeResponse) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private _decoded = 0;
  private _totalMs = 0;

  constructor() {
    this.worker = new Worker(new URL('./asset-decode.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (entry === undefined) return;
      this.pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data);
      else entry.reject(new Error(event.data.message));
    };
    this.worker.onerror = (event) => {
      // worker 整個掛掉時所有等待中的請求都不會有回應，必須全部拒絕，
      // 否則呼叫端會永遠 await 下去
      const error = new Error(`解碼 worker 失敗：${event.message}`);
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    };
  }

  get decodedCount(): number {
    return this._decoded;
  }

  /** 解碼所花的總時間（主執行緒感受到的等待，非 worker 內部耗時）。 */
  get totalMs(): number {
    return this._totalMs;
  }

  async decodeMesh(entry: MeshEntry, buffer: ArrayBuffer): Promise<DecodedLod[]> {
    const response = await this.send({ kind: 'mesh', id: this.allocId(), buffer, entry }, buffer);
    if (response.kind !== 'mesh') throw new Error('worker 回傳了非預期的型別');

    return response.lods.map((lod) => ({
      level: lod.level,
      vertices: response.vertices,
      indices: lod.indices,
      error: lod.error,
    }));
  }

  async decodeTexture(entry: TextureEntry, buffer: ArrayBuffer): Promise<DecodedTexture> {
    const response = await this.send({ kind: 'texture', id: this.allocId(), buffer, entry }, buffer);
    if (response.kind !== 'texture') throw new Error('worker 回傳了非預期的型別');

    return {
      format: response.format as DecodedTexture['format'],
      srgb: response.srgb,
      width: response.width,
      height: response.height,
      levels: response.levels,
    };
  }

  private allocId(): string {
    return String(this.nextId++);
  }

  private send(request: DecodeRequest, transfer: ArrayBuffer): Promise<DecodeResponse> {
    const started = performance.now();
    return new Promise<DecodeResponse>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      // 把來源 buffer 也 transfer 過去：主執行緒不再需要它，複製只是浪費
      this.worker.postMessage(request, [transfer]);
    }).then((response) => {
      this._decoded++;
      this._totalMs += performance.now() - started;
      return response;
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
