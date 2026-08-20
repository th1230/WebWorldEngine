import type { Texture } from 'three';

/**
 * 虛擬貼圖的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 逐行對照 `virtual-texture.ts` 裡那段 `wwSampleVirtual`：同一次頁表查詢、
 * 同一個階數縮放、同一圈邊界內縮。
 *
 * ## 為什麼一定要有兩份
 *
 * WebGL 那條路靠 `onBeforeCompile`，而 `WebGPURenderer` 整條編譯路徑**不經過
 * 那個鉤子**。只做一邊的症狀是 WebGPU 上整片地形是那張 1×1 的佔位貼圖 ——
 * 一片純白，看起來像「貼圖沒載到」。
 *
 * ## 兩張都是 `DataTexture`，所以**不翻 V**
 *
 * 圖集與頁表都是 CPU 填的 `DataTexture`。TSL 只對 render target 與深度貼圖
 * 自動翻 V —— 這裡兩張都不是，所以照原樣取樣。
 *
 * （impostor 那邊是反過來的：圖集是 render target，漏了翻轉的症狀是顏色差
 * 6% 而覆蓋率完全相同。兩種都踩過，所以這一行寫下來。）
 */

export interface VirtualTextureNodeParams {
  /** 最細階一邊幾頁。 */
  pagesPerSide: number;
  /** 圖集一邊幾頁。 */
  atlasPages: number;
  /** 一頁幾 texel。 */
  pageSize: number;
  /** 邊界幾 texel。 */
  border: number;
}

interface ColorableNodeMaterial {
  isNodeMaterial?: boolean;
  colorNode?: unknown;
  needsUpdate?: boolean;
}

/**
 * 把虛擬貼圖的取樣接到一個 node 材質上。
 *
 * 失敗時**丟例外**而不是靜靜跳過 —— 靜靜跳過的症狀是整片地形變成佔位色。
 */
export async function applyVirtualTextureNode(
  material: ColorableNodeMaterial,
  atlasTexture: Texture,
  tableTexture: Texture,
  params: VirtualTextureNodeParams,
): Promise<void> {
  /* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的 */
  const tsl = (await import('three/tsl')) as any;
  const { Fn, float, vec2, vec4, uniform, uv, texture, clamp, floor, fract, exp2, materialColor } =
    tsl;

  const atlas = texture(atlasTexture);
  const table = texture(tableTexture);
  const uPagesPerSide = uniform(float(params.pagesPerSide));
  const uAtlasPages = uniform(float(params.atlasPages));
  const uPageSize = uniform(float(params.pageSize));
  const uBorder = uniform(float(params.border));

  const sampleVirtual = Fn(() => {
    const coord = clamp(uv(), 0, 0.999999).toVar();
    // 頁表是 NEAREST 的，所以這一次查表拿到的是「這一格」的位址，不是附近
    // 幾格的平均 —— 平均出來的位址不存在。
    const entry = table.sample(coord).toVar();
    const slot = floor(entry.xy.mul(255).add(0.5)).toVar();
    const level = floor(entry.z.mul(255).add(0.5)).toVar();

    // 住著的那一頁蓋住 2^level 個最細階的頁。UV 換算到那一頁裡面。
    const span = exp2(level).toVar();
    const pageUv = fract(coord.mul(uPagesPerSide).div(span)).toVar();

    // 往內縮一圈：圖集裡兩頁貼在一起，線性取樣在邊界會吃到隔壁。
    const usable = uPageSize.sub(uBorder.mul(2));
    const inPage = pageUv.mul(usable).add(uBorder).div(uPageSize);
    const atlasUv = slot.add(inPage).div(uAtlasPages);
    return atlas.sample(vec2(atlasUv.x, atlasUv.y));
  })();

  // GLSL 那份是 `diffuseColor *= wwSampleVirtual( vMapUv )`，取代 `map_fragment`。
  // 這裡等價：材質自己的顏色乘上虛擬貼圖的取樣 —— 那張 1×1 的佔位不參與。
  //
  // 逐分量寫開而不是 `vec4(materialColor, 1)`：TSL 會丟「Length of parameters
  // exceeds maximum length of function vec4()」—— 結果還是對的，但主控台上
  // 多一行錯誤。而「有錯誤但結果對」正是下一個人會忽略的那種訊息。
  material.colorNode = vec4(
    sampleVirtual.r.mul(materialColor.r),
    sampleVirtual.g.mul(materialColor.g),
    sampleVirtual.b.mul(materialColor.b),
    sampleVirtual.a,
  );
  material.needsUpdate = true;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
