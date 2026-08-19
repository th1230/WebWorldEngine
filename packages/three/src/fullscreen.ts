import { BufferAttribute, BufferGeometry, Mesh, OrthographicCamera, Scene, ShaderMaterial } from 'three';
import type { WebGLRenderer } from 'three';

/**
 * 畫一個蓋滿畫面的三角形。
 *
 * 用一個三角形而不是兩個（矩形）：矩形的對角線讓 GPU 在那條邊上跑兩次
 * quad，而全螢幕的 pass 每一格像素都算數。
 *
 * ## 為什麼是共用的模組
 *
 * 幾何、相機、場景都沒有狀態，而螢幕空間的效果會越來越多（間接光、接觸
 * 陰影、反射……）。每個 pass 各配一份是白花記憶體，也讓「全螢幕三角形的
 * 那個技巧」在好幾個檔案裡各寫一次 —— 而那種重複遲早會有一份被改壞。
 */
const geometry = new BufferGeometry();
geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));

const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
const scene = new Scene();
const mesh = new Mesh(geometry, new ShaderMaterial());
mesh.frustumCulled = false;
scene.add(mesh);

export function drawFullscreen(renderer: WebGLRenderer, material: ShaderMaterial): void {
  mesh.material = material;
  renderer.render(scene, camera);
}

/** 全螢幕 pass 的頂點著色器。`vUv` 覆蓋整個畫面。 */
export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/**
 * 從深度貼圖還原出**視空間**的位置。
 *
 * 好幾個效果都要這一段，而它有兩個很容易寫錯的地方：
 *
 * 1. `depthTexture` 存的是非線性的裝置深度，要先換回 NDC 再乘逆投影矩陣。
 *    直接拿它當距離用的話近處幾乎沒有變化、遠處全部擠在一起。
 * 2. 齊次除法**不能省**。省掉的話透視越強的地方偏得越多 —— 而畫面中央
 *    看起來是對的，所以很容易以為沒問題。
 */
export const VIEW_POSITION_GLSL = /* glsl */ `
vec3 wwViewPositionFromDepth( vec2 uv, float rawDepth, mat4 projectionInverse ) {
  vec4 ndc = vec4( uv * 2.0 - 1.0, rawDepth * 2.0 - 1.0, 1.0 );
  vec4 view = projectionInverse * ndc;
  return view.xyz / view.w;
}
`;
