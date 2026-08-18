import { describe, expect, it } from 'vitest';
import { injectVertexAnimation } from './animated-instanced-mesh.ts';

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
