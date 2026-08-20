import {
  decodeBc1,
  decodeBc4,
  decodeBc7,
  encodeBc1,
  encodeBc4,
  encodeBc5,
  encodeBc7,
} from '@web-world-engine/cook/texture';
import type { BenchmarkScene, SceneDefinition, SceneVerdict } from './types.ts';

/**
 * 貼圖編碼器的 GPU 一致性驗證。
 *
 * ## 為什麼需要這個場景
 *
 * BC1/BC4/BC5/BC7 編碼器都是自己寫的（見 packages/cook/src/texture）。
 * 單元測試用「encode → 自寫的 decode → 比對原圖」驗證，但那**只證明編碼器
 * 與我的解碼器彼此一致**，不證明兩者符合規格。如果我對格式的理解從一開始
 * 就錯了，encode/decode 會一起錯，測試照樣全綠 —— 這正是 ADR 0004 反覆
 * 遇到的那個型態：「看起來在運作，但量到的不是你以為的東西」。
 *
 * 真正的裁判是 **GPU 的硬體解碼器**。這個場景做的事：
 *
 * 1. 用編碼器壓一張已知的測試圖
 * 2. 上傳成壓縮貼圖，用 `textureLoad` 逐 texel 取樣到 rgba8unorm render target
 * 3. 讀回像素
 * 4. 與**我自己的 CPU 解碼器**逐位元比對
 *
 * 第 4 步是重點。GPU 與 CPU 解碼結果一致，就證明我對位元佈局、端點展開、
 * 內插權重的理解與矽晶片一致；不一致就是規格 bug，而且會直接指出是哪個格式。
 *
 * 同時也回報「GPU 解碼 vs 原圖」的誤差，那是編碼器的品質指標。
 *
 * ## 驗不到就是失敗，不是通過
 *
 * 若裝置沒有 `texture-compression-bc`，這個場景判定**失敗**而不是靜默跳過。
 * 本引擎的目標平台是桌機 WebGPU，而桌機一律有 BC —— 沒有 BC 代表執行環境
 * 出了問題，那正是應該讓 CI 紅燈的情況。
 *
 * ## 為什麼自己開 device
 *
 * 不借用 three 的 renderer device：那個 device 要求哪些 feature 由 three
 * 決定，會讓「格式支援與否」這件事取決於 renderer 版本。自己開一個並明確
 * 要求所有可得的壓縮 feature，測的才是裝置本身的能力。
 */

const SIZE = 64;

/** 讀回 buffer 的 bytesPerRow 必須是 256 的倍數；64px × RGBA8 剛好 256。 */
const BYTES_PER_ROW = SIZE * 4;

interface FormatCase {
  id: string;
  /** WebGPU 的貼圖格式名稱。 */
  gpuFormat: GPUTextureFormat;
  /** 需要的 device feature。 */
  feature: GPUFeatureName;
  blockBytes: number;
  encode: (pixels: Uint8Array, width: number, height: number) => Uint8Array;
  /** 自寫的 CPU 解碼，輸出 RGBA8。用來與 GPU 的解碼結果比對。 */
  decode: (data: Uint8Array, width: number, height: number) => Uint8Array;
  /** 這個格式在 GPU 取樣時會回傳哪些通道，其餘由硬體補 0/1。 */
  channels: 1 | 2 | 3 | 4;
  /**
   * GPU 解碼與原圖的平均誤差上限（0–255）。
   *
   * 這是**退化偵測**而不是品質目標：數值取自 Intel gen-12lp 上的實測再加
   * 約 35% 餘裕。編碼器改動後若誤差衝破這條線，就是改壞了。絕對值大小
   * 沒有意義（取決於測試圖內容），有意義的是它不該變大。
   */
  qualityLimit: number;
}

/**
 * GPU 與自寫解碼器允許的最大差值。
 *
 * BC1/BC4/BC5 的內插（1/3、2/3、1/7…）在 D3D 規格裡是「容許誤差內的實作
 * 自由」，各家硬體的取整不同，實測就是差 1。BC7 的內插則有精確定義，
 * 實測 16384 個通道**完全相同**。所以「BC7 為 0、其餘為 1」不是巧合，
 * 是規格本來就這樣。差 2 以上代表位元佈局或端點展開理解錯了。
 */
const MAX_DECODER_DIFF = 1;

/** BC4/BC5 只有 R（RG）通道，把單通道結果攤成 RGBA 好與 GPU 輸出比對。 */
function expandChannels(planes: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = planes[0]?.[i] ?? 0;
    out[i * 4 + 1] = planes[1]?.[i] ?? 0;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

const CASES: FormatCase[] = [
  {
    id: 'bc1',
    gpuFormat: 'bc1-rgba-unorm',
    feature: 'texture-compression-bc',
    blockBytes: 8,
    encode: encodeBc1,
    decode: decodeBc1,
    channels: 3,
    qualityLimit: 11, // 實測 8.42
  },
  {
    id: 'bc4',
    gpuFormat: 'bc4-r-unorm',
    feature: 'texture-compression-bc',
    blockBytes: 8,
    encode: encodeBc4,
    decode: (data, w, h) => expandChannels([decodeBc4(data, w, h)], w),
    channels: 1,
    qualityLimit: 1.5, // 實測 0.95
  },
  {
    id: 'bc5',
    gpuFormat: 'bc5-rg-unorm',
    feature: 'texture-compression-bc',
    blockBytes: 16,
    encode: encodeBc5,
    decode: (data, w, h) =>
      expandChannels([decodeBc4(data, w, h, 16, 0), decodeBc4(data, w, h, 16, 8)], w),
    channels: 2,
    qualityLimit: 1.3, // 實測 0.82
  },
  {
    id: 'bc7',
    gpuFormat: 'bc7-rgba-unorm',
    feature: 'texture-compression-bc',
    blockBytes: 16,
    encode: encodeBc7,
    decode: decodeBc7,
    channels: 4,
    qualityLimit: 9, // 實測 6.70
  },
];

/**
 * 測試圖：漸層 + 反相關通道 + 雜訊 + 純色塊。
 *
 * 每一種內容都針對一類編碼器錯誤：漸層測內插權重、反相關通道測端點
 * 對角線方向、雜訊測索引搜尋、純色塊測端點量化。用單一種內容的圖會漏掉
 * 其中大部分。
 */
function testImage(): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const quadrant = (y < SIZE / 2 ? 0 : 2) + (x < SIZE / 2 ? 0 : 1);
      const t = Math.round((x / (SIZE - 1)) * 255);
      if (quadrant === 0) {
        // 漸層，且紅升綠降（反相關）
        pixels[i] = t;
        pixels[i + 1] = 255 - t;
        pixels[i + 2] = 128;
        pixels[i + 3] = 255;
      } else if (quadrant === 1) {
        // 以 2×2 為單位的雜訊，不是逐像素亂數。
        //
        // 逐像素亂數在 4×4 區塊裡完全不成一條線，任何區塊壓縮器都必然
        // 有巨大誤差 —— 那不是編碼器的問題，而且真實貼圖不長那樣
        // （真實內容都有空間相關性）。用不可壓縮的內容當品質基準，
        // 量到的只會是「格式的下限」，對偵測編碼器退化毫無鑑別力。
        const cellX = x >> 1;
        const cellY = y >> 1;
        let h = (cellX * 73856093) ^ (cellY * 19349663);
        h = (h ^ (h >>> 13)) >>> 0;
        pixels[i] = h & 0xff;
        pixels[i + 1] = (h >>> 8) & 0xff;
        pixels[i + 2] = (h >>> 16) & 0xff;
        pixels[i + 3] = 255;
      } else if (quadrant === 2) {
        pixels[i] = 200;
        pixels[i + 1] = 60;
        pixels[i + 2] = 30;
        pixels[i + 3] = 255;
      } else {
        const v = Math.round((y / (SIZE - 1)) * 255);
        pixels[i] = v;
        pixels[i + 1] = v;
        pixels[i + 2] = v;
        pixels[i + 3] = 255;
      }
    }
  }
  return pixels;
}

const SHADER = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // 全螢幕三角形，不需要頂點 buffer
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@group(0) @binding(0) var tex: texture_2d<f32>;

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // 用 textureLoad 而非取樣器：完全不經過過濾，拿到的就是硬體解碼的 texel
  return textureLoad(tex, vec2i(pos.xy), 0);
}
`;

interface CaseResult {
  id: string;
  status: 'pass' | 'fail' | 'skipped';
  detail: string;
  /** GPU 解碼相對原圖的平均誤差（0–255）。無法量測時為 NaN。 */
  quality: number;
}

async function runCase(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  source: Uint8Array,
  spec: FormatCase,
): Promise<CaseResult> {
  const blocks = SIZE / 4;
  const encoded = spec.encode(source, SIZE, SIZE);
  const expectedBytes = blocks * blocks * spec.blockBytes;
  if (encoded.byteLength !== expectedBytes) {
    return {
      id: spec.id,
      status: 'fail',
      detail: `編碼輸出 ${encoded.byteLength} 位元組，格式要求 ${expectedBytes}`,
      quality: Number.NaN,
    };
  }

  const texture = device.createTexture({
    size: [SIZE, SIZE],
    format: spec.gpuFormat,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const target = device.createTexture({
    size: [SIZE, SIZE],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: BYTES_PER_ROW * SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  try {
    device.queue.writeTexture(
      { texture },
      // 編碼器回傳的 Uint8Array 泛型是 ArrayBufferLike，WebGPU 的型別要求
      // ArrayBuffer。編碼器一律用 `new Uint8Array(n)` 配置，不可能是
      // SharedArrayBuffer，因此這個收窄是安全的。
      encoded as Uint8Array<ArrayBuffer>,
      { bytesPerRow: blocks * spec.blockBytes, rowsPerImage: blocks },
      [SIZE, SIZE],
    );

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: texture.createView() }],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: BYTES_PER_ROW },
      [SIZE, SIZE],
    );
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    const gpu = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();

    // 品質：GPU 解碼 vs 原圖
    let qualityTotal = 0;
    let qualityCount = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      for (let c = 0; c < Math.min(spec.channels, 3); c++) {
        qualityTotal += Math.abs(gpu[i * 4 + c]! - source[i * 4 + c]!);
        qualityCount++;
      }
    }
    const quality = qualityTotal / qualityCount;

    // 一致性：GPU 解碼 vs 自寫的 CPU 解碼。這才是 conformance 的核心。
    const cpu = spec.decode(encoded, SIZE, SIZE);
    let maxDiff = 0;
    let diffCount = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      for (let c = 0; c < spec.channels; c++) {
        const d = Math.abs(gpu[i * 4 + c]! - cpu[i * 4 + c]!);
        if (d > maxDiff) maxDiff = d;
        if (d > 0) diffCount++;
      }
    }

    const ok = maxDiff <= MAX_DECODER_DIFF && quality <= spec.qualityLimit;
    return {
      id: spec.id,
      status: ok ? 'pass' : 'fail',
      detail:
        `GPU vs 自寫解碼：最大差 ${maxDiff}、有差異的通道 ${diffCount}/${SIZE * SIZE * spec.channels}；` +
        `對原圖誤差 ${quality.toFixed(2)}（上限 ${spec.qualityLimit}）`,
      quality,
    };
  } finally {
    texture.destroy();
    target.destroy();
    readback.destroy();
  }
}

export const textureConformanceScene: SceneDefinition = {
  id: 'texture-conformance',
  title: '貼圖編碼器 GPU 一致性',
  measures: '自寫的 BC1/BC4/BC5/BC7 編碼器，其輸出能否被硬體解碼器正確解讀',
  async create(): Promise<BenchmarkScene> {
    const results: CaseResult[] = [];
    const notes: string[] = [];
    let device: GPUDevice | null = null;

    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter === undefined || adapter === null) {
      notes.push('沒有 WebGPU adapter，無法驗證任何格式');
    } else {
      const wanted: GPUFeatureName[] = ['texture-compression-bc'];
      const available = wanted.filter((f) => adapter.features.has(f));
      notes.push(
        available.length > 0 ? `裝置支援：${available.join('、')}` : '裝置不支援任何壓縮貼圖格式',
      );

      device = await adapter.requestDevice({ requiredFeatures: available });
      const module = device.createShaderModule({ code: SHADER });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });

      const source = testImage();
      for (const spec of CASES) {
        if (!available.includes(spec.feature)) {
          results.push({
            id: spec.id,
            status: 'skipped',
            detail: `裝置缺少 ${spec.feature}`,
            quality: Number.NaN,
          });
          continue;
        }
        try {
          results.push(await runCase(device, pipeline, source, spec));
        } catch (error) {
          results.push({
            id: spec.id,
            status: 'fail',
            detail: error instanceof Error ? error.message : String(error),
            quality: Number.NaN,
          });
        }
      }
    }

    for (const result of results) {
      notes.push(`${result.id}：${result.status} —— ${result.detail}`);
    }

    const failed = results.filter((r) => r.status === 'fail');
    const passed = results.filter((r) => r.status === 'pass');
    const skipped = results.filter((r) => r.status === 'skipped');

    return {
      update(): void {
        // 驗證在 create 時就跑完了；量測迴圈沒有工作要做
      },
      render(): void {
        // 不畫任何東西：這個場景的產出是 verdict，不是幀時間
      },
      reportParams: {
        formatsPassed: passed.length,
        formatsFailed: failed.length,
        formatsSkipped: skipped.length,
      },
      verdict(): SceneVerdict {
        if (failed.length > 0) {
          // 失敗的細節必須寫進 verdict 本身：場景失敗時 runner 不會保留
          // notes，只留下這一行。少了細節就得重跑一次才知道差在哪。
          return {
            ok: false,
            detail:
              `${failed.length} 個格式與硬體解碼器不一致 —— ` +
              failed.map((f) => `[${f.id}] ${f.detail}`).join('；'),
          };
        }
        if (passed.length === 0) {
          return {
            ok: false,
            detail: '沒有任何格式被驗證 —— 這個場景在無法驗證時不算通過',
          };
        }
        const skippedNote =
          skipped.length > 0
            ? `；${skipped.length} 個格式因裝置不支援而未驗證（${skipped.map((s) => s.id).join('、')}）`
            : '';
        return {
          ok: true,
          detail:
            `${passed.length} 個格式與硬體解碼器一致（` +
            passed.map((p) => `${p.id} ${p.quality.toFixed(2)}`).join('、') +
            `，數字為對原圖的平均誤差）${skippedNote}`,
        };
      },
      notes,
      dispose(): void {
        device?.destroy();
      },
    };
  },
};
