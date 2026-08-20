import { BoxGeometry, Mesh, MeshBasicMaterial, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { applyShadows, type CascadedShadows } from './shadows.ts';

/**
 * 這兩個坑的共同點是**沒有錯誤訊息**：漏接的材質完全沒有陰影，被蓋掉的
 * 頂點動畫變成一群不動的模型。所以測試驗的是「有沒有接到」與「有沒有蓋掉」，
 * 不是「有沒有跑完」。
 */

/** 模擬 CSM：像它一樣**直接指派** `onBeforeCompile`。 */
function fakeCsm(): CascadedShadows & { touched: Set<unknown> } {
  const touched = new Set<unknown>();
  return {
    touched,
    setupMaterial(material): void {
      touched.add(material);
      // 這一行就是真的 CSM 在做的事 —— 蓋掉，不是接續。
      material.onBeforeCompile = function csmHook(): void {};
    },
  };
}

describe('把 CSM 接上整個場景', () => {
  it('每一個材質都接到，不只第一個', () => {
    // 漏掉的症狀是**那個東西上沒有陰影**，而其他東西的陰影是好的 ——
    // 那看起來像 CSM 設定錯了，不像「漏接了一份材質」。
    const scene = new Scene();
    const a = new MeshBasicMaterial();
    const b = new MeshBasicMaterial();
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), a));
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), b));

    const csm = fakeCsm();
    expect(applyShadows(csm, scene)).toBe(2);
    expect(csm.touched.has(a)).toBe(true);
    expect(csm.touched.has(b)).toBe(true);
  });

  it('同一份材質只接一次 —— 共用材質是常態', () => {
    const scene = new Scene();
    const shared = new MeshBasicMaterial();
    for (let i = 0; i < 5; i++) scene.add(new Mesh(new BoxGeometry(1, 1, 1), shared));

    const csm = fakeCsm();
    expect(applyShadows(csm, scene)).toBe(1);
  });

  it('已經掛在材質上的 onBeforeCompile 不會被蓋掉', () => {
    // CSM 的 setupMaterial 是直接指派的。原本掛著的（例如頂點動畫的注入）
    // 會消失 —— 而症狀是一群停在綁定姿勢的模型，不報錯。
    const scene = new Scene();
    const material = new MeshBasicMaterial();
    let mine = 0;
    material.onBeforeCompile = (): void => {
      mine++;
    };
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), material));

    applyShadows(fakeCsm(), scene);
    material.onBeforeCompile({} as never, {} as never);

    // 兩個都要跑到：原本那個，以及 CSM 的。
    expect(mine).toBe(1);
  });

  it('陣列材質也要全部接到', () => {
    const scene = new Scene();
    const a = new MeshBasicMaterial();
    const b = new MeshBasicMaterial();
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), [a, b]));

    const csm = fakeCsm();
    expect(applyShadows(csm, scene)).toBe(2);
  });

  it('一個材質都沒找到時要講 —— 那通常是傳錯物件', () => {
    // 靜靜接了 0 個的症狀是「整個場景都沒有陰影」，看起來像 CSM 設定錯了。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(applyShadows(fakeCsm(), new Scene())).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * ## node 材質配上 CSM 是接不上的組合
   *
   * `setupMaterial` 走的是 `onBeforeCompile`，而 `WebGPURenderer` 不看那個
   * 鉤子。接了、沒報錯、那些材質上一點陰影都不會有 —— 而那看起來像 CSM
   * 的參數設錯了。
   *
   * 所以判準是「有沒有把話講出來」，不是「有沒有跑完」。
   */
  it('材質是 node 材質時大聲說接不上', () => {
    const scene = new Scene();
    const material = new MeshBasicMaterial();
    (material as unknown as { isNodeMaterial: boolean }).isNodeMaterial = true;
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), material));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyShadows(fakeCsm(), scene);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('CSMShadowNode');
    warn.mockRestore();
  });

  it('普通材質不要亂叫 —— 會叫的警告很快就沒人看', () => {
    const scene = new Scene();
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyShadows(fakeCsm(), scene);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
