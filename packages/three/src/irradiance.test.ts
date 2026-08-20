import { describe, expect, it, vi } from 'vitest';
import { MeshBasicMaterial, MeshStandardMaterial, Mesh, BoxGeometry, Group, Vector3 } from 'three';
import { IrradianceVolume, applyIrradiance } from './irradiance.ts';

/**
 * 一顆「均勻白光」的探針。
 *
 * SH 的 L0 係數乘上 0.886227 就是輻照度，所以要讓輻照度等於 E，L0 要填
 * E / 0.886227。L1 全部是 0 —— 均勻的環境沒有方向性。
 */
function uniformProbe(irradiance: number): { x: number; y: number; z: number }[] {
  const l0 = irradiance / 0.886227;
  return [
    { x: l0, y: l0, z: l0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  ];
}

function fill(volume: IrradianceVolume, coefficients: { x: number; y: number; z: number }[]): void {
  for (let i = 0; i < volume.probeCount; i++) volume.setProbe(i, coefficients);
}

const unit = (): IrradianceVolume =>
  new IrradianceVolume({
    min: new Vector3(0, 0, 0),
    size: new Vector3(10, 10, 10),
    resolution: [2, 2, 2],
  });

describe('探針體積的網格', () => {
  it('探針落在格點上，兩端都有 —— 邊緣沒有探針的話那半格會被糊掉', () => {
    const volume = unit();
    expect(volume.probeCount).toBe(8);
    expect(volume.probePosition(0).toArray()).toEqual([0, 0, 0]);
    // 索引順序是 x 最快、然後 y、然後 z。
    expect(volume.probePosition(1).toArray()).toEqual([10, 0, 0]);
    expect(volume.probePosition(2).toArray()).toEqual([0, 10, 0]);
    expect(volume.probePosition(4).toArray()).toEqual([0, 0, 10]);
    expect(volume.probePosition(7).toArray()).toEqual([10, 10, 10]);
  });

  it('任何一軸少於 2 顆探針直接擋下來', () => {
    // 只有一層的話那個方向的內插退化成常數，而症狀是「間接光在那個方向
    // 完全不變」—— 看起來像烘壞了，不像網格設錯。
    expect(
      () =>
        new IrradianceVolume({
          min: new Vector3(),
          size: new Vector3(1, 1, 1),
          resolution: [4, 1, 4],
        }),
    ).toThrow(/至少要 2 顆/);
  });
});

describe('SH 求值', () => {
  it('均勻環境下每個法線方向一樣亮 —— 均勻就是沒有方向性', () => {
    const volume = unit();
    fill(volume, uniformProbe(2));

    const at = new Vector3(5, 5, 5);
    for (const n of [
      new Vector3(0, 1, 0),
      new Vector3(0, -1, 0),
      new Vector3(1, 0, 0),
      new Vector3(0, 0, -1),
    ]) {
      const e = volume.sampleAt(at, n);
      expect(e.x).toBeCloseTo(2, 5);
      expect(e.y).toBeCloseTo(2, 5);
      expect(e.z).toBeCloseTo(2, 5);
    }
  });

  it('L1 讓朝向光的那一面比背光面亮', () => {
    // 這一條擋的是「方向搞反」與「L1 被忽略」兩種錯 —— 兩種都不會報錯，
    // 症狀分別是「光從錯的方向來」與「哪裡都一樣亮」。
    const volume = unit();
    // 只有 +Y 方向的 L1（Three 的順序：[0]=Y00, [1]=Y1-1(y), [2]=Y10(z), [3]=Y11(x)）
    fill(volume, [
      { x: 1, y: 1, z: 1 },
      { x: 1, y: 1, z: 1 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    ]);

    const at = new Vector3(5, 5, 5);
    const up = volume.sampleAt(at, new Vector3(0, 1, 0));
    const down = volume.sampleAt(at, new Vector3(0, -1, 0));
    expect(up.y).toBeGreaterThan(down.y);
  });

  it('負值會被夾成 0 —— 負的輻照度沒有意義，而它會在畫面上變成黑洞', () => {
    const volume = unit();
    // L1 大到讓背光面算出負值。
    fill(volume, [
      { x: 0.1, y: 0.1, z: 0.1 },
      { x: 5, y: 5, z: 5 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
    ]);
    const down = volume.sampleAt(new Vector3(5, 5, 5), new Vector3(0, -1, 0));
    expect(down.x).toBe(0);
  });

  it('強度是個乘數', () => {
    const volume = unit();
    fill(volume, uniformProbe(1));
    const before = volume.sampleAt(new Vector3(5, 5, 5), new Vector3(0, 1, 0)).y;
    volume.intensity = 3;
    const after = volume.sampleAt(new Vector3(5, 5, 5), new Vector3(0, 1, 0)).y;
    expect(after).toBeCloseTo(before * 3, 5);
  });
});

describe('日夜循環：先烘幾個角度，執行期內插', () => {
  // 太陽移動會讓**每一顆**探針過期，而整份重烘量到 693 ms、持續重烘每幀
  // 多付 12.1 ms。太陽不會停，所以那筆錢也不會停 —— 一個要求每幀重烘的
  // 烘焙等於沒有烘。所以改成先烘幾個相位，執行期在它們之間內插。

  it('沒有關鍵幀的時候設相位不會動到探針', () => {
    // 這是「沒在用日夜循環」的正常狀態，不是錯誤 —— 不能把探針清成 0。
    const volume = unit();
    fill(volume, uniformProbe(3));
    volume.phase = 0.7;
    expect(volume.keyframeCount).toBe(0);
    expect(volume.sampleAt(new Vector3(5, 5, 5), new Vector3(0, 1, 0)).x).toBeCloseTo(3, 5);
  });

  it('兩個關鍵幀中間拿到的是兩者的內插', () => {
    const volume = unit();
    fill(volume, uniformProbe(2));
    volume.saveKeyframe(0);
    fill(volume, uniformProbe(6));
    volume.saveKeyframe(1);
    expect(volume.keyframeCount).toBe(2);

    const n = new Vector3(0, 1, 0);
    const at = new Vector3(5, 5, 5);
    volume.phase = 0;
    expect(volume.sampleAt(at, n).x).toBeCloseTo(2, 4);
    volume.phase = 1;
    expect(volume.sampleAt(at, n).x).toBeCloseTo(6, 4);
    volume.phase = 0.5;
    expect(volume.sampleAt(at, n).x).toBeCloseTo(4, 4);
    volume.phase = 0.25;
    expect(volume.sampleAt(at, n).x).toBeCloseTo(3, 4);
  });

  it('超出兩端用最近的那一份，不外插', () => {
    // 外插會讓亮度跑到負的，而負的輻照度在畫面上是黑洞。
    const volume = unit();
    fill(volume, uniformProbe(2));
    volume.saveKeyframe(0);
    fill(volume, uniformProbe(6));
    volume.saveKeyframe(1);

    const n = new Vector3(0, 1, 0);
    const at = new Vector3(5, 5, 5);
    volume.phase = -5;
    expect(volume.sampleAt(at, n).x).toBeCloseTo(2, 4);
    volume.phase = 99;
    expect(volume.sampleAt(at, n).x).toBeCloseTo(6, 4);
  });

  it('同一個相位存兩次是取代，不是疊兩份', () => {
    const volume = unit();
    fill(volume, uniformProbe(1));
    volume.saveKeyframe(0.5);
    fill(volume, uniformProbe(9));
    volume.saveKeyframe(0.5);
    expect(volume.keyframeCount).toBe(1);
    volume.phase = 0.5;
    expect(volume.sampleAt(new Vector3(5, 5, 5), new Vector3(0, 1, 0)).x).toBeCloseTo(9, 4);
  });

  it('關鍵幀存進去的順序不影響結果', () => {
    // 呼叫端沒有義務照順序烘（漸進式烘焙可能是亂序完成的）。
    const volume = unit();
    fill(volume, uniformProbe(8));
    volume.saveKeyframe(1);
    fill(volume, uniformProbe(0));
    volume.saveKeyframe(0);
    volume.phase = 0.5;
    expect(volume.sampleAt(new Vector3(5, 5, 5), new Vector3(0, 1, 0)).x).toBeCloseTo(4, 4);
  });

  it('相位改了之後貼圖裡的資料也真的變了', () => {
    // 只改 CPU 那份的話畫面停在上一版，而數字全部正確 —— 這個專案最怕的
    // 形狀。所以直接檢查半精度那份。
    const volume = unit();
    fill(volume, uniformProbe(2));
    volume.saveKeyframe(0);
    fill(volume, uniformProbe(6));
    volume.saveKeyframe(1);

    volume.phase = 0;
    volume.upload();
    const low = (volume.textures[0]!.image.data as Uint16Array)[0];
    volume.phase = 1;
    volume.upload();
    const high = (volume.textures[0]!.image.data as Uint16Array)[0];
    expect(high).not.toBe(low);
  });
});

describe('一輪要挑得動好幾顆過期的探針', () => {
  it('挑走的排除掉之後會換下一顆，不是一直回同一顆', () => {
    // ## 這條是回歸測試
    //
    // 烘焙是「先把整輪發射出去、最後一次等完」——所以挑的當下還不能標記
    // 完成（那要等讀回）。少了排除清單，`nextToBake()` 每次都回同一顆，
    // 於是一輪只烘得動一顆，每顆各付一次 GPU 同步。
    //
    // 而這個退化**只在過期這條路上發生**：「還沒烘過」那條有 `_baked` 在
    // 推進，看不出問題。實測整份重烘 256 顆跑了 256 輪、每顆 10.19 ms，
    // 而批次正常時是 2.7 ms。
    const volume = unit();
    // 先全部烘完，這樣唯一的來源就是過期佇列。
    volume.markBaked(volume.probeCount);
    expect(volume.nextToBake()).toBe(-1);

    volume.invalidateAround(new Vector3(5, 5, 5), 100); // 全部

    const claimed = new Set<number>();
    for (let i = 0; i < volume.probeCount; i++) {
      const index = volume.nextToBake(claimed);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(claimed.has(index)).toBe(false);
      claimed.add(index);
    }
    // 全部挑完之後就沒有了。
    expect(volume.nextToBake(claimed)).toBe(-1);
  });

  it('沒給排除清單時行為不變', () => {
    const volume = unit();
    volume.markBaked(volume.probeCount);
    volume.invalidateAround(new Vector3(0, 0, 0), 1);
    const first = volume.nextToBake();
    expect(first).toBeGreaterThanOrEqual(0);
    // 沒標完成，所以再問一次還是同一顆 —— 呼叫端靠它知道「這顆還沒好」。
    expect(volume.nextToBake()).toBe(first);
  });
});

describe('三線性內插', () => {
  it('兩顆探針中間拿到的是兩者的平均', () => {
    const volume = new IrradianceVolume({
      min: new Vector3(0, 0, 0),
      size: new Vector3(10, 10, 10),
      resolution: [2, 2, 2],
    });
    // x = 0 那一面全暗，x = 10 那一面全亮。
    for (let i = 0; i < volume.probeCount; i++) {
      const onFarX = i % 2 === 1;
      volume.setProbe(i, uniformProbe(onFarX ? 4 : 0));
    }

    const n = new Vector3(0, 1, 0);
    expect(volume.sampleAt(new Vector3(0, 5, 5), n).x).toBeCloseTo(0, 5);
    expect(volume.sampleAt(new Vector3(10, 5, 5), n).x).toBeCloseTo(4, 5);
    expect(volume.sampleAt(new Vector3(5, 5, 5), n).x).toBeCloseTo(2, 5);
    expect(volume.sampleAt(new Vector3(2.5, 5, 5), n).x).toBeCloseTo(1, 5);
  });

  it('體積外會被夾住，不會繞到另一邊', () => {
    const volume = new IrradianceVolume({
      min: new Vector3(0, 0, 0),
      size: new Vector3(10, 10, 10),
      resolution: [2, 2, 2],
    });
    for (let i = 0; i < volume.probeCount; i++)
      volume.setProbe(i, uniformProbe(i % 2 === 1 ? 4 : 0));
    const n = new Vector3(0, 1, 0);
    // 遠遠超出 +x 那一側，拿到的還是那一面的值。
    expect(volume.sampleAt(new Vector3(999, 5, 5), n).x).toBeCloseTo(4, 5);
    expect(volume.sampleAt(new Vector3(-999, 5, 5), n).x).toBeCloseTo(0, 5);
  });
});

describe('接到材質上', () => {
  it('每個材質只接一次 —— 同一份材質被很多物件共用是常態', () => {
    const volume = unit();
    const material = new MeshStandardMaterial();
    const root = new Group();
    for (let i = 0; i < 5; i++) root.add(new Mesh(new BoxGeometry(), material));

    expect(applyIrradiance(volume, root)).toBe(1);
  });

  it('接住原本的 onBeforeCompile，不搶插槽', () => {
    // `onBeforeCompile` 是單一插槽，而 Three 自己的 CSM 是直接指派。
    // 這裡如果也直接指派，接的順序就會變成使用者要記住的知識。
    const volume = unit();
    const material = new MeshStandardMaterial();
    const before = vi.fn();
    material.onBeforeCompile = before;

    applyIrradiance(volume, new Mesh(new BoxGeometry(), material));

    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <worldpos_vertex>',
      fragmentShader: '#include <common>\n#include <lights_fragment_maps>',
    };
    material.onBeforeCompile(shader as never, null as never);

    expect(before).toHaveBeenCalledOnce();
    expect(shader.fragmentShader).toContain('wwIrradiance');
    expect(shader.vertexShader).toContain('wwWorldPos');
    expect(Object.keys(shader.uniforms)).toContain('wwIrrSH0');
  });

  it('接上去之後改 intensity 還是有效 —— uniform 物件不能每次重建', () => {
    // `onBeforeCompile` 只在編譯時跑一次，它把 uniform **物件**交給 shader。
    // 每次回傳新物件的話，接上去之後改 intensity 就完全沒有反應而且不報錯。
    //
    // 這一條特別重要，因為 A/B 比較正是靠改 intensity 做的 —— 壞掉的話
    // 兩邊會量到同一個值，然後那個「沒有差異」會被讀成「間接光沒生效」。
    const volume = unit();
    const material = new MeshStandardMaterial();
    applyIrradiance(volume, new Mesh(new BoxGeometry(), material));

    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <worldpos_vertex>',
      fragmentShader: '#include <common>\n#include <lights_fragment_maps>',
    };
    material.onBeforeCompile(shader as never, null as never);

    expect(shader.uniforms.wwIrrIntensity?.value).toBe(1);
    volume.intensity = 0;
    expect(shader.uniforms.wwIrrIntensity?.value).toBe(0);
  });

  it('不做光照的材質會警告 —— 否則它是靜靜地沒有間接光', () => {
    // `MeshBasicMaterial` 的著色器裡沒有 lights_fragment_maps，字串取代
    // 找不到目標時不會報錯，只是什麼都沒發生。
    const volume = unit();
    const material = new MeshBasicMaterial();
    applyIrradiance(volume, new Mesh(new BoxGeometry(), material));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <worldpos_vertex>',
      fragmentShader: '#include <common>\nvoid main() {}',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('不做光照');
    warn.mockRestore();
  });

  it('node 材質走另一條路，不碰 onBeforeCompile', () => {
    // `onBeforeCompile` 是 WebGL 的鉤子，`WebGPURenderer` 完全不經過它。
    // 在這裡不分流的話，WebGPU 上是靜靜地完全沒有間接光。
    const volume = unit();
    const material = new MeshStandardMaterial();
    (material as unknown as { isNodeMaterial: boolean }).isNodeMaterial = true;
    const before = material.onBeforeCompile;

    applyIrradiance(volume, new Mesh(new BoxGeometry(), material));

    // 走了 node 那條路，所以 WebGL 的鉤子原封不動。
    expect(material.onBeforeCompile).toBe(before);
  });

  /**
   * ## 改 intensity 要同時改到兩條路
   *
   * WebGL 讀的是 uniform，node 那條路讀的是一張 1×1 的貼圖 —— 那個節點底下
   * 的 uniform 只在第一次繪製時上傳（四種試過的做法記在 `irradiance-node.ts`）。
   *
   * 漏掉貼圖那一半的症狀是「這個公開屬性在 WebGPU 上靜靜地沒有作用」。
   */
  it('建構時給的 intensity 也要進那張貼圖', () => {
    // 初值寫死的話 `new IrradianceVolume({ intensity: 0 })` 在 node 那條路上
    // 照樣全亮 —— setter 從來沒跑過。關卡抓到過：關掉時該是 0，讀到 134.9。
    const volume = new IrradianceVolume({
      min: new Vector3(0, 0, 0),
      size: new Vector3(10, 10, 10),
      resolution: [2, 2, 2],
      intensity: 0.25,
    });
    expect((volume.intensityTexture.image.data as Float32Array)[0]).toBe(0.25);
  });

  it('改 intensity 會同時改到 uniform 與那張貼圖', () => {
    const volume = unit();
    const version = volume.intensityTexture.version;
    volume.intensity = 0.5;
    expect(volume.intensity).toBe(0.5);
    expect((volume.intensityTexture.image.data as Float32Array)[0]).toBe(0.5);
    // `needsUpdate` 在 Three 上只有 setter（它加 `version`），讀回來是 undefined。
    expect(volume.intensityTexture.version).toBeGreaterThan(version);
  });

  it('沒有 node 材質的時候改 intensity 不會亂吼', () => {
    const volume = unit();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    volume.intensity = 0.5;
    expect(volume.intensity).toBe(0.5);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('root 底下沒有材質會警告 —— 症狀是整個場景沒有間接光', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(applyIrradiance(unit(), new Group())).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('烘的進度', () => {
  it('一顆都沒烘的時候是全黑，不是隨機值', () => {
    // 沒初始化的記憶體會是隨機的，而隨機的 SH 在畫面上是**閃爍的彩色雜訊**。
    const volume = unit();
    expect(volume.baked).toBe(0);
    expect(volume.progress).toBe(0);
    const e = volume.sampleAt(new Vector3(5, 5, 5), new Vector3(0, 1, 0));
    expect(e.x).toBe(0);
    expect(e.y).toBe(0);
    expect(e.z).toBe(0);
  });

  it('progress 走到 1 就是烘完了', () => {
    const volume = unit();
    volume.markBaked(volume.probeCount);
    expect(volume.progress).toBe(1);
    // 多算的不會超過總數。
    volume.markBaked(50);
    expect(volume.baked).toBe(volume.probeCount);
  });
});

describe('會動的東西：把附近的探針標成過期', () => {
  const volume = (): IrradianceVolume =>
    new IrradianceVolume({
      min: new Vector3(0, 0, 0),
      size: new Vector3(30, 30, 30),
      resolution: [4, 4, 4],
    });

  it('只標半徑內的，不標整片', () => {
    const v = volume();
    // 格距是 10，所以半徑 6 只碰得到最靠近的那幾顆。
    const marked = v.invalidateAround(new Vector3(0, 0, 0), 6);
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(v.probeCount);
    expect(v.stale).toBe(marked);
  });

  it('用球不是盒 —— 盒的角落離得比半徑遠', () => {
    // 半徑 10 的球只碰得到原點與三個軸上的鄰居（距離 10），碰不到
    // 對角線上那顆（距離 10√2 ≈ 14.1）。
    const v = volume();
    v.invalidateAround(new Vector3(0, 0, 0), 10.5);
    expect(v.stale).toBe(4);
  });

  it('同一顆標兩次不會排兩遍', () => {
    const v = volume();
    const first = v.invalidateAround(new Vector3(0, 0, 0), 6);
    const second = v.invalidateAround(new Vector3(0, 0, 0), 6);
    expect(second).toBe(0);
    expect(v.stale).toBe(first);
  });

  it('過期的排在還沒烘過的前面 —— 那是畫面上看得到的錯', () => {
    const v = volume();
    // 還沒烘任何東西時，下一顆是 0。
    expect(v.nextToBake()).toBe(0);
    // 標一顆遠一點的過期，它要插隊。
    v.invalidateAround(new Vector3(30, 30, 30), 1);
    const next = v.nextToBake();
    expect(next).toBe(v.probeCount - 1);
  });

  it('烘完之後從佇列裡消失', () => {
    const v = volume();
    v.invalidateAround(new Vector3(30, 30, 30), 1);
    const index = v.nextToBake();
    v.markProbeDone(index);
    expect(v.stale).toBe(0);
    // 佇列空了就回去烘還沒烘過的。
    expect(v.nextToBake()).toBe(0);
  });

  it('沒有過期也沒有沒烘過的時候回 −1', () => {
    const v = volume();
    for (let i = 0; i < v.probeCount; i++) v.markProbeDone(i);
    expect(v.nextToBake()).toBe(-1);
  });

  it('進度不會被重烘倒退', () => {
    // 重烘一顆早就烘好的，不該讓 `baked` 退回去 —— 退回去的話畫面會從
    // 那一顆開始重新亮一次。
    const v = volume();
    for (let i = 0; i < v.probeCount; i++) v.markProbeDone(i);
    expect(v.baked).toBe(v.probeCount);
    v.invalidateAround(new Vector3(0, 0, 0), 1);
    v.markProbeDone(v.nextToBake());
    expect(v.baked).toBe(v.probeCount);
  });
});

describe('半徑太小的時候要講出來', () => {
  it('半徑小於格距而且一顆都沒標到 → 警告', () => {
    // 探針只在格點上，半徑太小的球會整個落在格與格之間 —— 一顆都碰不到，
    // 間接光完全不更新，而畫面上只是「那個東西不反彈光」。
    const v = new IrradianceVolume({
      min: new Vector3(0, 0, 0),
      size: new Vector3(80, 80, 80),
      resolution: [2, 2, 2],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 格距 80，半徑 5，而且位置刻意落在格子中間。
    expect(v.invalidateAround(new Vector3(40, 40, 40), 5)).toBe(0);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('比探針格距');
    warn.mockRestore();
  });

  it('標得到的時候不會亂吼', () => {
    const v = new IrradianceVolume({
      min: new Vector3(0, 0, 0),
      size: new Vector3(80, 80, 80),
      resolution: [2, 2, 2],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(v.invalidateAround(new Vector3(0, 0, 0), 5)).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('半徑夠大但剛好沒東西的時候不吼 —— 那不是設定錯', () => {
    const v = new IrradianceVolume({
      min: new Vector3(0, 0, 0),
      size: new Vector3(80, 80, 80),
      resolution: [2, 2, 2],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 半徑比格距大，但整個在體積外面。
    expect(v.invalidateAround(new Vector3(500, 500, 500), 100)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
