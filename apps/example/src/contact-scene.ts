import * as THREE from 'three';
import * as WW from '@webworld/three';

/**
 * 接觸陰影的證明場景：一個箱子**貼在**地面上。
 *
 * ## 判準是「箱子旁邊暗、空地不暗」
 *
 * 只驗「有東西變暗了」是不夠的 —— 自我遮蔽的 bug 會讓**整片**變暗，而那也
 * 通過「有變暗」這個檢查。所以要同時驗空曠處**沒有**被暗掉。
 *
 * 這與間接光那條「背光面偏紅，而紅只可能來自紅牆」是同一個判準形狀：訊號要
 * 有一個乾淨的來源，而且要有一個不該有訊號的對照點。
 */

/** 箱子的半邊長。取樣點要靠它算，所以兩邊共用同一個數字。 */
const HALF = 3;

export interface ContactScene {
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  /** 光照過來的方向（從光源指向場景）。 */
  lightDirection: THREE.Vector3;
  /** 跑一次：更新深度法線，然後算接觸陰影。 */
  render: (renderer: THREE.WebGLRenderer) => void;
  /** 讀某個世界座標投影到畫面上那一點的遮蔽值，0–1。 */
  sample: (renderer: THREE.WebGLRenderer, point: THREE.Vector3) => number;
  /** 幾個有意義的取樣點，測試要用同一組。 */
  points: {
    contact: THREE.Vector3;
    open: THREE.Vector3;
    lit: THREE.Vector3;
    terminator: THREE.Vector3;
    under: THREE.Vector3;
  };
  /**
   * 整張遮蔽圖裡有多少比例的像素是暗的（< 0.9）。
   *
   * ## 為什麼要看整張，不是看幾個點
   *
   * 手放的取樣點只驗得到「我想到的那些位置」。實測把法線偏移與厚度上限
   * 各拿掉一次，**五個手放的點一個都沒變** —— 那兩條路徑根本沒被那些點
   * 走到，於是斷言永遠是綠的。
   *
   * 整張的比例不會漏：那兩個 bug 的症狀都是「暗掉的範圍變大」，而範圍
   * 這件事只有看整張才量得到。
   */
  coverage: (renderer: THREE.WebGLRenderer) => number;
  setStrength: (value: number) => void;
  /**
   * 把相機移到另一個角度。
   *
   * 光的方向如果沒有換到視空間，陰影會**跟著相機轉** —— 而靜止的相機
   * 看不出來。換個角度再量同一個世界座標，答案應該一樣。
   */
  setCameraAngle: (which: 0 | 1) => void;
}

/** ContactShadows 的內部 target —— 讀回像素要用它，而那不是公開介面。 */
function targetOf(shadows: WW.ContactShadows): THREE.WebGLRenderTarget {
  return (shadows as unknown as { target: THREE.WebGLRenderTarget }).target;
}

export function makeContactScene(): ContactScene {
  const root = new THREE.Group();

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  // 箱子**剛好**站在地面上：底面 y = 0。浮起來一點點的話接觸陰影本來就該
  // 變淡，而那會讓測試在量一個自己造出來的假象。
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  box.position.set(0, HALF, 0);
  root.add(box);

  // ## 一顆球：平地驗不到自我遮蔽
  //
  // 拿掉法線偏移之後平坦的地面照樣正常（射線一步就離開地面了），所以
  // 那條 bug 在只有平面的場景裡**驗不到**。曲面才會讓射線擦著自己走。
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(3, 48, 32),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  sphere.position.set(14, 3, 0);
  root.add(sphere);

  // 低角度的光：接觸陰影在光很斜的時候最明顯，而那也是它最該生效的時候。
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(40, 14, 0);
  root.add(sun);
  const lightDirection = new THREE.Vector3(0, 0, 0).sub(sun.position).normalize();

  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.5, 500);
  camera.position.set(-18, 12, 26);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld(true);

  // ## 厚度上限的遮擋板要用**算的**擺，不是用猜的
  //
  // 要驗的是「螢幕空間上擋住了，但深度上遠得多，所以不算遮蔽」。第一版
  // 隨手把一個箱子丟在空中，結果它在螢幕上根本沒有蓋到追蹤路徑 —— 那條
  // 斷言於是永遠是綠的（把厚度檢查拿掉照樣過）。
  //
  // 這裡改成從相機拉一條線到「追蹤路徑上的某一點」，把板子放在那條線的
  // 三成處。螢幕空間的重疊因此是**構造出來的**，不是碰運氣。
  const groundProbe = new THREE.Vector3(24, 0.02, 0);
  const towardLight = lightDirection.clone().negate().normalize();
  const marchMid = groundProbe.clone().addScaledVector(towardLight, 1.5);
  const blocker = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide }),
  );
  blocker.position.copy(camera.position).lerp(marchMid, 0.3);
  blocker.lookAt(camera.position);
  root.add(blocker);

  const gbuffer = new WW.SceneDepthNormals({ scale: 1 });
  const shadows = new WW.ContactShadows({ distance: 2.5, thickness: 1.2, steps: 16, strength: 0.9 });

  const scene = new THREE.Scene();
  scene.add(root);

  const pixel = new Uint8Array(4);
  const projected = new THREE.Vector3();

  return {
    root,
    camera,
    lightDirection,
    render: (renderer) => {
      gbuffer.update(renderer, scene, camera);
      shadows.render(renderer, camera, gbuffer, lightDirection);
    },
    sample: (renderer, point) => {
      const target = targetOf(shadows);
      projected.copy(point).project(camera);
      const x = Math.round(((projected.x + 1) / 2) * target.width);
      const y = Math.round(((projected.y + 1) / 2) * target.height);
      renderer.readRenderTargetPixels(
        target,
        Math.min(target.width - 1, Math.max(0, x)),
        Math.min(target.height - 1, Math.max(0, y)),
        1,
        1,
        pixel,
      );
      return (pixel[0] ?? 0) / 255;
    },
    points: {
      // 背光那一側、緊貼箱子的地面。光從 +x 過來，所以影子落在 −x 那側。
      contact: new THREE.Vector3(-HALF - 0.6, 0.02, 0),
      // 空曠的地面，離箱子很遠 —— 這裡不該有接觸陰影。
      open: new THREE.Vector3(-34, 0.02, 22),
      // 球體上靠近明暗交界的地方：那裡 dot(法線, 光) 剛好大於 0，是自我
      // 遮蔽最容易發作的位置。它應該是**亮的**。
      terminator: new THREE.Vector3(14 - 0.75, 3 + 2.9, 0),
      // 浮空箱子下方的地面。往光源追會在螢幕空間掃過那個箱子，但它在深度
      // 上遠得多 —— 不該算成遮蔽。
      under: new THREE.Vector3(24, 0.02, 0),
      // 迎光那一側的地面：也不該有。
      lit: new THREE.Vector3(HALF + 2.5, 0.02, 0),
    },
    coverage: (renderer) => {
      const target = targetOf(shadows);
      const buffer = new Uint8Array(target.width * target.height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, buffer);
      let dark = 0;
      for (let i = 0; i < buffer.length; i += 4) {
        if ((buffer[i] ?? 255) < 230) dark++;
      }
      return dark / (target.width * target.height);
    },
    setCameraAngle: (which) => {
      if (which === 0) camera.position.set(-18, 12, 26);
      // 第二個角度**必須還看得見接觸點**。第一版放在 +x 那側，於是那個點
      // 被箱子自己擋住了 —— 量到的是箱子的正面，而測試紅了卻不是程式的錯。
      else camera.position.set(-24, 16, -18);
      camera.lookAt(0, 2, 0);
      camera.updateMatrixWorld(true);
    },
    setStrength: (value) => {
      (shadows as unknown as { options: { strength: number } }).options.strength = value;
    },
  };
}
