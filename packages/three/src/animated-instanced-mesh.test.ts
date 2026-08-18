import {
  BoxGeometry,
  DataTexture,
  Float32BufferAttribute,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AnimatedInstancedMesh, injectVertexAnimation } from './animated-instanced-mesh.ts';

/**
 * shader 注入的失效方式全部是靜默的：對不上就什麼都沒發生（所有東西擺在綁定
 * 姿勢，看起來像動畫沒播），順序錯了就是被後面的步驟蓋掉。
 *
 * 所以這裡驗的是**注入後的字串長什麼樣**，不是「有沒有跑完」。
 */

const RAW = ['#include <common>', '#include <batching_vertex>', '#include <begin_vertex>', '#include <project_vertex>'].join('\n');

describe('把 VAT 取樣插進 vertex shader', () => {
  it('取樣寫在 begin_vertex 之後 —— 之前的話 transformed 還不存在', () => {
    const out = injectVertexAnimation(RAW);
    const begin = out.indexOf('#include <begin_vertex>');
    const assign = out.indexOf('transformed = mix(');
    expect(begin).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(begin);
  });

  it('在 project_vertex 之前 —— 之後的話投影已經用舊的位置算完了', () => {
    const out = injectVertexAnimation(RAW);
    expect(out.indexOf('transformed = mix(')).toBeLessThan(out.indexOf('#include <project_vertex>'));
  });

  it('相位取自 getIndirectIndex，不是不存在的 batchId', () => {
    // Three 的 batching chunk 沒有把索引存成具名變數 —— 寫 `batchId` 會讓
    // shader 編不過，而那個失敗**量測看不出來**：三角形數照樣正常（送出去的
    // 幾何有算），時間還特別快。只有主控台會講。
    const out = injectVertexAnimation(RAW);
    expect(out).not.toContain('batchId');
    expect(out).toContain('getIndirectIndex( gl_DrawID )');
    // 要包在 USE_BATCHING 裡 —— 沒有批次時那個函式不存在。
    expect(out).toContain('#ifdef USE_BATCHING');
    expect(out.indexOf('#include <batching_vertex>')).toBeLessThan(out.indexOf('getIndirectIndex'));
  });

  it('時間軸上有內插 —— 只讀一幀的話動作會一格一格跳', () => {
    const out = injectVertexAnimation(RAW);
    expect(out).toContain('mix( wwP0, wwP1');
    // 兩幀都要讀，而且第二幀要夾住上界，不然最後一幀會讀到界外。
    expect(out).toContain('min( wwA + 1.0, wwVatFrames - 1.0 )');
  });

  it('查表用的是 wwVertexId 而不是 gl_VertexID', () => {
    // 幾何進了 BatchedMesh 的共用頂點緩衝之後，gl_VertexID 是**整個批次**的
    // 索引，會查到別的模型的位置 —— 症狀是模型爆開成一團亂線。
    const out = injectVertexAnimation(RAW);
    expect(out).toContain('attribute float wwVertexId;');
    expect(out).not.toContain('gl_VertexID');
  });

  it('取樣落在 texel 中心', () => {
    // 少了 +0.5 會落在兩個 texel 的邊界上，而 NearestFilter 在邊界上挑哪一個
    // 是未定義的 —— 症狀是畫面偶爾抖一下。
    const out = injectVertexAnimation(RAW);
    expect(out).toContain('( wwVertexId + 0.5 )');
    expect(out).toContain('( frame + 0.5 )');
  });

  it('不用 textureSize —— 那是 GLSL ES 3.00 才有的', () => {
    // Three 預設編 GLSL ES 1.00。用了 textureSize 會整支 shader 編不過，
    // 而畫面上是「那個材質的東西整個不見」。
    const out = injectVertexAnimation(RAW);
    expect(out).not.toContain('textureSize');
    expect(out).toContain('uniform float wwVatWidth;');
  });

  it('Three 換版把 begin_vertex 改掉時會丟例外，不是靜靜失效', () => {
    expect(() => injectVertexAnimation('#include <common>')).toThrow(/begin_vertex/);
  });
});

describe('AnimatedInstancedMesh — node 材質（WebGPU 那條路）', () => {
  it('接上 positionNode，而不是只印一句警告', async () => {
    // `onBeforeCompile` 對 node 材質完全無效，所以那條路要另一份實作。
    // 只做 WebGL 那一份的症狀是**一群停在綁定姿勢的模型** —— 不報錯、
    // 幀時間還特別好看。
    //
    // 這裡只驗「有沒有接上」；「畫面有沒有真的在動」要真的 GPU，那在
    // `pnpm webgpu-check` 裡比兩個時間點的像素。
    const material = new MeshBasicMaterial();
    (material as unknown as { isNodeMaterial: boolean }).isNodeMaterial = true;

    const geometry = new BoxGeometry(1, 1, 1);
    const n = geometry.getAttribute('position').count;
    geometry.setAttribute('wwVertexId', new Float32BufferAttribute(new Float32Array(n), 1));

    const mesh = new AnimatedInstancedMesh(
      {
        geometry,
        texture: new DataTexture(new Float32Array(n * 2 * 4), n, 2),
        frameCount: 2,
        duration: 1,
        vertexCount: n,
      } as never,
      material,
      4,
    );
    await mesh.nodeReady;

    // 接上了就會有 positionNode。沒接上的話它還是 undefined，而畫面上是
    // 一群不動的模型 —— 外面看起來與「接上了」一模一樣。
    expect((material as unknown as { positionNode?: unknown }).positionNode).toBeDefined();
  });

  it('node 那條路不會去掛 onBeforeCompile', () => {
    // 掛了也不會被呼叫，但留著會讓人以為那條路有在跑。
    const material = new MeshBasicMaterial();
    (material as unknown as { isNodeMaterial: boolean }).isNodeMaterial = true;
    const before = material.onBeforeCompile;

    const geometry = new BoxGeometry(1, 1, 1);
    const n = geometry.getAttribute('position').count;
    geometry.setAttribute('wwVertexId', new Float32BufferAttribute(new Float32Array(n), 1));
    new AnimatedInstancedMesh(
      {
        geometry,
        texture: new DataTexture(new Float32Array(n * 2 * 4), n, 2),
        frameCount: 2,
        duration: 1,
        vertexCount: n,
      } as never,
      material,
      4,
    );

    expect(material.onBeforeCompile).toBe(before);
  });
});

describe('別人把 onBeforeCompile 蓋掉時', () => {
  it('講出來，而不是靜靜地停在綁定姿勢', () => {
    // `onBeforeCompile` 是單一插槽，而生態系裡有人是**直接指派**的。
    // Three 自己的 CSM 就是（`three/addons/csm`）：
    //
    //   material.onBeforeCompile = function ( shader ) { … };
    //
    // 所以 `csm.setupMaterial(material)` 只要在建立這個 mesh 之後呼叫，
    // 頂點動畫就沒了 —— 而症狀是一群不動的模型，沒有任何錯誤。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const material = new MeshBasicMaterial();
    const geometry = new BoxGeometry(1, 1, 1);
    const n = geometry.getAttribute('position').count;
    geometry.setAttribute('wwVertexId', new Float32BufferAttribute(new Float32Array(n), 1));

    const mesh = new AnimatedInstancedMesh(
      {
        geometry,
        texture: new DataTexture(new Float32Array(n * 2 * 4), n, 2),
        frameCount: 2,
        duration: 1,
        vertexCount: n,
      } as never,
      material,
      2,
    );

    // 模擬 CSM：直接指派，把我們的蓋掉。
    material.onBeforeCompile = (): void => {};

    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    mesh.updateMatrixWorld(true);
    mesh.onBeforeRender(
      { getDrawingBufferSize: (t: never) => t, getRenderTarget: () => null } as never,
      new Scene(),
      camera,
      mesh.geometry,
      mesh.material as never,
    );

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('綁定姿勢');
    expect(said).toContain('CSM');
    warn.mockRestore();
  });
});
