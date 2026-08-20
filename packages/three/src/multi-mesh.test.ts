import {
  BoxGeometry,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  type Vector2,
} from 'three';
import { describe, expect, it } from 'vitest';
import { MultiMesh } from './multi-mesh.ts';
import { pixelsPerUnit } from './lod-chain.ts';

/**
 * `MultiMesh` 的正確性只有一條真正重要：**選階必須守住品質契約**。
 *
 * 選錯的症狀是遠處或近處悄悄變粗，而幀時間反而更好看 —— 沒有任何東西會報錯。
 * 所以這裡的判準不是「有沒有跑完」，是「挑的那一階，誤差投影到螢幕上有沒有
 * 超過 errorPixels」，而那個判準由**這個檔案自己算一遍**，不呼叫被測的程式碼。
 */

const VIEWPORT_HEIGHT = 1080;

const renderer = {
  getDrawingBufferSize(target: Vector2): Vector2 {
    return target.set(1920, VIEWPORT_HEIGHT);
  },
  getRenderTarget(): null {
    return null;
  },
} as never;

function material(): MeshBasicMaterial {
  return new MeshBasicMaterial();
}

function makeCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1920 / VIEWPORT_HEIGHT, 0.1, 8000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function draw(mesh: MultiMesh, camera: PerspectiveCamera): void {
  mesh.updateMatrixWorld(true);
  // 第六個參數是 `group`，只有多材質的 Mesh 才會非 null。
  mesh.onBeforeRender(
    renderer,
    new Scene(),
    camera,
    mesh.geometry,
    mesh.material as never,
    null as never,
  );
}

/** 三階的方塊鏈。三階的幾何一樣，差別只在宣告的誤差 —— 選階只看誤差。 */
function boxChain(): { lods: BoxGeometry[]; errors: number[] } {
  return {
    lods: [new BoxGeometry(1, 1, 1), new BoxGeometry(1, 1, 1), new BoxGeometry(1, 1, 1)],
    errors: [0, 0.05, 0.4],
  };
}

describe('MultiMesh — 多份相異幾何', () => {
  it('每一塊各自選階，不會被最近的那一塊綁死', () => {
    // 這就是這個類別存在的理由：整片丟成一份幾何時，選階被最近的那一塊決定，
    // 遠處那些也跟著畫最細的。
    const mesh = new MultiMesh([boxChain(), boxChain()], material());
    const m = new Matrix4();
    mesh.setPieceMatrixAt(0, m.makeTranslation(0, 0, -5));
    mesh.setPieceMatrixAt(1, m.makeTranslation(0, 0, -3000));

    draw(mesh, makeCamera());

    // 近的那塊要最細，遠的那塊要最粗 —— 兩塊在同一次繪製裡用不同的階。
    expect(mesh.levelCounts[0]).toBe(1);
    expect(mesh.levelCounts.at(-1)).toBe(1);
    expect(mesh.levelCounts.length).toBeGreaterThan(1);
  });

  it('挑中的那一階，誤差投影到螢幕上不超過 errorPixels', () => {
    // 判準自己算一遍，不呼叫 selectLevel —— 同一份實作驗自己不算驗過。
    const chain = boxChain();
    const errorPixels = 2;
    const mesh = new MultiMesh([chain], material(), { errorPixels });
    const camera = makeCamera();
    const ppu = pixelsPerUnit(VIEWPORT_HEIGHT, (60 * Math.PI) / 180);
    const m = new Matrix4();

    for (const distance of [4, 12, 40, 120, 400, 1200, 4000]) {
      mesh.setPieceMatrixAt(0, m.makeTranslation(0, 0, -distance));
      draw(mesh, camera);

      const level = mesh.levelCounts.findIndex((n) => n === 1);
      expect(level, `距離 ${distance}`).toBeGreaterThanOrEqual(0);

      // 方塊的包圍球半徑 √3/2，選階用的距離是扣掉半徑之後的最近點。
      const radius = Math.sqrt(3) / 2;
      const near = Math.max(distance - radius, 1e-6);
      const projected = chain.errors[level]! * (1 / near) * ppu;
      expect(projected, `距離 ${distance} 挑了第 ${level} 階`).toBeLessThanOrEqual(errorPixels);
    }
  });

  it('距離越遠挑的階只會越粗，不會來回跳', () => {
    // 不單調的話畫面會在某些距離忽細忽粗，而那看起來像閃爍不像 bug。
    const mesh = new MultiMesh([boxChain()], material());
    const camera = makeCamera();
    const m = new Matrix4();
    let previous = -1;
    for (let distance = 3; distance < 5000; distance = Math.round(distance * 1.3)) {
      mesh.setPieceMatrixAt(0, m.makeTranslation(0, 0, -distance));
      draw(mesh, camera);
      const level = mesh.levelCounts.findIndex((n) => n === 1);
      expect(level, `距離 ${distance}`).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
    // 真的有走到最粗，不是全程都在第 0 階（那樣這個測試等於沒驗）。
    expect(previous).toBe(2);
  });

  it('放大的那一塊要挑更細的階 —— 誤差是世界單位', () => {
    // 只看距離不看縮放的話，放大十倍的東西會過早變粗，而那看得出來。
    const mesh = new MultiMesh([boxChain(), boxChain()], material());
    const camera = makeCamera();
    const small = new Matrix4().makeTranslation(0, 0, -600);
    const large = new Matrix4().makeScale(40, 40, 40).setPosition(0, 0, -600);
    mesh.setPieceMatrixAt(0, small);
    mesh.setPieceMatrixAt(1, large);
    draw(mesh, camera);

    // 兩塊同距離、不同大小 → 必須落在不同的階。
    expect(mesh.levelCounts.filter((n) => n > 0).length).toBeGreaterThan(1);
  });

  it('只給一份幾何的塊就是單一階，不會報錯', () => {
    const mesh = new MultiMesh([new PlaneGeometry(2, 2), boxChain()], material());
    mesh.setPieceMatrixAt(0, new Matrix4().makeTranslation(0, 0, -2000));
    mesh.setPieceMatrixAt(1, new Matrix4().makeTranslation(0, 0, -2000));
    draw(mesh, makeCamera());
    expect(mesh.pieceCount).toBe(2);
  });

  it('矩陣寫進去讀得回來，而且是逐塊的', () => {
    const mesh = new MultiMesh([boxChain(), boxChain(), boxChain()], material());
    const m = new Matrix4();
    mesh.setPieceMatrixAt(1, m.makeTranslation(7, 8, 9));
    const read = new Matrix4();
    mesh.getPieceMatrixAt(1, read);
    expect(read.elements[12]).toBe(7);
    expect(read.elements[13]).toBe(8);
    expect(read.elements[14]).toBe(9);
  });

  it('errors 的筆數對不上就當場丟，不是靜靜算錯', () => {
    expect(
      () =>
        new MultiMesh(
          [{ lods: [new BoxGeometry(1, 1, 1), new BoxGeometry(1, 1, 1)], errors: [0] }],
          material(),
        ),
    ).toThrow(/errors/);
  });

  it('errors[0] 不是 0 就當場丟', () => {
    expect(
      () => new MultiMesh([{ lods: [new BoxGeometry(1, 1, 1)], errors: [0.5] }], material()),
    ).toThrow(/errors\[0\]/);
  });

  it('一塊都沒有就當場丟', () => {
    expect(() => new MultiMesh([], material())).toThrow(/至少/);
  });

  it('算出來的階要真的套到批次上，不是只記在統計裡', () => {
    // `levelCounts` 是我們自己記的，而畫面看的是 `setGeometryIdAt`。兩者
    // 脫鉤的話：統計顯示 LOD 有在運作、畫面卻永遠是最細的那一階，而幀時間
    // 只是「比預期差一點」。上面所有測試都驗不到這一條。
    const mesh = new MultiMesh([boxChain()], material());
    const camera = makeCamera();
    const m = new Matrix4();

    const seen = new Set<number>();
    for (const distance of [4, 200, 4000]) {
      mesh.setPieceMatrixAt(0, m.makeTranslation(0, 0, -distance));
      draw(mesh, camera);
      const level = mesh.levelCounts.findIndex((n) => n === 1);
      // 第 i 塊的第 level 階，在批次裡的 geometry id 是「這塊的第一個 id + level」
      // （建構時是依序 addGeometry 的）。
      expect(mesh.getGeometryIdAt(0), `距離 ${distance}`).toBe(level);
      seen.add(level);
    }
    // 三個距離要真的走到不同的階，否則這條等於沒驗。
    expect(seen.size).toBeGreaterThan(1);
  });

  it('物件層級的視錐剔除是關掉的', () => {
    // `BatchedMesh` 的 boundingSphere 只算一次然後永遠快取，內容一動就過期，
    // 而過期的症狀是**整個物件在相機移動後消失**。逐塊的剔除由
    // perObjectFrustumCulled 負責，那個是每幀重算的。
    const mesh = new MultiMesh([boxChain()], material());
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.perObjectFrustumCulled).toBe(true);
  });
});
