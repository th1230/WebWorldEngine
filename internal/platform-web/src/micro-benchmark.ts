/**
 * 開機微量測。
 *
 * 規格明確禁止「RTX 4060 → High」這種靠 GPU 名稱比對的分級 —— 名稱清單永遠追不上
 * 新硬體，而且瀏覽器常常不告訴你真正的型號。所以我們實際跑兩個極小的測試來量。
 *
 * 這裡刻意使用原生 WebGPU 而不是 Three.js：分級必須在 renderer 建立之前就完成，
 * 而且 platform-web 依架構規則不得依賴 three（見 eslint.config.js）。
 *
 * 用完即銷毀自己的 device，不與 renderer 的 device 共用。
 */

export interface MicroBenchmarkResult {
  /** 相對於參考機器的分數，1.0 約等於桌機中階。 */
  computeScore: number;
  fillScore: number;
  /** 兩者的加權合成。tier 分類用這個。 */
  compositeScore: number;
  /** 取得 device 與編譯 pipeline 的一次性成本，不計入預算。 */
  setupMs: number;
  /** 實際量測所花的時間，預算就是管這一段。 */
  measuredMs: number;
  durationMs: number;
  /**
   * 量測時間太短或被中斷時為 false。
   * 不可靠時 **不要**拿來分級 —— 寧可只用硬性門檻，也不要用雜訊決定畫質。
   */
  reliable: boolean;
  notes: string[];
}

export interface MicroBenchmarkOptions {
  /** 總預算。超過就跳過還沒跑的子測試。 */
  budgetMs?: number | undefined;
  powerPreference?: GPUPowerPreference | undefined;
}

/**
 * 預算涵蓋的是**量測階段**（含各子測試自己的 pipeline 編譯），
 * 但**不含**取得 adapter 與 device 的時間。
 *
 * 這個區分是第一次在真實硬體跑 baseline 學到的：在 Intel 內顯上，光是
 * requestAdapter + requestDevice 就吃掉舊有 200ms 預算的絕大部分，於是 fill
 * 子測試永遠被跳過、結果永遠標記為不可靠、分級永遠退回保守預設 ——
 * 微量測看起來有在跑，實際上從來沒有產生過可用的分數。
 *
 * 取得 device 是一次性成本，不該排擠掉量測本身。
 */
const DEFAULT_BUDGET_MS = 300;

/** 量測時間短於這個值就是雜訊，不足以分級。 */
const MIN_RELIABLE_MS = 2;

/**
 * 參考常數：把原始吞吐量正規化成分數，1.0 約等於桌機中階。
 *
 * ## 校準狀態：只有一個資料點
 *
 * 目前依 Intel gen-12lp 內顯（WebGPU / Chrome）實測校準，讓它落在 Tier 1
 * （Entry / iGPU），也就是 composite ≈ 0.30：
 *
 *   compute  6.0e10 ops/s  →  0.30
 *   fill     3.4e11 ops/s  →  0.30
 *
 * 初版的 fill 參考值估成 6.0e10，比實測低了將近 20 倍，導致一台內顯被判成
 * Tier 3。這說明**憑直覺猜吞吐量是不可行的**，必須用量的。
 *
 * 一個資料點不足以定義完整的分級曲線。每在新的一類硬體（獨顯、Apple Silicon、
 * 行動裝置）跑過 baseline，就應該回來補一筆並重新檢視門檻。
 * 見 specs/01-capability-tier.md。
 */
const REFERENCE_COMPUTE_OPS_PER_SEC = 2.0e11;
const REFERENCE_FILL_OPS_PER_SEC = 1.15e12;

const COMPUTE_INVOCATIONS = 64 * 1024;
const COMPUTE_WORKGROUP_SIZE = 64;
const COMPUTE_ITERATIONS = 256;
const COMPUTE_SUBMITS = 8;

const FILL_SIZE = 1024;
const FILL_ITERATIONS = 128;
const FILL_SUBMITS = 8;

const COMPUTE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&data)) { return; }
  var acc = data[i] + 1.0;
  for (var k = 0u; k < ${COMPUTE_ITERATIONS}u; k = k + 1u) {
    acc = fma(acc, 1.0000001, 0.0000001);
  }
  data[i] = acc;
}
`;

const FILL_WGSL = /* wgsl */ `
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out: VOut;
  let c = corners[i];
  out.pos = vec4<f32>(c, 0.0, 1.0);
  out.uv = c * 0.5 + vec2<f32>(0.5, 0.5);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  var acc = vec4<f32>(in.uv, 0.5, 1.0);
  for (var k = 0u; k < ${FILL_ITERATIONS}u; k = k + 1u) {
    acc = fma(acc, vec4<f32>(1.0000001), vec4<f32>(0.0000001));
  }
  return acc;
}
`;

export async function runMicroBenchmark(
  options: MicroBenchmarkOptions = {},
): Promise<MicroBenchmarkResult | null> {
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) return null;

  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const notes: string[] = [];
  const started = performance.now();

  let device: GPUDevice;
  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: options.powerPreference ?? 'high-performance',
    });
    if (adapter === null) return null;
    device = await adapter.requestDevice();
  } catch (error) {
    return {
      computeScore: 0,
      fillScore: 0,
      compositeScore: 0,
      setupMs: performance.now() - started,
      measuredMs: 0,
      durationMs: performance.now() - started,
      reliable: false,
      notes: [`requestDevice failed: ${errorMessage(error)}`],
    };
  }

  const setupMs = performance.now() - started;
  const measureStarted = performance.now();

  // device 在量測途中遺失時要能立即放棄，而不是卡在 onSubmittedWorkDone
  let deviceLost = false;
  void device.lost.then(() => {
    deviceLost = true;
  });

  let computeOpsPerSec = 0;
  let fillOpsPerSec = 0;
  let reliable = true;

  try {
    const compute = await measureCompute(device);
    if (compute === null) {
      reliable = false;
      notes.push('compute 子測試失敗');
    } else {
      computeOpsPerSec = compute.opsPerSec;
      if (compute.elapsedMs < MIN_RELIABLE_MS) {
        reliable = false;
        notes.push(`compute 只花了 ${compute.elapsedMs.toFixed(2)}ms，低於可信門檻`);
      }
    }

    if (deviceLost) {
      notes.push('device 在量測途中遺失');
      reliable = false;
    } else if (performance.now() - measureStarted > budgetMs) {
      notes.push(
        `量測已用 ${(performance.now() - measureStarted).toFixed(0)}ms 超出 ${budgetMs}ms 預算，跳過 fill 子測試`,
      );
      reliable = false;
    } else {
      const fill = await measureFill(device);
      if (fill === null) {
        reliable = false;
        notes.push('fill 子測試失敗');
      } else {
        fillOpsPerSec = fill.opsPerSec;
        if (fill.elapsedMs < MIN_RELIABLE_MS) {
          reliable = false;
          notes.push(`fill 只花了 ${fill.elapsedMs.toFixed(2)}ms，低於可信門檻`);
        }
      }
    }
  } catch (error) {
    reliable = false;
    notes.push(`量測發生例外: ${errorMessage(error)}`);
  } finally {
    // 探測用的 device 一定要銷毀。GPU 資源不會等 JavaScript GC。
    device.destroy();
  }

  const computeScore = computeOpsPerSec / REFERENCE_COMPUTE_OPS_PER_SEC;
  const fillScore = fillOpsPerSec / REFERENCE_FILL_OPS_PER_SEC;

  return {
    computeScore,
    fillScore,
    compositeScore: 0.5 * computeScore + 0.5 * fillScore,
    setupMs,
    measuredMs: performance.now() - measureStarted,
    durationMs: performance.now() - started,
    reliable,
    notes,
  };
}

interface SubMeasurement {
  elapsedMs: number;
  opsPerSec: number;
}

async function measureCompute(device: GPUDevice): Promise<SubMeasurement | null> {
  device.pushErrorScope('validation');

  const byteLength = COMPUTE_INVOCATIONS * 4;
  const buffer = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.STORAGE,
  });

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: COMPUTE_WGSL }), entryPoint: 'main' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  });

  const validationError = await device.popErrorScope();
  if (validationError !== null) {
    buffer.destroy();
    return null;
  }

  const workgroups = COMPUTE_INVOCATIONS / COMPUTE_WORKGROUP_SIZE;

  // 先跑一次暖機，把 pipeline 編譯與首次資源配置排除在計時之外
  submitCompute(device, pipeline, bindGroup, workgroups);
  await device.queue.onSubmittedWorkDone();

  const t0 = performance.now();
  for (let i = 0; i < COMPUTE_SUBMITS; i++) {
    submitCompute(device, pipeline, bindGroup, workgroups);
  }
  await device.queue.onSubmittedWorkDone();
  const elapsedMs = performance.now() - t0;

  buffer.destroy();

  // fma 算兩個運算
  const ops = COMPUTE_INVOCATIONS * COMPUTE_ITERATIONS * 2 * COMPUTE_SUBMITS;
  return { elapsedMs, opsPerSec: elapsedMs > 0 ? (ops / elapsedMs) * 1000 : 0 };
}

function submitCompute(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  bindGroup: GPUBindGroup,
  workgroups: number,
): void {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

async function measureFill(device: GPUDevice): Promise<SubMeasurement | null> {
  device.pushErrorScope('validation');

  const target = device.createTexture({
    size: { width: FILL_SIZE, height: FILL_SIZE },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const module = device.createShaderModule({ code: FILL_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });

  const validationError = await device.popErrorScope();
  if (validationError !== null) {
    target.destroy();
    return null;
  }

  const view = target.createView();
  submitFill(device, pipeline, view);
  await device.queue.onSubmittedWorkDone();

  const t0 = performance.now();
  for (let i = 0; i < FILL_SUBMITS; i++) {
    submitFill(device, pipeline, view);
  }
  await device.queue.onSubmittedWorkDone();
  const elapsedMs = performance.now() - t0;

  target.destroy();

  // 每個 pixel 每次迭代做一次 vec4 fma = 8 個 scalar 運算
  const ops = FILL_SIZE * FILL_SIZE * FILL_ITERATIONS * 8 * FILL_SUBMITS;
  return { elapsedMs, opsPerSec: elapsedMs > 0 ? (ops / elapsedMs) * 1000 : 0 };
}

function submitFill(device: GPUDevice, pipeline: GPURenderPipeline, view: GPUTextureView): void {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
    ],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
