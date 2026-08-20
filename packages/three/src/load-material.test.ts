import type { AssetManifest, MaterialEntry, TextureEntry } from '@web-world-engine/format';
import { createDefaultContainer, write } from 'ktx-parse';
import {
  MeshStandardMaterial,
  NoColorSpace,
  RED_GREEN_RGTC2_Format,
  RGBA_BPTC_Format,
  SRGBColorSpace,
  type CompressedTexture,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMaterial, loadTexture, releaseMaterial } from './load-material.ts';
import { clearAssetCache } from './manifest.ts';

/**
 * 這一組驗的東西有一個共同點：**壞掉的時候畫面還是會出來**。
 *
 * 色彩空間搞混只是「顏色不太對」，mip 沒接上只是「走動時會閃」，
 * 貼圖沒共用只是「VRAM 多了幾倍」—— 沒有一個會丟例外，也沒有一個會有人
 * 回報。所以只能在這裡把它們釘住。
 *
 * KTX2 用 `ktx-parse` 真的寫出來，不 mock：這條路的重點就是「解析器讀不讀
 * 得懂我們寫的東西」，mock 掉等於把要驗的那件事拿走。
 */

/** BC7 每個 4×4 區塊 16 位元組；BC5 也是 16。 */
const BLOCK_BYTES = 16;

function ktx2(vkFormat: number, size: number, mips: number): Uint8Array {
  const container = createDefaultContainer();
  container.vkFormat = vkFormat as typeof container.vkFormat;
  container.typeSize = 1;
  container.pixelWidth = size;
  container.pixelHeight = size;
  container.levelCount = mips;
  container.levels = [];
  for (let level = 0; level < mips; level++) {
    const edge = Math.max(4, size >> level);
    const bytes = (edge / 4) * (edge / 4) * BLOCK_BYTES;
    container.levels.push({
      levelData: new Uint8Array(bytes).fill(level + 1),
      uncompressedByteLength: bytes,
    });
  }
  return write(container, { keepWriter: true });
}

function textureEntry(id: string, vkFormat: number, size: number, mips: number): TextureEntry {
  return {
    id: id as TextureEntry['id'],
    contentHash: 'test',
    file: `${id.replace(':', '_')}.ktx2`,
    vkFormat,
    width: size,
    height: size,
    levelCount: mips,
    byteLength: 0 as TextureEntry['byteLength'],
    uncompressedBytes: 0 as TextureEntry['uncompressedBytes'],
  };
}

const ALBEDO_VK = 146; // BC7 sRGB
const NORMAL_VK = 141; // BC5 unorm —— 資料，不是顏色

const MANIFEST_URL = 'http://localhost/cooked/assets.manifest.json';

function buildManifest(): AssetManifest {
  const material: MaterialEntry = {
    id: 'material:rock' as MaterialEntry['id'],
    contentHash: 'test',
    baseColor: [0.5, 0.25, 0.125, 1],
    roughness: 0.8,
    metalness: 0.1,
    baseColorTexture: 'texture:rock-albedo',
    normalTexture: 'texture:rock-normal',
    roughnessAoTexture: 'texture:rock-orm',
  };
  return {
    schemaVersion: 1,
    cookerVersion: 'test',
    meshes: {},
    textures: {
      'texture:rock-albedo': textureEntry('texture:rock-albedo', ALBEDO_VK, 8, 2),
      'texture:rock-normal': textureEntry('texture:rock-normal', NORMAL_VK, 8, 2),
      'texture:rock-orm': textureEntry('texture:rock-orm', NORMAL_VK, 8, 2),
    },
    materials: { 'material:rock': material },
    warnings: [],
    stats: {},
  } as unknown as AssetManifest;
}

describe('WW.loadTexture / WW.loadMaterial', () => {
  let manifest: AssetManifest;
  let files: Map<string, Uint8Array>;

  beforeEach(() => {
    clearAssetCache();
    manifest = buildManifest();
    files = new Map([
      ['texture_rock-albedo.ktx2', ktx2(ALBEDO_VK, 8, 2)],
      ['texture_rock-normal.ktx2', ktx2(NORMAL_VK, 8, 2)],
      ['texture_rock-orm.ktx2', ktx2(NORMAL_VK, 8, 2)],
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('.json')) return { ok: true, json: async () => manifest } as Response;
        const name = url.split('/').pop() ?? '';
        const bytes = files.get(name);
        if (bytes === undefined) return { ok: false, status: 404 } as Response;
        return { ok: true, arrayBuffer: async () => bytes.buffer.slice(0) } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAssetCache();
  });

  it('BC 格式與色彩空間都對上 Three 的常數', async () => {
    const albedo = (await loadTexture(MANIFEST_URL, 'texture:rock-albedo')) as CompressedTexture;
    const normal = (await loadTexture(MANIFEST_URL, 'texture:rock-normal')) as CompressedTexture;

    expect(albedo.format).toBe(RGBA_BPTC_Format);
    expect(normal.format).toBe(RED_GREEN_RGTC2_Format);

    // 顏色是 sRGB、法線是資料。反過來的話畫面只是「顏色怪怪的」。
    expect(albedo.colorSpace).toBe(SRGBColorSpace);
    expect(normal.colorSpace).toBe(NoColorSpace);
  });

  it('cook 好的 mip 被接上，而不是丟給 GPU 重算', async () => {
    const texture = (await loadTexture(MANIFEST_URL, 'texture:rock-albedo')) as CompressedTexture;

    expect(texture.mipmaps?.length).toBe(2);
    expect(texture.mipmaps?.[0]).toMatchObject({ width: 8, height: 8 });
    expect(texture.mipmaps?.[1]).toMatchObject({ width: 4, height: 4 });

    // 這兩條缺任何一條，遠處的貼圖就會在最高階上取樣，走動時整片閃爍。
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.minFilter).not.toBe(texture.magFilter);
  });

  it('同一張貼圖只抓一次，而且是同一個實例', async () => {
    const a = await loadTexture(MANIFEST_URL, 'texture:rock-albedo');
    const b = await loadTexture(MANIFEST_URL, 'texture:rock-albedo');

    // 兩個 Texture 包同一份位元組的話，Three 會依實例上傳 —— VRAM 加倍，
    // 而畫面完全正常。
    expect(a).toBe(b);
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('.ktx2'))).toHaveLength(
      1,
    );
  });

  it('材質把三張貼圖接到對的插槽，ORM 共用同一個實例', async () => {
    const material = await loadMaterial(MANIFEST_URL, 'material:rock');

    expect(material.map).not.toBeNull();
    expect(material.normalMap).not.toBeNull();
    expect(material.roughness).toBe(0.8);
    expect(material.metalness).toBe(0.1);

    // R = AO、G = roughness，同一張。分成兩個 Texture 就是為完全一樣的
    // 位元組付兩次頻寬。
    expect(material.aoMap).toBe(material.roughnessMap);
    expect(material.aoMap).toBe(await loadTexture(MANIFEST_URL, 'texture:rock-orm'));
  });

  it('baseColor 當成線性值寫入，不再被轉換一次', async () => {
    const material = await loadMaterial(MANIFEST_URL, 'material:rock');

    // 走 `new Color(r, g, b)` 的話會被當成 sRGB 再轉一次，值會掉到 ~0.21。
    expect(material.color.r).toBeCloseTo(0.5, 5);
    expect(material.color.g).toBeCloseTo(0.25, 5);
  });

  it('材質少一張貼圖不是錯誤，就是少接一個插槽', async () => {
    manifest.materials['material:rock']!.normalTexture = null;

    const material = await loadMaterial(MANIFEST_URL, 'material:rock');

    expect(material.normalMap).toBeNull();
    expect(material.map).not.toBeNull();
  });

  it('mip 長度與尺寸對不上時明確失敗，不把亂資料送進 GPU', async () => {
    // 宣告 8×8（4 個區塊）但只給 4×4 的資料量。GPU 那一側拿到的會是一張
    // 「只是比較糊」的貼圖，或是一句沒有上下文的 validation error。
    const container = createDefaultContainer();
    container.vkFormat = ALBEDO_VK as typeof container.vkFormat;
    container.typeSize = 1;
    container.pixelWidth = 8;
    container.pixelHeight = 8;
    container.levelCount = 1;
    container.levels = [
      { levelData: new Uint8Array(BLOCK_BYTES), uncompressedByteLength: BLOCK_BYTES },
    ];
    files.set('texture_rock-albedo.ktx2', write(container, { keepWriter: true }));

    await expect(loadTexture(MANIFEST_URL, 'texture:rock-albedo')).rejects.toThrow(/資料不一致/);
  });

  it('傳網格 id 就跟著它的材質連結走', async () => {
    manifest.meshes['material:rock'] = {
      material: 'material:rock',
    } as unknown as AssetManifest['meshes'][string];

    // cooker 的材質命名是內部的；使用者手上有的是網格 id。
    expect(await loadMaterial(MANIFEST_URL, 'material:rock')).toBe(
      await loadMaterial(MANIFEST_URL, 'material:rock'),
    );
  });

  it('網格沒有材質時說出來，而不是給一個看起來正常的白模', async () => {
    manifest.meshes['mesh:bare'] = {
      material: null,
    } as unknown as AssetManifest['meshes'][string];

    await expect(loadMaterial(MANIFEST_URL, 'mesh:bare')).rejects.toThrow(/沒有材質/);
  });

  it('id 打錯時把有哪些可選一起講出來', async () => {
    await expect(loadTexture(MANIFEST_URL, 'texture:nope')).rejects.toThrow(/texture:rock-albedo/);
    await expect(loadMaterial(MANIFEST_URL, 'material:nope')).rejects.toThrow(/material:rock/);
  });

  it('抓不到檔案時說出是哪一個', async () => {
    files.delete('texture_rock-albedo.ktx2');
    await expect(loadTexture(MANIFEST_URL, 'texture:rock-albedo')).rejects.toThrow(/HTTP 404/);
  });

  describe('放掉貼圖：GPU 那一份要真的還回去', () => {
    it('clearAssetCache 會 dispose，不是只把 Map 清掉', async () => {
      // Three 釋放 VRAM 靠 `dispose()`，不是靠垃圾回收。只清 Map 的話 JS 這側
      // 乾淨了、GPU 那張貼圖永遠留著 —— 串流的世界裡那是無上限的洩漏，而且
      // 畫面完全正常直到配置失敗為止。
      const texture = await loadTexture(MANIFEST_URL, 'texture:rock-albedo');
      const disposed = vi.fn();
      texture.addEventListener('dispose', disposed);

      clearAssetCache();
      // dispose 是在 promise 裡做的，等幾輪微任務。
      await Promise.resolve();
      await Promise.resolve();
      expect(disposed).toHaveBeenCalled();
    });

    it('releaseMaterial 只放掉那一份，之後重新載入拿到新的', async () => {
      const material = await loadMaterial(MANIFEST_URL, 'material:rock');
      const map = material.map!;
      const disposed = vi.fn();
      map.addEventListener('dispose', disposed);

      expect(releaseMaterial(MANIFEST_URL, 'material:rock')).toBe(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(disposed).toHaveBeenCalled();

      // 放過之後再要一次要**重新載入**，不是拿到一個已經釋放的空殼 ——
      // 拿到空殼的話畫面上是黑的，而且不會報錯。
      const again = await loadMaterial(MANIFEST_URL, 'material:rock');
      expect(again).not.toBe(material);
    });

    it('沒被快取過的回 false，不會炸', () => {
      expect(releaseMaterial(MANIFEST_URL, 'material:rock')).toBe(false);
    });
  });

  describe('給哪一種材質類別', () => {
    /**
     * ## 為什麼要能換類別
     *
     * WebGPU 上 `MeshStandardMaterial` **不是 node 材質**（換掉是
     * `WebGPURenderer` 內部做的）。而套件裡往呼叫端材質上加東西的功能
     * 只加得上 node 材質 —— 沒有這個口的話，照文件走的人一用
     * `loadMaterial` 就再也接不上那四個，而症狀是靜靜地什麼都沒發生。
     */
    it('用得到給進去的那一個', async () => {
      class Fake extends MeshStandardMaterial {}
      const material = await loadMaterial(MANIFEST_URL, 'material:rock', {
        MaterialClass: Fake,
      });
      expect(material).toBeInstanceOf(Fake);
      // 貼圖與參數照樣接上 —— 換的只有類別。
      expect(material.roughness).toBeGreaterThan(0);
    });

    /**
     * 快取的鍵要帶著類別。不帶的話第二次會拿到第一次那一份 —— 而那正是
     * 這個參數本來要解決的事（「WebGPU 上接不上」）。
     */
    it('兩種類別各拿到自己那一份', async () => {
      class Fake extends MeshStandardMaterial {}
      const plain = await loadMaterial(MANIFEST_URL, 'material:rock');
      const fake = await loadMaterial(MANIFEST_URL, 'material:rock', { MaterialClass: Fake });
      expect(plain).not.toBe(fake);
      expect(fake).toBeInstanceOf(Fake);
      expect(plain).not.toBeInstanceOf(Fake);
    });

    /** 放掉一個 id 要把它的每一種變體都放掉，不然剩下那份還掛著貼圖。 */
    it('releaseMaterial 放掉所有變體', async () => {
      class Fake extends MeshStandardMaterial {}
      await loadMaterial(MANIFEST_URL, 'material:rock');
      await loadMaterial(MANIFEST_URL, 'material:rock', { MaterialClass: Fake });
      expect(releaseMaterial(MANIFEST_URL, 'material:rock')).toBe(true);
      expect(releaseMaterial(MANIFEST_URL, 'material:rock')).toBe(false);
    });
  });
});
