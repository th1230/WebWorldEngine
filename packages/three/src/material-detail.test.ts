import { BoxGeometry, MeshStandardMaterial, ShaderChunk } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { InstancedMesh } from './instanced-mesh.ts';
import { installMaterialDetail } from './material-detail.ts';

/**
 * shader 注入的失效方式全部是靜默的：對不上就什麼都沒發生（畫面正常、只是
 * 沒省到），對上了但導數寫錯就是某些角度細微的著色錯誤。
 *
 * 所以這裡驗的是**注入後的字串長什麼樣**，不是「有沒有跑完」。
 */

/**
 * Three 交給 `onBeforeCompile` 的 shader **還沒有展開 `#include`**。
 *
 * 這個假 shader 因此也必須是沒展開的形態 —— 餵展開後的內容給它，測試會通過
 * 而真實情況會失效，而那正是第一版犯的錯。
 */
const RAW = {
  vertex: '#include <common>\n#include <project_vertex>',
  fragment: [
    '#include <common>',
    '#include <normal_fragment_maps>',
    '#include <roughnessmap_fragment>',
    '#include <metalnessmap_fragment>',
  ].join('\n'),
};

function compile(material: MeshStandardMaterial): { vertex: string; fragment: string } {
  const shader = {
    uniforms: {} as Record<string, { value: number }>,
    vertexShader: RAW.vertex,
    fragmentShader: RAW.fragment,
  };
  material.onBeforeCompile(shader as never, null as never);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader };
}

describe('材質細節依貼圖縮小程度降級', () => {
  it('不設定就完全不碰使用者的材質', () => {
    const material = new MeshStandardMaterial();
    const before = material.onBeforeCompile;
    new InstancedMesh(new BoxGeometry(1, 1, 1), material, 4, { autoLod: false });

    // 沒開就不該掛任何鉤子 —— 靜靜改別人的材質是最糟的一種。
    expect(material.onBeforeCompile).toBe(before);
  });

  it('三個 include 都被換掉，一個都不漏', () => {
    const material = new MeshStandardMaterial();
    installMaterialDetail(material, { uvPerPixel: 0.004 });
    const { fragment } = compile(material);

    for (const chunk of [
      'normal_fragment_maps',
      'roughnessmap_fragment',
      'metalnessmap_fragment',
    ]) {
      expect(fragment, chunk).not.toContain(`#include <${chunk}>`);
    }
    expect(fragment).toContain('uniform float wwUvPerPixel;');
  });

  it('導數算在取樣之外，而且包在同一個 #ifdef 裡', () => {
    const material = new MeshStandardMaterial();
    installMaterialDetail(material, { uvPerPixel: 0.004 });
    const { fragment } = compile(material);

    for (const [sampler, define] of [
      ['normalMap', 'USE_NORMALMAP'],
      ['roughnessMap', 'USE_ROUGHNESSMAP'],
      ['metalnessMap', 'USE_METALNESSMAP'],
    ]) {
      const guard = fragment.indexOf(`#ifdef ${define}`);
      const dfdx = fragment.indexOf(`vec2 wwDx_${sampler}`, guard);
      const use = fragment.indexOf(`textureGrad( ${sampler}`, dfdx);
      // 導數必須在 `#ifdef` 裡（沒那張貼圖時 UV varying 不存在，裸著放會
      // 編譯失敗）而且在取樣之前。
      expect(guard, sampler).toBeGreaterThan(-1);
      expect(dfdx, sampler).toBeGreaterThan(guard);
      expect(use, sampler).toBeGreaterThan(dfdx);
      // 原本的 texture2D 不能留著 —— 留著就是取樣兩次。
      expect(fragment, sampler).not.toContain(`texture2D( ${sampler}`);
    }
  });

  it('接住使用者原本的 onBeforeCompile，不蓋掉', () => {
    const material = new MeshStandardMaterial();
    let called = 0;
    material.onBeforeCompile = (): void => {
      called++;
    };
    installMaterialDetail(material, { uvPerPixel: 0.004 });
    compile(material);

    expect(called).toBe(1);
  });

  it('vertex shader 完全不動', () => {
    const material = new MeshStandardMaterial();
    installMaterialDetail(material, { uvPerPixel: 0.004 });
    expect(compile(material).vertex).toBe(RAW.vertex);
  });

  it('Three 換版把那幾行改掉時會丟例外，不是靜靜失效', () => {
    // 注入的來源就是 `ShaderChunk`，所以「字串過期」在這裡是抓得到的：
    // 找不到那個呼叫就丟。靜靜失效的症狀是「開了旋鈕但沒省」，查不到原因。
    for (const [chunk, call] of [
      [ShaderChunk.normal_fragment_maps, 'texture2D( normalMap, vNormalMapUv )'],
      [ShaderChunk.roughnessmap_fragment, 'texture2D( roughnessMap, vRoughnessMapUv )'],
      [ShaderChunk.metalnessmap_fragment, 'texture2D( metalnessMap, vMetalnessMapUv )'],
    ]) {
      expect(chunk).toContain(call);
    }
  });
});

describe('材質細節降級 — node 材質', () => {
  it('在 node 材質上大聲說它不會生效，而且回傳值也讀得到', () => {
    // 靜靜沒作用的症狀是「開了旋鈕但一點都沒省」—— 那看起來像旋鈕沒用，
    // 而不是沒生效。兩者的下一步完全不同。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const material = new MeshStandardMaterial();
    (material as unknown as { isNodeMaterial: boolean }).isNodeMaterial = true;
    const handle = installMaterialDetail(material, { uvPerPixel: 0.004 });

    // 只有讀 console 才知道的行為變化是錯的設計 —— 程式也要判斷得出來。
    expect(handle.active).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
