import {
  NO_BACKEND_PROFILE,
  UNKNOWN_ADAPTER,
  type AdapterIdentity,
  type CapabilityProfile,
  type TextureCompressionFamily,
} from '@ww/core';

export interface ProbeOptions {
  /** 強制走 WebGL2 路徑，用來 A/B 驗證 fallback 是否正確降級。 */
  forceWebGL?: boolean | undefined;
  powerPreference?: GPUPowerPreference | undefined;
}

/**
 * 在建立 renderer **之前**探測硬體能力。
 *
 * 刻意用原生 WebGPU API 而不是透過 Three.js：我們要的是未經包裝的 adapter、
 * feature 與 limit 原始資料。Three.js 的 backend 會把 adapter 支援的所有 feature
 * 都放進 requiredFeatures，這對執行有利，但會讓「這台機器到底有什麼」變得不透明。
 */
export async function probeCapabilities(options: ProbeOptions = {}): Promise<CapabilityProfile> {
  if (!options.forceWebGL) {
    const webgpu = await probeWebGPU(options.powerPreference ?? 'high-performance');
    if (webgpu !== null) return webgpu;
  }

  const webgl2 = probeWebGL2(options.forceWebGL === true);
  if (webgl2 !== null) return webgl2;

  return { ...NO_BACKEND_PROFILE };
}

// ── WebGPU ────────────────────────────────────────────────────────────────

async function probeWebGPU(
  powerPreference: GPUPowerPreference,
): Promise<CapabilityProfile | null> {
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) return null;

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference });
  } catch {
    return null;
  }
  if (adapter === null) return null;

  const features = [...adapter.features].map(String).sort();
  const limits = readLimits(adapter.limits);
  const adapterIdentity = readAdapterIdentity(adapter);

  return {
    backend: 'webgpu',
    // 這三項是 WebGPU 的核心能力，不是可選 feature。它們正是 WebGL2 拿不到的東西。
    compute: true,
    indirectDraw: true,
    storageTextures: true,
    timestampQueries: adapter.features.has('timestamp-query'),
    textureCompression: compressionFamilies((name) => adapter.features.has(name)),
    maxTextureSize: limits['maxTextureDimension2D'] ?? 0,
    maxStorageBufferSize: limits['maxStorageBufferBindingSize'] ?? 0,
    maxBindGroups: limits['maxBindGroups'] ?? 0,
    outputHDR: detectHDRDisplay(),
    // WebGPU 的 multiview 沒有標準 feature 名稱；three 的 multiview 走 WebXR layers，
    // 必須在 XR session 建立時才能確認。M12 處理 XR 時再回來補。
    multiview: false,
    adapter: adapterIdentity,
    features,
    limits,
    failureReason: null,
  };
}

/**
 * GPUSupportedLimits 的欄位是定義在 prototype 上的 WebIDL getter，
 * 不能用 Object.keys()；for...in 會走 prototype chain 才拿得到。
 */
function readLimits(limits: GPUSupportedLimits): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key in limits) {
    const value = (limits as unknown as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * `adapter.info` 是目前規範的同步屬性；`isFallbackAdapter` 曾經在 adapter 上，
 * 後來搬進 info。兩個位置都讀，因為瀏覽器版本不一致。
 */
function readAdapterIdentity(adapter: GPUAdapter): AdapterIdentity {
  const info = (adapter as { info?: GPUAdapterInfo }).info;
  const legacyFallback = (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter;
  const infoFallback = (info as unknown as { isFallbackAdapter?: boolean } | undefined)
    ?.isFallbackAdapter;

  return {
    vendor: info?.vendor ?? '',
    architecture: info?.architecture ?? '',
    device: info?.device ?? '',
    description: info?.description ?? '',
    isFallbackAdapter: infoFallback ?? legacyFallback ?? false,
  };
}

// ── WebGL2 fallback ───────────────────────────────────────────────────────

/**
 * 規格要求 fallback 是**功能降級**，不是假裝與 WebGPU 相同。
 * 因此 compute / indirectDraw / storageTextures 在這條路徑上一律回 false，
 * 呼叫端必須自己處理少了這些能力的情況。
 */
function probeWebGL2(forced: boolean): CapabilityProfile | null {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (gl === null) return null;

  try {
    const extensions = gl.getSupportedExtensions() ?? [];
    const has = (name: string): boolean => extensions.includes(name);

    const limits: Record<string, number> = {
      maxTextureDimension2D: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxTextureArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
      max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,
      maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) as number,
      maxColorAttachments: gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number,
      maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
      maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number,
    };

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererString =
      debugInfo !== null
        ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '')
        : String(gl.getParameter(gl.RENDERER) ?? '');

    return {
      backend: 'webgl2',
      compute: false,
      indirectDraw: false,
      storageTextures: false,
      timestampQueries: has('EXT_disjoint_timer_query_webgl2'),
      textureCompression: compressionFamiliesWebGL(has),
      maxTextureSize: limits['maxTextureDimension2D'] ?? 0,
      maxStorageBufferSize: 0,
      maxBindGroups: 0,
      outputHDR: detectHDRDisplay(),
      multiview: has('OVR_multiview2'),
      adapter: {
        ...UNKNOWN_ADAPTER,
        vendor: debugInfo !== null ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '') : '',
        device: rendererString,
        description: rendererString,
        isFallbackAdapter: /swiftshader|software|llvmpipe|basic render/i.test(rendererString),
      },
      features: [...extensions].sort(),
      limits,
      failureReason: forced ? null : 'WebGPU unavailable; degraded to WebGL2',
    };
  } finally {
    // 探測用的 context 要主動釋放，否則會佔著一個 GL context 直到 GC
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ── 共用 ──────────────────────────────────────────────────────────────────

function compressionFamilies(has: (name: GPUFeatureName) => boolean): TextureCompressionFamily[] {
  const out: TextureCompressionFamily[] = [];
  if (has('texture-compression-bc')) out.push('bc');
  if (has('texture-compression-etc2')) out.push('etc2');
  if (has('texture-compression-astc')) out.push('astc');
  return out;
}

function compressionFamiliesWebGL(has: (name: string) => boolean): TextureCompressionFamily[] {
  const out: TextureCompressionFamily[] = [];
  if (has('WEBGL_compressed_texture_s3tc') || has('EXT_texture_compression_bptc')) out.push('bc');
  if (has('WEBGL_compressed_texture_etc')) out.push('etc2');
  if (has('WEBGL_compressed_texture_astc')) out.push('astc');
  return out;
}

/** 顯示器是否為 HDR。決定 tone mapping 的輸出目標。 */
function detectHDRDisplay(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(dynamic-range: high)').matches;
  } catch {
    return false;
  }
}
