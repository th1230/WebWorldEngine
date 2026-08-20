import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCapabilities } from './capability-probe.ts';

/**
 * WebGPU 的 `GPUSupportedLimits` 把欄位定義成 prototype 上的 WebIDL getter，
 * `Object.keys()` 讀不到。這裡刻意用同樣的形狀，確保 probe 真的走 for...in。
 */
function fakeLimits(values: Record<string, number>): object {
  const proto: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(proto, key, { get: () => value, enumerable: true });
  }
  return Object.create(proto) as object;
}

interface FakeAdapterOptions {
  features?: string[];
  limits?: Record<string, number>;
  info?: Record<string, unknown>;
  legacyIsFallback?: boolean;
}

function stubWebGPU(options: FakeAdapterOptions | null): void {
  if (options === null) {
    vi.stubGlobal('navigator', {});
    return;
  }
  const adapter = {
    features: new Set(options.features ?? []),
    limits: fakeLimits(options.limits ?? {}),
    info: options.info,
    ...(options.legacyIsFallback !== undefined
      ? { isFallbackAdapter: options.legacyIsFallback }
      : {}),
  };
  vi.stubGlobal('navigator', { gpu: { requestAdapter: () => Promise.resolve(adapter) } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeCapabilities on WebGPU', () => {
  it('reads limits defined as prototype getters', async () => {
    stubWebGPU({
      limits: {
        maxTextureDimension2D: 16384,
        maxStorageBufferBindingSize: 2147483644,
        maxBindGroups: 4,
      },
    });

    const profile = await probeCapabilities();

    expect(profile.backend).toBe('webgpu');
    expect(profile.maxTextureSize).toBe(16384);
    expect(profile.maxStorageBufferSize).toBe(2147483644);
    expect(profile.maxBindGroups).toBe(4);
    // 原始 limits 全部保留，之後不必重新探測
    expect(profile.limits['maxTextureDimension2D']).toBe(16384);
  });

  it('treats compute, indirect draw and storage textures as core WebGPU capabilities', async () => {
    stubWebGPU({});
    const profile = await probeCapabilities();

    expect(profile.compute).toBe(true);
    expect(profile.indirectDraw).toBe(true);
    expect(profile.storageTextures).toBe(true);
  });

  it('maps texture compression features to families', async () => {
    stubWebGPU({ features: ['texture-compression-bc', 'texture-compression-astc'] });
    const profile = await probeCapabilities();

    expect(profile.textureCompression).toEqual(['bc', 'astc']);
  });

  it('reports no compression when the adapter exposes none', async () => {
    stubWebGPU({ features: [] });
    expect((await probeCapabilities()).textureCompression).toEqual([]);
  });

  it('detects timestamp-query support', async () => {
    stubWebGPU({ features: ['timestamp-query'] });
    expect((await probeCapabilities()).timestampQueries).toBe(true);

    stubWebGPU({ features: [] });
    expect((await probeCapabilities()).timestampQueries).toBe(false);
  });

  it('sorts features so the cache key is order-independent', async () => {
    stubWebGPU({ features: ['timestamp-query', 'texture-compression-bc'] });
    const a = await probeCapabilities();
    stubWebGPU({ features: ['texture-compression-bc', 'timestamp-query'] });
    const b = await probeCapabilities();

    expect(a.features).toEqual(b.features);
  });

  it('reads isFallbackAdapter from adapter.info', async () => {
    stubWebGPU({ info: { vendor: 'google', device: 'SwiftShader', isFallbackAdapter: true } });
    const profile = await probeCapabilities();

    expect(profile.adapter.isFallbackAdapter).toBe(true);
    expect(profile.adapter.vendor).toBe('google');
  });

  it('falls back to the legacy adapter.isFallbackAdapter location', async () => {
    // 這個旗標曾經在 adapter 上，後來搬進 info；瀏覽器版本不一致，兩處都要讀
    stubWebGPU({ info: { vendor: 'x' }, legacyIsFallback: true });
    expect((await probeCapabilities()).adapter.isFallbackAdapter).toBe(true);
  });

  it('defaults to a non-fallback adapter when neither location reports it', async () => {
    stubWebGPU({ info: { vendor: 'nvidia' } });
    expect((await probeCapabilities()).adapter.isFallbackAdapter).toBe(false);
  });

  it('survives an adapter with no info at all', async () => {
    stubWebGPU({});
    const profile = await probeCapabilities();

    expect(profile.adapter.vendor).toBe('');
    expect(profile.adapter.device).toBe('');
    expect(profile.failureReason).toBeNull();
  });
});

describe('probeCapabilities without a GPU', () => {
  it('reports the no-backend profile instead of throwing', async () => {
    // node 環境沒有 navigator.gpu 也沒有 document，兩條路徑都走不通
    stubWebGPU(null);
    const profile = await probeCapabilities();

    expect(profile.backend).toBe('none');
    expect(profile.compute).toBe(false);
    expect(profile.failureReason).not.toBeNull();
  });

  it('does not reach WebGPU when forceWebGL is set', async () => {
    const requestAdapter = vi.fn(() => Promise.resolve(null));
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });

    const profile = await probeCapabilities({ forceWebGL: true });

    expect(requestAdapter).not.toHaveBeenCalled();
    expect(profile.backend).toBe('none'); // node 裡沒有 document，退不到 WebGL2
  });

  it('treats a rejected requestAdapter as no WebGPU rather than crashing', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: () => Promise.reject(new Error('blocked')) },
    });

    await expect(probeCapabilities()).resolves.toMatchObject({ backend: 'none' });
  });

  it('treats a null adapter as no WebGPU', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: () => Promise.resolve(null) } });
    await expect(probeCapabilities()).resolves.toMatchObject({ backend: 'none' });
  });
});
