import type { AssetId } from '@webworld/format';

import type { ThreeAssetProvider } from '@ww/render-three';
import type { BufferGeometry, Material } from 'three/webgpu';

/**
 * AssetId → Three.js 資源的最小實作。
 *
 * 還沒有 Asset Cooker，所以場景直接把建好的 geometry 與 material
 * 註冊進來。之後換成從 cooked pack 載入的實作，`ThreeAssetProvider` 介面不變，
 * backend 也不必改 —— 這就是把它抽成介面的用意。
 */
export class BenchmarkAssetRegistry implements ThreeAssetProvider {
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly materials = new Map<string, Material>();

  registerGeometry(id: string, geometry: BufferGeometry): string {
    this.geometries.set(id, geometry);
    return id;
  }

  registerMaterial(id: string, material: Material): string {
    this.materials.set(id, material);
    return id;
  }

  geometry(id: AssetId): BufferGeometry | undefined {
    return this.geometries.get(id);
  }

  material(id: AssetId): Material | undefined {
    return this.materials.get(id);
  }

  /** 場景結束時釋放。GPU 資源不會等 JavaScript GC。 */
  disposeAll(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
  }
}
