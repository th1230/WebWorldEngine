/**
 * 探針體積在著色器裡的查表，**一份原始碼兩邊共用**。
 *
 * ## 為什麼要共用同一個字串
 *
 * 材質那條路（`applyIrradiance`）與螢幕空間的效果（反射打到螢幕外的東西時
 * 要知道那裡多亮）查的是同一份資料。各寫一份的話兩邊會慢慢分岔 —— 而分岔的
 * 症狀是「反射裡的亮度跟直接看到的不一樣」，看起來像反射算錯了。
 *
 * 這與水那一節「一份波形兩邊共用」是同一個判斷。
 *
 * 常數與 Three 的 `shGetIrradianceAt` 逐字相同（0.886227 = π · Y₀₀，
 * 1.023328 = 2 · 0.511664）—— 改動它們就等於與 Three 的慣例分家。
 */
export const IRRADIANCE_UNIFORMS_GLSL = /* glsl */ `
uniform sampler3D wwIrrSH0;
uniform sampler3D wwIrrSH1;
uniform sampler3D wwIrrSH2;
uniform sampler3D wwIrrSH3;
uniform vec3 wwIrrMin;
uniform vec3 wwIrrInvSize;
uniform float wwIrrIntensity;
`;

export const IRRADIANCE_SAMPLE_GLSL = /* glsl */ `
vec3 wwIrradiance( vec3 worldPos, vec3 normal ) {
  vec3 uvw = ( worldPos - wwIrrMin ) * wwIrrInvSize;
  // 體積外就沒有間接光。夾住的話外面會拖著一條邊緣顏色，那比沒有更奇怪。
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) {
    return vec3( 0.0 );
  }
  vec3 c0 = texture( wwIrrSH0, uvw ).rgb;
  vec3 c1 = texture( wwIrrSH1, uvw ).rgb;
  vec3 c2 = texture( wwIrrSH2, uvw ).rgb;
  vec3 c3 = texture( wwIrrSH3, uvw ).rgb;
  // 常數與 Three 的 shGetIrradianceAt 逐字相同。
  vec3 result = c0 * 0.886227 + 1.023328 * ( c1 * normal.y + c2 * normal.z + c3 * normal.x );
  return max( result, vec3( 0.0 ) ) * wwIrrIntensity;
}
`;
