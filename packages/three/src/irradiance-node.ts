import type { IrradianceVolume } from './irradiance.ts';

/**
 * 間接光的 node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * ## 為什麼一定要有兩份
 *
 * WebGL 那條路靠 `onBeforeCompile` 注入 GLSL，而 `WebGPURenderer` 整條編譯
 * 路徑**不經過那個鉤子**。只做一邊的症狀是 WebGPU 上完全沒有間接光，而且
 * 不會有任何錯誤 —— 看起來像「烘壞了」或「這個場景本來就這麼暗」。
 *
 * 這個專案在 VAT 上踩過一模一樣的坑（實作在 WebGL、量測在 WebGPU，兩邊
 * 碰不到），所以那之後的規矩是兩邊一起做、兩邊一起驗。
 *
 * ## 接的地方：`IrradianceNode`
 *
 * Three 的 node 系統裡有一個現成的東西剛好就是這件事：
 *
 * ```js
 * class IrradianceNode extends LightingNode {
 *   setup( builder ) { builder.context.irradiance.addAssign( this.node ); }
 * }
 * ```
 *
 * `addAssign( irradiance )` 與 WebGL 那份的 `irradiance += …` 是同一件事，
 * 只是換一種語言講。所以兩條路加的是同一個量到同一個地方 —— 不是兩套各自
 * 近似的實作。
 *
 * 材質那一側的掛勾是 `setupMaterialLightings`。它本來就是設計給子類別覆寫的，
 * 而這裡的做法與 `onBeforeCompile` 那邊完全一樣：**先接住原本那個**，再把
 * 自己的加進去。搶掉的話材質原本的環境光、light map、AO 全部會消失。
 *
 * ## 為什麼是動態 import
 *
 * `three/tsl` 與 `three/webgpu` 只有 WebGPU 那條路用得到。靜態拉進來的話
 * **每一個使用者都要下載它**，包括只用 WebGL 的人。
 */

export interface IrradianceNodeMaterial {
  isNodeMaterial?: boolean;
  setupMaterialLightings?: (builder: unknown) => unknown[];
  needsUpdate?: boolean;
}

/**
 * 把這個體積的間接光接到一個 node 材質上。
 *
 * 失敗時**丟例外**而不是靜靜跳過 —— 靜靜跳過的症狀是整個場景沒有間接光，
 * 而那看起來像烘壞了，不像這裡沒接上。
 */
export async function applyIrradianceNode(
  material: IrradianceNodeMaterial,
  volume: IrradianceVolume,
): Promise<void> {
  const tsl = (await import('three/tsl')) as unknown as TslModule;
  const webgpu = (await import('three/webgpu')) as unknown as {
    IrradianceNode: new (node: unknown) => unknown;
  };

  const { texture, texture3D, positionWorld, normalWorld, uniform, vec2, vec3, step } = tsl;
  const textures = volume.textures;
  const u = volume.uniforms();

  // uniform 節點包住的是**同一個 Vector3 物件**，所以體積搬家時不必重接。
  const min = uniform(u.wwIrrMin!.value);
  const invSize = uniform(u.wwIrrInvSize!.value);
  // ## intensity 走的是**一張 1×1 的貼圖**，不是 uniform
  //
  // 這個節點掛在 lighting context 底下，而**那一組的 uniform 只在第一次繪製
  // 時上傳**。改 `.value` 在 JS 那一側確實變了（讀回 0 / 1 / 50 都對），畫面
  // 一個位元都不會動。
  //
  // 那個歸因驗過四次，四種做法都沒用：做成 TSL 的 uniform、重接一份新的節點
  // 圖、`needsUpdate = true` 強制重編，以及「把節點的 setter 交回體積、改的
  // 時候推一次」。最後那個看起來最像答案（換階淡入上就是 `uniform( 數字 )`
  // 包的是數字不是物件），而量法要用**同一個狀態連讀三次**才分得出來：
  //
  // | 順序 | WebGPU 讀到 |
  // | --- | --- |
  // | 開 → 關 → 再開 | 0.345 / 0.345 / 0.345 |
  // | 關 → 開 | 0.269 / 0.269 |
  //
  // 它定在**第一次繪製時**的那個值不動 —— 不是「沒推到」。
  //
  // ## 而同一個節點裡的**貼圖**是會更新的
  //
  // 那是量出來的，不是推的：搬一塊藍板子過去、重烘附近的探針，WebGPU 上
  // 畫面裡的藍從 0.0244 漲到 0.0601 —— 與 WebGL 的 0.0244 → 0.0602 逐位元
  // 相同。四張 SH 貼圖就在這個節點裡，那條路一直是好的。
  //
  // 所以強度改走同一條路。代價是每個 fragment 多一次 1×1 的取樣，換掉的是
  // 「一個公開屬性在一個後端上靜靜地沒有作用」。
  const intensity = texture(volume.intensityTexture, vec2(0.5, 0.5)).x;

  const uvw = positionWorld.sub(min).mul(invSize);

  // ## 體積外不給光，而且用乘的不用分支
  //
  // GLSL 那份用的是 `if` 提早返回。這裡用 step 相乘 —— 結果一樣，而在
  // node 材質裡不引進分支比較安全（分支在某些後端會讓整段被特化兩次）。
  const insideLow = step(vec3(0, 0, 0), uvw);
  const insideHigh = step(uvw, vec3(1, 1, 1));
  const mask = insideLow.x
    .mul(insideLow.y)
    .mul(insideLow.z)
    .mul(insideHigh.x)
    .mul(insideHigh.y)
    .mul(insideHigh.z);

  const c0 = texture3D(textures[0], uvw).xyz;
  const c1 = texture3D(textures[1], uvw).xyz;
  const c2 = texture3D(textures[2], uvw).xyz;
  const c3 = texture3D(textures[3], uvw).xyz;

  const n = normalWorld;
  // 常數與 GLSL 那份、與 Three 的 `shGetIrradianceAt` 逐字相同。
  // 三個地方寫同一組數字是刻意的：它們是同一份慣例的三個出口，改一個就要
  // 三個一起改，而數字不一樣的症狀是「兩條路亮度不同」。
  const directional = c1.mul(n.y).add(c2.mul(n.z)).add(c3.mul(n.x)).mul(1.023328);
  const result = c0
    .mul(0.886227)
    .add(directional)
    .max(vec3(0, 0, 0))
    .mul(intensity)
    .mul(mask);

  const previous = material.setupMaterialLightings?.bind(material);
  material.setupMaterialLightings = (builder: unknown): unknown[] => {
    // **先接住原本那個。** 搶掉的話材質的環境光、light map、AO 全會消失，
    // 而那看起來像「間接光把別的光蓋掉了」。
    const nodes = previous ? previous(builder) : [];
    nodes.push(new webgpu.IrradianceNode(result));
    return nodes;
  };
  material.needsUpdate = true;
}

/** 只列出這裡真的會用到的節點，其餘交給 Three 自己的型別。 */
interface TslNode {
  add: (v: unknown) => TslNode;
  sub: (v: unknown) => TslNode;
  mul: (v: unknown) => TslNode;
  max: (v: unknown) => TslNode;
  readonly x: TslNode;
  readonly y: TslNode;
  readonly z: TslNode;
  readonly xyz: TslNode;
}

interface TslModule {
  float: (v: number) => TslNode;
  texture3D: (texture: unknown, uvw: unknown) => TslNode;
  texture: (map: unknown, uv: unknown) => TslNode;
  vec2: (x: number, y: number) => TslNode;
  positionWorld: TslNode;
  normalWorld: TslNode;
  uniform: (v: unknown) => TslNode & { value: unknown };
  vec3: (x: number, y: number, z: number) => TslNode;
  step: (edge: unknown, x: unknown) => TslNode;
}
