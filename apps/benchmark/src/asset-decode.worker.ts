import type { MeshEntry, TextureEntry } from '@web-world-engine/format';
import { decodeMesh, decodeTexture } from '@ww/assets-runtime';

/**
 * 資產解碼 worker。
 *
 * ## 為什麼要有它
 *
 * 解碼一個大型網格或貼圖會佔用主執行緒數十毫秒 —— 那正是 profiler
 * 會記成 long task 的東西，在畫面上表現為一次明顯的卡頓。streaming
 * 開始之後，這種解碼會**持續發生**而不只在載入時，主執行緒完全承受不起。
 *
 * `@ww/assets-runtime` 的 `decode.ts` 與 `texture.ts` 從一開始就刻意不碰
 * 任何 DOM 或 renderer API，就是為了能原封不動搬到這裡。
 *
 * ## 傳輸
 *
 * 解碼結果透過 transferable 交回主執行緒 —— 複製幾 MB 的頂點資料回去
 * 就把省下的時間又還回去了。注意 transfer 之後 worker 這邊的 buffer
 * 會被中性化，所以每個請求都用自己的 buffer。
 */

export interface DecodeMeshRequest {
  kind: 'mesh';
  id: string;
  buffer: ArrayBuffer;
  entry: MeshEntry;
}

export interface DecodeTextureRequest {
  kind: 'texture';
  id: string;
  buffer: ArrayBuffer;
  entry: TextureEntry;
}

export type DecodeRequest = DecodeMeshRequest | DecodeTextureRequest;

export interface DecodeMeshResponse {
  kind: 'mesh';
  id: string;
  ok: true;
  /** 所有 LOD 共用的頂點資料。 */
  vertices: Float32Array;
  lods: Array<{ level: number; indices: Uint16Array | Uint32Array; error: number }>;
}

export interface DecodeTextureResponse {
  kind: 'texture';
  id: string;
  ok: true;
  format: string;
  srgb: boolean;
  width: number;
  height: number;
  levels: Array<{ level: number; width: number; height: number; data: Uint8Array }>;
}

export interface DecodeErrorResponse {
  kind: 'error';
  id: string;
  ok: false;
  message: string;
}

export type DecodeResponse = DecodeMeshResponse | DecodeTextureResponse | DecodeErrorResponse;

/**
 * tsconfig 的 `lib` 含 DOM 但不含 WebWorker，所以 `self` 會被推導成 `Window`
 * —— 它的 `postMessage` 簽名是 `(message, targetOrigin)`，與 worker 的
 * `(message, transfer)` 不同。同時載入兩個 lib 會產生大量衝突，
 * 因此在這裡用區域型別收窄，把影響限制在這個檔案。
 */
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: DecodeResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'mesh') {
      const lods = decodeMesh(new Uint8Array(request.buffer), request.entry);
      const first = lods[0];
      if (first === undefined) throw new Error('沒有任何 LOD');

      // 視圖都指向同一個 buffer，複製成獨立陣列才能個別 transfer
      const vertices = new Float32Array(first.vertices);
      const copied = lods.map((lod) => ({
        level: lod.level,
        indices:
          lod.indices instanceof Uint16Array
            ? new Uint16Array(lod.indices)
            : new Uint32Array(lod.indices),
        error: lod.error,
      }));

      const response: DecodeMeshResponse = {
        kind: 'mesh',
        id: request.id,
        ok: true,
        vertices,
        lods: copied,
      };
      workerScope.postMessage(response, [
        vertices.buffer,
        ...copied.map((lod) => lod.indices.buffer),
      ]);
      return;
    }

    const texture = decodeTexture(new Uint8Array(request.buffer), request.entry);
    const levels = texture.levels.map((level) => ({
      level: level.level,
      width: level.width,
      height: level.height,
      data: new Uint8Array(level.data),
    }));

    const response: DecodeTextureResponse = {
      kind: 'texture',
      id: request.id,
      ok: true,
      format: texture.format,
      srgb: texture.srgb,
      width: texture.width,
      height: texture.height,
      levels,
    };
    workerScope.postMessage(
      response,
      levels.map((level) => level.data.buffer),
    );
  } catch (error) {
    const response: DecodeErrorResponse = {
      kind: 'error',
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};
