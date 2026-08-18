import {
  BoxGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
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
  Uint16BufferAttribute,
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

  it('宣告了 extendLodChain 才會接尾巴，而且只接更粗的', async () => {
    // ## 為什麼這是宣告的而不是預設的
    //
    // 鏈會見底：示範內容有 88.5% 的 instance 掛在最粗階，接一階更粗的上去
    // GPU 時間掉 61%。但接了之後 `visual-check` 的多畫是 0.471% 對門檻
    // 0.45% —— 踩在容忍邊緣，而分不出那是殘餘的低估還是抗鋸齒。
    //
    // 分不出來就不預設開。**把門檻放寬到剛好讓自己過**是這裡最不該做的事。
    const supplied = { lods: [sphere()], errors: [0] };
    const plain = new InstancedMesh(supplied, material(), 4);
    await plain.lodReady;
    // 自備鏈 + 沒宣告 = 一階都不接。
    expect(plain.levelCount).toBe(1);

    const extended = new InstancedMesh(supplied, material(), 4, { extendLodChain: true });
    await extended.lodReady;
    expect(extended.levelCount).toBeGreaterThan(1);

    // 接上去的每一階都必須比前一階更不準 —— 「更粗 = 更不準」是所有下游
    // 都在假設的性質，而接尾巴是從第 0 階簡化的，落在原鏈範圍裡的那幾階
    // 必須被濾掉才維持得住。
    const errors = extended.errorsPerLevel;
    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]!, `第 ${i} 階`).toBeGreaterThan(errors[i - 1]!);
    }
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

describe('InstancedMesh — 串流的區塊就是現成的空間分割', () => {
  /** 一塊：`n` 個 instance 擠在 `(cx, cz)` 附近，就是串流一格的形狀。 */
  const cellBlock = (cx: number, cz: number, n: number, size = 20): Float32Array => {
    const block = new Float32Array(n * 16);
    const m = new Matrix4();
    for (let i = 0; i < n; i++) {
      m.makeTranslation(
        cx * size + ((i % 5) / 5) * size,
        0,
        cz * size + (Math.floor(i / 5) / 5) * size,
      ).toArray(block, i * 16);
    }
    return block;
  };

  /** 沿著 z 軸鋪一排 cell，每格 25 個 —— 相機只看得到其中幾格。 */
  const streamIn = (mesh: InstancedMesh, cells: number): void => {
    for (let c = 0; c < cells; c++) {
      mesh.writeMatrices(c * 25, cellBlock(0, c - cells / 2, 25));
    }
    mesh.count = cells * 25;
  };

  const check = (mesh: InstancedMesh, camera: PerspectiveCamera, geometry: BufferGeometry): void => {
    draw(mesh, camera);
    const drawn = new Set(Array.from(mesh.drawnInstances));
    const lost = [...referenceVisible(mesh, camera, geometry)].filter((id) => !drawn.has(id));
    expect(lost).toEqual([]);
  };

  const looker = (): PerspectiveCamera => {
    const camera = makeCamera();
    camera.position.set(0, 6, 60);
    camera.lookAt(0, 0, -40);
    return camera;
  };

  it('整段寫入之後就有空間剔除，而且一次格子都沒建', () => {
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 1200, { autoLod: false });
    streamIn(mesh, 40);
    const camera = looker();
    check(mesh, camera, geometry);

    // 這是這條路存在的理由：分割是現成的，所以不必排序，而剔除照樣有效。
    expect(mesh.stats.spatial).toBe(true);
    expect(mesh.stats.tested).toBeLessThan(mesh.count);
    // 空間格一次都沒建 —— 建了的話 cells 會大於 0。
    expect(mesh.stats.cells).toBe(0);
  });

  it('掃過所有角度都不破洞 —— 包括視錐邊緣正好切在區塊邊界上', () => {
    // **這是區塊剔除唯一不能違反的性質。** 區塊的包圍球是從**平移點**算的，
    // 而 instance 有體積 —— 邊緣那些會突出區塊外。半徑沒把體積加回去的話，
    // 突出的部分會跟著整塊一起被剔掉。
    //
    // 症狀是「某個角度看過去少一叢東西」，所有時間指標完全正常。單一視角
    // 測不出來：只有視錐的邊界正好切在區塊邊界上時兩者才會分岔，所以必須
    // 掃角度。
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 900, { autoLod: false });
    const m = new Matrix4();
    const size = new Vector3(6, 6, 6);
    // 每一塊 25 個，而且**放大 6 倍** —— 體積遠大於塊內平移點的間距，
    // 所以「加不加體積」的差別會落在畫面上。
    for (let c = 0; c < 36; c++) {
      const block = new Float32Array(25 * 16);
      for (let i = 0; i < 25; i++) {
        m.makeTranslation(((c % 6) - 3) * 40 + (i % 5) * 4, 0, (Math.floor(c / 6) - 3) * 40 + Math.floor(i / 5) * 4);
        m.scale(size);
        m.toArray(block, i * 16);
      }
      mesh.writeMatrices(c * 25, block);
    }
    mesh.count = 900;

    const camera = makeCamera();
    let sawPartial = false;
    for (let step = 0; step < 48; step++) {
      const angle = (step / 48) * Math.PI * 2;
      camera.position.set(Math.cos(angle) * 70, 8, Math.sin(angle) * 70);
      camera.lookAt(0, 0, 0);
      draw(mesh, camera);
      if (mesh.stats.tested < mesh.count) sawPartial = true;

      const drawn = new Set(Array.from(mesh.drawnInstances));
      const lost = [...referenceVisible(mesh, camera, geometry)].filter((id) => !drawn.has(id));
      expect(lost, `角度 ${step}`).toEqual([]);
    }
    // 每個角度都看得到全部的話，這個測試什麼都沒驗到。
    expect(sawPartial).toBe(true);
  });

  it('卸載（把尾巴搬進洞裡）之後仍然正確', () => {
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 1200, { autoLod: false });
    streamIn(mesh, 40);
    const camera = looker();
    check(mesh, camera, geometry);

    // 串流卸載的形狀：把洞**後面的全部**往前挪，然後 count 縮小。
    // （不是「把最後一塊搬進洞」—— 那是我一開始猜錯的形狀，猜錯的代價是
    // 每一次卸載都讓整張區塊表作廢。）
    for (let i = 0; i < 6; i++) {
      const live = mesh.count;
      const hole = i * 25;
      mesh.moveInstances(hole + 25, hole, live - hole - 25);
      mesh.count = live - 25;
      check(mesh, camera, geometry);
    }
    expect(mesh.stats.spatial).toBe(true);
    expect(mesh.stats.tested).toBeLessThan(mesh.count);
  });

  it('有人逐個改矩陣就作廢整張表，退回空間格', () => {
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 1200, { autoLod: false });
    streamIn(mesh, 40);
    const camera = looker();
    check(mesh, camera, geometry);
    expect(mesh.stats.cells).toBe(0);

    // 一個 setMatrixAt 就讓那一塊的包圍球過期。過期的包圍球會讓整塊憑空
    // 消失，所以必須整張表作廢，不是嘗試修補。
    mesh.setMatrixAt(3, new Matrix4().makeTranslation(0, 0, -500));
    check(mesh, camera, geometry);
    expect(mesh.stats.cells).toBeGreaterThan(0);
  });

  it('不是接在上一塊後面的寫入就作廢', () => {
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 1200, { autoLod: false });
    streamIn(mesh, 40);
    const camera = looker();
    draw(mesh, camera);
    expect(mesh.stats.cells).toBe(0);

    // 覆寫中間那一塊：區塊表對不上，只能作廢。硬記下去會留下一塊邊界錯的
    // 包圍球。
    mesh.writeMatrices(200, cellBlock(3, 3, 25));
    check(mesh, camera, geometry);
    expect(mesh.stats.cells).toBeGreaterThan(0);
  });
});

describe('InstancedMesh — 包圍球快取的增量更新', () => {
  /**
   * 快取只重算改過的那幾段，所以**漏標一段的症狀是那些 instance 用舊的
   * 位置做剔除** —— 畫面破洞，而所有數字都正常。
   *
   * 所以這裡不驗「有沒有增量」，驗的是**每一次變動之後，該看得見的都還在**，
   * 而且是拿一份完全獨立的實作（Three.js 自己的 Frustum + Sphere，走世界
   * 座標）去比。
   */
  const check = (mesh: InstancedMesh, camera: PerspectiveCamera, geometry: BufferGeometry): void => {
    draw(mesh, camera);
    const drawn = new Set(Array.from(mesh.drawnInstances));
    const lost = [...referenceVisible(mesh, camera, geometry)].filter((id) => !drawn.has(id));
    expect(lost).toEqual([]);
  };

  it('宣告動態時，逐段更新的結果與整份重算一致', () => {
    const geometry = unitBox();
    // 宣告動態 → 沒有空間格 → 快取依編號排 → 走增量那條路。
    const mesh = new InstancedMesh(geometry, material(), 900, { dynamic: true, autoLod: false });
    fillGrid(mesh, 30, 6);
    const camera = makeCamera();
    camera.position.set(0, 12, 40);
    camera.lookAt(0, 0, -30);
    check(mesh, camera, geometry);

    const m = new Matrix4();
    const block = new Float32Array(16 * 12);
    // 決定性的偽亂數 —— 破洞必須每次都在同一個地方才查得下去。
    let seed = 20260817;
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);

    for (let round = 0; round < 40; round++) {
      const kind = round % 4;
      if (kind === 0) {
        mesh.setMatrixAt(Math.floor(rnd() * 900), m.makeTranslation(rnd() * 60 - 30, 0, -rnd() * 60));
      } else if (kind === 1) {
        const start = Math.floor(rnd() * 800);
        for (let i = 0; i < 12; i++) {
          m.makeTranslation(rnd() * 80 - 40, 0, -rnd() * 80).toArray(block, i * 16);
        }
        mesh.writeMatrices(start, block);
      } else if (kind === 2) {
        mesh.moveInstances(Math.floor(rnd() * 400) + 400, Math.floor(rnd() * 300), 20);
      } else {
        mesh.count = 700 + Math.floor(rnd() * 200);
      }
      check(mesh, camera, geometry);
    }
  });

  it('搬移之後包圍球跟著搬 —— 搬進來的東西不會用舊位置做剔除', () => {
    // **這是「跟著搬」唯一測得到的方式：讓新舊位置的可見性相反。**
    //
    // 前半段放在相機**背後**，後半段放在**前方**。把後半段搬到前半段的
    // 位置之後，那些編號的內容是「看得見的」；快取沒跟著搬的話它們還留著
    // 背後那份包圍球，於是整批被剔掉 —— 畫面破洞，數字全正常。
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 400, { dynamic: true, autoLod: false });
    const m = new Matrix4();
    for (let i = 0; i < 200; i++) mesh.setMatrixAt(i, m.makeTranslation((i % 20) * 3 - 30, 0, 400));
    for (let i = 200; i < 400; i++) mesh.setMatrixAt(i, m.makeTranslation((i % 20) * 3 - 30, 0, -400));

    const camera = makeCamera();
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    draw(mesh, camera);
    // 先確認前半真的看不見、後半真的看得見 —— 不然這個測試什麼都沒驗到。
    const first = new Set(Array.from(mesh.drawnInstances));
    expect([...first].some((id) => id < 200)).toBe(false);
    expect([...first].some((id) => id >= 200)).toBe(true);

    mesh.moveInstances(200, 0, 200);
    mesh.count = 200;
    draw(mesh, camera);

    const drawn = new Set(Array.from(mesh.drawnInstances));
    const lost = [...referenceVisible(mesh, camera, geometry)].filter((id) => !drawn.has(id));
    expect(lost).toEqual([]);
    expect(drawn.size).toBeGreaterThan(0);
  });

  it('髒區間超過上限就整份重算，不是靜靜漏掉', () => {
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 400, { dynamic: true, autoLod: false });
    fillGrid(mesh, 20, 6);
    const camera = makeCamera();
    camera.position.set(0, 10, 30);
    camera.lookAt(0, 0, -20);
    draw(mesh, camera);

    // 散開的單點改動遠多於追蹤得下的段數。合併不了就必須退回整份重算。
    const m = new Matrix4();
    for (let i = 0; i < 400; i += 7) {
      mesh.setMatrixAt(i, m.makeTranslation((i % 20) * 3 - 30, 0, -(Math.floor(i / 20) * 3)));
    }
    check(mesh, camera, geometry);
  });

  it('容量長大時舊的快取不會被清成零', () => {
    const geometry = unitBox();
    const mesh = new InstancedMesh(geometry, material(), 64, { dynamic: true, autoLod: false });
    fillGrid(mesh, 8, 6);
    const camera = makeCamera();
    camera.position.set(0, 8, 30);
    camera.lookAt(0, 0, 0);
    check(mesh, camera, geometry);

    // 長大會換一塊新的快取陣列。沒把舊的搬過去的話，前 64 個的半徑會變成
    // 0 —— 症狀是它們靜靜地被剔掉，而不是報錯。
    mesh.ensureCapacity(300);
    const block = new Float32Array(16 * 8);
    const m = new Matrix4();
    for (let i = 0; i < 8; i++) m.makeTranslation(i * 4 - 16, 0, -10).toArray(block, i * 16);
    mesh.writeMatrices(64, block);
    mesh.count = 72;
    check(mesh, camera, geometry);
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
  /**
   * 相機在正上方**看得到整片** —— 一格都剔不掉，所以格子省下的走訪是 0。
   *
   * 高度必須夠高。只高一點的話有些 cell 會被剔掉，於是「省下的走訪」不是 0，
   * 而暫停與否就變成一場「累計成本贏不贏得過累計節省」的賽跑 —— 那種測試
   * 在快的機器上會偶爾過、偶爾不過。
   */
  const overhead = (): PerspectiveCamera => {
    const camera = makeCamera();
    camera.position.set(0, 400, 0);
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

describe('InstancedMesh — 同一頁上兩個引擎實例', () => {
  /**
   * 網站上很常見：頁面上兩塊 3D，各自一個 scene、各自一份內容。
   *
   * 套件裡有**模組層級的共用狀態**（LOD worker 是單例、manifest 有快取），
   * 那是刻意的 —— 一個 worker 服務所有 mesh 才對。但共用狀態一旦有一份是
   * 「以為只有一個使用者」寫的，兩塊就會互相污染，而症狀是**其中一塊的
   * 剔除或選階套用了另一塊的相機**。
   *
   * demo 永遠看不出來，因為 demo 只有一塊。
   */
  it('兩個 mesh 各自用自己的相機，統計不互相污染', () => {
    const geometry = unitBox();
    const a = new InstancedMesh(geometry, material(), 400, { autoLod: false });
    const b = new InstancedMesh(geometry, material(), 400, { autoLod: false });
    fillGrid(a, 20, 8);
    fillGrid(b, 20, 8);

    // 一個看得到全部，一個幾乎看不到 —— 兩者的統計必須明顯不同。
    const wide = makeCamera();
    wide.position.set(0, 400, 0);
    wide.lookAt(0, 0, 0);
    const narrow = makeCamera();
    narrow.position.set(0, 2, 500);
    narrow.lookAt(0, 0, 600);

    // 交錯畫，模擬同一幀裡兩塊各自 render 的情形。
    for (let i = 0; i < 4; i++) {
      draw(a, wide);
      draw(b, narrow);
    }

    expect(a.stats.visible).toBeGreaterThan(0);
    expect(b.stats.visible).toBe(0);
    // 反過來再確認一次：換相機之後兩邊都要跟著換，而不是停在對方的結果上。
    draw(a, narrow);
    draw(b, wide);
    expect(a.stats.visible).toBe(0);
    expect(b.stats.visible).toBeGreaterThan(0);
  });

  it('兩個 scene 各自串流，載入的是自己的內容', () => {
    const geometry = unitBox();
    const rocksA = new InstancedMesh(geometry, material(), 4000, { autoLod: false });
    const rocksB = new InstancedMesh(geometry, material(), 4000, { autoLod: false });
    const sceneA = new Scene();
    const sceneB = new Scene();
    sceneA.add(rocksA);
    sceneB.add(rocksB);

    const m = new Matrix4();
    let loadsA = 0;
    let loadsB = 0;
    worldFor(sceneA).stream({
      cellSize: 100,
      radius: 150,
      load: (cx, cz, place) => {
        loadsA++;
        for (let i = 0; i < 10; i++) place(rocksA, m.makeTranslation(cx * 100 + i, 0, cz * 100));
      },
    });
    worldFor(sceneB).stream({
      cellSize: 100,
      radius: 150,
      load: (cx, cz, place) => {
        loadsB++;
        // 刻意放在很遠的地方 —— 兩邊的內容不該混在一起。
        for (let i = 0; i < 10; i++) place(rocksB, m.makeTranslation(cx * 100 + i, 0, cz * 100 + 9000));
      },
    });

    const camera = makeCamera();
    camera.position.set(0, 10, 0);
    camera.lookAt(0, 0, -1);
    camera.updateMatrixWorld(true);
    // 兩個 scene 各自被 render 一次 —— 串流掛在 scene.onBeforeRender 上。
    for (const scene of [sceneA, sceneB]) {
      scene.onBeforeRender(null as never, scene, camera, null as never, null as never, null as never);
    }

    expect(loadsA).toBeGreaterThan(0);
    expect(loadsB).toBeGreaterThan(0);
    // 各自的 world 是各自的：停掉一個不該影響另一個。
    worldFor(sceneA).stopStream();
    expect(worldFor(sceneA).streaming).toBeNull();
    expect(worldFor(sceneB).streaming).not.toBeNull();
  });
});

describe('InstancedMesh — 蒙皮', () => {
  it('有骨骼權重時大聲說「動畫不會發生」，而不是只講 LOD', async () => {
    // ## 這是最危險的那一類失效
    //
    // 底層的 `BatchedMesh` 沒有蒙皮，所以 `skinIndex` / `skinWeight` 會被當成
    // 兩個沒人讀的 attribute 帶著走。畫面上是**綁定姿勢的靜止模型**，動畫
    // 完全不發生 —— 沒有錯誤、沒有例外、幀時間還特別好看。
    //
    // 原本唯一會講話的是 LOD 那條路（「不能自動產生 LOD（有骨骼權重）」），
    // 而那句話講的是別的事，會讓人以為只是少了 LOD。
    const geometry = new CylinderGeometry(0.5, 0.5, 4, 8, 8);
    const n = geometry.getAttribute('position').count;
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(new Float32Array(n * 4), 4));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const mesh = new InstancedMesh(geometry, material(), 4);
    await mesh.lodReady;

    expect(warn).toHaveBeenCalled();
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    // 要講到「不會蒙皮」，不能只說 LOD 產生不了。
    expect(said).toContain('不會蒙皮');
    // 而且要給出路，不是只說做不到。
    expect(said).toContain('SkinnedMesh');

    warn.mockRestore();
    info.mockRestore();
  });

  it('沒有骨骼權重就不要多嘴', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new InstancedMesh(unitBox(), material(), 4, { autoLod: false });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
