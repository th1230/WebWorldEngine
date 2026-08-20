import { describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  Matrix4,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import { InstancedMesh } from './instanced-mesh.ts';

/**
 * 遮蔽剔除接到 `InstancedMesh` 上之後的行為。
 *
 * 緩衝本身的單元測試在 `internal/engine` —— 這裡驗的是**接線**：矩陣有沒有
 * 傳對、包圍球查的是不是同一個 instance、拿掉之後清單有沒有壓對。
 *
 * 接線錯了的症狀與緩衝算錯一模一樣（東西不見，或者完全沒效果），而兩邊
 * 各自的單元測試都會過。
 */

/** 假的 renderer，只提供選階要的那兩個數字。 */
function fakeRenderer(height = 720): unknown {
  return {
    getDrawingBufferSize: (target: { x: number; y: number }) => {
      target.x = (height * 16) / 9;
      target.y = height;
      return target;
    },
    getRenderTarget: () => null,
  };
}

function render(mesh: InstancedMesh, camera: PerspectiveCamera): void {
  const scene = new Scene();
  scene.add(mesh);
  camera.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  mesh.onBeforeRender(
    fakeRenderer() as never,
    scene,
    camera,
    mesh.geometry,
    mesh.material as never,
  );
}

describe('遮蔽剔除接到 InstancedMesh 上', () => {
  /**
   * 一排箱子排在同一條視線上：近的擋住遠的。
   *
   * 用箱子是因為它的內接盒幾乎等於本體 —— 遮蔽能力最強，訊號最清楚。
   */
  function makeRow(count: number, occlusion: boolean): InstancedMesh {
    const mesh = new InstancedMesh(new BoxGeometry(10, 10, 10), new MeshStandardMaterial(), count, {
      occlusion,
      hlod: false,
    });
    const m = new Matrix4();
    for (let i = 0; i < count; i++) {
      // 全部在 z 軸上一路往後排，彼此完全對齊。
      mesh.setMatrixAt(i, m.makeTranslation(0, 0, -30 - i * 7));
    }
    return mesh;
  }

  it('關掉的時候一個都不剔', () => {
    const mesh = makeRow(600, false);
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 9000);
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -1));
    render(mesh, camera);
    expect(mesh.stats.occluded).toBe(0);
  });

  it('開了之後排在後面的箱子被剔掉', () => {
    const mesh = makeRow(600, true);
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 9000);
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -1));
    render(mesh, camera);

    // 第一個看得見，後面的被它擋住。
    expect(mesh.stats.occluded).toBeGreaterThan(400);
    expect(mesh.stats.visible).toBeLessThan(200);
    // 但不能剔光 —— 最前面那個一定看得見。
    expect(mesh.stats.visible).toBeGreaterThan(0);
  });

  it('散開排列的時候不會亂剔', () => {
    // 每個箱子錯開，彼此擋不到 —— 一個都不該被剔。
    const count = 600;
    const mesh = new InstancedMesh(new BoxGeometry(4, 4, 4), new MeshStandardMaterial(), count, {
      occlusion: true,
      hlod: false,
    });
    const m = new Matrix4();
    for (let i = 0; i < count; i++) {
      const angle = i * 2.399;
      const radius = 40 + i * 0.6;
      mesh.setMatrixAt(
        i,
        m.makeTranslation(Math.cos(angle) * radius, Math.sin(angle) * radius, -300),
      );
    }
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 9000);
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -1));
    render(mesh, camera);

    // 全部在同一個深度平面上，誰也擋不住誰。
    expect(mesh.stats.occluded).toBe(0);
  });

  it('低於門檻的數量不做遮蔽剔除 —— 固定成本收不回來', () => {
    const mesh = makeRow(100, true);
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 9000);
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -1));
    render(mesh, camera);
    expect(mesh.stats.occluded).toBe(0);
  });

  it('相機轉到旁邊之後，原本被剔掉的又回來了', () => {
    // 剔除是**每幀重算**的，不是一次算完就記著。記著的話相機一動就會留下
    // 一堆該出現卻沒出現的東西。
    const mesh = makeRow(600, true);
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 9000);
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -1));
    render(mesh, camera);
    const occludedAhead = mesh.stats.occluded;

    // 從側面看這一排 —— 沒有東西擋得住任何東西。
    camera.position.set(2000, 0, -2100);
    camera.lookAt(new Vector3(0, 0, -2100));
    render(mesh, camera);

    expect(occludedAhead).toBeGreaterThan(400);
    expect(mesh.stats.occluded).toBeLessThan(occludedAhead / 4);
  });

  it('開著卻幾乎剔不到東西的時候會警告', () => {
    // 這是這個功能最重要的一條。它在密集散佈的小東西上剔不到東西（實測兩萬顆
    // 石頭剔掉 0 個），而**開著沒效果是使用者看不見的** —— 他只會覺得
    // 「開了好像沒變快」，然後去找別的原因。
    const count = 600;
    const mesh = new InstancedMesh(new BoxGeometry(4, 4, 4), new MeshStandardMaterial(), count, {
      occlusion: true,
      hlod: false,
    });
    const m = new Matrix4();
    for (let i = 0; i < count; i++) {
      const angle = i * 2.399;
      const radius = 10 + i * 0.13;
      mesh.setMatrixAt(
        i,
        m.makeTranslation(Math.cos(angle) * radius, Math.sin(angle) * radius, -300),
      );
    }
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 9000);
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -1));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let frame = 0; frame < 130; frame++) render(mesh, camera);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('幾乎沒有剔到東西');
    warn.mockRestore();
  });

  it('真的有在剔的時候不會亂警告', () => {
    const mesh = makeRow(600, true);
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 9000);
    camera.position.set(0, 0, 0);
    camera.lookAt(new Vector3(0, 0, -1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let frame = 0; frame < 130; frame++) render(mesh, camera);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('cpuParts 會報告它花了多少時間', () => {
    const mesh = makeRow(600, true);
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 9000);
    camera.lookAt(new Vector3(0, 0, -1));
    render(mesh, camera);
    // 有跑就要有數字 —— 沒有數字的話「它值不值得」就問不出來。
    expect(mesh.stats.cpuParts.occlusion).toBeGreaterThanOrEqual(0);
    expect(typeof mesh.stats.cpuParts.occlusion).toBe('number');
  });
});
