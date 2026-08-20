/* eslint-disable @typescript-eslint/no-explicit-any -- TSL 的節點型別是動態的，見 fullscreen-node.ts */
import {
  createDepthConvention,
  flipV,
  loadTsl,
  loadWebGPU,
  sampleDepth,
  texture2DPlaceholder,
  viewPositionFromDepth,
} from './fullscreen-node.ts';
import type { Matrix4, Texture, Vector3 } from 'three';

/**
 * 虛擬陰影圖的 resolve pass，node 材質版本 —— `WebGPURenderer` 那條路。
 *
 * 逐行對照 `virtual-shadow-map.ts` 的 `RESOLVE_FRAGMENT`。同樣的早退順序、
 * 同樣的偏移（只有一個 texel 項，沒有斜度也沒有常數）、同樣的除錯號碼。
 *
 * 兩份一不一致由 `tools/gpu-check/cross-backend.mjs` 量。
 *
 * ## 這一支比前面幾個多一個坑：**兩種貼圖要用兩種取樣方式**
 *
 * TSL 的 `texture()` 對 render target 與深度貼圖會自動翻一次 V（見
 * `flipV` 的說明），對一般貼圖不會。而這裡兩種都有：
 *
 * | 貼圖 | 是什麼 | 取樣 |
 * | --- | --- | --- |
 * | `tDepth`／`tNormal` | render target | `flipV` |
 * | `tShadow` | render target（陰影圖集）| `flipV` |
 * | `tTable` | `DataTexture`（CPU 填的頁表）| **不翻** |
 *
 * 而 `tShadow` 的 uv 不是螢幕座標，是從頁表算出來的圖集座標 —— 那個也要翻，
 * 因為翻的是「交給取樣器的那組 uv」，與它從哪裡來無關。翻錯的症狀是陰影
 * 上下顛倒地貼在場景上，而那看起來像頁表算錯。
 */

/**
 * ## 圖集那一趟也要自己寫一份
 *
 * WebGL 那邊用的是 `MeshDepthMaterial({ depthPacking: RGBADepthPacking })`。
 * Three 0.185 的 WebGPU build 裡**沒有** `MeshDepthNodeMaterial` —— 交給
 * `WebGPURenderer` 會直接丟：
 *
 * ```
 * THREE.NodeBuilder: Material "MeshDepthMaterial" is not compatible.
 * ```
 *
 * 而症狀不是畫面壞掉，是**圖集整張是空的**：解析那一段照常跑，頁表、槽位、
 * 圖集座標全部算對（實測兩邊 0.000%），只是取到的深度一律 0。於是整個場景
 * 都在陰影裡，看起來像光源方向設錯了。
 *
 * 所以這裡自己打包。而打包的算式必須與 Three 的 `packDepthToRGBA` **逐位元
 * 相同**，因為解析那一段解的是同一份資料 —— 兩邊各寫一份「數學上也對」的
 * 編碼，症狀是深度差一點點，也就是陰影的接縫飄一點點。
 */
export interface DepthPackNodeHandle {
  material: unknown;
  /** 把一頁重設成「最遠」的那個 quad。見 `virtual-shadow-map.ts` 的說明。 */
  resetMaterial: unknown;
  setRange: (near: number, far: number) => void;
}

export async function createDepthPackNodeMaterial(): Promise<DepthPackNodeHandle> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const { Fn, If, float, vec4, uniform, positionView, positionGeometry, floor, fract } = tsl;

  const uNear = uniform(float(0));
  const uFar = uniform(float(1));

  /**
   * Three 的 `packDepthToRGBA`，用 `floor`/`fract` 寫的 `modf`。
   *
   * ```glsl
   * float af = modf( v * 256^3, vuf );
   * float bf = modf( vuf / 256, vuf );
   * float gf = modf( vuf / 256, vuf );
   * return vec4( vuf / 255, gf * 256/255, bf * 256/255, af );
   * ```
   *
   * `modf(x, out i)` 對正數就是 `(fract(x), floor(x))`，而這裡的 v 一定
   * 在 0…1。
   */
  const packDepth = (v: any): any => {
    const t0 = v.mul(16777216);
    const af = fract(t0);
    const t1 = floor(t0).div(256);
    const bf = fract(t1);
    const t2 = floor(t1).div(256);
    const gf = fract(t2);
    return vec4(floor(t2).div(255), gf.mul(256 / 255), bf.mul(256 / 255), af);
  };

  const fragment = Fn(() => {
    // ## 正交相機的深度可以直接算，不必問 `gl_FragCoord.z`
    //
    // Three 的 depth_frag 是 `0.5 * clip.z / clip.w + 0.5`，而那條式子是
    // **WebGL 約定的**（clip 的 z 在 −1…1）。WebGPU 是 0…1，同一條式子
    // 算出來是別的數字，而圖集的內容兩邊就對不起來。
    //
    // 正交投影下那個值等於 `(−viewZ − near) / (far − near)`，兩個約定都
    // 一樣（推導：z_clip =(2d − far − near)/(far − near)，代進去約掉）。
    // 而虛擬陰影圖的相機一定是正交的。
    const d = positionView.z.negate().sub(uNear).div(uFar.sub(uNear)).toVar();
    const out = packDepth(d).toVar();
    // Three 那份的兩個早退。TSL 沒有中途 return，所以改成覆蓋。
    If(d.lessThanEqual(0), () => {
      out.assign(vec4(0, 0, 0, 0));
    });
    If(d.greaterThanEqual(1), () => {
      out.assign(vec4(1, 1, 1, 1));
    });
    return out;
  });

  const material = new webgpu.NodeMaterial();
  material.fragmentNode = fragment();
  // ## 混合要**明確關掉**
  //
  // 打包出來的 alpha 是最細的那個位元組，值在 0…1 之間亂跳。而 WebGPU 這條
  // 路上它會參與混合 —— 於是寫進去的 RGB 被底下那張白的重設拌過一次。
  //
  // 症狀非常會騙人：深度值算對（`d` 兩邊逐位元相同）、打包也算對（把 R 與
  // G 單獨印出來兩邊也逐位元相同），只有**整包寫進去之後**對不上 —— 圖集
  // 的 R 從 0.553 變成 0.995。把 alpha 固定成 1 就好了，那才指到這裡。
  material.transparent = false;
  material.blending = webgpu.NoBlending;

  // ## 重設一頁的那個 quad
  //
  // `vertexNode` 直接給 clip 座標：xy 蓋滿視埠，z = 1 就是最遠。兩個
  // 約定的「最遠」都是 1（WebGL 的 NDC z 是 −1…1、WebGPU 是 0…1，而兩者
  // 的遠平面都對到 1），所以這一段不必分後端。
  const resetMaterial = new webgpu.NodeMaterial();
  resetMaterial.vertexNode = vec4(positionGeometry.x, positionGeometry.y, 1, 1);
  resetMaterial.fragmentNode = vec4(1, 1, 1, 1);
  resetMaterial.depthTest = true;
  resetMaterial.depthWrite = true;
  resetMaterial.depthFunc = webgpu.AlwaysDepth;

  return {
    material,
    resetMaterial,
    setRange: (near, far) => {
      uNear.value = near;
      uFar.value = far;
    },
  };
}

export interface VirtualShadowMapNodeHandle {
  material: unknown;
  setTextures: (depth: Texture, normal: Texture, shadow: Texture, table: Texture) => void;
  setMatrices: (projectionInverse: Matrix4, cameraMatrix: Matrix4, lightView: Matrix4) => void;
  setLight: (direction: Vector3) => void;
  setLayout: (layout: {
    extent: number;
    depthRange: number;
    pagesPerSide: number;
    atlasPages: number;
    pageSize: number;
  }) => void;
  setDebug: (mode: number) => void;
  /** 深度約定要跟著 renderer 走。 */
  setConvention: (renderer: unknown) => void;
}

export async function createVirtualShadowMapNodeMaterial(): Promise<VirtualShadowMapNodeHandle> {
  const tsl = await loadTsl();
  const webgpu = await loadWebGPU();
  const {
    Fn,
    If,
    float,
    vec3,
    vec4,
    uniform,
    uv,
    texture,
    normalize,
    dot,
    mat4,
    floor,
    fract,
    exp2,
  } = tsl;

  // `texture(null)` 建不起來，所以先給一張佔位的 —— `setTextures` 之後會換掉。
  const tDepth = texture(texture2DPlaceholder(webgpu));
  const tNormal = texture(texture2DPlaceholder(webgpu));
  const tShadow = texture(texture2DPlaceholder(webgpu));
  const tTable = texture(texture2DPlaceholder(webgpu));

  const uProjectionInverse = uniform(mat4());
  const uCameraMatrix = uniform(mat4());
  const uLightView = uniform(mat4());
  const uLightDirection = uniform(vec3(0, -1, 0));
  const uExtent = uniform(float(1));
  const uDepthRange = uniform(float(1));
  const uPagesPerSide = uniform(float(1));
  const uAtlasPages = uniform(float(1));
  const uPageSize = uniform(float(1));
  const uDebug = uniform(float(0));

  const convention = createDepthConvention(tsl);

  /** Three 的 `unpackRGBAToDepth`。係數要跟 `packDepth` 是一對，見 GLSL 那份。 */
  const unpackDepth = (packed: any): any =>
    dot(packed, vec4(255 / 256, 255 / 65536, 255 / 16777216, 1 / 16777216));

  const fragment = Fn(() => {
    const screenUv = uv();
    const rawDepth = sampleDepth(tsl, tDepth, screenUv).toVar();

    // ## 早退在 TSL 裡是**由外往內收**
    //
    // GLSL 那份是一連串 `return`。這裡沒有中途 return，所以先把最外層那個
    // 答案放進 `out`，再一層一層往裡面覆蓋 —— 順序與 GLSL 的 return 順序
    // 一樣，只是方向相反。
    const out = vec4(1).toVar(); // rawDepth >= 1：天空，照得到

    If(rawDepth.lessThan(1), () => {
      const viewPosition = viewPositionFromDepth(
        tsl,
        screenUv,
        rawDepth,
        uProjectionInverse,
        convention,
      ).toVar();
      const worldPosition = uCameraMatrix.mul(vec4(viewPosition, 1)).xyz.toVar();
      const viewNormal = normalize(tNormal.sample(flipV(tsl, screenUv)).xyz.mul(2).sub(1)).toVar();
      // `mat3( uCameraMatrix ) * viewNormal` —— 只要旋轉，不要平移。
      const worldNormal = normalize(uCameraMatrix.mul(vec4(viewNormal, 0)).xyz).toVar();
      const toLight = normalize(uLightDirection.negate()).toVar();

      // 背光面本來就是暗的，不必問陰影圖 —— 而且問了反而會拿到自己的深度。
      out.assign(vec4(0, 0, 0, 1));

      If(dot(worldNormal, toLight).greaterThan(0), () => {
        // 換到光源空間：x/y 是平面上的位置，−z 是沿著光走了多遠。
        const lightSpace = uLightView.mul(vec4(worldPosition, 1)).xyz.toVar();
        const tileUv = lightSpace.xy.div(uExtent).add(0.5).toVar();

        // 光源視錐外面沒有資料 —— 當成照得到，不是當成陰影。
        out.assign(vec4(1));

        If(
          tileUv.x
            .greaterThanEqual(0)
            .and(tileUv.x.lessThanEqual(1))
            .and(tileUv.y.greaterThanEqual(0))
            .and(tileUv.y.lessThanEqual(1)),
          () => {
            const depth = lightSpace.z.negate().div(uDepthRange).toVar();

            // 頁表：這一格該去圖集哪裡拿，以及它是第幾階。CPU 填的
            // `DataTexture`，所以**不翻 V**。
            const entry = tTable.sample(tileUv).toVar();
            const slot = floor(entry.xy.mul(255).add(0.5)).toVar();
            const level = floor(entry.z.mul(255).add(0.5)).toVar();

            const span = exp2(level).toVar();
            const pageUv = fract(tileUv.mul(uPagesPerSide).div(span)).toVar();
            const atlasUv = slot.add(pageUv).div(uAtlasPages).toVar();

            // 圖集是 render target，所以要翻 V。
            const stored = unpackDepth(tShadow.sample(flipV(tsl, atlasUv))).toVar();

            // 偏移就是一個 texel 的深度差，沒有別的項 —— 理由與量到的數字
            // 都在 `virtual-shadow-map.ts` 那份 GLSL 的註解裡。
            const texelWorld = uExtent.mul(span).div(uPagesPerSide.mul(uPageSize)).toVar();
            const bias = texelWorld.mul(2).div(uDepthRange).toVar();
            const lit = depth.sub(bias).lessThanEqual(stored).select(1, 0).toVar();
            out.assign(vec4(vec3(lit), 1));

            // ## 除錯的分支順序**與 GLSL 相反**
            //
            // GLSL 那邊是 `return`，所以第一個成立的贏。這邊是覆蓋，所以
            // 最後一個成立的贏 —— 要拿到同一個答案就得倒過來寫。
            //
            // 號碼本身一定要一樣：不一樣的話跨後端比中間值時比到不同的
            // 東西，而那比不比更糟。
            If(uDebug.greaterThan(0.5), () => {
              out.assign(vec4(tileUv.x, tileUv.y, depth, 1));
            });
            If(uDebug.greaterThan(1.5), () => {
              out.assign(vec4(entry.x, entry.y, level.div(32), 1));
            });
            If(uDebug.greaterThan(2.5), () => {
              const d = stored.sub(depth).mul(20).add(0.5);
              out.assign(vec4(d, d, d, 1));
            });
            If(uDebug.greaterThan(3.5), () => {
              out.assign(vec4(tShadow.sample(flipV(tsl, atlasUv)).rgb, 1));
            });
            If(uDebug.lessThan(-0.5), () => {
              out.assign(vec4(stored, stored, stored, 1));
            });
            If(uDebug.lessThan(-1.5), () => {
              out.assign(vec4(atlasUv.x, atlasUv.y, 0, 1));
            });
          },
        );
      });
    });

    return out;
  });

  const material = new webgpu.NodeMaterial();
  material.fragmentNode = fragment();
  material.depthTest = false;
  material.depthWrite = false;

  return {
    material,
    setTextures: (depth, normal, shadow, table) => {
      tDepth.value = depth;
      tNormal.value = normal;
      tShadow.value = shadow;
      tTable.value = table;
    },
    setMatrices: (projectionInverse, cameraMatrix, lightView) => {
      (uProjectionInverse.value as Matrix4).copy(projectionInverse);
      (uCameraMatrix.value as Matrix4).copy(cameraMatrix);
      (uLightView.value as Matrix4).copy(lightView);
    },
    setLight: (direction) => {
      (uLightDirection.value as Vector3).copy(direction);
    },
    setLayout: (layout) => {
      uExtent.value = layout.extent;
      uDepthRange.value = layout.depthRange;
      uPagesPerSide.value = layout.pagesPerSide;
      uAtlasPages.value = layout.atlasPages;
      uPageSize.value = layout.pageSize;
    },
    setConvention: (renderer) => {
      convention.set(renderer);
    },
    setDebug: (mode) => {
      uDebug.value = mode;
    },
  };
}
