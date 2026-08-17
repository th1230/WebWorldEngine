import { BatchedMesh, MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { assertBatchedMeshInternals } from './three-internals.ts';

/**
 * 這個檢查存在的理由：`WW.InstancedMesh` 直接寫 `BatchedMesh` 的私有繪製表。
 * Three.js 若改名或改結構，寫入會落到一個不存在的欄位上 —— **不會報錯，
 * 只是畫面空白**。那是本專案最忌諱的失效形態。
 *
 * 所以這裡不只驗證「對得上時會過」，更重要的是驗證「對不上時真的會炸」。
 * 一個從來沒紅過的檢查跟沒有檢查是同一回事。
 */
describe('assertBatchedMeshInternals', () => {
  function mesh(): BatchedMesh {
    return new BatchedMesh(4, 64, 128, new MeshBasicMaterial());
  }

  it('目前這一版 three 的 BatchedMesh 對得上', () => {
    const internals = assertBatchedMeshInternals(mesh());

    expect(internals._multiDrawStarts).toBeInstanceOf(Int32Array);
    expect(internals._multiDrawCounts).toBeInstanceOf(Int32Array);
    expect(Array.isArray(internals._instanceInfo)).toBe(true);
    expect(Array.isArray(internals._geometryInfo)).toBe(true);
    expect(internals._indirectTexture.image.data).toBeInstanceOf(Uint32Array);
    expect(internals._matricesTexture.image.data).toBeInstanceOf(Float32Array);
    expect(typeof internals._multiDrawCount).toBe('number');
    expect(typeof internals._visibilityChanged).toBe('boolean');
  });

  it.each([
    '_multiDrawStarts',
    '_multiDrawCounts',
    '_instanceInfo',
    '_geometryInfo',
    '_indirectTexture',
    '_matricesTexture',
    '_multiDrawCount',
    '_visibilityChanged',
  ])('少了 %s 就丟例外，而不是靜默地畫不出東西', (field) => {
    const broken = mesh() as unknown as Record<string, unknown>;
    delete broken[field];

    expect(() => assertBatchedMeshInternals(broken)).toThrow(new RegExp(field));
  });

  it('例外訊息說得出怎麼修', () => {
    const broken = mesh() as unknown as Record<string, unknown>;
    delete broken['_multiDrawCount'];

    expect(() => assertBatchedMeshInternals(broken)).toThrow(/three-internals\.ts/);
    expect(() => assertBatchedMeshInternals(broken)).toThrow(/0\.185/);
  });
});
