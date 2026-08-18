import { MeshStandardMaterial, ShaderChunk } from 'three';
import { describe, expect, it } from 'vitest';
import { InstancedMesh } from './instanced-mesh.ts';
import { installMaterialDetail } from './material-detail.ts';
import { BoxGeometry } from 'three';

/**
 * shader 注入的失效方式全部是靜默的：字串沒對上就什麼都沒發生（畫面正常、
 * 只是沒省到），對上了但導數寫錯就是某些角度細微的著色錯誤。
 *
 * 所以這裡驗的是**注入後的字串長什麼樣**，不是「有沒有跑完」。
 */

/** Three 真實 shader 裡的那幾行，用來確認替換字串沒有過期。 */
const REAL_CHUNKS = {
  vertex: ['#include <common>', '#include <project_vertex>'],
  fragment: [
    '#include <common>',
    'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
    'vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );',
    'vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );',
  ],
};

function compile(material: MeshStandardMaterial): { vertex: string; fragment: string } {
  const shader = {
    uniforms: {} as Record<string, { value: number }>,
    vertexShader: REAL_CHUNKS.vertex.join('\n'),
    fragmentShader: REAL_CHUNKS.fragment.join('\n'),
  };
  material.onBeforeCompile(shader as never, null as never);
  return { vertex: shader.vertexShader, fragment: shader.fragmentShader };
}

describe('材質細節依螢幕大小降級', () => {
  it('不設定就完全不碰使用者的材質', () => {
    const material = new MeshStandardMaterial();
    const before = material.onBeforeCompile;
    new InstancedMesh(new BoxGeometry(1, 1, 1), material, 4, { autoLod: false });

    // 沒開就不該掛任何鉤子 —— 靜靜改別人的材質是最糟的一種。
    expect(material.onBeforeCompile).toBe(before);
  });

  it('取樣包在分支裡，而且導數在分支外算', () => {
    const material = new MeshStandardMaterial();
    installMaterialDetail(material, { pixels: 8, baseRadius: 1 });
    const { fragment } = compile(material);

    for (const sampler of ['normalMap', 'roughnessMap', 'metalnessMap']) {
      // 導數必須在 `if` 之前 —— 在裡面算是未定義行為，而它不會報錯。
      const dfdx = fragment.indexOf(`vec2 wwDx_${sampler}`);
      const branch = fragment.indexOf('if ( vWWDetail > 0.0 )', dfdx);
      expect(dfdx, sampler).toBeGreaterThan(-1);
      expect(branch, sampler).toBeGreaterThan(dfdx);
      // 分支裡必須是 textureGrad，不能是 texture2D。
      const guarded = fragment.slice(branch, fragment.indexOf('}', branch));
      expect(guarded, sampler).toContain(`textureGrad( ${sampler}`);
      expect(guarded, sampler).not.toContain(`texture2D( ${sampler}`);
    }
  });

  it('螢幕大小從 batchingMatrix 算，而且算在 mvPosition 之後', () => {
    const material = new MeshStandardMaterial();
    installMaterialDetail(material, { pixels: 8, baseRadius: 1 });
    const { vertex } = compile(material);

    // mvPosition 是 project_vertex 產生的 —— 順序反了就讀到未初始化的值。
    expect(vertex.indexOf('#include <project_vertex>')).toBeLessThan(
      vertex.indexOf('- mvPosition.z'),
    );
    expect(vertex).toContain('length( batchingMatrix[ 0 ].xyz )');
    expect(vertex).toContain('smoothstep(');
  });

  it('接住使用者原本的 onBeforeCompile，不蓋掉', () => {
    const material = new MeshStandardMaterial();
    let called = 0;
    material.onBeforeCompile = (): void => {
      called++;
    };
    installMaterialDetail(material, { pixels: 8, baseRadius: 1 });
    compile(material);

    expect(called).toBe(1);
  });

  it('要替換的那幾行，在 Three 現在的 shader 裡真的存在', () => {
    // **這一條要從 Three 自己的 ShaderChunk 讀，不能拿測試裡自己寫的字串比。**
    //
    // 注入靠的是字串比對：Three 一升級、那幾行改了，替換就靜靜失效 ——
    // 畫面完全正常，只是這個功能悄悄沒了。而如果這個測試比的是我自己寫的
    // 常數，它會永遠通過，什麼都擋不住。
    expect(ShaderChunk.normal_fragment_maps).toContain(
      'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
    );
    expect(ShaderChunk.roughnessmap_fragment).toContain(
      'vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );',
    );
    expect(ShaderChunk.metalnessmap_fragment).toContain(
      'vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );',
    );
    // vertex 那兩個注入點是 include 指令，存在於 meshphysical 的 shader 裡。
    expect(ShaderChunk.project_vertex).toContain('mvPosition');
    expect(ShaderChunk.batching_pars_vertex).toContain('getBatchingMatrix');
  });

  it('三個取樣點一個都不漏', () => {
    const material = new MeshStandardMaterial();
    installMaterialDetail(material, { pixels: 8, baseRadius: 1 });
    const { vertex, fragment } = compile(material);

    expect(vertex).toContain('vWWDetail');
    expect(fragment).toContain('vWWDetail');
    expect(fragment).not.toContain('vec3 mapN = texture2D( normalMap');
    expect(fragment).not.toContain('vec4 texelRoughness = texture2D( roughnessMap');
    expect(fragment).not.toContain('vec4 texelMetalness = texture2D( metalnessMap');
  });
});
