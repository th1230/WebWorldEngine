import { ASSET_SCHEMA_VERSION, type AssetManifest, type MeshEntry } from '@webworld/format';
import { assert, type Bytes } from '@ww/core';
import { AssetFormatError, decodeMesh, type DecodedLod } from './decode.ts';
import { decodeTexture, validateTexture, type DecodedTexture } from './texture.ts';

/**
 * 資產快取。
 *
 * 三件事必須同時成立，少一件之後的 streaming就會出問題：
 *
 * 1. **參考計數** —— 同一個 mesh 被兩個 cell 用到時只能載入一次
 * 2. **記憶體預算** —— 超過就驅逐，而不是無限成長直到分頁崩潰
 * 3. **不驅逐使用中的資產** —— refCount > 0 的絕對不能被回收
 */

export interface AssetHandle {
  readonly id: string;
  readonly lods: readonly DecodedLod[];
  readonly entry: MeshEntry;
  readonly byteLength: Bytes;
}

interface CacheSlot {
  handle: AssetHandle;
  refCount: number;
  /** 最後一次被取用的序號，用於 LRU。 */
  lastUsed: number;
}

export interface AssetCacheOptions {
  /** CPU 端快取的位元組上限。超過就驅逐未被參考的資產。 */
  budgetBytes?: number;
  fetch?: (url: string) => Promise<ArrayBuffer>;
}

const DEFAULT_BUDGET = 256 * 1024 * 1024;

export interface CacheStats {
  resident: number;
  residentBytes: Bytes;
  budgetBytes: Bytes;
  hits: number;
  misses: number;
  evictions: number;
  /** 因為全部都在使用中而無法騰出空間的次數。持續大於 0 代表預算太小。 */
  evictionFailures: number;
}

export class AssetCache {
  private readonly slots = new Map<string, CacheSlot>();
  private readonly inFlight = new Map<string, Promise<AssetHandle>>();
  private readonly budgetBytes: number;
  private readonly fetchBytes: (url: string) => Promise<ArrayBuffer>;
  private manifest: AssetManifest | null = null;
  private baseUrl = '';

  private clock = 0;
  private residentBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private evictionFailures = 0;

  constructor(options: AssetCacheOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET;
    this.fetchBytes =
      options.fetch ??
      (async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`載入 ${url} 失敗：HTTP ${response.status}`);
        return response.arrayBuffer();
      });
  }

  /**
   * 載入 manifest。
   *
   * schema 版本不符時直接拒絕。舊 manifest 配新 runtime 會以「偏移量對不上」
   * 的形式出錯，那種錯誤看起來像隨機的圖形損毀，極難追查回格式不符。
   */
  async loadManifest(url: string): Promise<AssetManifest> {
    const bytes = await this.fetchBytes(url);
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as AssetManifest;

    if (manifest.schemaVersion !== ASSET_SCHEMA_VERSION) {
      throw new AssetFormatError(
        `manifest schema v${manifest.schemaVersion} 與 runtime 的 v${ASSET_SCHEMA_VERSION} 不符，請重新執行 pnpm cook`,
      );
    }

    this.manifest = manifest;
    this.baseUrl = url.slice(0, url.lastIndexOf('/') + 1);
    return manifest;
  }

  get loadedManifest(): AssetManifest | null {
    return this.manifest;
  }

  meshIds(): string[] {
    return Object.keys(this.manifest?.meshes ?? {});
  }

  textureIds(): string[] {
    return Object.keys(this.manifest?.textures ?? {});
  }

  /**
   * 載入並解析一張貼圖。
   *
   * 不走 mesh 的參考計數快取：貼圖通常被大量材質共用且生命週期較長，
   * streaming 會需要不同的驅逐策略。現在先各自獨立，等 cell 的
   * 定義出來再統一。
   */
  async loadTexture(id: string): Promise<DecodedTexture> {
    const manifest = this.manifest;
    assert(manifest !== null, '必須先呼叫 loadManifest');

    const entry = manifest.textures[id];
    if (entry === undefined) throw new AssetFormatError(`manifest 裡沒有貼圖 "${id}"`);

    const buffer = await this.fetchBytes(this.baseUrl + entry.file);
    const texture = decodeTexture(new Uint8Array(buffer), entry);

    // 長度不符時 GPU 上傳只會給出無上下文的 validation error
    const problems = validateTexture(texture, id);
    if (problems.length > 0) throw new AssetFormatError(problems.join('；'));

    return texture;
  }

  /**
   * 取得資產並將參考計數加一。
   *
   * 併發請求同一個資產只會實際載入一次 —— 沒有這層去重，剛進入視野的
   * 一批 物件 會同時對同一個 mesh 發出數十個請求。
   */
  async acquire(id: string): Promise<AssetHandle> {
    const existing = this.slots.get(id);
    if (existing !== undefined) {
      existing.refCount++;
      existing.lastUsed = ++this.clock;
      this.hits++;
      return existing.handle;
    }

    const pending = this.inFlight.get(id);
    if (pending !== undefined) {
      const handle = await pending;
      const slot = this.slots.get(id);
      if (slot !== undefined) {
        slot.refCount++;
        slot.lastUsed = ++this.clock;
      }
      return handle;
    }

    this.misses++;
    const load = this.loadMesh(id);
    this.inFlight.set(id, load);
    try {
      const handle = await load;
      const slot: CacheSlot = { handle, refCount: 1, lastUsed: ++this.clock };
      this.slots.set(id, slot);
      this.residentBytes += handle.byteLength;
      this.evictIfNeeded();
      return handle;
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** 釋放一次參考。計數歸零後才可能被驅逐，但不會立刻釋放。 */
  release(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    slot.refCount = Math.max(0, slot.refCount - 1);
  }

  private async loadMesh(id: string): Promise<AssetHandle> {
    const manifest = this.manifest;
    assert(manifest !== null, '必須先呼叫 loadManifest');

    const entry = manifest.meshes[id];
    if (entry === undefined) throw new AssetFormatError(`manifest 裡沒有資產 "${id}"`);

    const buffer = await this.fetchBytes(this.baseUrl + entry.file);
    const bytes = new Uint8Array(buffer);
    const lods = decodeMesh(bytes, entry);

    return { id, lods, entry, byteLength: bytes.byteLength };
  }

  /**
   * 驅逐未被參考的資產直到回到預算內。
   *
   * 使用中的資產（refCount > 0）**絕不驅逐** —— 那會讓正在畫的東西
   * 從底下消失。若全部都在使用中，就記錄一次失敗並讓記憶體超出預算：
   * 超出預算是可觀察的問題，畫面破圖不是。
   */
  private evictIfNeeded(): void {
    if (this.residentBytes <= this.budgetBytes) return;

    const candidates = [...this.slots.entries()]
      .filter(([, slot]) => slot.refCount === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [id, slot] of candidates) {
      if (this.residentBytes <= this.budgetBytes) return;
      this.slots.delete(id);
      this.residentBytes -= slot.handle.byteLength;
      this.evictions++;
    }

    if (this.residentBytes > this.budgetBytes) this.evictionFailures++;
  }

  get stats(): CacheStats {
    return {
      resident: this.slots.size,
      residentBytes: this.residentBytes,
      budgetBytes: this.budgetBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      evictionFailures: this.evictionFailures,
    };
  }

  /** 場景切換時清空。使用中的資產也會被丟棄，呼叫端必須自行確保安全。 */
  clear(): void {
    this.slots.clear();
    this.inFlight.clear();
    this.residentBytes = 0;
  }
}
