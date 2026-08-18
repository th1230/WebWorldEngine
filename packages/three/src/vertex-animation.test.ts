import {
  AnimationClip,
  Bone,
  type BufferAttribute,
  CylinderGeometry,
  Float32BufferAttribute,
  MeshBasicMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { describe, expect, it } from 'vitest';
import { bakeVertexAnimation, type BakedVertexAnimation } from './vertex-animation.ts';

/**
 * 烘出來的東西**必須與 Three 自己的蒙皮一致**，而驗這件事只有一個誠實的做法：
 * 拿一個算得出答案的案例，逐頂點比。
 *
 * 「跑完沒報錯」在這裡完全不算驗過 —— 烘錯的症狀是模型變形或不動，而兩者
 * 都不會丟例外。
 */

const HEIGHT = 4;

/** 一根兩節骨頭的圓柱，下半段綁骨 0、上半段綁骨 1。 */
function makeRig(): { mesh: SkinnedMesh; bones: Bone[] } {
  const geometry = new CylinderGeometry(0.5, 0.5, HEIGHT, 6, 4);
  const position = geometry.getAttribute('position');
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  for (let i = 0; i < position.count; i++) {
    // 綁定姿勢裡圓柱中心在原點，所以 y > 0 是上半段。
    const upper = position.getY(i) > 0 ? 1 : 0;
    skinIndices.push(upper, 0, 0, 0);
    skinWeights.push(1, 0, 0, 0);
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4));

  const root = new Bone();
  root.name = 'root';
  const tip = new Bone();
  tip.name = 'tip';
  root.add(tip);

  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.add(root);
  mesh.bind(new Skeleton([root, tip]));
  mesh.updateMatrixWorld(true);
  return { mesh, bones: [root, tip] };
}

/** 讀出烘好的第 `frame` 幀、第 `vertex` 個頂點。 */
function read(baked: BakedVertexAnimation, frame: number, vertex: number): Vector3 {
  const at = (frame * baked.vertexCount + vertex) * 4;
  const data = baked.texture.image.data as unknown as ArrayLike<number>;
  return new Vector3(data[at]!, data[at + 1]!, data[at + 2]!);
}

describe('把骨骼動畫烘成頂點位置貼圖', () => {
  it('沒有動畫的軌道時，每一幀都等於綁定姿勢', () => {
    const { mesh } = makeRig();
    const clip = new AnimationClip('still', 1, []);
    const baked = bakeVertexAnimation(mesh, clip, { frames: 4 });

    const position = mesh.geometry.getAttribute('position');
    for (const frame of [0, 1, 2, 3]) {
      for (const v of [0, 5, 11]) {
        const got = read(baked, frame, v);
        const want = new Vector3().fromBufferAttribute(position, v);
        expect(got.distanceTo(want), `第 ${frame} 幀第 ${v} 個頂點`).toBeLessThan(1e-5);
      }
    }
  });

  it('平移一根骨頭，綁在它上面的頂點要跟著移動同樣的量', () => {
    // 這一條是算得出答案的：骨 1 往上移 d，綁在骨 1 的頂點就往上移 d，
    // 綁在骨 0 的完全不動。烘錯的話兩邊都會錯，而且錯得不一樣。
    const { mesh } = makeRig();
    const clip = new AnimationClip('lift', 1, [
      new VectorKeyframeTrack('tip.position', [0, 1], [0, 0, 0, 0, 2, 0]),
    ]);
    const baked = bakeVertexAnimation(mesh, clip, { frames: 3 });

    const position = mesh.geometry.getAttribute('position');
    const skinIndex = mesh.geometry.getAttribute('skinIndex') as BufferAttribute;

    for (let v = 0; v < position.count; v++) {
      const bind = new Vector3().fromBufferAttribute(position, v);
      const last = read(baked, 2, v);
      const expected = skinIndex.getX(v) === 1 ? 2 : 0;
      expect(last.y - bind.y, `第 ${v} 個頂點`).toBeCloseTo(expected, 4);
      // x / z 完全不該動。
      expect(last.x, `第 ${v} 個頂點的 x`).toBeCloseTo(bind.x, 4);
      expect(last.z, `第 ${v} 個頂點的 z`).toBeCloseTo(bind.z, 4);
    }
  });

  it('中間那一幀是內插出來的，不是抓最近的關鍵影格', () => {
    // 抓最近的話中間幀會等於頭或尾，而那個症狀是動作一格一格跳。
    const { mesh } = makeRig();
    const clip = new AnimationClip('lift', 1, [
      new VectorKeyframeTrack('tip.position', [0, 1], [0, 0, 0, 0, 2, 0]),
    ]);
    const baked = bakeVertexAnimation(mesh, clip, { frames: 3 });

    const skinIndex = mesh.geometry.getAttribute('skinIndex') as BufferAttribute;
    const upper = (() => {
      for (let v = 0; v < skinIndex.count; v++) if (skinIndex.getX(v) === 1) return v;
      throw new Error('沒有綁在骨 1 的頂點');
    })();

    const bind = new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), upper);
    // 三幀 → t = 0, 0.5, 1。中間那幀應該是一半。
    expect(read(baked, 1, upper).y - bind.y).toBeCloseTo(1, 4);
  });

  it('旋轉的結果與 Three 自己的蒙皮逐頂點相符', () => {
    // 最強的一條：把同一個姿勢套上去，拿 Three 的 applyBoneTransform 算一遍，
    // 逐頂點比。差異只能來自烘焙的取樣時機，不能來自蒙皮的算法。
    const { mesh, bones } = makeRig();
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7);
    const clip = new AnimationClip('turn', 1, [
      new QuaternionKeyframeTrack(
        'tip.quaternion',
        [0, 1],
        [0, 0, 0, 1, turn.x, turn.y, turn.z, turn.w],
      ),
    ]);
    const baked = bakeVertexAnimation(mesh, clip, { frames: 2 });

    // 手動擺到最後一幀的姿勢。
    bones[1]!.quaternion.copy(turn);
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();

    const position = mesh.geometry.getAttribute('position');
    const reference = new Vector3();
    for (let v = 0; v < position.count; v++) {
      reference.fromBufferAttribute(position, v);
      mesh.applyBoneTransform(v, reference);
      expect(read(baked, 1, v).distanceTo(reference), `第 ${v} 個頂點`).toBeLessThan(1e-5);
    }
  });

  it('貼圖的形狀是「寬 = 頂點數、高 = 幀數」，而且不做線性過濾', () => {
    // 貼圖的一個維度是**頂點編號**，相鄰兩個頂點在空間上毫無關係。線性過濾
    // 會把兩個不相干的頂點混起來，症狀是模型上長出隨機的尖刺。
    const { mesh } = makeRig();
    const baked = bakeVertexAnimation(mesh, new AnimationClip('x', 1, []), { frames: 8 });

    expect(baked.texture.image.width).toBe(baked.vertexCount);
    expect(baked.texture.image.height).toBe(8);
    expect(baked.texture.magFilter).toBe(1003); // NearestFilter
    expect(baked.texture.minFilter).toBe(1003);
    expect(baked.texture.generateMipmaps).toBe(false);
  });

  it('沒有 bind 骨架就當場丟，不是烘出一疊綁定姿勢', () => {
    // 靜靜烘出綁定姿勢的症狀是「動畫沒有播」—— 那看起來像動畫資料有問題，
    // 而不是像烘焙有問題，於是查錯地方。
    const geometry = new CylinderGeometry(0.5, 0.5, HEIGHT, 6, 4);
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
    (mesh as unknown as { skeleton: null }).skeleton = null;
    expect(() => bakeVertexAnimation(mesh, new AnimationClip('x', 1, []))).toThrow(/bind/);
  });

  it('幀數至少 2 —— 一幀的動畫沒有時間軸可以取樣', () => {
    const { mesh } = makeRig();
    const baked = bakeVertexAnimation(mesh, new AnimationClip('x', 1, []), { frames: 1 });
    expect(baked.frameCount).toBe(2);
  });
});
