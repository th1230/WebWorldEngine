/* eslint-disable @typescript-eslint/no-explicit-any -- 見下面「為什麼這裡是 any」 */

/**
 * 全螢幕效果在 **node / TSL** 那一側的共用層。
 *
 * ## 為什麼需要它
 *
 * `WebGPURenderer` 不吃 `ShaderMaterial`，所以每個螢幕空間效果都要有第二份
 * 實作。而那些效果共用的東西（從深度還原視空間位置、全螢幕的 uv）在 GLSL
 * 那側已經抽成 `fullscreen.ts` 的共用字串 —— 這一側也必須抽，否則同一段數學
 * 會在十幾個檔案裡各寫一次。
 *
 * ## 為什麼這裡是 `any`
 *
 * TSL 的節點是**動態組出來的**：`.mul()` 回傳的型別取決於兩邊的維度，而那個
 * 資訊 Three 沒有用 TypeScript 表達。硬要標型別的結果是每一行都要 `as`，而
 * 那讓程式碼變得看不出在算什麼 —— 那比沒有型別更糟。
 *
 * 真正守著這一側的不是型別，是**跨後端關卡**：同一個場景兩邊各跑一次，數字
 * 不一樣就紅。型別擋不住「兩份實作算出不同答案」，而那是這裡唯一會出的錯。
 */

export type Tsl = Record<string, any>;
export type TslNode = any;

/**
 * 佔位貼圖。
 *
 * TSL 的 `texture()` / `texture3D()` 在建節點時就要一個**有效的** Texture ——
 * 給 null 會丟「expects a valid instance of THREE.Texture()」。而效果的貼圖
 * 要等到第一次 render 才知道是哪一張。
 *
 * 所以先接一張 1×1 的，之後換 `.value`。
 */
let placeholder2D: unknown = null;
let placeholder3D: unknown = null;

export function texture2DPlaceholder(three: Tsl): unknown {
  placeholder2D ??= new three.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  (placeholder2D as { needsUpdate: boolean }).needsUpdate = true;
  return placeholder2D;
}

export function texture3DPlaceholder(three: Tsl): unknown {
  placeholder3D ??= new three.Data3DTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 1);
  (placeholder3D as { needsUpdate: boolean }).needsUpdate = true;
  return placeholder3D;
}

let tslPromise: Promise<Tsl> | null = null;
let webgpuPromise: Promise<Tsl> | null = null;

/**
 * 載入 `three/tsl`，**只載一次**。
 *
 * 動態載入的理由與 `irradiance-node.ts` 相同：只用 WebGL 的人不該為了這條路
 * 多下載一份。而快取的理由是每個效果都會叫它 —— 不快取的話十幾個效果各觸發
 * 一次模組解析。
 */
export async function loadTsl(): Promise<Tsl> {
  tslPromise ??= import('three/tsl') as unknown as Promise<Tsl>;
  return tslPromise;
}

/** 載入 `three/webgpu`，只載一次。 */
export async function loadWebGPU(): Promise<Tsl> {
  webgpuPromise ??= import('three/webgpu') as unknown as Promise<Tsl>;
  return webgpuPromise;
}

/**
 * 從深度貼圖還原出**視空間**的位置 —— TSL 版。
 *
 * 與 `fullscreen.ts` 的 `VIEW_POSITION_GLSL` 逐行相同，而且兩個容易寫錯的
 * 地方是同樣那兩個：
 *
 * 1. 深度貼圖存的是非線性的裝置深度，要先換回 NDC。
 * 2. 齊次除法不能省 —— 省掉的話畫面中央看起來還是對的，所以很難發現。
 */
export function viewPositionFromDepth(
  tsl: Tsl,
  uv: TslNode,
  rawDepth: TslNode,
  projectionInverse: TslNode,
  convention: DepthConvention,
): TslNode {
  const { vec4 } = tsl;
  const ndc = vec4(uv.mul(2).sub(1), rawDepth.mul(convention.scale).add(convention.offset), 1);
  const view = projectionInverse.mul(ndc);
  return view.xyz.div(view.w);
}

export interface DepthConvention {
  scale: TslNode;
  offset: TslNode;
  /** 從 renderer 決定用哪一套。每幀叫一次就好。 */
  set: (renderer: unknown) => void;
}

/**
 * 裝置深度 → NDC z 的換算，**兩個座標系不一樣**。
 *
 * | | NDC 的 z 範圍 | 換算 |
 * | --- | --- | --- |
 * | WebGL | −1 … 1 | `raw * 2 − 1` |
 * | WebGPU | 0 … 1 | `raw` |
 *
 * 這是我實測踩到最難查的一個，因為它**自洽**：把位置投影回 UV 再取一次深度，
 * 兩個方向用的是同一個錯的約定，所以往返測試完全正確。中間值一路查（深度對、
 * 法線對、參數對、迴圈跑滿）全都正常，錯的是還原出來的世界。
 *
 * 症狀是接觸陰影在 WebGPU 上暗掉 29.6% 的畫面（WebGL 是 0.52%），而遮罩印成
 * 圖之後才看得出來那不是「沒生效」是「算在錯的地方」。
 *
 * 不寫死成 WebGPU 的那一套：`WebGPURenderer` 在沒有 WebGPU 的機器上會退回
 * WebGL2 後端，那時座標系是 WebGL 的。
 */
export function createDepthConvention(tsl: Tsl): DepthConvention {
  const scale = tsl.uniform(tsl.float(1));
  const offset = tsl.uniform(tsl.float(0));
  return {
    scale,
    offset,
    set: (renderer) => {
      // 2000 = WebGLCoordinateSystem、2001 = WebGPUCoordinateSystem。
      const webgl = (renderer as { coordinateSystem?: number }).coordinateSystem === 2000;
      scale.value = webgl ? 2 : 1;
      offset.value = webgl ? -1 : 0;
    },
  };
}

/**
 * 讀深度貼圖的第一個通道。
 *
 * ## 這裡有一個實測踩到的陷阱
 *
 * GLSL 那側是 `texture2D(tDepth, uv).x` —— 深度貼圖也是個 vec4，取 x。
 * 而 TSL 這側 **`texture()` 對深度貼圖回傳的直接就是 float**（見 Three 的
 * `TextureNode.generateNodeType`：`isDepthTexture` 就回 `float`）。
 *
 * 照 GLSL 的習慣再寫一個 `.r` 的話不會報錯，但讀出來的值恆大於等於 1 ——
 * 於是每個像素都被當成天空，效果整片失效。實測接觸陰影在 WebGPU 上
 * 每一點都讀到 1.0（完全沒有遮蔽），而主控台一行錯誤都沒有。
 */
export function sampleDepth(tsl: Tsl, depthTexture: TslNode, uv: TslNode): TslNode {
  // 對節點本身取樣。再包一層 `texture(node, uv)` 會被當成「拿節點當貼圖」。
  return depthTexture.sample(flipV(tsl, uv));
}

/**
 * 取樣 render target 時要把 v 翻過來。
 *
 * TSL 的 `texture()` 對 render target 與深度貼圖會自動套一次 flipY（見 Three
 * 的 `TextureNode`：`isRenderTargetTexture || isDepthTexture` 就設 flipY），
 * 而 GLSL 那側沒有這一步。
 *
 * 症狀非常有辨識度：整張圖上下顛倒。實測接觸陰影把畫面**底部的地面判成天空**、
 * 把頂部的天空判成幾何 —— 於是天空整片被塗黑，而地面完全沒有陰影。
 *
 * 而它與投影往返那類自我檢查**互相抵銷**：把位置投影回 UV 再取一次深度，
 * 兩次都被翻，結果完全一致。所以那種檢查驗不到它。
 */
export function flipV(tsl: Tsl, uv: TslNode): TslNode {
  const { vec2, float } = tsl;
  return vec2(uv.x, float(1).sub(uv.y));
}
