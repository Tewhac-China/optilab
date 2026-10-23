/* ═══════════════════════════════════════════════════════════
   renderer.js · 前向渲染器 v2
   HDR(RGBA16F) → 方向光阴影(PCF) → SSAO → 多级 Bloom → FXAA/ACES
   材质家族：PBR 实体 / 贴花 / 自发光 / 体积光束 / 屏幕 / 网格 / 玻璃
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* 拾取时跳过的网格名：支杆 / 线缆 / 线夹 / 光斑截面环 / 选中框 / 悬浮面板支架。
     它们又细又长，AABB 会把整排器件连成一片，点谁都会选中邻居。 */
  const RND_PICK_SKIP = /^(stand|rod_|postBase|clamp|clampScrew|clampKnob|hvCable|psuCable|camCable|camClip|cableClip|slmRibbon|hpPost|hpArm|hpBall|hpFoot|beamRing|beam|selwire|selbox|hover|hpFrame)/;

  /* ═══════════ 着色器源码 ═══════════ */

  const COMMON = `
const float PI = 3.14159265359;
const float INV_PI = 0.31830988618;

float sat(float x){ return clamp(x,0.0,1.0); }
vec3  sat3(vec3 x){ return clamp(x,0.0,1.0); }

// ── 程序化环境：暗室中的冷色天顶 + 三盏摄影灯箱 ──
vec3 envColor(vec3 d, float rough){
  float t = clamp(d.y*0.5+0.5, 0.0, 1.0);
  vec3 sky   = mix(vec3(0.046,0.054,0.070), vec3(0.170,0.200,0.248), t*t);
  vec3 floorC= vec3(0.056,0.056,0.062);
  vec3 c = mix(floorC, sky, smoothstep(0.25, 1.0, t));

  // 主光箱（前上方，与主光同向）
  vec3 b1 = normalize(vec3(-0.40,0.72,0.56));
  c += vec3(0.95,1.00,1.10) * pow(max(dot(d,b1),0.0), mix(46.0, 2.2, rough));

  // 冷补光箱（后右）
  vec3 b2 = normalize(vec3(0.62,0.28,-0.72));
  c += vec3(0.30,0.48,0.64) * pow(max(dot(d,b2),0.0), mix(34.0, 2.0, rough));

  // 低角度品红轮廓（前方低处）
  vec3 b3 = normalize(vec3(0.30,0.12,0.94));
  c += vec3(0.30,0.10,0.20) * pow(max(dot(d,b3),0.0), mix(45.0, 1.8, rough));

  // 地面柔光
  c += vec3(0.030,0.034,0.042) * pow(max(-d.y,0.0), 2.0);
  return c;
}

// ── GGX ──
float D_GGX(float NoH, float a){
  float a2 = a*a;
  float d = NoH*NoH*(a2-1.0)+1.0;
  return a2/(PI*d*d+1e-7);
}
float V_SmithGGX(float NoV, float NoL, float a){
  float a2=a*a;
  float gv = NoL*sqrt(NoV*NoV*(1.0-a2)+a2);
  float gl = NoV*sqrt(NoL*NoL*(1.0-a2)+a2);
  return 0.5/max(1e-5, gv+gl);
}
vec3 F_Schlick(vec3 f0, float u){ return f0 + (1.0-f0)*pow(1.0-u,5.0); }
`;

  /* ── PBR ── */
  const PBR_VS = `
in vec3 aPos; in vec3 aNrm; in vec2 aUV; in vec4 aExtra;
uniform mat4 uProj, uView, uModel, uLightVP;
uniform mat3 uNrmMat;
out vec3 vW; out vec3 vN; out vec2 vUV; out vec4 vEx; out vec4 vLP; out vec3 vObj;
void main(){
  vec4 wp = uModel * vec4(aPos,1.0);
  vW = wp.xyz; vObj = aPos;
  vN = normalize(uNrmMat * aNrm);
  vUV = aUV; vEx = aExtra;
  vLP = uLightVP * wp;
  gl_Position = uProj * uView * wp;
}`;

  const PBR_FS = COMMON + `
in vec3 vW; in vec3 vN; in vec2 vUV; in vec4 vEx; in vec4 vLP; in vec3 vObj;
out vec4 fragColor;

uniform vec3  uAlbedo;
uniform float uMetal, uRough, uOpacity, uEmissiveI, uAO;
uniform vec3  uEmissive;
uniform vec3  uEye;
uniform sampler2D uMap;   uniform float uUseMap;
uniform sampler2D uShadow; uniform float uShadowOn; uniform vec2 uShadowTexel;
uniform vec3  uLightDir[3];
uniform vec3  uLightCol[3];
uniform vec3  uTint;
uniform float uWear;
uniform vec2  uUVScale;
uniform float uDecal;

float shadowFetch(vec3 n, vec3 L){
  if(uShadowOn < 0.5) return 1.0;
  vec3 pc = vLP.xyz / vLP.w * 0.5 + 0.5;
  if(pc.x<0.0||pc.x>1.0||pc.y<0.0||pc.y>1.0||pc.z>1.0) return 1.0;
  float bias = max(0.0012, 0.0042*(1.0-max(0.0,dot(n,L))));
  float s = 0.0; vec2 tx = uShadowTexel;
  for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++){
    float d = texture(uShadow, pc.xy + vec2(float(i),float(j))*tx).r;
    s += (pc.z - bias > d) ? 0.0 : 1.0;
  }
  return s/9.0;
}

void main(){
  vec3 albedo = uAlbedo * uTint;
  float rough = uRough, metal = uMetal, ao = uAO;

  if(uUseMap > 0.5){
    vec4 m = texture(uMap, vUV*uUVScale);
    if(uDecal > 0.5){
      if(m.a < 0.45) discard;
      albedo = m.rgb;
      metal = 0.02; rough = 0.62; ao = 1.0;
    } else {
      albedo *= m.rgb;
      ao *= mix(1.0, m.a, 0.85);
    }
  }

  // 细密磨损/拉丝，打破完美表面
  float grain = fract(sin(dot(vObj.xy*vec2(127.1,311.7), vec2(1.0)))*43758.5453);
  rough = sat(rough + (grain-0.5)*0.10*uWear);
  albedo *= 1.0 + (grain-0.5)*0.05*uWear;

  vec3 N = normalize(vN);
  vec3 V = normalize(uEye - vW);
  if(dot(N,V) < 0.0 && uOpacity < 0.999) N = -N;
  float NoV = max(1e-4, dot(N,V));

  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 diffCol = albedo * (1.0 - metal);
  float a = max(0.0025, rough*rough);

  vec3 diffAcc = vec3(0.0), specAcc = vec3(0.0);
  for(int i=0;i<3;i++){
    // uLightDir 存的是光的「传播方向」（与阴影相机 eye = target - dir*d 一致），
    // 着色需要的方向是「指向光源」，故取反。之前直接用它，导致受光面被当成背面跳过，
    // 整个场景几乎只剩环境光 —— 这才是画面发闷、缺立体感的根因。
    vec3 L = normalize(-uLightDir[i]);
    float NoL = dot(N,L);
    if(NoL <= 0.0) continue;
    vec3 H = normalize(L+V);
    float NoH = max(0.0, dot(N,H));
    float VoH = max(0.0, dot(V,H));
    float sh = shadowFetch(N, L);
    float D = D_GGX(NoH, a);
    float Vis = V_SmithGGX(NoV, NoL, a);
    vec3 F = F_Schlick(F0, VoH);
    vec3 spec = D*Vis*F;
    vec3 kd = (1.0-F);
    vec3 li = uLightCol[i] * NoL * sh;
    diffAcc += kd*diffCol*INV_PI * li;
    specAcc += spec * li;
  }

  // 环境漫反射 + 镜面
  vec3 R = reflect(-V, N);
  vec3 irr = envColor(N, 0.95) * ao;
  // 宽一些的镜面环境采样：金属表面在大面积灯箱下才有"润"的感觉
  vec3 pre = envColor(R, min(0.92, rough*0.55 + 0.12)) * mix(1.0, ao, 0.45);
  vec3 Fenv = F_Schlick(F0, NoV);
  vec3 kd = (1.0-Fenv) * (1.0-metal);
  vec3 ambientD = kd*diffCol*irr;
  vec3 ambientS = pre*Fenv*(1.0-rough*0.92);

  // 镜面软压缩：小面积强反射不再削顶成纯白斑（"塑料球"感），
  // 漫反射保持线性，避免整体压暗
  vec3 specTotal = specAcc + ambientS;
  specTotal = specTotal / (1.0 + specTotal * 0.10);

  // 台面反照（极简 GI）：朝下的面被下方阳极氧化台面反射的冷光打亮，
  // 没有这一项时器件底面会死黑，看起来像"贴"在台面上而不是"站"在上面
  float upFacing = max(0.0, -N.y);
  vec3 bounce = diffCol * vec3(0.070, 0.078, 0.092) * upFacing * mix(1.0, ao, 0.5);

  vec3 col = diffAcc + ambientD + specTotal + bounce + uEmissive*uEmissiveI;

  // 边缘微光：仅对深色工业表面，突出轮廓
  float rim = pow(1.0-NoV, 3.5);
  col += rim * 0.035 * vec3(0.32,0.58,0.82) * uWear;

  float alpha = uOpacity;
  if(uOpacity < 0.999){
    // 玻璃：菲涅尔边缘 + 轻微色散
    float fres = pow(1.0-NoV, 3.0);
    alpha = sat(uOpacity + fres*(1.0-uOpacity)*2.0);
    col += fres * envColor(R, 0.06) * 0.9;
  }
  fragColor = vec4(col, alpha);
}`;

  /* ── 深度（阴影） ── */
  const DEPTH_VS = `
in vec3 aPos;
uniform mat4 uLightVP, uModel;
void main(){ gl_Position = uLightVP * uModel * vec4(aPos,1.0); }`;
  const DEPTH_FS = `
out vec4 fragColor;
void main(){ fragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }`;

  /* ── 光束（加性体积近似） ── */
  const BEAM_VS = `
in vec3 aPos; in vec3 aNrm; in vec2 aUV; in vec4 aExtra;
uniform mat4 uProj,uView,uModel;
uniform mat3 uNrmMat;
uniform float uW0, uW1, uLen, uSpread, uMinW;
out vec3 vW; out vec3 vN; out vec2 vUV; out vec3 vObj;
void main(){
  // 单位几何：x=轴向[0,1]，y/z=归一化半径；半径锥度与长度在此展开
  // uSpread 让片宽大于实际束径，为高斯外晕留出绘制空间
  float t = clamp(aPos.x, 0.0, 1.0);
  // 远处光斑只有一两个像素，纯物理宽度会「消失」；给一个随距离缩放的最小可见宽度，
  // 近看时仍是真实 1/e² 直径（uMinW 随相机距离变小）
  float w = max(mix(uW0, uW1, t), uMinW) * uSpread;
  vec3 p = vec3(aPos.x*uLen, aPos.y*w, aPos.z*w);
  vec4 wp = uModel*vec4(p,1.0);
  vW=wp.xyz; vObj=p; vUV=aUV;
  vN = normalize(uNrmMat*aNrm);
  gl_Position = uProj*uView*wp;
}`;

  const BEAM_FS = COMMON + `
in vec3 vW; in vec3 vN; in vec2 vUV; in vec3 vObj;
out vec4 fragColor;
uniform vec3 uEye;
uniform vec3 uColor;
uniform float uIntensity, uSeeded, uSoftness, uTime, uAlphaScale;
uniform float uLength, uFade, uSpread;

void main(){
  // 横向归一化半径：0 = 轴心，1 = 1/e² 束半径（片已随相机滚转，横向即径向）
  // uSpread 只留出一点点外晕空间，所以「画出来的光柱宽度」≈ 真实光斑直径，
  // 光阑一收、准直一偏，肉眼就能看到光柱变细变粗。
  float r = clamp(abs(vUV.x*2.0-1.0) * uSpread, 0.0, 1.8);

  // 光柱本体：r<0.88 几乎是平的实心，最后 12% 柔和收边。
  // 这样「画出来的宽度」才等于真实 1/e² 光斑直径，光阑一收能直接看出变细。
  float body = smoothstep(1.0, 0.62, r);
  // 中心亮芯：只做轻微增亮，不再用极细的高斯（那是「一根线」的来源）
  float core = exp(-r*r*3.0) * 0.55;
  // 外晕：1.0→1.55 倍束径的弱辉光
  float halo = exp(-r*r*1.6) * smoothstep(1.55, 0.9, r) * 0.5;

  // 沿轴包络，避免端面硬边
  float along = vUV.y;
  float fade = smoothstep(0.0, uFade, along) * smoothstep(1.0, 1.0-uFade, along);

  // 相干噪声与呼吸（模拟激光散斑 / 气流扰动）
  float jit = 1.0 + 0.10*sin(vObj.x*17.0 + uTime*2.6 + uSeeded*9.0)
                  + 0.07*sin(vObj.x*41.0 - uTime*1.7 + uSeeded*3.1);

  // 距离衰减：贴近镜头时不过曝（场景尺度 1~3 m，衰减需温和）
  // 极近距离再叠一层淡出，避免镜头钻进光束时整屏泛红
  float d = length(uEye - vW);
  float att = 1.0 / (1.0 + d*d*0.42) * smoothstep(0.012, 0.085, d);

  float i = (body*0.62 + core*0.42 + halo*0.20) * uIntensity * fade * jit * uAlphaScale * att;
  // 颜色可以超过 1（交给 bloom 出辉光），alpha 封顶：中心不过曝，边缘保留渐变
  float glow = i * 1.25 + core * 0.85;
  fragColor = vec4(uColor * min(2.2, glow), min(0.84, i));
}`;

  /* ── 屏幕/光场显示 ── */
  const SCREEN_VS = `
in vec3 aPos; in vec3 aNrm; in vec2 aUV; in vec4 aExtra;
uniform mat4 uProj,uView,uModel;
uniform mat3 uNrmMat;
out vec3 vW; out vec3 vN; out vec2 vUV;
void main(){
  vec4 wp = uModel*vec4(aPos,1.0);
  vW=wp.xyz; vUV=aUV;
  vN = normalize(uNrmMat*aNrm);
  gl_Position = uProj*uView*wp;
}`;

  const SCREEN_FS = COMMON + `
in vec3 vW; in vec3 vN; in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uField;
uniform vec3 uEye, uTint;
uniform float uGain, uGamma, uPixelGrid, uNoData, uTime, uScanline, uGlass, uAspect;
uniform vec2 uFieldRes;

void main(){
  vec2 uv = vUV;
  vec3 c;
  if(uNoData > 0.5){
    float g = 0.5 + 0.5*sin(uv.x*260.0 + uTime*2.0)*sin(uv.y*260.0 - uTime*1.6);
    c = vec3(0.014,0.017,0.022)*(0.6+g*0.5);
  } else {
    c = texture(uField, vec2(uv.x, 1.0-uv.y)).rgb;
    c *= uTint * uGain;
    // 像素栅格（模拟 SLM / CMOS 像素）
    if(uPixelGrid > 0.5){
      vec2 p = uv*uFieldRes;
      vec2 f = abs(fract(p)-0.5);
      float grid = smoothstep(0.40,0.5,max(f.x,f.y));
      c *= mix(1.0, 0.70 + 0.30*grid, 0.85);
    }
    if(uScanline > 0.5){
      c *= 0.94 + 0.06*sin(uv.y*uFieldRes.y*3.14159);
    }
    c = pow(max(c,0.0), vec3(uGamma));
    // 屏边缘压暗：模拟背光不均与边框遮挡
    vec2 e2 = abs(uv*2.0-1.0);
    c *= 1.0 - 0.30*smoothstep(0.74, 1.02, max(e2.x, e2.y));
  }

  // 玻璃盖板反射：掠射角增强
  if(uGlass > 0.5){
    vec3 V = normalize(uEye - vW);
    vec3 N = normalize(vN);
    float f = pow(1.0 - max(dot(N,V),0.0), 4.0);
    vec3 R = reflect(-V, N);
    c += envColor(R, 0.05) * (0.025 + f*0.28);
    // 极淡的斜向反光条
    float streak = smoothstep(0.86, 0.995, uv.x*0.7 + uv.y*0.55);
    c += vec3(0.06,0.085,0.11) * streak * 0.30;
  }
  fragColor = vec4(c, 1.0);
}`;

  /* ── 网格地板 ── */
  const GRID_VS = `
in vec3 aPos; in vec2 aUV;
uniform mat4 uProj,uView,uModel;
out vec3 vW; out vec2 vUV;
void main(){
  vec4 wp = uModel*vec4(aPos,1.0);
  vW = wp.xyz; vUV=aUV;
  gl_Position = uProj*uView*wp;
}`;
  const GRID_FS = `
in vec3 vW; in vec2 vUV;
out vec4 fragColor;
uniform vec3 uEye,uA,uB;
uniform float uCell, uFade, uMajor;

float gridLine(vec2 p){
  vec2 fw = max(fwidth(p), vec2(1e-5));
  vec2 g = abs(fract(p-0.5)-0.5) / fw;
  float l = 1.0 - min(min(g.x, g.y), 1.0);
  float grazing = 1.0 - smoothstep(0.22, 1.10, max(fw.x, fw.y));
  return l * grazing;
}

void main(){
  vec2 p = vW.xz/uCell;
  float minor = gridLine(p);
  float major = gridLine(p/uMajor);
  float d = length(vW.xz-uEye.xz);
  float att = exp(-d*uFade);
  vec3 col = uA*minor*0.45*att + uB*major*0.62*att;
  float a = clamp(minor*0.42 + major*0.75, 0.0, 1.0) * att;
  if(a < 0.003) discard;
  fragColor = vec4(col/max(a,1e-4), a);
}`;

  /* ── 线框 ── */
  const LINE_VS = `
in vec3 aPos;
uniform mat4 uProj,uView,uModel;
void main(){ gl_Position = uProj*uView*uModel*vec4(aPos,1.0); }`;
  const LINE_FS = `
out vec4 fragColor;
uniform vec4 uColor;
void main(){ fragColor = uColor; }`;

  /* ── 天空 ── */
  const SKY_VS = `
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 1.0, 1.0); }`;

  const SKY_FS = COMMON + `
out vec4 fragColor;
uniform mat4 uView;
uniform vec2 uRes;
uniform float uTanHalfFov;

void main(){
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  float aspect = uRes.x / max(1.0, uRes.y);
  vec3 dv = vec3(uv.x * aspect * uTanHalfFov, uv.y * uTanHalfFov, -1.0);
  vec3 d = normalize(transpose(mat3(uView)) * dv);

  float t = d.y * 0.5 + 0.5;
  vec3 c = mix(vec3(0.020,0.025,0.034), vec3(0.005,0.007,0.012), pow(t,0.55));
  // 地平线冷光带：给台面一个可读的背景分离度
  c += vec3(0.026,0.040,0.058) * exp(-abs(d.y) * 20.0);
  // 台后柔光（模拟远处墙面被灯箱照亮），让器件形成轮廓
  c += vec3(0.055,0.072,0.098) * pow(max(0.0, dot(d, normalize(vec3(0.10, 0.28, -1.0)))), 7.0);
  c += vec3(0.030,0.010,0.022) * exp(-abs(d.y + 0.55) * 12.0);
  fragColor = vec4(c, 1.0);
}`;

  /* ── 泛光 ── */
  const BLIT_VS = `
in vec2 aPos; out vec2 vUV;
void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

  const BRIGHT_FS = `
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uSrc; uniform float uThresh, uKnee;
void main(){
  vec3 c = texture(uSrc, vUV).rgb;
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  float s = clamp((l-uThresh+uKnee)/(2.0*uKnee),0.0,1.0);
  float w = max(l-uThresh, s*s*uKnee)/max(l,1e-4);
  fragColor = vec4(c*w, 1.0);
}`;

  const DOWN_FS = `
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec3 a = texture(uSrc, vUV + uTexel*vec2(-1,-1)).rgb;
  vec3 b = texture(uSrc, vUV + uTexel*vec2( 1,-1)).rgb;
  vec3 c = texture(uSrc, vUV + uTexel*vec2(-1, 1)).rgb;
  vec3 d = texture(uSrc, vUV + uTexel*vec2( 1, 1)).rgb;
  fragColor = vec4((a+b+c+d)*0.25, 1.0);
}`;

  const UP_FS = `
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uRadius;
void main(){
  vec3 s = vec3(0.0);
  s += texture(uSrc, vUV + vec2(-1.0,-1.0)*uTexel*uRadius).rgb * 1.0;
  s += texture(uSrc, vUV + vec2( 0.0,-1.0)*uTexel*uRadius).rgb * 2.0;
  s += texture(uSrc, vUV + vec2( 1.0,-1.0)*uTexel*uRadius).rgb * 1.0;
  s += texture(uSrc, vUV + vec2(-1.0, 0.0)*uTexel*uRadius).rgb * 2.0;
  s += texture(uSrc, vUV + vec2( 0.0, 0.0)*uTexel*uRadius).rgb * 4.0;
  s += texture(uSrc, vUV + vec2( 1.0, 0.0)*uTexel*uRadius).rgb * 2.0;
  s += texture(uSrc, vUV + vec2(-1.0, 1.0)*uTexel*uRadius).rgb * 1.0;
  s += texture(uSrc, vUV + vec2( 0.0, 1.0)*uTexel*uRadius).rgb * 2.0;
  s += texture(uSrc, vUV + vec2( 1.0, 1.0)*uTexel*uRadius).rgb * 1.0;
  fragColor = vec4(s/16.0, 1.0);
}`;

  /* ── SSAO ── */
  const SSAO_FS = `
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uDepth;
uniform mat4 uProj, uInvProj;
uniform vec2 uTexel;
uniform float uRadius, uBias, uPower;

vec3 viewPos(vec2 uv, float z){
  vec4 clip = vec4(uv*2.0-1.0, z*2.0-1.0, 1.0);
  vec4 v = uInvProj * clip;
  return v.xyz / v.w;
}

void main(){
  float z0 = texture(uDepth, vUV).r;
  if(z0 >= 0.99999){ fragColor = vec4(1.0); return; }
  vec3 p0 = viewPos(vUV, z0);

  vec3 pX = viewPos(vUV + vec2(uTexel.x, 0.0), texture(uDepth, vUV + vec2(uTexel.x,0.0)).r);
  vec3 pY = viewPos(vUV + vec2(0.0, uTexel.y), texture(uDepth, vUV + vec2(0.0,uTexel.y)).r);
  vec3 n = normalize(cross(pX - p0, pY - p0));
  if(n.z < 0.0) n = -n;

  // 旋转抖动
  float ang = fract(sin(dot(vUV, vec2(12.9898,78.233)))*43758.5453) * 6.2831;
  float ca = cos(ang), sa = sin(ang);
  mat2 rot = mat2(ca, -sa, sa, ca);

  float occ = 0.0;
  for(int i=0;i<12;i++){
    float fi = float(i);
    float a = (fi + 0.5) / 12.0 * 6.2831 * 4.0;
    float r = uRadius * (0.25 + 0.75 * fract(sin(fi*78.233)*43758.5453));
    vec3 dir = vec3(cos(a), sin(a), 0.0);
    dir.xy = rot * dir.xy;
    dir.z = 0.35 + 0.65 * fract(sin(fi*12.9898)*43758.5453);
    dir = normalize(dir);
    vec3 sp = p0 + dir * r;
    vec4 clip = uProj * vec4(sp, 1.0);
    vec2 suv = clip.xy/clip.w*0.5+0.5;
    if(suv.x<0.0||suv.x>1.0||suv.y<0.0||suv.y>1.0) continue;
    float sz = texture(uDepth, suv).r;
    vec3 spv = viewPos(suv, sz);
    float dz = sp.z - spv.z;
    if(dz > uBias) occ += 1.0;
  }
  occ /= 12.0;
  fragColor = vec4(vec3(pow(1.0 - occ, uPower)), 1.0);
}`;

  const BLUR_FS = `
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  float s = 0.0;
  for(int i=-2;i<=2;i++) for(int j=-2;j<=2;j++)
    s += texture(uSrc, vUV + vec2(float(i),float(j))*uTexel).r;
  fragColor = vec4(vec3(s/25.0), 1.0);
}`;

  /* ── 合成（ACES + FXAA） ── */
  const COMP_FS = `
in vec2 vUV; out vec4 fragColor;
uniform sampler2D uScene, uBloom, uAO;
uniform float uBloomAmt, uExposure, uVignette, uGrain, uCA, uTime, uSaturation;
uniform float uAOStrength, uAOOn, uFXAA;
uniform vec2 uRes;

vec3 aces(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);
}
vec3 srgb(vec3 c){
  return mix(c*12.92, 1.055*pow(max(c,vec3(1e-5)),vec3(0.41666))-0.055, step(0.0031308,c));
}
float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }

void main(){
  vec2 uv = vUV;

  // FXAA（轻量）：只在亮度对比明显的边缘混合
  vec3 col;
  if(uFXAA > 0.5){
    vec2 texel = 1.0/uRes;
    vec3 rgbM = texture(uScene, uv).rgb;
    vec3 rgbNW = texture(uScene, uv + vec2(-1.0,-1.0)*texel).rgb;
    vec3 rgbNE = texture(uScene, uv + vec2( 1.0,-1.0)*texel).rgb;
    vec3 rgbSW = texture(uScene, uv + vec2(-1.0, 1.0)*texel).rgb;
    vec3 rgbSE = texture(uScene, uv + vec2( 1.0, 1.0)*texel).rgb;
    float lM = luma(rgbM);
    float lNW = luma(rgbNW), lNE = luma(rgbNE), lSW = luma(rgbSW), lSE = luma(rgbSE);
    float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE)));
    float lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));
    vec2 dir = vec2(-((lNW+lNE)-(lSW+lSE)), ((lNW+lSW)-(lNE+lSE)));
    float dirReduce = max((lNW+lNE+lSW+lSE)*0.25*0.05, 1.0/128.0);
    float rcpDirMin = 1.0/(min(abs(dir.x),abs(dir.y))+dirReduce);
    dir = clamp(dir*rcpDirMin, vec2(-8.0), vec2(8.0)) * texel;
    vec3 rgbA = 0.5*(texture(uScene, uv+dir*(1.0/3.0-0.5)).rgb + texture(uScene, uv+dir*(2.0/3.0-0.5)).rgb);
    vec3 rgbB = rgbA*0.5 + 0.25*(texture(uScene, uv+dir*-0.5).rgb + texture(uScene, uv+dir*0.5).rgb);
    float lB = luma(rgbB);
    col = (lB < lMin || lB > lMax) ? rgbA : rgbB;
  } else {
    col = texture(uScene, uv).rgb;
  }

  // SSAO
  if(uAOOn > 0.5){
    float ao = texture(uAO, uv).r;
    col *= mix(1.0, ao, uAOStrength);
  }

  vec3 bloom = texture(uBloom, uv).rgb;
  col += bloom * uBloomAmt;

  col *= uExposure;
  col = aces(col);

  float lum = luma(col);
  col = mix(vec3(lum), col, uSaturation);

  vec2 ctr = uv-0.5;
  float r2 = dot(ctr,ctr);
  col *= mix(1.0, smoothstep(1.15, 0.18, r2*1.9), uVignette);

  if(uGrain > 0.001){
    float n = hash(uv*vec2(1723.0,911.0) + uTime*0.7);
    col += (n-0.5)*uGrain;
  }
  fragColor = vec4(srgb(max(col,vec3(0.0))), 1.0);
}`;

  /* ═══════════ 节点 ═══════════ */

  let UID = 1;

  class Node {
    constructor(o) {
      o = o || {};
      this.id = UID++;
      this.name = o.name || 'node';
      this.tag = o.tag || null;
      this.pos = o.pos ? o.pos.slice() : [0, 0, 0];
      this.rot = o.rot ? o.rot.slice() : [0, 0, 0];
      this.scale = o.scale ? o.scale.slice() : [1, 1, 1];
      this.mesh = o.mesh || null;
      this.material = o.material || null;
      this.children = [];
      this.parent = null;
      this.visible = o.visible !== false;
      this.pickable = o.pickable !== false;
      this.castShadow = o.castShadow !== false;
      this.matrix = M4.create();
      this.world = M4.create();
      this.worldNrm = new Float32Array(9);
      this.dirty = true;
      this.aabb = null;
      this.worldAABB = { min: [0, 0, 0], max: [0, 0, 0] };
      this.userData = o.userData || {};
      this.rotOrder = o.rotOrder || 'XYZ';
      this.matrixAuto = true;
      this.updateMatrix();
    }
    add(...ns) { for (const n of ns) { n.parent = this; this.children.push(n); } return this; }
    remove(n) {
      const i = this.children.indexOf(n);
      if (i >= 0) { this.children.splice(i, 1); n.parent = null; }
      return this;
    }
    updateMatrix() {
      M4.fromTRS(this.matrix, this.pos, this.rot, this.scale);
      this.dirty = true;
      return this;
    }
    setPos(x, y, z) { this.pos[0] = x; this.pos[1] = y; this.pos[2] = z; return this.updateMatrix(); }
    setRot(x, y, z) { this.rot[0] = x; this.rot[1] = y; this.rot[2] = z; return this.updateMatrix(); }
    setScale(x, y, z) { this.scale[0] = x; this.scale[1] = y; this.scale[2] = z; return this.updateMatrix(); }

    updateWorld(parentWorld) {
      if (parentWorld) M4.mul(this.world, parentWorld, this.matrix);
      else this.world.set(this.matrix);
      M4.normalMat3(this.worldNrm, this.world);

      let mn = null, mx = null;
      const g = this.mesh && this.mesh.geo;
      if (g && g.aabb) {
        mn = [Infinity, Infinity, Infinity];
        mx = [-Infinity, -Infinity, -Infinity];
        const p = new Float32Array(3);
        for (let i = 0; i < 8; i++) {
          p[0] = (i & 1) ? g.aabb.max[0] : g.aabb.min[0];
          p[1] = (i & 2) ? g.aabb.max[1] : g.aabb.min[1];
          p[2] = (i & 4) ? g.aabb.max[2] : g.aabb.min[2];
          M4.transformPoint(p, this.world, p);
          for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
        }
      }
      for (const c of this.children) {
        c.updateWorld(this.world);
        if (c.hasAABB) {
          if (!mn) { mn = c.worldAABB.min.slice(); mx = c.worldAABB.max.slice(); }
          else {
            for (let k = 0; k < 3; k++) {
              if (c.worldAABB.min[k] < mn[k]) mn[k] = c.worldAABB.min[k];
              if (c.worldAABB.max[k] > mx[k]) mx[k] = c.worldAABB.max[k];
            }
          }
        }
      }
      if (mn) { this.worldAABB.min = mn; this.worldAABB.max = mx; this.hasAABB = true; }
      else { this.worldAABB.min = [0, 0, 0]; this.worldAABB.max = [0, 0, 0]; this.hasAABB = false; }
    }
    /** 遍历：父节点隐藏时整棵子树不参与渲染（符合直觉的分组显隐） */
    traverse(fn) {
      fn(this);
      if (this.visible === false) return;
      for (const c of this.children) c.traverse(fn);
    }
  }

  /* ═══════════ 渲染器 ═══════════ */

  class Renderer {
    constructor(canvas) {
      const ctx = GLX.createContext(canvas);
      this.canvas = canvas;
      this.gl = ctx.gl;
      this.caps = ctx.caps;

      const gl = this.gl;
      this.progPbr = new GLX.Program(gl, PBR_VS, PBR_FS, 'pbr');
      this.progDepth = new GLX.Program(gl, DEPTH_VS, DEPTH_FS, 'depth');
      this.progBeam = new GLX.Program(gl, BEAM_VS, BEAM_FS, 'beam');
      this.progScreen = new GLX.Program(gl, SCREEN_VS, SCREEN_FS, 'screen');
      this.progGrid = new GLX.Program(gl, GRID_VS, GRID_FS, 'grid');
      this.progLine = new GLX.Program(gl, LINE_VS, LINE_FS, 'line');
      this.progSky = new GLX.Program(gl, SKY_VS, SKY_FS, 'sky');
      this.progBright = new GLX.Program(gl, BLIT_VS, BRIGHT_FS, 'bright');
      this.progDown = new GLX.Program(gl, BLIT_VS, DOWN_FS, 'down');
      this.progUp = new GLX.Program(gl, BLIT_VS, UP_FS, 'up');
      this.progSSAO = new GLX.Program(gl, BLIT_VS, SSAO_FS, 'ssao');
      this.progBlur = new GLX.Program(gl, BLIT_VS, BLUR_FS, 'blur');
      this.progComp = new GLX.Program(gl, BLIT_VS, COMP_FS, 'comp');

      this.quad = GLX.fullscreenVAO(gl);

      this.geoCache = new Map();
      this.texCache = new Map();
      this.root = new Node({ name: 'root' });
      this.uidNodes = new Map();

      this.camera = {
        target: [0, 0, 0], dist: 1.1, yaw: -0.72, pitch: 0.42,
        fov: 34 * Math.PI / 180, near: 0.006, far: 60,
        view: M4.create(), proj: M4.create(), vp: M4.create(), invVP: M4.create(),
        invProj: M4.create(),
        eye: [0, 0, 0], ortho: false, orthoH: 0.6,
      };

      this.settings = {
        exposure: 1.55, bloomAmt: 0.30, bloomThresh: 0.78, bloomKnee: 0.30,
        vignette: 0.74, grain: 0.0055, ca: 0.0018, saturation: 1.04,
        shadows: true, shadowSize: 1536,
        ssao: true, ssaoStrength: 0.55, ssaoRadius: 0.040,
        fxaa: true,
      };
      this.lights = [
        { dir: [0.40, -0.72, -0.56], col: [1.02, 0.98, 0.92], int: 3.40 },
        { dir: [-0.62, -0.28, 0.72], col: [0.34, 0.57, 0.82], int: 1.30 },
        { dir: [-0.34, -0.18, 0.92], col: [0.56, 0.30, 0.52], int: 0.55 },
      ];

      this.frames = 0; this.fps = 0; this._tFps = performance.now();
      this._time = 0;
      this.drawCalls = 0; this.triDrawn = 0;
      this._list = [];
      this._buildTargets(1, 1);
    }

    get width() { return this.canvas.width; }
    get height() { return this.canvas.height; }

    _buildTargets(w, h) {
      const gl = this.gl, caps = this.caps;
      const hdrFmt = caps.colorBufferFloat ? 'rgba16f' : 'rgba8';
      this.hdrFormat = hdrFmt;
      const del = (t) => { if (t) { if (t.fb) gl.deleteFramebuffer(t.fb); if (t.tex) gl.deleteTexture(t.tex); if (t.depth) gl.deleteRenderbuffer(t.depth); if (t.depthTex) gl.deleteTexture(t.depthTex); } };
      del(this.hdr); del(this.bfirst);
      if (this.shadow) { gl.deleteFramebuffer(this.shadow.fb); gl.deleteTexture(this.shadow.tex); this.shadow = null; }
      if (this.mips) this.mips.forEach(del);
      if (this.ssaoA) { del(this.ssaoA); del(this.ssaoB); }

      const mw = Math.max(2, w >> 1), mh = Math.max(2, h >> 1);
      this.hdr = GLX.makeFBO(gl, { width: w, height: h, format: hdrFmt, filter: 'linear', depth: true, depthTexture: true });
      this.bfirst = GLX.makeFBO(gl, { width: mw, height: mh, format: hdrFmt, filter: 'linear' });
      this.mips = [];
      let cw = mw >> 1, ch = mh >> 1;
      for (let i = 0; i < 4 && cw > 4 && ch > 4; i++) {
        this.mips.push(GLX.makeFBO(gl, { width: cw, height: ch, format: hdrFmt, filter: 'linear' }));
        cw >>= 1; ch >>= 1;
      }
      // SSAO 半分辨率
      const aw = Math.max(2, w >> 1), ah = Math.max(2, h >> 1);
      this.ssaoA = GLX.makeFBO(gl, { width: aw, height: ah, format: 'rgba8', filter: 'linear' });
      this.ssaoB = GLX.makeFBO(gl, { width: aw, height: ah, format: 'rgba8', filter: 'linear' });
      // 阴影贴图
      const S = this.settings.shadowSize;
      const sf = caps.colorBufferFloat ? 'r32f' : 'rgba8';
      this.shadow = GLX.makeFBO(gl, { width: S, height: S, format: sf, filter: 'nearest', depth: true });
      this.shadowSize = S;
      this.lightVP = M4.create();
      // 新贴图内容全 0（= 最近深度），若不重画，整场都会被判成处于阴影中
      this._shadowDirty = true;
    }

    /** 场景发生位移后调用：下一帧重画阴影贴图 */
    invalidateShadow() { this._shadowDirty = true; }

    setSize(w, h) {
      w = Math.max(2, Math.min(4096, w | 0));
      h = Math.max(2, Math.min(4096, h | 0));
      if (this.hdr && this.hdr.width === w && this.hdr.height === h) return;
      this._buildTargets(w, h);
    }

    upload(geo, key) {
      if (key && this.geoCache.has(key)) return this.geoCache.get(key);
      const m = GLX.uploadMesh(this.gl, geo);
      m.geo = geo;
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      const V = geo.vertices;
      for (let i = 0; i < V.length; i += 12) {
        for (let k = 0; k < 3; k++) {
          if (V[i + k] < mn[k]) mn[k] = V[i + k];
          if (V[i + k] > mx[k]) mx[k] = V[i + k];
        }
      }
      geo.aabb = { min: mn, max: mx };
      if (key) this.geoCache.set(key, m);
      return m;
    }

    /** Canvas → GL 纹理（mipmap + 各向异性） */
    texture(canvas, key) {
      if (key && this.texCache.has(key)) return this.texCache.get(key);
      const gl = this.gl;
      const t = GLX.tex2D(gl, { width: canvas.width, height: canvas.height, format: 'rgba8', data: canvas, filter: 'mipmap' });
      if (this.caps.aniso) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        const max = gl.getParameter(this.caps.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, this.caps.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      if (key) this.texCache.set(key, t);
      return t;
    }

    /** 俯仰下限：保证相机眼点不低于台面（否则画面全黑，像 3D 坏了） */
    minPitch() {
      const c = this.camera;
      return Math.asin(U.clamp((-0.095 - c.target[1]) / Math.max(0.08, c.dist), -1.45, 1.45));
    }

    orbit(dx, dy) {
      const c = this.camera;
      // 「抓住场景」语义：向右拖 → 场景跟着往右走。
      // 之前是 yaw += dx（相机绕行），在前后半球都表现为场景反向移动，
      // 与右键平移（grab）方向相反，操作起来像是「换了个半球就反了」。
      c.yaw -= dx * 0.0075;
      /* 俯仰下限随距离变化：相机眼点不允许掉到台面以下。
         原来写死 −1.45 rad（−83°），把鼠标往下一拖就钻到桌子底下，
         画面只剩一片黑 —— 用户不知道发生了什么，只会觉得「3D 坏了」。 */
      c.pitch = U.clamp(c.pitch + dy * 0.0075, this.minPitch(), 1.45);
      // 限制在 ±π，避免长时间拖拽后 yaw 无界增长（切视角时绕远路）
      // 低帧率下浏览器会合并 pointermove，单次 dx 可能上千像素，一次 ±2π 不够
      while (c.yaw > Math.PI) c.yaw -= Math.PI * 2;
      while (c.yaw < -Math.PI) c.yaw += Math.PI * 2;
    }
    pan(dx, dy, viewportH) {
      const c = this.camera;
      // viewportH 缺失时不能除出 NaN —— 一旦 target 变 NaN，整台相机就永久失效（画面全黑）
      const vh = viewportH || this.height || 800;
      const k = 2 * Math.tan(c.fov / 2) * c.dist / vh;
      const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch),
        cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
      const right = [cy, 0, -sy];
      const up = [sp * sy, cp, -sp * cy];
      for (let i = 0; i < 3; i++) c.target[i] += (-right[i] * dx + up[i] * dy) * k;
      // 别把视点平移到台面之外（否则会看着一片虚空，还以为光照坏了）
      c.target[0] = U.clamp(c.target[0], -0.35, 1.95);
      c.target[1] = U.clamp(c.target[1], -0.28, 0.85);
      c.target[2] = U.clamp(c.target[2], -0.95, 0.95);
      // 平移把视点压下去以后，原来的俯仰角可能让眼点钻到台面下，同步收一下
      c.pitch = Math.max(c.pitch, this.minPitch());
    }
    zoom(f) {
      const c = this.camera;
      c.dist = U.clamp(c.dist * f, 0.11, 40);
      c.pitch = Math.max(c.pitch, this.minPitch());   // 拉远时眼点会下沉，同步收俯仰
    }

    updateCamera() {
      const c = this.camera;
      const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch),
        cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
      c.eye[0] = c.target[0] + c.dist * cp * sy;
      c.eye[1] = c.target[1] + c.dist * sp;
      c.eye[2] = c.target[2] + c.dist * cp * cy;
      const aspect = this.width / Math.max(1, this.height);
      if (c.ortho) {
        const hh = c.orthoH, hw = hh * aspect;
        M4.ortho(c.proj, -hw, hw, -hh, hh, 0.001, 200);
      } else {
        M4.perspective(c.proj, c.fov, aspect, c.near, c.far);
      }
      M4.lookAt(c.view, c.eye, c.target, [0, 1, 0]);
      M4.mul(c.vp, c.proj, c.view);
      M4.invert(c.invVP, c.vp);
      M4.invert(c.invProj, c.proj);
    }

    _renderShadow() {
      const gl = this.gl, S = this.shadowSize;
      const L = this.lights[0];
      /* 阴影相机固定在台面中心，**不跟随相机 target**。
         跟着 target 会带来两个问题：① 平移/聚焦后阴影锥离开场景，边缘物体落在
         贴图之外；② 既然阴影贴图做了缓存（只在物体移动时重画），相机一动贴图就过期，
         投影会「粘」在旧位置。平行光的阴影锥本来就该钉在世界坐标上。 */
      const t = this._shadowTarget || [0.70, -0.02, 0];
      const ext = Math.max(this.shadowExtent || 1.0, 1.12);
      const d = 1.6;
      const eye = [t[0] - L.dir[0] * d, t[1] - L.dir[1] * d, t[2] - L.dir[2] * d];
      const vm = M4.lookAt(M4.create(), eye, t, Math.abs(L.dir[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0]);
      const pm = M4.ortho(M4.create(), -ext, ext, -ext, ext, 0.02, d * 3.2);
      M4.mul(this.lightVP, pm, vm);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadow.fb);
      gl.viewport(0, 0, S, S);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);

      const p = this.progDepth;
      p.use();
      const list = [];
      this.root.traverse(n => {
        if (!n.visible || !n.mesh || !n.castShadow) return;
        const m = n.material;
        if (!m || m.castShadow === false) return;
        if (m.kind === 'beam' || m.kind === 'sky' || m.kind === 'grid' || m.kind === 'line') return;
        list.push(n);
      });
      for (const n of list) {
        p.set('uLightVP', this.lightVP);
        p.set('uModel', n.world);
        gl.bindVertexArray(n.mesh.vao);
        if (n.mesh.indexed) gl.drawElements(gl.TRIANGLES, n.mesh.count, gl.UNSIGNED_INT, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, n.mesh.count);
      }
      gl.bindVertexArray(null);
      gl.cullFace(gl.BACK);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    render(scene, opts) {
      opts = opts || {};
      const gl = this.gl;
      const t0 = performance.now();
      this._time = opts.time || 0;
      this.drawCalls = 0; this.triDrawn = 0;

      this.root.updateWorld(null);
      this.updateCamera();

      // 1) 天空
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fb);
      gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      gl.clearColor(0.005, 0.007, 0.011, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const sky = this.root.children.find(c => c.userData.isSky);
      if (sky && sky.visible) {
        const p = this.progSky; p.use();
        p.set('uView', this.camera.view);
        p.set('uRes', [this.width, this.height]);
        p.set('uTanHalfFov', Math.tan(this.camera.fov / 2));
        gl.depthMask(false);
        gl.bindVertexArray(this.quad.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        gl.depthMask(true);
      }

      // 2) 收集
      const opaque = [], transparent = [], beams = [], screens = [], grids = [];
      this.root.traverse(n => {
        if (!n.visible || !n.mesh || !n.material || n.userData.isSky || n.userData.isLine) return;
        const k = n.material.kind || 'pbr';
        if (k === 'beam') beams.push(n);
        else if (k === 'screen') screens.push(n);
        else if (k === 'grid') grids.push(n);
        else if (k === 'line') { }
        else if (n.material.opacity !== undefined && n.material.opacity < 0.999) transparent.push(n);
        else opaque.push(n);
      });

      const setCam = (p) => {
        p.set('uProj', this.camera.proj);
        p.set('uView', this.camera.view);
        p.set('uEye', this.camera.eye);
      };

      // 3) 阴影
      // 平行光与场景都是静态的：只有器件被移动 / 光阑改口径时才需要重画阴影贴图。
      // 之前每帧都把全部不透明几何再画一遍（≈400 draw call × 2），是白给的帧开销。
      const wantShadow = this.settings.shadows && !opts.noShadow;
      if (wantShadow && (this._shadowDirty || !this.shadow)) {
        this.shadowExtent = opts.shadowExtent || 1.1;
        this._renderShadow();
        this._shadowDirty = false;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fb);
        gl.viewport(0, 0, this.width, this.height);
      }

      // 4) 地板网格
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const n of grids) {
        const p = this.progGrid; p.use(); setCam(p);
        p.set('uModel', n.world);
        p.set('uCell', n.material.cell || 0.05);
        p.set('uMajor', n.material.major || 5);
        p.set('uFade', n.material.fade || 5.0);
        p.set('uA', n.material.gridA || [0.22, 0.30, 0.40]);
        p.set('uB', n.material.gridB || [0.32, 0.55, 0.72]);
        gl.bindVertexArray(n.mesh.vao);
        if (n.mesh.indexed) gl.drawElements(gl.TRIANGLES, n.mesh.count, gl.UNSIGNED_INT, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, n.mesh.count);
        this.drawCalls++;
      }
      gl.depthMask(true);

      // 5) 不透明 PBR
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
      const pbr = this.progPbr;
      pbr.use(); setCam(pbr);
      pbr.set('uLightVP', this.lightVP);
      pbr.set('uShadow', 0);
      pbr.set('uShadowOn', wantShadow ? 1 : 0);
      pbr.set('uShadowTexel', [1 / (this.shadowSize || 1536), 1 / (this.shadowSize || 1536)]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.shadow ? this.shadow.tex : null);
      const LD = [], LC = [];
      for (const L of this.lights) {
        const l = V3.norm([0, 0, 0], L.dir);
        LD.push(l[0], l[1], l[2]);
        LC.push(L.col[0] * L.int, L.col[1] * L.int, L.col[2] * L.int);
      }
      pbr.set('uLightDir', LD);
      pbr.set('uLightCol', LC);

      const drawPbr = (n) => {
        const m = n.material;
        if (m.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
        pbr.set('uModel', n.world);
        pbr.set('uNrmMat', n.worldNrm);
        pbr.set('uAlbedo', m.albedo || [0.5, 0.5, 0.5]);
        pbr.set('uMetal', m.metal !== undefined ? m.metal : 0.0);
        pbr.set('uRough', m.rough !== undefined ? m.rough : 0.55);
        pbr.set('uOpacity', m.opacity !== undefined ? m.opacity : 1.0);
        pbr.set('uEmissive', m.emissive || [0, 0, 0]);
        pbr.set('uEmissiveI', m.emissiveI || 0);
        pbr.set('uAO', m.ao !== undefined ? m.ao : 1.0);
        pbr.set('uTint', m.tint || [1, 1, 1]);
        pbr.set('uWear', m.wear !== undefined ? m.wear : 0.35);
        pbr.set('uDecal', m.decal ? 1 : 0);
        pbr.set('uUseMap', m.map ? 1 : 0);
        pbr.set('uUVScale', m.uvScale || [1, 1]);
        if (m.map) pbr.tex('uMap', m.map, 1); else pbr.set('uMap', 1);
        gl.bindVertexArray(n.mesh.vao);
        if (n.mesh.indexed) gl.drawElements(gl.TRIANGLES, n.mesh.count, gl.UNSIGNED_INT, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, n.mesh.count);
        this.drawCalls++; this.triDrawn += n.mesh.count / 3;
        n._drawn = true;
      };
      for (const n of opaque) drawPbr(n);

      // 6) 屏幕
      const scr = this.progScreen;
      for (const n of screens) {
        const m = n.material;
        gl.disable(gl.BLEND);
        scr.use(); setCam(scr);
        scr.set('uModel', n.world);
        scr.set('uNrmMat', n.worldNrm);
        scr.set('uGain', m.gain !== undefined ? m.gain : 1.0);
        scr.set('uGamma', m.gamma !== undefined ? m.gamma : 1.0);
        scr.set('uPixelGrid', m.pixelGrid ? 1 : 0);
        scr.set('uScanline', m.scanline ? 1 : 0);
        scr.set('uGlass', m.glass ? 1 : 0);
        scr.set('uTint', m.tint3 || [1, 1, 1]);
        scr.set('uNoData', m.field ? 0 : 1);
        scr.set('uTime', this._time);
        scr.set('uFieldRes', m.fieldRes || [256, 256]);
        if (m.field) scr.tex('uField', m.field, 0);
        gl.bindVertexArray(n.mesh.vao);
        gl.disable(gl.CULL_FACE);
        if (n.mesh.indexed) gl.drawElements(gl.TRIANGLES, n.mesh.count, gl.UNSIGNED_INT, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, n.mesh.count);
        gl.enable(gl.CULL_FACE);
        this.drawCalls++;
      }

      // 7) 光束
      // 用 alpha 混合而不是纯加法：加法叠加会让光柱中心迅速削顶成一根白线，
      // 整条光只剩「线」没有「粗细」。alpha 混合下亮度封顶在光色本身，
      // 径向渐变保留下来，光柱的轮廓（= 真实束径）才看得出来。
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      const bm = this.progBeam;
      bm.use(); setCam(bm);
      for (const n of beams) {
        const m = n.material;
        bm.set('uModel', n.world);
        bm.set('uNrmMat', n.worldNrm);
        bm.set('uColor', m.color || [1, 0.1, 0.1]);
        bm.set('uIntensity', m.intensity !== undefined ? m.intensity : 1.0);
        bm.set('uSoftness', m.softness !== undefined ? m.softness : 1.6);
        bm.set('uSeeded', m.seed || 0);
        bm.set('uTime', this._time);
        bm.set('uFade', m.fade !== undefined ? m.fade : 0.08);
        bm.set('uAlphaScale', m.alphaScale !== undefined ? m.alphaScale : 1.0);
        const bs = this.beamScale || 1;
        bm.set('uW0', (m.w0 || 0.001) * bs);
        bm.set('uW1', (m.w1 || 0.001) * bs);
        bm.set('uLen', m.len || 1.0);
        bm.set('uSpread', m.spread || 1.55);
        bm.set('uMinW', (this._beamMinW || 0.0006) * bs);
        gl.bindVertexArray(n.mesh.vao);
        if (n.mesh.indexed) gl.drawElements(gl.TRIANGLES, n.mesh.count, gl.UNSIGNED_INT, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, n.mesh.count);
        this.drawCalls++;
      }
      gl.enable(gl.CULL_FACE);

      // 8) 透明
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      transparent.sort((a, b) => V3.dist(b.world.slice(12, 15), this.camera.eye) - V3.dist(a.world.slice(12, 15), this.camera.eye));
      pbr.use();
      for (const n of transparent) drawPbr(n);
      gl.depthMask(true);
      gl.disable(gl.BLEND);

      // 9) 线框
      const lines = [];
      this.root.traverse(n => { if (n.userData.isLine && n.visible && n.mesh) lines.push(n); });
      if (lines.length) {
        const lp = this.progLine; lp.use(); setCam(lp);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        for (const n of lines) {
          lp.set('uModel', n.world);
          lp.set('uColor', n.material.color4 || [1, 1, 1, 1]);
          gl.bindVertexArray(n.mesh.vao);
          if (n.mesh.indexed) gl.drawElements(gl.LINES, n.mesh.count, gl.UNSIGNED_INT, 0);
          else gl.drawArrays(gl.LINES, 0, n.mesh.count);
          this.drawCalls++;
        }
        gl.disable(gl.BLEND);
      }

      // 10) SSAO
      if (this.settings.ssao && this.hdr.depthTex) this._ssao();

      // 11) 后处理
      this._post();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this.frames++;
      const tn = performance.now();
      if (tn - this._tFps > 420) {
        this.fps = this.frames * 1000 / (tn - this._tFps);
        this.frames = 0; this._tFps = tn;
      }
      return performance.now() - t0;
    }

    _ssao() {
      const gl = this.gl, S = this.settings;
      const A = this.ssaoA, B = this.ssaoB;
      this._blit(this.progSSAO, A, (p) => {
        p.tex('uDepth', this.hdr.depthTex, 0);
        p.set('uProj', this.camera.proj);
        p.set('uInvProj', this.camera.invProj);
        p.set('uTexel', [1 / A.width, 1 / A.height]);
        p.set('uRadius', S.ssaoRadius);
        p.set('uBias', 0.006);
        p.set('uPower', 1.6);
      });
      this._blit(this.progBlur, B, (p) => {
        p.tex('uSrc', A.tex, 0);
        p.set('uTexel', [1 / A.width, 1 / A.height]);
      });
      this._blit(this.progBlur, A, (p) => {
        p.tex('uSrc', B.tex, 0);
        p.set('uTexel', [1 / B.width, 1 / B.height]);
      });
      this._ssaoTex = A.tex;
      this.drawCalls += 3;
    }

    _blit(prog, target, setup) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      if (target) gl.viewport(0, 0, target.width, target.height);
      else gl.viewport(0, 0, this.width, this.height);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
      prog.use();
      gl.bindVertexArray(this.quad.vao);
      if (setup) setup(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    _post() {
      const gl = this.gl, S = this.settings;
      this._blit(this.progBright, this.bfirst, (p) => {
        p.tex('uSrc', this.hdr.tex, 0);
        p.set('uThresh', S.bloomThresh);
        p.set('uKnee', S.bloomKnee);
      });
      let src = this.bfirst;
      const mips = this.mips;
      for (let i = 0; i < mips.length; i++) {
        this._blit(this.progDown, mips[i], (p) => {
          p.tex('uSrc', src.tex, 0);
          p.set('uTexel', [1 / src.width, 1 / src.height]);
        });
        src = mips[i];
      }
      for (let i = mips.length - 2; i >= 0; i--) {
        const lower = mips[i + 1], upper = mips[i];
        this._blit(this.progUp, upper, (p) => {
          p.tex('uSrc', lower.tex, 0);
          p.set('uTexel', [1 / lower.width, 1 / lower.height]);
          p.set('uRadius', 1.35);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
        });
        gl.disable(gl.BLEND);
      }
      this._blit(this.progComp, null, (p) => {
        p.tex('uScene', this.hdr.tex, 0);
        p.tex('uBloom', mips.length ? mips[0].tex : this.bfirst.tex, 1);
        p.tex('uAO', this._ssaoTex || this.bfirst.tex, 2);
        p.setAll({
          uBloomAmt: S.bloomAmt, uExposure: S.exposure, uVignette: S.vignette,
          uGrain: S.grain, uCA: S.ca, uTime: this._time, uSaturation: S.saturation,
          uAOStrength: S.ssaoStrength, uAOOn: (S.ssao && this._ssaoTex) ? 1 : 0,
          uFXAA: S.fxaa ? 1 : 0, uRes: [this.width, this.height],
        });
      });
      this.drawCalls += mips.length * 2 + 2;
    }

    rayFromScreen(px, py) {
      const c = this.camera;
      const ndcX = (px / this.canvas.clientWidth) * 2 - 1;
      const ndcY = 1 - (py / this.canvas.clientHeight) * 2;
      const p0 = new Float32Array(3), p1 = new Float32Array(3);
      M4.transformPoint(p0, c.invVP, [ndcX, ndcY, -1]);
      M4.transformPoint(p1, c.invVP, [ndcX, ndcY, 1]);
      const dir = new Float32Array(3);
      V3.norm(dir, V3.sub(new Float32Array(3), p1, p0));
      return { origin: p0, dir };
    }

    pick(px, py) {
      const r = this.rayFromScreen(px, py);
      let best = null, bestD = Infinity;
      /* 逐网格求交，而不是用器件整体的包围盒：
         一个 150 mm 的激光头 + 燕尾座，整体 AABB 有 300 mm 长，
         点它右边的光阑①时射线会先撞进这个「大盒子」——选中的是激光器。
         网格 AABB 贴合真实外形，再回溯到所属器件，才是所见即所得。 */
      this.root.traverse(n => {
        if (!n.visible || n.pickable === false || !n.hasAABB) return;
        if (!n.mesh || !n.mesh.geo || !n.mesh.geo.aabb) return;
        if (RND_PICK_SKIP.test(n.name || '')) return;
        const t = rayAABB(r.origin, r.dir, n.worldAABB.min, n.worldAABB.max);
        if (t === null || t >= bestD) return;
        let p = n;
        while (p && !p.tag) p = p.parent;
        if (!p || p === this.root) return;
        bestD = t; best = p;
      });
      return best;
    }

    /** 带容差的拾取：光阑 / 透镜的孔在轴心是空的，射线正好穿过孔口时
        pick() 会返回 null —— 但用户明明点在了镜架正中央。 */
    pickSoft(px, py) {
      const hit = this.pick(px, py);
      const r = this.rayFromScreen(px, py);
      this.updateCamera();
      /* 同时算出「离点击射线最近的那条光轴」。
         注意不能用「屏幕空间最近的包围盒中心」：器件挤在一起时邻居的
         中心可能比目标更近，会把拖动派给隔壁那件（用户看到的是
         「点 A 结果 B 在动」）。 */
      const axisDist = (node) => {
        const v0 = node.pos[0] - r.origin[0], v1 = -r.origin[1], v2 = -r.origin[2];
        const t = v0 * r.dir[0] + v1 * r.dir[1] + v2 * r.dir[2];
        return Math.sqrt(Math.max(0, v0 * v0 + v1 * v1 + v2 * v2 - t * t));
      };
      let best = null, bestD = 0.045;        // 容差 45 mm（最大镜架半径量级）
      this.root.traverse(n => {
        if (!n.visible || !n.tag || !n.hasAABB) return;
        const d = axisDist(n);
        if (d < bestD) { bestD = d; best = n; }
      });
      if (hit) {
        /* 射线穿过前面器件的通光孔、打到后面那件的镜架上时，命中结果
           是后面那件（它的光轴离射线几十毫米），而点击点其实正对着
           前面那件的孔心。这时以「光轴离射线最近」的为准 —— 否则
           学生点 P₂ 正中央，动起来的却是后面的 L₁。 */
        if (best && best !== hit && bestD < 0.004 && axisDist(hit) > 0.012) return best;
        return hit;
      }
      return best;
    }

    /** 3D 悬浮光场屏的拾取。
        这些屏被 pick() 主动跳过（否则会挡住后面的器件），但它们要支持
        「点击看大图」，所以单独做一次只针对屏面的求交。
        只遍历注册过的屏（3 块），不做整树遍历 —— pointermove 每次都要问一次。 */
    pickScreens(px, py) {
      const list = this.screenNodes;
      if (!list || !list.length) return null;
      const r = this.rayFromScreen(px, py);
      let best = null, bestD = Infinity;
      for (const n of list) {
        if (!n.hasAABB || !this._ancestorsVisible(n)) continue;
        const t = rayAABB(r.origin, r.dir, n.worldAABB.min, n.worldAABB.max);
        if (t !== null && t < bestD) { bestD = t; best = n; }
      }
      return best;
    }

    _ancestorsVisible(n) {
      for (let p = n; p; p = p.parent) if (p.visible === false) return false;
      return true;
    }
  }

  function rayAABB(o, d, mn, mx) {
    let t0 = -Infinity, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
      const inv = 1 / (d[i] || 1e-9);
      let a = (mn[i] - o[i]) * inv, b = (mx[i] - o[i]) * inv;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return null;
    }
    return t1 < 0 ? null : (t0 < 0 ? t1 : t0);
  }

  global.RND = { Renderer, Node, rayAABB };
})(window);
