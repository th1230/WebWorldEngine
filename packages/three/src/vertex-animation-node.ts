import type { BakedVertexAnimation } from './vertex-animation.ts';

/**
 * VAT 的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * ## 為什麼要有兩份
 *
 * WebGL 那條路靠 `onBeforeCompile` 注入 GLSL，而 `WebGPURenderer` 用的是 node
 * 材質，整條編譯路徑不經過那個鉤子。只做一邊的症狀是**一群停在綁定姿勢、
 * 完全不動的模型**，而且不會有任何錯誤 —— 看起來像動畫資料壞了。
 *
 * 這個專案在材質那條軸上已經踩過同一個坑（實作在 WebGL、量測在 WebGPU，
 * 兩邊碰不到），所以這次兩邊一起做。
 *
 * ## 為什麼是動態 import
 *
 * `three/tsl` 只有 WebGPU 那條路用得到。靜態 import 會把它拉進主套件，
 * **每一個使用者都要下載它**，包括只用 WebGL 的人。那正好違反「用了更好，
 * 不用也能動」在下載量上的意思。
 *
 * 所以只有真的遇到 node 材質時才抓。代價是設定 `positionNode` 變成非同步的
 * ——那一兩幀裡模型停在綁定姿勢，而那是安全的方向（畫面正確、只是還沒動）。
 *
 * ## 為什麼用 textureLoad 而不是 texture
 *
 * `texture()` 是有過濾的取樣，而這張貼圖的一個維度是**頂點編號** —— 相鄰兩個
 * 頂點在空間上毫無關係，內插它們會把兩個不相干的頂點混在一起，症狀是模型上
 * 長出隨機的尖刺。
 *
 * `textureLoad()` 是整數 texel 取值，不過濾，而且在 vertex 階段本來就該用它
 * （`texture()` 在頂點著色器裡需要明確的 LOD）。
 *
 * 時間軸上的內插是自己做的：讀兩幀再混。
 */

export interface NodeAnimationOptions {
  /** 每個 instance 的相位差多少（0–1）。0 就是全部同步。 */
  phaseSpread: number;
  /** 目前的時間，用來初始化 uniform。 */
  time: { value: number };
}

/**
 * 把 `material.positionNode` 設成「從貼圖讀位置」。
 *
 * 失敗時**丟例外**而不是靜靜跳過：靜靜跳過的症狀是模型全部不動，而那看起來
 * 像動畫資料有問題，不像這裡沒接上。
 */
export async function applyVertexAnimationNode(
  material: { positionNode?: unknown; needsUpdate?: boolean },
  baked: BakedVertexAnimation,
  options: NodeAnimationOptions,
): Promise<{ value: number }> {
  const tsl = (await import('three/tsl')) as unknown as TslModule;
  const { attribute, float, instanceIndex, int, ivec2, mix, textureLoad, uniform } = tsl;

  // 頂點編號從 attribute 來，不是 `gl_VertexID` —— 幾何進了批次的共用緩衝
  // 之後，那個內建變數是整個批次的索引，會查到別的模型的位置。
  const vertexId = attribute('wwVertexId', 'float');
  const frames = float(baked.frameCount);
  const duration = float(Math.max(baked.duration, 1e-6));
  // TSL 的 uniform 是一個節點，改它的 `.value` 就會傳到 shader。回傳給
  // 呼叫端，讓 `mesh.time = t` 改到的是這一個。
  const time = uniform(options.time.value);

  // 每個 instance 自己的相位。`instanceIndex` 在批次下就是這個 instance 的
  // 編號 —— 與 WebGL 那份用 `getIndirectIndex( gl_DrawID )` 是同一個東西。
  const seed = float(instanceIndex).mul(12.9898).sin().mul(43758.5453).fract();
  const phase = time
    .div(duration)
    .add(seed.mul(float(options.phaseSpread)))
    .fract();

  const position = phase.mul(frames.sub(1));
  const frameA = position.floor();
  const frameB = frameA.add(1).min(frames.sub(1));

  const texel = (frame: TslNode): TslNode =>
    textureLoad(baked.texture, ivec2(int(vertexId), int(frame))).xyz;

  material.positionNode = mix(texel(frameA), texel(frameB), position.sub(frameA));
  material.needsUpdate = true;
  return time;
}

/** 只列出這裡真的會用到的節點，其餘交給 Three 自己的型別。 */
interface TslNode {
  add: (v: unknown) => TslNode;
  sub: (v: unknown) => TslNode;
  mul: (v: unknown) => TslNode;
  div: (v: unknown) => TslNode;
  min: (v: unknown) => TslNode;
  sin: () => TslNode;
  fract: () => TslNode;
  floor: () => TslNode;
  readonly xyz: TslNode;
}

interface TslModule {
  attribute: (name: string, type: string) => TslNode;
  float: (v: unknown) => TslNode;
  instanceIndex: TslNode;
  int: (v: unknown) => TslNode;
  ivec2: (x: unknown, y: unknown) => TslNode;
  mix: (a: unknown, b: unknown, t: unknown) => TslNode;
  textureLoad: (texture: unknown, uv: unknown) => TslNode;
  uniform: (v: number) => TslNode & { value: number };
}
