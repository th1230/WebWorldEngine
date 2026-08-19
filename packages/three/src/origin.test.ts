import { BoxGeometry, Matrix4, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { InstancedMesh } from './instanced-mesh.ts';
import { OriginRebase, translateObject } from './origin.ts';
import { worldFor } from './world.ts';

/**
 * 這一支驗的是**精度真的回來了**，不是「函式有跑」。
 *
 * 精度塌陷的症狀是畫面在抖、細節擠在一起 —— 不報錯、不影響幀時間、不會
 * 出現在任何統計上。所以測試必須直接量「兩個很近的東西還分不分得開」，
 * 而不是量「有沒有呼叫到」。
 */

function material(): MeshBasicMaterial {
  return new MeshBasicMaterial();
}

/** 在 `at` 附近放兩個相距 `gap` 的 instance，回傳它們被存成什麼。 */
function placePair(mesh: InstancedMesh, at: number, gap: number): void {
  const m = new Matrix4();
  mesh.setMatrixAt(0, m.makeTranslation(at, 0, 0));
  mesh.setMatrixAt(1, m.makeTranslation(at + gap, 0, 0));
}

function readX(mesh: InstancedMesh, index: number): number {
  const m = new Matrix4();
  mesh.getMatrixAt(index, m);
  return m.elements[12]!;
}

describe('大世界的原點重定位', () => {
  it('這就是要修的病：離原點 200,000 時，相距 5 公釐的兩個東西會擠在一起', () => {
    // 先證明病是真的。沒有這一條的話，下面那些測試只是在驗一個
    // 「解決了想像中的問題」的功能。
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material(), 2, { autoLod: false });
    placePair(mesh, 200_000, 0.005);

    // float32 在 200,000 附近的間距約 0.0156，比 0.005 還大。
    expect(readX(mesh, 1) - readX(mesh, 0)).toBe(0);
  });

  it('搬回原點之後，同樣的兩個東西分得開了', () => {
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material(), 2, { autoLod: false });
    placePair(mesh, 200_000, 0.005);

    mesh.translateInstances(new Vector3(-200_000, 0, 0));

    // 搬完之後它們在原點附近，float32 的間距是 1e-5 等級 —— 分得開了。
    //
    // 但**它們的距離救不回來**：資訊在存進去的那一刻就沒了。這一條驗的是
    // 「搬過去之後精度是好的」，而正確的用法是一開始就別讓座標長那麼大
    //（見下一條：串流的內容是搬過之後才寫進來的）。
    expect(readX(mesh, 1) - readX(mesh, 0)).toBe(0);
    // 兩個都落在原點附近，所以之後**再動它們**就有精度了。
    mesh.setMatrixAt(1, new Matrix4().makeTranslation(0.005, 0, 0));
    expect(readX(mesh, 1)).toBeCloseTo(0.005, 6);
  });

  it('相機沒走遠就完全不動作', () => {
    const rebase = new OriginRebase({ threshold: 4096 });
    const camera = new PerspectiveCamera();
    camera.position.set(100, 0, 100);

    expect(rebase.update(camera)).toBe(false);
    expect(rebase.count).toBe(0);
    expect(camera.position.x).toBe(100);
  });

  it('走遠了就把世界與相機一起搬，相對關係一點都不變', () => {
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material(), 2, { autoLod: false });
    const m = new Matrix4();
    mesh.setMatrixAt(0, m.makeTranslation(5000, 0, 0));
    mesh.setMatrixAt(1, m.makeTranslation(5000, 0, 30));

    const rebase = new OriginRebase({ threshold: 4096 });
    rebase.add(mesh);
    const camera = new PerspectiveCamera();
    camera.position.set(5000, 0, 0);

    // 搬之前：相機到第 0 個是 0，到第 1 個是 30。
    expect(rebase.update(camera)).toBe(true);

    // 搬之後相對關係必須一模一樣 —— 這才是「相對關係不變」的意思。
    expect(camera.position.x - readX(mesh, 0)).toBeCloseTo(0, 6);
    const m1 = new Matrix4();
    mesh.getMatrixAt(1, m1);
    expect(m1.elements[14]! - camera.position.z).toBeCloseTo(30, 6);
    // 相機自己回到原點附近。
    expect(camera.position.length()).toBeLessThan(1);
  });

  it('origin 記得世界座標，而且搬很多次也不漂', () => {
    // 沒有這個的話，重定位之後「這個東西在世界的哪裡」就答不出來 ——
    // 存檔、跟伺服器對齊、跨 session 定位全部要用它。
    const rebase = new OriginRebase({ threshold: 1000 });
    const camera = new PerspectiveCamera();

    let expected = 0;
    for (let i = 0; i < 50; i++) {
      camera.position.x += 1500;
      expected += 1500;
      rebase.update(camera);
      // 場景座標 + origin 必須還原成真正的世界座標。
      expect(camera.position.x + rebase.origin.x).toBeCloseTo(expected, 6);
    }
    expect(rebase.count).toBe(50);
  });

  it('平移量取整 —— 不取整的話搬幾次就開始漂', () => {
    const rebase = new OriginRebase({ threshold: 1000 });
    const camera = new PerspectiveCamera();
    camera.position.set(1234.567, 0, 0);
    rebase.update(camera);

    // 原點只會落在整數上，所以它本身可以被 float32 精確表示。
    expect(rebase.origin.x).toBe(Math.round(1234.567));
    expect(Number.isInteger(rebase.origin.x)).toBe(true);
  });

  it('通知呼叫端搬自己的東西 —— 套件不碰使用者的 Object3D', () => {
    // 自動去搬整個 scene 就得猜哪些是世界、哪些是 HUD 或貼在相機上的，
    // 而猜錯的症狀是東西跑掉。所以這裡只通知。
    const moved: Vector3[] = [];
    const rebase = new OriginRebase({
      threshold: 1000,
      onRebase: (offset) => moved.push(offset.clone()),
    });
    const camera = new PerspectiveCamera();
    camera.position.set(2000, 0, 0);
    rebase.update(camera);

    expect(moved).toHaveLength(1);
    expect(moved[0]!.x).toBe(-2000);

    // 呼叫端拿到 offset 之後搬自己的東西。
    const light = new Scene();
    light.position.set(2000, 0, 0);
    translateObject(light, moved[0]!);
    expect(light.position.x).toBe(0);
    // `updateMatrixWorld` 也要做掉 —— 忘了的話那個物件會晚一幀才跳過去。
    expect(light.matrixWorld.elements[12]).toBe(0);
  });

  it('掛在 World 上，而且加進 scene 的 mesh 會自己被收進來', async () => {
    const scene = new Scene();
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material(), 2, { autoLod: false });
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(9000, 0, 0));
    scene.add(mesh);

    const world = worldFor(scene);
    world.rebaseOrigin({ threshold: 4096 });

    const camera = new PerspectiveCamera();
    camera.position.set(9000, 0, 0);
    world.updateOrigin(camera);

    // 使用者沒有註冊過任何東西 —— scene 裡的 WW 物件要自己被找到，
    // 否則「加進 scene 就運作」這個承諾在這裡就破了。
    expect(readX(mesh, 0)).toBeCloseTo(0, 3);
    expect(world.origin.x).toBe(9000);
  });
});

describe('大世界精度的另外一半：內容寫進來的那一刻', () => {
  it('串流用世界座標描述內容，而存進去的精度不會被距離吃掉', async () => {
    // 這是真正讓大世界成立的那一條。
    //
    // 原點重定位修的是「相機與世界都很大時相減掉精度」——畫面在抖。但使用者
    // 描述內容時只能用世界座標（那是唯一自然的寫法），而矩陣最後存進
    // Float32Array —— 在 200,000 那裡間距是 0.0156，公分級的擺放全毀。
    //
    // 引擎在轉成 float32 之前把原點減掉，所以兩邊都成立：使用者照世界座標
    // 寫，存進去的是小數字。
    const scene = new Scene();
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material(), 4, { autoLod: false });
    mesh.count = 0;
    scene.add(mesh);

    const world = worldFor(scene);
    // 假裝相機已經走到 200,000 並重定位過。
    world.rebaseOrigin({ threshold: 1000 });
    const camera = new PerspectiveCamera();
    camera.position.set(200_000, 0, 0);
    world.updateOrigin(camera);
    expect(world.origin.x).toBe(200_000);

    const m = new Matrix4();
    const stream = world.stream({
      cellSize: 100,
      radius: 150,
      load(_cx, _cz, place) {
        // **世界座標**，相距 5 公釐 —— 使用者不必知道原點的存在。
        place(mesh, m.makeTranslation(200_000, 0, 0));
        place(mesh, m.makeTranslation(200_000.005, 0, 0));
      },
    });

    stream.update(0, 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.update(0, 0, 16);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mesh.count).toBeGreaterThanOrEqual(2);
    // 5 公釐分得開了 —— 直接寫世界座標的話這裡會是 0。
    expect(readX(mesh, 1) - readX(mesh, 0)).toBeCloseTo(0.005, 6);
    world.stopStream();
  });
});

describe('只搬水平 —— 垂直搬會把世界推到看不見', () => {
  it('origin.y 永遠是 0，相機高度不會被歸零', () => {
    // 相機高度通常是絕對的（離地多高），應用程式每幀設回同一個值。
    // 連 Y 一起搬的話，每次重定位就把整個世界往下推一個相機高度，而下一幀
    // 高度又被設回去 —— 世界越沉越深。
    //
    // 實測（`?rebase=200`）畫面上只剩地面那 2 個三角形，而且沒有任何錯誤。
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material(), 2, { autoLod: false });
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, 0));

    const rebase = new OriginRebase({ threshold: 100 });
    rebase.add(mesh);
    const camera = new PerspectiveCamera();
    camera.position.set(500, 14, 500);

    expect(rebase.update(camera)).toBe(true);
    expect(rebase.origin.y).toBe(0);
    // 高度原封不動 —— 世界沒有被往下推。
    expect(camera.position.y).toBe(14);
    // 水平則搬回原點附近。
    expect(Math.hypot(camera.position.x, camera.position.z)).toBeLessThan(1);
  });

  it('高度再大也不會自己觸發重定位', () => {
    // 門檻看的是水平距離。一台拉得很高的相機不該讓整個世界被搬動。
    const rebase = new OriginRebase({ threshold: 1000 });
    const camera = new PerspectiveCamera();
    camera.position.set(0, 50_000, 0);
    expect(rebase.update(camera)).toBe(false);
  });
});
