import { QUALITY_TIER_NAMES, hashObject } from '@ww/core';
import { Profiler, StatsOverlay, type ReportMeta } from '@ww/diagnostics';
import { DeviceLostManager, resolvePlatformProfile } from '@ww/platform-web';
import { ThreeRenderBackend } from '@ww/render-three';

import { BenchmarkAssetRegistry } from './asset-registry.ts';
import { createHarnessState, runHarness } from './harness.ts';
import { renderSceneIndex } from './scene-index.ts';
import { measureCpuReference, measureMemoryReference } from './cpu-reference.ts';
import { DEFAULT_SCENE_ID, SCENES, findScene } from './scene-registry.ts';
import { boolParam, numberParam, type BenchmarkScene } from './scenes/types.ts';

const ENGINE_VERSION = '0.0.0-m1';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const requestedScene = params.get('scene');
  const sceneId = requestedScene ?? DEFAULT_SCENE_ID;
  const state = createHarnessState(sceneId);
  const boot = document.getElementById('boot');
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;

  // 沒指定場景就列出所有場景，而不是靜默挑一個 —— 使用者不該需要先讀原始碼
  if (requestedScene === null && boot !== null) {
    renderSceneIndex(boot);
    state.phase = 'interactive';
    return;
  }

  const setBoot = (text: string | null): void => {
    if (boot === null) return;
    if (text === null) {
      boot.hidden = true;
    } else {
      boot.hidden = false;
      boot.textContent = text;
    }
  };

  try {
    const definition = findScene(sceneId);
    if (definition === undefined) {
      // 打錯場景名稱時直接給清單，比丟一行錯誤有用
      if (boot !== null) renderSceneIndex(boot, `未知場景 "${sceneId}"`);
      state.phase = 'failed';
      state.error = `未知場景 "${sceneId}"。可用：${SCENES.map((s) => s.id).join(', ')}`;
      return;
    }

    const forceWebGL = boolParam(params, 'forceWebGL', false);
    const trackTimestamp = boolParam(params, 'timestamps', true);
    const warmupFrames = numberParam(params, 'warmup', 120, 0, 100_000);
    const measureFrames = numberParam(params, 'frames', 600, 1, 100_000);
    const autorun = boolParam(params, 'autorun', false);
    const measureTier = boolParam(params, 'tier', true);
    // 下限允許 0.25：小於 1 的值用來做「填充率還是頂點吞吐受限」的判定 ——
    // 只改解析度、其餘完全不動，GPU 時間若等比下降就是填充率問題。
    // 這也是 Adaptive Quality Manager 要用的同一個旋鈕（動態解析度）。
    const maxPixelRatio = numberParam(params, 'maxdpr', 2, 0.25, 4);

    setBoot('探測硬體能力…');
    const platform = await resolvePlatformProfile({
      engineVersion: ENGINE_VERSION,
      forceWebGL,
      measure: measureTier,
    });

    const pixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);

    setBoot('建立 renderer…');

    // backend 與 DeviceLostManager 互相需要對方，用一個可變的轉接函式打破循環
    let notifyLost: (detail: string) => void = () => {};

    const assets = new BenchmarkAssetRegistry();

    const backend = new ThreeRenderBackend({
      canvas,
      capabilities: platform.capabilities,
      assets,
      forceWebGL,
      trackTimestamp,
      pixelRatio,
      onDeviceLost: (detail) => {
        notifyLost(detail);
      },
    });

    await backend.init();

    const profiler = new Profiler({
      telemetry: backend.telemetry,
      historyFrames: Math.min(Math.max(measureFrames, 60), 5000),
    });

    const overlay = new StatsOverlay();

    const deviceLost = new DeviceLostManager({
      reacquire: () => backend.recreate(),
      onStateChange: (event) => {
        const text = `device ${event.state} (#${event.lossCount}) ${event.detail}`;
        overlay.setStatus(
          event.state === 'running' ? null : text,
          event.state === 'failed' ? 'error' : 'warn',
        );
      },
    });
    notifyLost = (detail) => {
      void deviceLost.notifyLost(detail);
    };

    // renderer 重建後 telemetry 會是全新的物件，profiler 必須換手
    deviceLost.register({
      id: 'profiler-telemetry',
      onDeviceLost: () => {
        profiler.setTelemetry(null);
      },
      onDeviceRestored: () => {
        profiler.setTelemetry(backend.telemetry);
        applySize();
      },
    });

    function applySize(): void {
      const width = window.innerWidth;
      const height = window.innerHeight;
      backend.resize(width, height, pixelRatio);
      currentScene?.resize?.(width, height);
    }

    let currentScene: BenchmarkScene | null = null;
    window.addEventListener('resize', applySize);
    applySize();

    setBoot(`建構場景 ${definition.id}…`);
    const scene = await definition.create({
      backend,
      deviceLost,
      assets,
      params,
      measureFrames,
      aspect: window.innerWidth / window.innerHeight,
    });
    currentScene = scene;
    applySize();

    // 拒絕暖機的場景（shader-compile）量的就是啟動成本；
    // 在這裡預先編譯會把它要量的東西整個抹掉。
    if (scene.overrideWarmupFrames !== 0) {
      setBoot('預先編譯材質…');
      await scene.precompile?.(backend);
    }

    // 量測前先記錄機器的 CPU 吞吐。這不是效能指標，是「這次執行與上次
    // 是否可比較」的判準 —— 熱受限的機器在不同時間點的時脈可以差兩倍。
    const cpuReferenceMs = measureCpuReference();
    const memoryReferenceMs = measureMemoryReference();

    const machineId = hashObject({
      backend: platform.capabilities.backend,
      adapter: platform.capabilities.adapter,
      userAgent: navigator.userAgent,
    });

    overlay.setHeader([
      `${definition.id}  ${QUALITY_TIER_NAMES[platform.decision.tier]}`,
      `${backend.activeBackend}  ${describeAdapter(platform.capabilities.adapter.device)}`,
      `machine ${machineId}  cpu-ref ${cpuReferenceMs}ms${platform.fromCache ? '  (tier 快取)' : ''}`,
    ]);

    const buildMeta = (s: BenchmarkScene): ReportMeta => ({
      engineVersion: ENGINE_VERSION,
      scene: definition.id,
      params: { warmupFrames: s.overrideWarmupFrames ?? warmupFrames, measureFrames, ...s.reportParams },
      machineId,
      cpuReferenceMs,
      memoryReferenceMs,
      platform: {
        backend: platform.capabilities.backend,
        tier: platform.decision.tier,
        tierReasons: platform.decision.reasons,
        adapter: platform.capabilities.adapter,
        timestampsAvailable: backend.timestampsEnabled,
        userAgent: navigator.userAgent,
        devicePixelRatio: pixelRatio,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      },
      verdict: s.verdict?.() ?? null,
      notes: [
        ...s.notes,
        ...platform.decision.warnings,
        ...(backend.timestampsEnabled ? [] : ['GPU timestamp 不可得，僅有 CPU 時間']),
        ...(platform.capabilities.adapter.isFallbackAdapter
          ? ['以軟體 adapter 執行，效能數字不可作為硬體基準']
          : []),
      ],
    });

    setBoot(null);

    await runHarness(
      {
        backend,
        profiler,
        overlay,
        scene,
        sceneId: definition.id,
        warmupFrames,
        measureFrames,
        autorun,
        buildMeta,
      },
      state,
    );
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
    state.phase = 'failed';
    state.error = detail;
    setBoot(`啟動失敗\n\n${detail}`);
    console.error(error);
  }
}

function describeAdapter(device: string): string {
  return device.length > 0 ? device.slice(0, 40) : '(adapter 未提供型號)';
}

void main();
