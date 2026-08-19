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
    for (let i = 0; i < volume.probeCount; i++) volume.setProbe(i, uniformProbe(i % 2 === 1 ? 4 : 0));
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
