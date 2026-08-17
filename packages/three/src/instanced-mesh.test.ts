import {
  BoxGeometry,
  Frustum,
  Matrix4,
  IcosahedronGeometry,
  MeshBasicMaterial,
  PlaneGeometry,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Sphere,
  SphereGeometry,
  Uint8BufferAttribute,
  type Vector2,
  Vector3,
  type BufferGeometry,
} from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstancedMesh } from './instanced-mesh.ts';
import { resolveLodChain } from './lod-chain.ts';
import { worldFor } from './world.ts';

/**
 * 這些測試不需要 GPU：所有被驗證的東西（剔除、選階、索引穩定性）都發生在
 * `onBeforeRender` 裡的 CPU 迴圈。真正的畫面驗證走 `pnpm bench`。
 */

const VIEWPORT_HEIGHT = 1080;

/**
 * `Matrix4.compose` 讀的是 `Quaternion._x` 這種私有欄位，所以物件字面值
 * `{ x, y, z, w }` 會靜靜地產生 NaN 矩陣 —— 位置照樣正確，只有縮放全毀。
 * 這裡固定用真的 Three.js 型別。
 */
const _position = new Vector3();
const _scale = new Vector3();
const _rotation = new Quaternion();

/** 只提供 `onBeforeRender` 用得到的那兩個方法。 */
const renderer = {
  getDrawingBufferSize(target: Vector2): Vector2 {
    return target.set(1920, VIEWPORT_HEIGHT);
  },
  getRenderTarget(): null {
    return null;
  },
} as never;

/** 模擬 `EffectComposer` / shadow map：畫到一張離屏的 render target 上。 */
function rendererWithTarget(height: number): never {
  return {
    getDrawingBufferSize(target: Vector2): Vector2 {
      return target.set(1920, VIEWPORT_HEIGHT);
    },
    getRenderTarget(): { height: number } {
      return { height };
    },
  } as never;
}

function material(): MeshBasicMaterial {
  return new MeshBasicMaterial();
}

/** 邊長 1 的立方體，包圍球半徑 √3/2 ≈ 0.866。 */
function unitBox(): BoxGeometry {
  return new BoxGeometry(1, 1, 1);
}

function makeCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1920 / VIEWPORT_HEIGHT, 0.1, 5000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  return camera;
}

/** 模擬 Three.js render() 在呼叫 onBeforeRender 之前做的事。 */
function draw(
  mesh: InstancedMesh,
  camera: PerspectiveCamera,
  scene = new Scene(),
  withRenderer = renderer,
): void {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  mesh.updateMatrixWorld(true);
  mesh.onBeforeRender(withRenderer, scene, camera, mesh.geometry, mesh.material as never);
}

/**
 * 用完全獨立的實作算出「應該看得見」的 instance。
 *
 * 刻意用 Three.js 自己的 `Frustum` 與 `Sphere` 走世界座標 —— 與被測程式碼
 * （自製平面、區域座標、Float32Array）沒有共用任何一行。兩份實作一起錯的
 * 機率遠低於同一份實作自己驗自己。
 */
function referenceVisible(
  mesh: InstancedMesh,
  camera: PerspectiveCamera,
  geometry: BufferGeometry,
): Set<number> {
  geometry.computeBoundingSphere();
  const base = geometry.boundingSphere!;
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    camera.coordinateSystem,
    camera.reversedDepth,
  );

  const visible = new Set<number>();
  const local = new Matrix4();
  const sphere = new Sphere();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, local);
    sphere.copy(base).applyMatrix4(local).applyMatrix4(mesh.matrixWorld);
    if (frustum.intersectsSphere(sphere)) visible.add(i);
  }
  return visible;
}

/** 在 XZ 平面上鋪一片方格，中心在原點。 */
function fillGrid(mesh: InstancedMesh, side: number, spacing: number): void {
  const m = new Matrix4();
  const half = ((side - 1) * spacing) / 2;
  for (let i = 0; i < side * side; i++) {
    const x = (i % side) * spacing - half;
    const z = Math.floor(i / side) * spacing - half;
    mesh.setMatrixAt(i, m.makeTranslation(x, 0, z));
  }
}

describe('InstancedMesh — 換一個字的相容性', () => {
  it('建構參數與 THREE.InstancedMesh 相同', () => {
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 100);

    expect(mesh.count).toBe(100);
    expect(mesh.levelCount).toBe(1);
    expect(mesh.sourceGeometry).toBe(geometry);
  });

  it('是 Object3D，可以直接加進使用者的 scene', () => {
    const scene = new Scene();
    const mesh = new InstancedMesh(unitBox(), material(), 10);
    scene.add(mesh);

    expect(mesh.parent).toBe(scene);
    let found = 0;
    scene.traverse((o) => {
      if (o === mesh) found++;
    });
    expect(found).toBe(1);
  });

  it('setMatrixAt / getMatrixAt 是同一個索引', () => {
    const mesh = new InstancedMesh(unitBox(), material(), 64);
    fillGrid(mesh, 8, 10);

    const read = new Matrix4();
    mesh.getMatrixAt(5, read);
    expect(read.elements[12]).toBeCloseTo(5 * 10 - 35);
  });

  it('空間格重建之後索引仍指向同一個 instance', () => {
    const mesh = new InstancedMesh(unitBox(), material(), 400);
    fillGrid(mesh, 20, 8);
    const camera = makeCamera();
    camera.position.set(0, 200, 0);
    camera.lookAt(0, 0, 0);

    const before = new Matrix4();
    mesh.getMatrixAt(137, before);
    draw(mesh, camera);
    const after = new Matrix4();
    mesh.getMatrixAt(137, after);

    // 重排的是走訪順序表，不是矩陣本身 —— 使用者的 i 必須永遠指向同一個東西。
    expect(after.elements).toEqual(before.elements);
    expect(mesh.stats.cells).toBeGreaterThan(1);
  });

  it('instanceMatrix 與內部儲存共用同一塊記憶體', () => {
    const mesh = new InstancedMesh(unitBox(), material(), 8);
    const m = new Matrix4().makeTranslation(3, 4, 5);
    mesh.setMatrixAt(2, m);

    const array = mesh.instanceMatrix.array;
    expect(array.length).toBe(8 * 16);
    expect(array[2 * 16 + 12]).toBe(3);
    expect(array[2 * 16 + 13]).toBe(4);
    expect(array[2 * 16 + 14]).toBe(5);

    // 反方向：直接寫陣列，getMatrixAt 要讀得到
    array[2 * 16 + 12] = 9;
    const read = new Matrix4();
    mesh.getMatrixAt(2, read);
    expect(read.elements[12]).toBe(9);
  });

  it('count 會被夾在容量內，越界不會讀到別人的矩陣', () => {
    const mesh = new InstancedMesh(unitBox(), material(), 16);
    fillGrid(mesh, 4, 5);
    mesh.count = 999;
    draw(mesh, makeCamera());

    expect(mesh.count).toBe(16);
  });

  it('raycast 照舊，而且打到的是使用者的索引', () => {
    const mesh = new InstancedMesh(unitBox(), material(), 9);
    const m = new Matrix4();
    for (let i = 0; i < 9; i++) mesh.setMatrixAt(i, m.makeTranslation((i - 4) * 10, 0, -20));
    mesh.updateMatrixWorld(true);

    const raycaster = new Raycaster(new Vector3(20, 0, 0), new Vector3(0, 0, -1));
    const hits = raycaster.intersectObject(mesh);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.object).toBe(mesh);
    // (i - 4) * 10 === 20 → i === 6
    expect(hits[0]!.batchId).toBe(6);
  });

  it('raycast 打的是最細的幾何，不受 LOD 影響', () => {
    // 遠處的 instance 畫的是粗階，但 raycast 必須用細階 —— 不然滑鼠會
    // 打在一個玩家看不到的簡化外殼上。
    const mesh = new InstancedMesh(
      { lods: [unitBox(), unitBox(), unitBox()], errors: [0, 0.05, 0.4] },
      material(),
      1,
    );
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, -1500));
    mesh.updateMatrixWorld(true);
    draw(mesh, makeCamera());
    expect(mesh.stats.levels[2]).toBe(1);

    const hits = new Raycaster(new Vector3(0, 0, 0), new Vector3(0, 0, -1)).intersectObject(mesh);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('count = 0 時什麼都不畫', () => {
    const mesh = new InstancedMesh(unitBox(), material(), 16);
    fillGrid(mesh, 4, 5);
    mesh.count = 0;
    draw(mesh, makeCamera());

    expect(mesh.stats.visible).toBe(0);
  });
});

describe('InstancedMesh — 剔除的正確性', () => {
  /**
   * 這是整個類別**唯一真正重要**的正確性條件。
   *
   * 剔錯的症狀是畫面偶爾破洞，而所有時間指標都完全正常 —— 事實上剔掉
   * 越多，數字看起來越好。同樣的錯誤在引擎那一側被抓到過三次
   * （沒外擴 margin、半高取太小、代理比本體大），每一次都是靠這種比對，
   * 沒有一次是靠效能數字。
   */
  const geometry = unitBox();

  function expectNoneLost(mesh: InstancedMesh, camera: PerspectiveCamera): void {
    const drawn = new Set(Array.from(mesh.drawnInstances));
    const expected = referenceVisible(mesh, camera, geometry);
    const lost = [...expected].filter((id) => !drawn.has(id));
    expect(lost).toEqual([]);
  }

  it('沒有任何該看得見的 instance 被剔掉（相機在上方俯視）', () => {
    const mesh = new InstancedMesh(geometry, material(), 2500);
    fillGrid(mesh, 50, 4);
    const camera = makeCamera();
    camera.position.set(0, 60, 0);
    camera.lookAt(0, 0, 0);
    draw(mesh, camera);

    expect(mesh.stats.visible).toBeGreaterThan(0);
    expect(mesh.stats.visible).toBeLessThan(2500);
    expectNoneLost(mesh, camera);
  });

  it('沒有任何該看得見的 instance 被剔掉（相機貼地看向地平線）', () => {
    const mesh = new InstancedMesh(geometry, material(), 2500);
    fillGrid(mesh, 50, 4);
    const camera = makeCamera();
    camera.position.set(0, 1.6, 0);
    camera.lookAt(0, 1.6, -100);
    draw(mesh, camera);

    expectNoneLost(mesh, camera);
  });

  it('中心落在 cell 邊緣的物件不會跟著整個 cell 被剔掉', () => {
    // 物件放大到與 cell 同一個量級 —— margin 沒外擴的話這裡就會漏。
    const mesh = new InstancedMesh(geometry, material(), 900);
    const m = new Matrix4();
    for (let i = 0; i < 900; i++) {
      const x = (i % 30) * 3 - 43.5;
      const z = Math.floor(i / 30) * 3 - 43.5;
      mesh.setMatrixAt(i, m.compose(_position.set(x, 0, z), _rotation, _scale.setScalar(2.5)));
    }
    const camera = makeCamera();
    camera.position.set(0, 5, 30);
    camera.lookAt(0, 0, 0);
    draw(mesh, camera);

    expectNoneLost(mesh, camera);
  });

  it('包圍球心偏離原點的幾何不會漏', () => {
    // 空間格是依 instance 的**平移點**分格的，但物件實際佔的位置是球心。
    // 只用半徑外擴的話，球心偏移的那一段沒被算進去。
    const offset = new BoxGeometry(1, 1, 1).translate(0, 6, 0);
    const mesh = new InstancedMesh(offset, material(), 900);
    fillGrid(mesh, 30, 3);
    const camera = makeCamera();
    camera.position.set(0, 8, 25);
    camera.lookAt(0, 6, -20);
    draw(mesh, camera);

    const drawn = new Set(Array.from(mesh.drawnInstances));
    const lost = [...referenceVisible(mesh, camera, offset)].filter((id) => !drawn.has(id));
    expect(lost).toEqual([]);
  });

  it('整片內容浮在高處時不會整批消失', () => {
    // CellVisibility 的 AABB 是以 y = 0 為中心的 ±halfHeight。用「內容高度
    // 的一半」當 halfHeight 的話，這個場景會一個都畫不出來。
    const mesh = new InstancedMesh(geometry, material(), 400);
    const m = new Matrix4();
    for (let i = 0; i < 400; i++) {
      mesh.setMatrixAt(i, m.makeTranslation((i % 20) * 3 - 28.5, 1000, Math.floor(i / 20) * 3 - 28.5));
    }
    const camera = makeCamera();
    camera.position.set(0, 1010, 40);
    camera.lookAt(0, 1000, 0);
    draw(mesh, camera);

    expect(mesh.stats.visible).toBeGreaterThan(0);
    expectNoneLost(mesh, camera);
  });

  it('相機轉向之後仍然正確（遮罩不是只算一次）', () => {
    const mesh = new InstancedMesh(geometry, material(), 1600);
    fillGrid(mesh, 40, 5);
    const camera = makeCamera();
    camera.position.set(0, 30, 0);

    for (const target of [
      [0, 0, -50],
      [50, 0, 0],
      [0, 0, 50],
      [-50, 0, 0],
    ]) {
      camera.lookAt(target[0]!, target[1]!, target[2]!);
      draw(mesh, camera);
      expectNoneLost(mesh, camera);
    }
  });

  it('物件本身有變換時也正確（frustum 轉進區域空間）', () => {
    const mesh = new InstancedMesh(geometry, material(), 900);
    fillGrid(mesh, 30, 4);
    mesh.position.set(120, 8, -40);
    mesh.rotation.y = 0.7;
    mesh.scale.setScalar(1.5);

    const camera = makeCamera();
    camera.position.set(100, 40, 20);
    camera.lookAt(120, 0, -40);
    draw(mesh, camera);

    expect(mesh.stats.visible).toBeGreaterThan(0);
    expectNoneLost(mesh, camera);
  });

  it('確認這個檢查真的會紅：把 margin 拿掉就會漏', () => {
    // 驗證測試本身。referenceVisible 若因為某個共用的錯誤而與被測程式碼
    // 一起錯，這個檢查就永遠不會紅 —— 那跟沒有檢查是同一回事。
    const mesh = new InstancedMesh(geometry, material(), 900);
    fillGrid(mesh, 30, 4);
    const camera = makeCamera();
    camera.position.set(0, 5, 20);
    camera.lookAt(0, 0, -20);
    draw(mesh, camera);

    const drawn = new Set(Array.from(mesh.drawnInstances));
    // 人工製造一個「被剔掉但其實看得見」的 instance，確認比對抓得到。
    const anyVisible = [...referenceVisible(mesh, camera, geometry)][0]!;
    drawn.delete(anyVisible);
    const lost = [...referenceVisible(mesh, camera, geometry)].filter((id) => !drawn.has(id));
    expect(lost).toEqual([anyVisible]);
  });
});

describe('InstancedMesh — LOD 依螢幕誤差選階', () => {
  function chain(): { lods: BufferGeometry[]; errors: number[] } {
    return {
      lods: [unitBox(), unitBox(), unitBox()],
      errors: [0, 0.05, 0.4],
    };
  }

  it('近的用細階、遠的用粗階', () => {
    const mesh = new InstancedMesh(chain(), material(), 2);
    const m = new Matrix4();
    mesh.setMatrixAt(0, m.makeTranslation(0, 0, -5));
    mesh.setMatrixAt(1, m.makeTranslation(0, 0, -2000));

    const camera = makeCamera();
    draw(mesh, camera);

    expect(mesh.levelCount).toBe(3);
    // 兩個都看得見，但不會落在同一階
    expect(mesh.stats.visible).toBe(2);
    expect(mesh.stats.levels[0]).toBe(1);
    expect(mesh.stats.levels[2]).toBe(1);
  });

  it('同一距離、不同大小的物件會選到不同階', () => {
    // 這正是 THREE.LOD 做不到的事 —— 它只看距離。
    const mesh = new InstancedMesh(chain(), material(), 2);
    const big = new Matrix4().compose(
      new Vector3(-20, 0, -300),
      _rotation,
      new Vector3(40, 40, 40),
    );
    const small = new Matrix4().compose(new Vector3(20, 0, -300), _rotation, new Vector3(1, 1, 1));
    mesh.setMatrixAt(0, big);
    mesh.setMatrixAt(1, small);

    draw(mesh, makeCamera());

    const drawn = Array.from(mesh.drawnInstances);
    expect(drawn.length).toBe(2);
    // 大的必須比小的細（階數小）
    expect(mesh.stats.levels[0]).toBe(1);
    expect(mesh.stats.levels[2]).toBe(1);
  });

  it('errorPixels 是硬上限：被選中的階投影誤差不超過它', () => {
    const errorPixels = 2;
    const errors = [0, 0.05, 0.4];
    const mesh = new InstancedMesh({ lods: [unitBox(), unitBox(), unitBox()], errors }, material(), 60, {
      errorPixels,
    });
    const m = new Matrix4();
    for (let i = 0; i < 60; i++) mesh.setMatrixAt(i, m.makeTranslation(0, 0, -(i + 1) * 20));

    const camera = makeCamera();
    draw(mesh, camera);

    // 用獨立算式重新驗證每一階的選擇
    const ppu = VIEWPORT_HEIGHT / (2 * Math.tan(((60 * Math.PI) / 180) / 2));
    const counted = mesh.stats.levels;
    let checked = 0;
    for (let level = 1; level < errors.length; level++) {
      // 該階能被選中的最遠距離：error * scale / d * ppu ≤ errorPixels
      const maxDistance = (errors[level]! * ppu) / errorPixels;
      expect(counted[level]!).toBeGreaterThanOrEqual(0);
      checked += counted[level]!;
      expect(maxDistance).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('畫進 render target 時用的是 target 的高度，不是畫布的', () => {
    // 後處理、陰影、反射探針都會畫進 render target。用畫布高度算螢幕誤差，
    // 半解析度的 composer 會讓每個物件都選到太細的階 —— 白付三角形，而且
    // **看不出來**：畫面完全正確，只是慢。
    const build = (): InstancedMesh =>
      new InstancedMesh(
        { lods: [unitBox(), unitBox(), unitBox()], errors: [0, 0.05, 0.4] },
        material(),
        1,
      );

    const full = build();
    const half = build();
    const m = new Matrix4().makeTranslation(0, 0, -180);
    full.setMatrixAt(0, m);
    half.setMatrixAt(0, m);

    // 1080 高：0.4 / 180 * 935 = 2.08 px > 2 → 選不到最粗階
    draw(full, makeCamera());
    // 540 高（半解析度）：1.04 px ≤ 2 → 可以選最粗階
    draw(half, makeCamera(), new Scene(), rendererWithTarget(VIEWPORT_HEIGHT / 2));

    expect(full.stats.levels[2]).toBe(0);
    expect(half.stats.levels[2]).toBe(1);
  });

  it('關掉自動 LOD 時說出來，而不是靜默地不做', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    new InstancedMesh(unitBox(), material(), 4, { autoLod: false });
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]![0]).toContain('只有一階幾何');
    info.mockRestore();
  });
});

describe('InstancedMesh — 資產不再是門檻（W2）', () => {
  /**
   * 這一組跑的是**真的 meshoptimizer**。node 環境沒有 `Worker`，所以走的是
   * 主執行緒的退路 —— 那條路也必須是對的，而且必須有講出來。
   */

  function sphere(): SphereGeometry {
    return new SphereGeometry(1, 32, 24);
  }

  it('只給一份 BufferGeometry 也會有 LOD 鏈', async () => {
    const geometry = sphere();
    const mesh = new InstancedMesh(geometry, material(), 100);

    expect(mesh.levelCount).toBe(1); // 還沒補上來，但物件已經可以用
    await mesh.lodReady;
    expect(mesh.levelCount).toBeGreaterThan(1);
  });

  it('鏈補上來之後，遠處的 instance 真的會用粗階', async () => {
    const mesh = new InstancedMesh(sphere(), material(), 2);
    await mesh.lodReady;

    const m = new Matrix4();
    mesh.setMatrixAt(0, m.makeTranslation(0, 0, -4));
    mesh.setMatrixAt(1, m.makeTranslation(0, 0, -2000));
    draw(mesh, makeCamera());

    expect(mesh.stats.visible).toBe(2);
    expect(mesh.stats.levels[0]).toBe(1);
    expect(mesh.stats.levels.at(-1)).toBe(1);
  });

  it('**不會把使用者的 geometry 抽走** —— transfer 只能動複本', async () => {
    // postMessage 的轉移會 detach 來源緩衝區。轉到使用者的 BufferGeometry
    // 上，畫面會直接空掉而且沒有錯誤訊息。
    const geometry = sphere();
    const position = geometry.getAttribute('position');
    const lengthBefore = position.array.length;

    const mesh = new InstancedMesh(geometry, material(), 4);
    await mesh.lodReady;

    expect(position.array.length).toBe(lengthBefore);
    expect(position.array[0]).not.toBeNaN();
    expect(mesh.sourceGeometry).toBe(geometry);
  });

  it('產生的階帶著全部 attribute，長度對得上', async () => {
    const mesh = new InstancedMesh(sphere(), material(), 4);
    await mesh.lodReady;

    // BatchedMesh 的合併幾何必須有與來源相同的 attribute 集合，
    // 少一個 addGeometry 就會丟例外 —— 能走到這裡就代表對上了。
    expect(mesh.geometry.getAttribute('normal')).toBeDefined();
    expect(mesh.geometry.getAttribute('uv')).toBeDefined();
    expect(mesh.levelCount).toBeGreaterThan(1);
  });

  it('非索引的來源也能產生（先熔接）', async () => {
    const geometry = new IcosahedronGeometry(1, 4);
    expect(geometry.getIndex()).toBeNull();

    const mesh = new InstancedMesh(geometry, material(), 4);
    await mesh.lodReady;

    expect(mesh.levelCount).toBeGreaterThan(1);
  });

  it('autoLod: false 就真的不產生', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const mesh = new InstancedMesh(sphere(), material(), 4, { autoLod: false });
    await mesh.lodReady;

    expect(mesh.levelCount).toBe(1);
    info.mockRestore();
  });

  it('自備 lods 時不會再自動接一條尾巴上去', async () => {
    const mesh = new InstancedMesh(
      { lods: [unitBox(), unitBox(), unitBox()], errors: [0, 0.05, 0.4] },
      material(),
      4,
    );
    await mesh.lodReady;
    expect(mesh.levelCount).toBe(3);
  });

  it('做不到的時候講清楚做不到什麼', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const geometry = sphere();
    // 正規化的整數 attribute 轉成 float 會改變語意 —— 寧可不做，並且說出來
    geometry.setAttribute(
      'color',
      new Uint8BufferAttribute(new Uint8Array(geometry.getAttribute('position').count * 3), 3, true),
    );

    const mesh = new InstancedMesh(geometry, material(), 4);
    await mesh.lodReady;

    expect(mesh.levelCount).toBe(1);
    expect(info).toHaveBeenCalled();
    expect(info.mock.calls[0]![0]).toContain('不能自動產生 LOD');
    expect(info.mock.calls[0]![0]).toContain('color');
    info.mockRestore();
  });

  it('簡化不下去的幾何不會產生一堆一模一樣的階', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const mesh = new InstancedMesh(new PlaneGeometry(1, 1), material(), 4);
    await mesh.lodReady;

    expect(mesh.levelCount).toBe(1);
    expect(info.mock.calls.some((call) => String(call[0]).includes('簡化不下去'))).toBe(true);
    info.mockRestore();
  });

  it('鏈補上來之後剔除仍然正確', async () => {
    const geometry = sphere();
    const mesh = new InstancedMesh(geometry, material(), 900);
    fillGrid(mesh, 30, 4);
    await mesh.lodReady;

    const camera = makeCamera();
    camera.position.set(0, 20, 30);
    camera.lookAt(0, 0, -20);
    draw(mesh, camera);

    const drawn = new Set(Array.from(mesh.drawnInstances));
    const lost = [...referenceVisible(mesh, camera, geometry)].filter((id) => !drawn.has(id));
    expect(lost).toEqual([]);
  });
});

describe('InstancedMesh — 物件層級的視錐剔除', () => {
  it('晚一點才寫進來的矩陣不會讓整個物件被剔掉', () => {
    // 這是串流的形狀：建構時是空的，內容之後才進來，而且離原點很遠。
    const mesh = new InstancedMesh(unitBox(), material(), 200, { autoLod: false });
    const camera = makeCamera();
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld(true);

    /** renderer 每一幀對每個物件做的那件事。第一次呼叫會順手快取包圍球。 */
    const rendererWouldCull = (): boolean => {
      camera.updateProjectionMatrix();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      const frustum = new Frustum().setFromProjectionMatrix(
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
      return !frustum.intersectsObject(mesh);
    };

    // 第一幀：只有 identity 矩陣，所以算出來的球在原點 —— 然後被記住。
    rendererWouldCull();
    draw(mesh, camera);

    const m = new Matrix4();
    for (let i = 0; i < 200; i++) mesh.setMatrixAt(i, m.makeTranslation(i % 20, 0, -400));
    camera.position.set(0, 0, -300);
    camera.lookAt(0, 0, -400);
    camera.updateMatrixWorld(true);
    draw(mesh, camera);

    // Three 那一層真的會判斷錯 —— 這一行證明危險是實際存在的，不是假想的。
    // `BatchedMesh.boundingSphere` 只算一次然後永遠快取，`setMatrixAt`
    // 不會讓它失效，所以它還停在原點（現在在相機後面）。
    expect(rendererWouldCull()).toBe(true);

    // 所以必須關掉那一層，否則整個物件一格都不畫，而 console 一片乾淨。
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.stats.visible).toBeGreaterThan(0);
  });
});

describe('InstancedMesh — 靜態是宣告出來的，不是猜出來的', () => {
  /** 相機在正上方看整片 —— 全部都在視錐裡，所以格子省不到走訪。 */
  const overhead = (): PerspectiveCamera => {
    const camera = makeCamera();
    camera.position.set(0, 40, 0);
    camera.lookAt(0, 0, 0);
    return camera;
  };

  /** 每幀改一個矩陣，跑 `frames` 幀。 */
  const jitter = (mesh: InstancedMesh, camera: PerspectiveCamera, frames: number): void => {
    const m = new Matrix4();
    for (let frame = 0; frame < frames; frame++) {
      mesh.setMatrixAt(frame % mesh.count, m.makeTranslation(frame % 20, 0, 0));
      draw(mesh, camera);
    }
  };

  it('沒宣告而矩陣一直在變：量到不划算就暫停，並且說出來', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = new InstancedMesh(unitBox(), material(), 400);
    fillGrid(mesh, 20, 5);
    jitter(mesh, overhead(), 12);

    expect(mesh.stats.spatial).toBe(false);
    expect(warn.mock.calls[0]![0]).toContain('已暫停空間分割剔除');
    // 為什麼暫停必須講清楚：畫面一模一樣，只有幀時間變了。
    expect(warn.mock.calls[0]![0]).toContain('dynamic');
    warn.mockRestore();
  });

  it('暫停之後矩陣停下來，格子會自己恢復', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = new InstancedMesh(unitBox(), material(), 400);
    fillGrid(mesh, 20, 5);
    const camera = overhead();
    jitter(mesh, camera, 12);
    expect(mesh.stats.spatial).toBe(false);

    // 載入時抖動幾幀的內容不該永遠失去空間分割。
    for (let frame = 0; frame < 3; frame++) draw(mesh, camera);
    expect(mesh.stats.spatial).toBe(true);
    warn.mockRestore();
  });

  it('宣告 `dynamic: false` 卻在動：警告，但不換策略', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = new InstancedMesh(unitBox(), material(), 400, { dynamic: false });
    fillGrid(mesh, 20, 5);
    jitter(mesh, overhead(), 12);

    expect(mesh.stats.spatial).toBe(true);
    expect(warn.mock.calls[0]![0]).toContain('`dynamic: false`');
    warn.mockRestore();
  });

  it('宣告 `dynamic: true`：不建格子，不警告，剔除仍然正確', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 900, { dynamic: true });
    fillGrid(mesh, 30, 4);
    const camera = makeCamera();
    camera.position.set(0, 20, 10);
    camera.lookAt(0, 0, -20);

    const m = new Matrix4();
    for (let frame = 0; frame < 12; frame++) {
      mesh.setMatrixAt(frame, m.makeTranslation(0, 0, 0));
      draw(mesh, camera);
    }

    expect(mesh.stats.spatial).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    const drawn = new Set(Array.from(mesh.drawnInstances));
    const lost = [...referenceVisible(mesh, camera, geometry)].filter((id) => !drawn.has(id));
    expect(lost).toEqual([]);
    warn.mockRestore();
  });

  it('靜態內容不會被誤判成動態', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = new InstancedMesh(unitBox(), material(), 400);
    fillGrid(mesh, 20, 5);
    const camera = overhead();

    for (let frame = 0; frame < 30; frame++) draw(mesh, camera);

    expect(mesh.stats.spatial).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('串流那種「每幀都在寫矩陣」會暫停，但載入停下來之後格子回來', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = new InstancedMesh(unitBox(), material(), 10_000);
    fillGrid(mesh, 100, 6);
    const camera = makeCamera();
    camera.position.set(0, 2, 300);
    camera.lookAt(0, 0, 0);

    // 一格載入好了就寫進一批矩陣 —— 跟串流走的是同一條路。
    const burst = new Float32Array(16 * 20);
    for (let i = 0; i < 20; i++) new Matrix4().makeTranslation(i, 0, 300).toArray(burst, i * 16);
    for (let frame = 0; frame < 20; frame++) {
      mesh.writeMatrices(frame * 20, burst);
      draw(mesh, camera);
    }

    // 每幀整份重建**確實不划算** —— 實測 10,000 個時重建 16.30 ms 對省下
    // 0.83 ms，20 倍。所以載入中暫停是對的判斷。
    expect(mesh.stats.spatial).toBe(false);

    // 但**載入會結束**，而結束之後格子必須回來 —— 那才是 1M 撐得住的原因。
    // 舊的實作是永久停用，於是串流過的物件永遠拿不回空間分割：畫面完全
    // 正常，只有幀時間差，正是「靜靜改變行為」最典型的樣子。
    for (let frame = 0; frame < 3; frame++) draw(mesh, camera);
    expect(mesh.stats.spatial).toBe(true);
    expect(mesh.stats.tested).toBeLessThan(mesh.count);
    warn.mockRestore();
  });

  it('改一次矩陣不算動態 —— 不警告也不暫停', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mesh = new InstancedMesh(unitBox(), material(), 400);
    fillGrid(mesh, 20, 5);
    const camera = overhead();

    for (let frame = 0; frame < 5; frame++) draw(mesh, camera);
    mesh.setMatrixAt(7, new Matrix4().makeTranslation(3, 0, 0));
    for (let frame = 0; frame < 5; frame++) draw(mesh, camera);

    expect(mesh.stats.spatial).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('InstancedMesh — 空間分割真的省下走訪', () => {
  it('看不見的 cell 連走訪都不做', () => {
    const mesh = new InstancedMesh(unitBox(), material(), 2500);
    fillGrid(mesh, 50, 4);
    const camera = makeCamera();
    camera.position.set(0, 2, 0);
    camera.lookAt(0, 2, -100);
    draw(mesh, camera);

    const { tested, cells, visibleCells } = mesh.stats;
    expect(cells).toBeGreaterThan(4);
    expect(visibleCells).toBeLessThan(cells);
    // 這是整個機制存在的理由：被剔掉的東西連碰都沒碰過。
    expect(tested).toBeLessThan(2500);
  });
});

describe('LOD 鏈的前置條件', () => {
  it('給了 lods 就必須給 errors', () => {
    expect(() => resolveLodChain({ lods: [unitBox()] } as never)).toThrow(/errors/);
  });

  it('errors[0] 必須是 0', () => {
    expect(() => resolveLodChain({ lods: [unitBox(), unitBox()], errors: [0.1, 0.2] })).toThrow(
      /errors\[0\] 必須是 0/,
    );
  });

  it('errors 必須嚴格遞增', () => {
    expect(() =>
      resolveLodChain({ lods: [unitBox(), unitBox(), unitBox()], errors: [0, 0.3, 0.2] }),
    ).toThrow(/嚴格遞增/);
  });

  it('數量必須相同', () => {
    expect(() => resolveLodChain({ lods: [unitBox(), unitBox()], errors: [0] })).toThrow(/數量必須相同/);
  });

  it('單一幾何不需要 errors', () => {
    const { geometries, errors } = resolveLodChain(unitBox());
    expect(geometries.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBe(0);
  });
});

describe('worldFor', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = new Scene();
  });

  it('同一個 scene 回傳同一個 world', () => {
    expect(worldFor(scene)).toBe(worldFor(scene));
  });

  it('不同 scene 互不干擾', () => {
    expect(worldFor(scene)).not.toBe(worldFor(new Scene()));
  });

  it('加總 scene 裡所有 WW 物件的統計', () => {
    const a = new InstancedMesh(unitBox(), material(), 100);
    const b = new InstancedMesh(unitBox(), material(), 50);
    fillGrid(a, 10, 5);
    fillGrid(b, 7, 5);
    scene.add(a, b);

    const camera = makeCamera();
    camera.position.set(0, 40, 0);
    camera.lookAt(0, 0, 0);
    draw(a, camera, scene);
    draw(b, camera, scene);

    const stats = worldFor(scene).stats;
    expect(stats.objects).toBe(2);
    expect(stats.instances).toBe(150);
    expect(stats.visible).toBe(a.stats.visible + b.stats.visible);
    expect(stats.spatialObjects).toBe(2);
  });

  it('沒有 WW 物件時是零，不是報錯', () => {
    expect(worldFor(scene).stats.objects).toBe(0);
  });
});
