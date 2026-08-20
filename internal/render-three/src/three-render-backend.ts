import type { AssetId } from '@web-world-engine/format';
import { NO_BACKEND_PROFILE, type CapabilityProfile } from '@ww/core';
import type { RendererTelemetry } from '@ww/diagnostics';
import type {
  CameraSnapshot,
  RenderBackend,
  RenderBackendConfig,
  RenderBatch,
  RenderFrame,
  RenderLight,
} from '@ww/render-core';
import type { BufferGeometry, Material } from 'three/webgpu';
import {
  AmbientLight,
  DirectionalLight,
  InstancedMesh,
  PerspectiveCamera,
  PointLight,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { NULL_TELEMETRY, ThreeTelemetry } from './three-telemetry.ts';

/**
 * AssetId → Three.js 資源。
 *
 * 還沒有 Asset Cooker（那是 ），所以由 app 直接註冊 geometry 與 material。
 * 介面留在這裡，之後換成從 cooked pack 載入的實作即可，backend 不必改。
 */
export interface ThreeAssetProvider {
  geometry(id: AssetId): BufferGeometry | undefined;
  material(id: AssetId): Material | undefined;
}

export interface ThreeRenderBackendConfig extends RenderBackendConfig {
  capabilities: CapabilityProfile;
  assets: ThreeAssetProvider;
  onDeviceLost?: ((detail: string) => void) | undefined;
}

interface BatchSlot {
  mesh: InstancedMesh;
  capacity: number;
}

/**
 * Three.js WebGPURenderer 的 adapter。
 *
 * **這是整個 repo 唯一允許 import three 的 package**（見 eslint.config.js）。
 *
 * 從 起它的輸入只有 RenderFrame —— 一份純資料。它的工作是把那份資料
 * 「投影」到一棵 Three.js 場景樹上，並讓那棵樹在幀與幀之間持續存在
 * （重建 Object3D 會讓 GPU 資源每幀重新配置）。
 *
 * 引擎完全不知道這棵樹存在。
 */
export class ThreeRenderBackend implements RenderBackend {
  private renderer: WebGPURenderer | null = null;
  private _telemetry: RendererTelemetry = NULL_TELEMETRY;
  private _capabilities: CapabilityProfile;
  private _initialized = false;
  private _timestampsEnabled = false;
  private readonly config: ThreeRenderBackendConfig;

  /** 持久的場景樹。RenderFrame 只描述內容，不描述物件身分。 */
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly slots = new Map<string, BatchSlot>();
  private readonly directionalLights: DirectionalLight[] = [];
  private readonly pointLights: PointLight[] = [];
  private readonly ambient = new AmbientLight(0xffffff, 0);
  private _missingAssets = 0;

  constructor(config: ThreeRenderBackendConfig) {
    this.config = config;
    this._capabilities = config.capabilities;
    this.scene.add(this.ambient);
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get capabilities(): CapabilityProfile {
    return this._capabilities;
  }

  get telemetry(): RendererTelemetry {
    return this._telemetry;
  }

  /** 找不到對應資源而被跳過的 batch 數。持續大於 0 代表資產註冊漏了。 */
  get missingAssets(): number {
    return this._missingAssets;
  }

  get activeBackend(): 'webgpu' | 'webgl2' {
    return this.config.forceWebGL === true || this._capabilities.backend !== 'webgpu'
      ? 'webgl2'
      : 'webgpu';
  }

  /**
   * timestamp query 是否真的啟用。
   *
   * 要求 `trackTimestamp: true` 並不保證拿得到 —— three 內部還會再與
   * `hasFeature('timestamp-query')` 取交集，所以只有 init 之後才能確定。
   */
  get timestampsEnabled(): boolean {
    return this._timestampsEnabled;
  }

  async init(): Promise<void> {
    if (this._initialized) return;

    const renderer = new WebGPURenderer({
      canvas: this.config.canvas,
      antialias: this.config.antialias ?? false,
      samples: this.config.samples ?? 0,
      forceWebGL: this.config.forceWebGL ?? false,
      trackTimestamp: this.config.trackTimestamp ?? false,
    });

    // 型別由 three 的 onDeviceLost 簽名推導（DeviceLostInfo 沒有被匯出，無法明寫）
    renderer.onDeviceLost = (info) => {
      this.config.onDeviceLost?.(
        `${info.api} device lost (${info.reason ?? 'unknown'}): ${info.message}`,
      );
    };

    await renderer.init();

    this.renderer = renderer;
    this._initialized = true;
    this._timestampsEnabled =
      (this.config.trackTimestamp ?? false) && renderer.hasFeature('timestamp-query');
    this._telemetry = new ThreeTelemetry(renderer, this._timestampsEnabled);

    this.applySize();
    this.watchNativeDeviceLoss();
  }

  private watchNativeDeviceLoss(): void {
    const device = this.gpuDevice();
    if (device === null) return;
    void device.lost.then((info) => {
      if (info.reason === 'destroyed' && this.renderer === null) return;
      this.config.onDeviceLost?.(`native device.lost: ${info.reason} ${info.message}`);
    });
  }

  gpuDevice(): GPUDevice | null {
    const backend = this.renderer?.backend as unknown as { device?: GPUDevice } | undefined;
    return backend?.device ?? null;
  }

  /**
   * 強制觸發 device 遺失。只給 device-loss-soak 場景與測試使用。
   * 回傳是否真的觸發（WebGL2 路徑下無法模擬）。
   */
  simulateDeviceLoss(): boolean {
    const device = this.gpuDevice();
    if (device === null) return false;
    device.destroy();
    return true;
  }

  resize(width: number, height: number, pixelRatio?: number): void {
    if (this.renderer === null) return;
    this.renderer.setPixelRatio(pixelRatio ?? this.config.pixelRatio ?? 1);
    this.renderer.setSize(width, height, false);
  }

  private applySize(): void {
    const { canvas } = this.config;
    this.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
  }

  submit(frame: RenderFrame): void {
    const renderer = this.renderer;
    if (renderer === null) return;

    this.syncCamera(frame.camera);
    this.syncLights(frame.lights);
    this.syncBatches(frame.batches);

    renderer.render(this.scene, this.camera);
  }

  /**
   * 直接繪製一棵自備的 Three.js 場景樹，**繞過 RenderFrame**。
   *
   * 逃生門，只給 renderer 層級的 benchmark 使用。像 shader 編譯停頓、貼圖記憶體、
   * compute → indirect draw 這些量的是 renderer 本身的特性，不是引擎的；
   * 硬把它們套進 ECS 只會在量測與被量測對象之間多墊一層無關的東西。
   *
   * 引擎程式碼**不得**使用這個方法。正式路徑是 `submit(frame)`。
   */
  submitRaw(scene: Scene, camera: PerspectiveCamera): void {
    this.renderer?.render(scene, camera);
  }

  /** 同上，供 benchmark 對自備場景做預編譯。 */
  async precompileRaw(scene: Scene, camera: PerspectiveCamera): Promise<void> {
    await this.renderer?.compileAsync(scene, camera);
  }

  /**
   * 直接取用底層 renderer。
   *
   * 與 `submitRaw` 同樣是 benchmark 專用的逃生門，用於 compute 與 indirect draw
   * 這些在 還沒有中立介面的能力。每一處使用都代表一個尚未被抽象化的缺口。
   */
  get raw(): WebGPURenderer | null {
    return this.renderer;
  }

  /**
   * 相機永遠放在原點。
   *
   * frame 裡的矩陣已經是 camera-relative，所以場景「跟著」相機移動而不是相機
   * 在世界裡移動。這正是 floating origin 在 renderer 端的樣子 —— 不論玩家走到
   * 世界的哪個角落，送進 GPU 的座標都在原點附近，float32 的精度永遠夠用。
   */
  private syncCamera(snapshot: CameraSnapshot): void {
    const camera = this.camera;
    camera.position.set(0, 0, 0);
    camera.quaternion.set(
      snapshot.rotation[0]!,
      snapshot.rotation[1]!,
      snapshot.rotation[2]!,
      snapshot.rotation[3]!,
    );
    camera.fov = (snapshot.fovYRadians * 180) / Math.PI;
    camera.aspect = snapshot.aspect;
    camera.near = snapshot.near;
    camera.far = snapshot.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  private syncLights(lights: readonly RenderLight[]): void {
    let directionalUsed = 0;
    let pointUsed = 0;
    let ambientIntensity = 0;
    const ambientColor = this.ambient.color;

    for (const light of lights) {
      switch (light.kind) {
        case 'ambient':
          ambientIntensity += light.intensity;
          ambientColor.setRGB(light.color[0]!, light.color[1]!, light.color[2]!);
          break;
        case 'directional': {
          const target = this.directionalLightAt(directionalUsed++);
          target.intensity = light.intensity;
          target.color.setRGB(light.color[0]!, light.color[1]!, light.color[2]!);
          target.position.set(light.vector[0]!, light.vector[1]!, light.vector[2]!);
          target.visible = true;
          break;
        }
        case 'point': {
          const target = this.pointLightAt(pointUsed++);
          target.intensity = light.intensity;
          target.color.setRGB(light.color[0]!, light.color[1]!, light.color[2]!);
          target.position.set(light.vector[0]!, light.vector[1]!, light.vector[2]!);
          target.visible = true;
          break;
        }
      }
    }

    this.ambient.intensity = ambientIntensity;
    // 這一幀沒用到的燈先隱藏而非移除：移除會讓 three 重建 shader
    for (let i = directionalUsed; i < this.directionalLights.length; i++) {
      this.directionalLights[i]!.visible = false;
    }
    for (let i = pointUsed; i < this.pointLights.length; i++) {
      this.pointLights[i]!.visible = false;
    }
  }

  private directionalLightAt(index: number): DirectionalLight {
    let light = this.directionalLights[index];
    if (light === undefined) {
      light = new DirectionalLight(0xffffff, 1);
      this.directionalLights[index] = light;
      this.scene.add(light);
    }
    return light;
  }

  private pointLightAt(index: number): PointLight {
    let light = this.pointLights[index];
    if (light === undefined) {
      light = new PointLight(0xffffff, 1);
      this.pointLights[index] = light;
      this.scene.add(light);
    }
    return light;
  }

  private syncBatches(batches: readonly RenderBatch[]): void {
    this._missingAssets = 0;
    const seen = new Set<string>();

    for (const batch of batches) {
      const key = `${batch.meshAsset} ${batch.materialAsset}`;
      seen.add(key);

      const slot = this.slotFor(key, batch);
      if (slot === null) {
        this._missingAssets++;
        continue;
      }

      const target = slot.mesh.instanceMatrix.array as Float32Array;
      const used = batch.count * 16;
      // 直接把抽取階段算好的矩陣搬進 GPU 緩衝區。
      // 不重算、不建立 Matrix4 物件 —— 那會讓一百萬個 instance 產生一百萬個物件。
      target.set(batch.matrices.subarray(0, used));
      slot.mesh.count = batch.count;
      slot.mesh.instanceMatrix.needsUpdate = true;
      slot.mesh.visible = batch.count > 0;
    }

    // 這一幀沒出現的 batch 停止繪製，但保留 InstancedMesh 以免下一幀又要重建
    for (const [key, slot] of this.slots) {
      if (!seen.has(key)) {
        slot.mesh.count = 0;
        slot.mesh.visible = false;
      }
    }
  }

  private slotFor(key: string, batch: RenderBatch): BatchSlot | null {
    const existing = this.slots.get(key);
    if (existing !== undefined && existing.capacity >= batch.count) return existing;

    const geometry = this.config.assets.geometry(batch.meshAsset);
    const material = this.config.assets.material(batch.materialAsset);
    if (geometry === undefined || material === undefined) return null;

    // 容量以 2 的冪成長，避免每多一個 instance 就重建一次
    const capacity = Math.max(64, nextPowerOfTwo(batch.count));
    if (existing !== undefined) {
      this.scene.remove(existing.mesh);
      existing.mesh.dispose();
    }

    const mesh = new InstancedMesh(geometry, material, capacity);
    // 這些矩陣已經是 camera-relative，three 的自動 culling 會用錯的世界座標判斷
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);

    const slot: BatchSlot = { mesh, capacity };
    this.slots.set(key, slot);
    return slot;
  }

  async precompile(frame: RenderFrame): Promise<void> {
    if (this.renderer === null) return;
    this.syncCamera(frame.camera);
    this.syncLights(frame.lights);
    this.syncBatches(frame.batches);
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  /**
   * 丟棄目前的 renderer 並重建。device 遺失後的恢復路徑。
   *
   * 場景樹本身是 CPU-side 資料，完全保留；只有 GPU 資源被重建。
   * 這正是 RenderFrame 架構的好處之一：世界狀態根本不在這一層。
   */
  async recreate(): Promise<void> {
    this.disposeRenderer();
    this._initialized = false;
    await this.init();
  }

  private disposeRenderer(): void {
    const renderer = this.renderer;
    this.renderer = null;
    this._telemetry = NULL_TELEMETRY;
    this._timestampsEnabled = false;
    if (renderer === null) return;
    try {
      renderer.dispose();
    } catch {
      // device 已經死掉時 dispose 可能丟例外；那不影響我們要走的恢復流程
    }
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      this.scene.remove(slot.mesh);
      slot.mesh.dispose();
    }
    this.slots.clear();
    this.disposeRenderer();
    this._initialized = false;
    this._capabilities = NO_BACKEND_PROFILE;
  }
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}
