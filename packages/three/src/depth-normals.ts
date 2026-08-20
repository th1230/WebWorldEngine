import {
  DepthTexture,
  MeshNormalMaterial,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  UnsignedShortType,
  Vector2,
  WebGLRenderTarget,
} from 'three';
// 那份 node 材質是動態載入的（見 `update`）—— 只用 WebGL 的人不必下載它。
import type { Camera, Scene, Texture, WebGLRenderer } from 'three';

/**
 * 這一幀的深度與法線，**一次重畫，很多個效果共用**。
 *
 * ## 為什麼要抽出來
 *
 * 螢幕空間的效果全部需要同一份資料：接觸陰影、反射、環境光遮蔽、景深。
 * Three 的 addons 每一個 pass 自己重畫一次 —— 四個效果就是四次全場景繪製，
 * 而那四次畫出來的東西**一模一樣**。
 *
 * 這個套件已經有剔除、選階、遠景合併，所以一次全場景繪製不是小錢。共用一份
 * 之後，加第二個、第三個螢幕空間效果的邊際成本只剩下那個效果自己的 pass。
 *
 * ## 深度是掛在同一張 target 上的
 *
 * `depthTexture` 讓深度與法線在**同一次繪製**裡拿到。分成兩次畫的話不只慢
 * 一倍，兩張還可能因為不同的裁切而對不齊 —— 而對不齊的症狀是效果沿著物體
 * 邊緣描一圈亮邊，看起來像「效果就是長這樣」。
 *
 * ## 誰負責每幀更新
 *
 * `update()` 每次呼叫都真的重畫。共用是靠**呼叫端每幀叫一次**，然後把同一個
 * 物件傳給各個效果。
 *
 * 忘了叫的話效果會吃到上一幀的深度 —— 而那在相機移動時是看得見的殘影，
 * 靜止時完全正常。那種「動起來才錯」最難查，所以這裡會在資料過期時警告。
 */

export interface SceneDepthNormalsOptions {
  /**
   * 解析度倍率。預設 0.5。
   *
   * 半解析度對遮蔽與收集類的效果夠用（那些本來就是低頻的），而且省的是
   * 一次全場景繪製的填充。要拿來做銳利的東西（例如描邊）再調到 1。
   */
  scale?: number;
}

export class SceneDepthNormals {
  readonly scale: number;

  private target: WebGLRenderTarget | null = null;
  private readonly material = new MeshNormalMaterial();
  /**
   * WebGPU 那條路的法線材質。
   *
   * 不能用 `MeshNormalMaterial` —— 它的 node 版本多做一次 sRGB 轉換，法線
   * 方向會整個歪掉。見 `depth-normals-node.ts`。
   */
  private nodeMaterial: unknown = null;
  private nodePending: Promise<void> | null = null;
  private readonly size = new Vector2();
  /** 上一次更新是在 renderer 的第幾次繪製。過期檢查用。 */
  private stamp = -1;
  private warnedStale = false;

  constructor(options: SceneDepthNormalsOptions = {}) {
    this.scale = options.scale ?? 0.5;
  }

  /** 法線貼圖。還沒 `update()` 過就是 null。 */
  get normalTexture(): Texture | null {
    return this.target?.texture ?? null;
  }

  /** 深度貼圖。與法線同一次繪製拿到的，所以一定對得齊。 */
  get depthTexture(): DepthTexture | null {
    return this.target?.depthTexture ?? null;
  }

  get width(): number {
    return this.target?.width ?? 0;
  }

  get height(): number {
    return this.target?.height ?? 0;
  }

  /**
   * 重畫這一幀的深度與法線。**每幀叫一次**，然後把這個物件傳給各個效果。
   */
  update(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    renderer.getSize(this.size);
    const width = Math.max(1, Math.floor(this.size.x * this.scale));
    const height = Math.max(1, Math.floor(this.size.y * this.scale));
    this.ensureTarget(width, height);

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;

    // WebGPU 上換成自己那份 —— 兩邊寫進去的編碼必須一樣，否則下游每個效果
    // 拿到的法線都是歪的。還沒建好就先用 Three 那份（只有前幾幀）。
    if (
      (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true &&
      this.nodeMaterial === null
    ) {
      this.nodePending ??= import('./depth-normals-node.ts')
        .then((m) => m.createNormalNodeMaterial())
        .then((material) => {
          this.nodeMaterial = material;
        })
        .catch((error: unknown) => {
          // **大聲說出來。** 靜靜失敗的症狀是「WebGPU 上這個效果完全沒有」，
          // 而那看起來像場景沒設定好，不像材質建不起來。
          console.error('WW.SceneDepthNormals：node 材質建不起來，WebGPU 上不會有深度法線。', error);
        });
    }
    scene.overrideMaterial = (this.nodeMaterial ?? this.material) as never;
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    scene.overrideMaterial = previousOverride;
    renderer.setRenderTarget(previousTarget);

    this.stamp = renderer.info.render.frame;
  }

  /**
   * 資料是這一幀的嗎。效果在用之前問一次。
   *
   * 不是的話會警告一次並回 false —— 呼叫端可以自己決定要跳過還是照用。
   * 靜靜地用舊資料是最糟的：靜止時完全正常，一動起來就有殘影。
   */
  isFresh(renderer: WebGLRenderer): boolean {
    if (this.target === null) return false;
    // 同一幀裡會有好幾次 render（各個效果自己的 pass），所以不能要求完全相等。
    const fresh = renderer.info.render.frame - this.stamp <= 8;
    if (!fresh && !this.warnedStale) {
      this.warnedStale = true;
      console.warn(
        [
          'WW.SceneDepthNormals: 拿到的是舊的深度與法線 —— `update()` 這一幀沒有被呼叫。',
          '症狀是相機移動時效果有殘影，而靜止時完全正常（所以很難查）。',
          '正確的用法是每幀先呼叫一次 update()，再把同一個物件傳給各個效果。',
        ].join('\n'),
      );
    }
    return fresh;
  }

  private ensureTarget(width: number, height: number): void {
    if (this.target !== null && this.target.width === width && this.target.height === height) return;
    this.target?.dispose();
    const depth = new DepthTexture(width, height, UnsignedShortType);
    this.target = new WebGLRenderTarget(width, height, {
      format: RGBAFormat,
      // 法線是**資料**，不是顏色 —— 走色彩空間轉換的話解出來的方向是錯的，
      // 而那不會報錯，只會讓效果從錯的方向取樣。
      colorSpace: NoColorSpace,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthTexture: depth,
    });
  }

  dispose(): void {
    this.target?.dispose();
    this.material.dispose();
  }
}
