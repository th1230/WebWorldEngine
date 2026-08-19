/**
 * 全域距離場在著色器裡的查表，**一份原始碼多邊共用**。
 *
 * 距離場陰影、追蹤反射、體積霧都在查同一份場。各寫一份的話遲早會分岔 ——
 * 而分岔的症狀是「陰影說那裡有牆，霧說沒有」，看起來像其中一個壞了。
 *
 * 這與探針那份 GLSL（`irradiance-glsl.ts`）、水的波形是同一個判斷。
 *
 * ## 越界回傳「很遠」，不是 0
 *
 * 場的外面代表**沒有資料**，不代表那裡有東西。回 0 的話整個場外面會被當成
 * 實心的 —— 陰影全黑、霧全暗、反射全打到。而場只有幾百公尺寬，世界比它大。
 */
export const FIELD_UNIFORMS_GLSL = /* glsl */ `
uniform sampler3D tField;
uniform sampler3D tAlbedo;
uniform vec3 uFieldMin;
uniform float uFieldExtent;
uniform float uCell;
`;

export const FIELD_SAMPLE_GLSL = /* glsl */ `
float wwFieldAt( vec3 worldPoint ) {
  vec3 uvw = ( worldPoint - uFieldMin ) / uFieldExtent;
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) {
    return uFieldExtent;
  }
  return texture( tField, uvw ).r;
}

/** 打到的那個表面是什麼顏色。距離場只答得出「有東西」。 */
vec3 wwFieldAlbedoAt( vec3 worldPoint ) {
  vec3 uvw = ( worldPoint - uFieldMin ) / uFieldExtent;
  if ( any( lessThan( uvw, vec3( 0.0 ) ) ) || any( greaterThan( uvw, vec3( 1.0 ) ) ) ) {
    return vec3( 1.0 );
  }
  return texture( tAlbedo, uvw ).rgb;
}

/**
 * 從一點往一個方向追，回傳 0（全擋）到 1（沒擋）。
 *
 * 球體追蹤：每一步都跳「離最近的表面多遠」，所以空曠處一兩步跨過去，貼近
 * 表面時自動變細。半影是免費的副產品 —— 距離與已走路程之比就是圓錐張角。
 */
float wwFieldVisibility( vec3 origin, vec3 direction, float range, float steps, float softness ) {
  vec3 point = origin;
  float travelled = uCell;
  point += direction * uCell;
  float closest = 1.0;
  for ( int i = 0; i < 128; i++ ) {
    if ( float( i ) >= steps || travelled >= range ) break;
    float distance = wwFieldAt( point );
    if ( distance < uCell * 0.25 ) return 0.0;
    closest = min( closest, softness * distance / travelled );
    point += direction * distance;
    travelled += distance;
  }
  return clamp( closest, 0.0, 1.0 );
}
`;
