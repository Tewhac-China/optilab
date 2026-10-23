/* ═══════════════════════════════════════════════════════════
   fft.js · GPU 复数二维 FFT
   ─ 分解：二维 DFT = 行变换 → 转置 → 列变换 → 转置
   ─ 蝶形：DIF（自然序入 / 位反转序出）用于第一次变换，
          DIT（位反转序入 / 自然序出）用于第二次变换，
          两者恰好首尾相接，无需额外的位反转重排 pass。
   ─ 数据布局：RGBA32F 纹理 (R,G) = (Re, Im)，坐标为 texelFetch 直取
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const FS_VS = `
in vec2 aPos; out vec2 vUV;
void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

  /* ── 蝶形 ──
     uDir = 0 : DIF   块长 m = N >> stage，输入自然序
     uDir = 1 : DIT   块长 m = 2 << stage，输入位反转序
     uSign = -1 : 正变换 (exp(-iθ))     +1 : 逆变换
  */
  const FS_STAGE = `
uniform sampler2D uTex;
uniform sampler2D uTw;
uniform int  uN, uStage, uDir;
uniform float uSign;
out vec4 fragColor;

vec2 fetchC(int i, int y){ return texelFetch(uTex, ivec2(i, y), 0).xy; }
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }

void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  int k = c.x, y = c.y;
  int m, twStep;
  if(uDir == 0){ m = uN >> uStage; twStep = 1 << uStage; }
  else         { m = 2 << uStage;  twStep = 1 << ((uLog2N(uN)) - uStage - 1); }

  int mh = m >> 1;
  int block = k / m;
  int off = k - block*m;
  int j = (off < mh) ? off : (off - mh);
  int i0 = block*m + j;
  int i1 = i0 + mh;

  vec2 a = fetchC(i0, y);
  vec2 b = fetchC(i1, y);
  vec2 w = texelFetch(uTw, ivec2(j*twStep, 0), 0).xy;
  w.y *= uSign;

  vec2 r;
  if(uDir == 0){
    vec2 s = a + b;
    vec2 d = cmul(a - b, w);
    r = (off < mh) ? s : d;
  } else {
    vec2 bw = cmul(b, w);
    r = (off < mh) ? (a + bw) : (a - bw);
  }
  fragColor = vec4(r, 0.0, 1.0);
}`;

  const FS_TRANSPOSE = `
uniform sampler2D uTex;
out vec4 fragColor;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  fragColor = texelFetch(uTex, ivec2(c.y, c.x), 0);
}`;

  const FS_COPY = `
uniform sampler2D uTex;
out vec4 fragColor;
void main(){
  fragColor = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0);
}`;

  const FS_MAGSQ = `
uniform sampler2D uTex;
uniform float uScale;
out vec4 fragColor;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 v = texelFetch(uTex, ivec2(c), 0).xy;
  fragColor = vec4((v.x*v.x + v.y*v.y) * uScale, 0.0, 0.0, 1.0);
}`;

  /* 复数滤波 / 记录介质效应
     op 0=恒等 1=二值化 2=相位化 3=径向高通 4=有限量化位数 */
  const FS_FILTER = `
uniform sampler2D uTex;
uniform int uOp;
uniform float uThresh, uKnee, uCut;
uniform int uN, uLog2N;
out vec4 fragColor;

int brev(int x){
  int r = 0;
  for(int i = 0; i < 16; i++){
    if(i >= uLog2N) break;
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r;
}

void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 s = texelFetch(uTex, ivec2(c), 0).xy;
  float val = s.x;                 // 此刻 S 为实、非负

  // S 为位反转序：像素 c 承载的真实频率 k = brev(c)，直流(DC)位于 k=0。
  // 径向滤波须以 DC 为中心、按带符号环绕频率度量半径。
  int kx = brev(c.x), ky = brev(c.y);
  float sx = float(kx <= uN/2 ? kx : kx - uN);
  float sy = float(ky <= uN/2 ? ky : ky - uN);
  float rr = sqrt(sx*sx + sy*sy) / float(uN/2);

  if(uOp == 1){
    // 二值化：经典二进制 JTC，可显著锐化相关峰
    val = val > uThresh ? 1.0 : 0.0;
  } else if(uOp == 2){
    // 相位化：仅保留单位幅值
    val = val > uThresh ? 1.0 : 0.0;
  } else if(uOp == 3){
    // 径向高通：抑制零级自相关，提升一级项对比度
    val *= smoothstep(uCut, uCut + 0.18, rr);
  } else if(uOp == 4){
    // 有限量化位数：floor(v/max·L + ½)·max/L
    float mx = max(uThresh, 1e-30);
    float lv = max(2.0, uKnee);
    val = floor(val / mx * lv + 0.5) / lv * mx;
  } else if(uOp == 5){
    // 探测器离焦：模糊圆卷积 JPS（S 域低通），uCut = 归一化高斯 σ
    if(uCut > 1e-4){
      val *= exp(-0.5 * (rr/uCut) * (rr/uCut));
    }
  } else if(uOp == 6){
    // 探测器读出噪声：加性、零均值、确定性伪随机（同参数下可重复，符合测量重复性）
    // uThresh = 噪声幅度（相对 |FT|² 峰值）→ 通量越低，相对噪声越大
    // 注：不可对结果做 max(·,0) 截断——半波整流会在 JPS 上加均匀基底，
    //     经第二次变换后变成巨大的零级尖峰，把峰/零级比压垮。
    float hh = fract(sin(dot(vec2(c), vec2(12.9898, 78.233))) * 43758.5453);
    val = val + uThresh * (hh - 0.5) * 2.0;
  }
  fragColor = vec4(val, 0.0, 0.0, 1.0);
}`;

  /* ── 显示映射：位反转解缠 + fftshift + 归一化 + 伪彩 ── */
  const FS_DISPLAY = `
uniform sampler2D uSrc;
uniform int uN, uLog2N, uBitrev, uShift;
uniform int uMode;          // 0=|c|², 1=|c|
uniform int uPalette;       // 0=灰阶 1=热力 2=HeNe 单色 3=青紫
uniform float uGain, uFloor, uGamma;
uniform float uLogMin;      // 对数显示的地板（相对于 1）
out vec4 fragColor;

int brev(int x){
  int r = 0;
  for(int i = 0; i < 16; i++){
    if(i >= uLog2N) break;
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r;
}

vec3 paletteHeat(float t){
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.006, 0.008, 0.016);
  const vec3 c1 = vec3(0.048, 0.040, 0.155);
  const vec3 c2 = vec3(0.160, 0.520, 0.620);
  const vec3 c3 = vec3(0.930, 0.760, 0.230);
  const vec3 c4 = vec3(1.000, 1.000, 0.960);
  if(t < 0.25) return mix(c0, c1, t/0.25);
  if(t < 0.50) return mix(c1, c2, (t-0.25)/0.25);
  if(t < 0.78) return mix(c2, c3, (t-0.50)/0.28);
  return mix(c3, c4, (t-0.78)/0.22);
}
vec3 paletteHeNe(float t){
  t = clamp(t,0.0,1.0);
  return vec3(pow(t,0.85), pow(t,2.4)*0.42, pow(t,3.4)*0.34);
}
vec3 paletteCyan(float t){
  t = clamp(t,0.0,1.0);
  return vec3(pow(t,2.1)*0.30, pow(t,0.9), pow(t,0.75));
}

void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  int kx = c.x, ky = c.y;
  if(uShift == 1){ kx = (kx + uN/2) % uN; ky = (ky + uN/2) % uN; }
  if(uBitrev == 1){ kx = brev(kx); ky = brev(ky); }
  vec4 s = texelFetch(uSrc, ivec2(kx, ky), 0);
  float v = (uMode == 0) ? (s.x*s.x + s.y*s.y) : length(s.xy);

  v = max(v, 0.0) * uGain;
  if(uFloor > 0.0){
    v = log(1.0 + v/uFloor) / log(1.0 + 1.0/uFloor);
  }
  v = pow(clamp(v, 0.0, 1.0), uGamma);

  vec3 col;
  if(uPalette == 1) col = paletteHeat(v);
  else if(uPalette == 2) col = paletteHeNe(v);
  else if(uPalette == 3) col = paletteCyan(v);
  else col = vec3(v);
  fragColor = vec4(col, 1.0);
}`;

  /* ── 降采样提取（供 CPU 侧做峰值分析）── */
  const FS_REDUCE = `
uniform sampler2D uSrc;
uniform int uN, uM, uK, uLog2N, uBitrev;
uniform int uMode;
out vec4 fragColor;

int brev(int x){
  int r = 0;
  for(int i = 0; i < 16; i++){
    if(i >= uLog2N) break;
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r;
}

/* 输出像素 o 覆盖物理频率索引 [-N/2 + o*K, -N/2 + (o+1)*K)
   —— 已内含 fftshift 语义，源索引 = (物理索引 mod N)                  */
void main(){
  ivec2 o = ivec2(gl_FragCoord.xy);
  float acc = 0.0;
  int hn = uN/2;
  for(int t = 0; t < 16; t++){
    if(t >= uK) break;
    for(int u = 0; u < 16; u++){
      if(u >= uK) break;
      int kx = o.x*uK - hn + t;
      int ky = o.y*uK - hn + u;
      kx = ((kx % uN) + uN) % uN;
      ky = ((ky % uN) + uN) % uN;
      if(uBitrev == 1){ kx = brev(kx); ky = brev(ky); }
      vec2 s = texelFetch(uSrc, ivec2(kx, ky), 0).xy;
      acc += (uMode == 0) ? (s.x*s.x + s.y*s.y) : length(s.xy);
    }
  }
  fragColor = vec4(acc / float(uK*uK), 0.0, 0.0, 1.0);
}`;

  /* ═══════════ GPUFFT ═══════════ */
  class GPUFFT {
    constructor(gl, caps, N) {
      this.gl = gl; this.caps = caps;
      this.N = N;
      this.p = Math.round(Math.log2(N));
      if ((1 << this.p) !== N) throw new Error('FFT 长度须为 2 的幂，收到 ' + N);

      const F = caps.colorBufferFloat ? 'rgba32f' : 'rgba16f';
      this.FMT = F;

      // twiddle 因子表：exp(+i2πk/N)
      const tw = new Float32Array(N * 4);
      for (let k = 0; k < N; k++) {
        const a = 2 * Math.PI * k / N;
        tw[k * 4] = Math.cos(a); tw[k * 4 + 1] = Math.sin(a);
        tw[k * 4 + 2] = 0; tw[k * 4 + 3] = 1;
      }
      this.twTex = GLX.tex2D(gl, { width: N, height: 1, format: F, data: tw, filter: 'nearest' });

      this.texA = GLX.makeFBO(gl, { width: N, height: N, format: F, filter: 'nearest' });
      this.texB = GLX.makeFBO(gl, { width: N, height: N, format: F, filter: 'nearest' });
      this.texS = GLX.makeFBO(gl, { width: N, height: N, format: F, filter: 'nearest' });
      /* 输入场的常驻副本：texA 是 FFT 的工作区，一次变换就被覆盖，
         所以输入场单独存一份，输入没变时只需一次 GPU 拷贝，省掉 4 MB 上传。 */
      this.texIn = GLX.makeFBO(gl, { width: N, height: N, format: F, filter: 'nearest' });

      this.pStage = new GLX.Program(gl, FS_VS, FS_STAGE.replace('uLog2N(uN)', String(this.p)), 'fft.stage');
      this.pTrans = new GLX.Program(gl, FS_VS, FS_TRANSPOSE, 'fft.trans');
      this.pCopy = new GLX.Program(gl, FS_VS, FS_COPY, 'fft.copy');
      this.pMag = new GLX.Program(gl, FS_VS, FS_MAGSQ, 'fft.magsq');
      this.pFilter = new GLX.Program(gl, FS_VS, FS_FILTER, 'fft.filter');
      this.pDisplay = new GLX.Program(gl, FS_VS, FS_DISPLAY, 'fft.display');
      this.pReduce = new GLX.Program(gl, FS_VS, FS_REDUCE, 'fft.reduce');

      this.quad = GLX.fullscreenVAO(gl);

      // 显示输出（RGBA8，供 3D 屏幕采样 / 2D 面板绘制）
      this.dispJps = GLX.makeFBO(gl, { width: N, height: N, format: 'rgba8', filter: 'linear' });
      this.dispOut = GLX.makeFBO(gl, { width: N, height: N, format: 'rgba8', filter: 'linear' });
      this.dispIn = GLX.makeFBO(gl, { width: N, height: N, format: 'rgba8', filter: 'linear' });

      this._tmp = new Float32Array(4);
      this.stats = { passes: 0, lastMs: 0 };
    }

    dispose() {
      const gl = this.gl;
      for (const k of ['twTex']) if (this[k]) gl.deleteTexture(this[k]);
      for (const k of ['texA', 'texB', 'texS', 'texIn', 'dispJps', 'dispOut', 'dispIn']) {
        const t = this[k];
        if (!t) continue;
        gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex);
        if (t.depth) gl.deleteRenderbuffer(t.depth);
      }
    }

    _pass(prog, target, setup) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, target.width, target.height);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
      prog.use();
      gl.bindVertexArray(this.quad.vao);
      if (setup) setup(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      this.stats.passes++;
    }

    /** 把复数场（交错 Re,Im 的 Float32Array，长度 2N²）上传到 texA */
    loadComplex(data) {
      const gl = this.gl;
      let buf = data;
      if (this.FMT === 'rgba16f') {
        // 半精度降级：转成半浮点编码的 Uint16
        buf = new Float32Array(this.N * this.N * 4);
        for (let i = 0, n = this.N * this.N; i < n; i++) {
          buf[i * 4] = data[i * 2]; buf[i * 4 + 1] = data[i * 2 + 1];
        }
        buf = floatToHalf(buf);
      } else {
        const f = new Float32Array(this.N * this.N * 4);
        for (let i = 0, n = this.N * this.N; i < n; i++) {
          f[i * 4] = data[i * 2]; f[i * 4 + 1] = data[i * 2 + 1];
          f[i * 4 + 3] = 1;
        }
        buf = f;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texA.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.N, this.N,
        gl.RGBA, this.FMT === 'rgba16f' ? gl.HALF_FLOAT : gl.FLOAT, buf);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return this.texA;
    }

    /** 上传实数场（长度 N²）到 texA 的 R 通道 */
    loadReal(data) {
      const gl = this.gl;
      const n = this.N * this.N;
      /* 缓冲复用：N=1024 时这里原本每次求解都新分配 16 MB（+ 8 MB 半浮点），
         拖动时每帧一次 → GC 抖动明显，表现为「拖一下就卡一下」。 */
      if (!this._upBuf || this._upBuf.length !== n * 4) {
        this._upBuf = new Float32Array(n * 4);
        this._upHalf = new Uint16Array(n * 4);
      }
      const f = this._upBuf;
      let buf;
      if (this.FMT === 'rgba16f') {
        for (let i = 0; i < n; i++) f[i * 4] = data[i];
        buf = floatToHalf(f, this._upHalf);
      } else {
        for (let i = 0; i < n; i++) f[i * 4] = data[i];
        buf = f;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texIn.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.N, this.N,
        gl.RGBA, this.FMT === 'rgba16f' ? gl.HALF_FLOAT : gl.FLOAT, buf);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.copy(this.texIn, this.texA);       // 工作区每次求解都会被覆盖，先备一份
      return this.texA;
    }

    /** 输入场没变时：把常驻副本拷回工作区（一次全屏 pass，远快于 4 MB 上传） */
    restoreInput() { return this.copy(this.texIn, this.texA); }

    /** 一维按行变换链：in → out，共 p 个 pass */
    _fft1D(src, dst, dir, sign) {
      let a = src, b = dst;
      const p = this.pStage;
      for (let s = 0; s < this.p; s++) {
        this._pass(p, b, (pr) => {
          pr.tex('uTex', a.tex, 0);
          pr.tex('uTw', this.twTex, 1);
          pr.set('uN', this.N);
          pr.set('uStage', s);
          pr.set('uDir', dir);
          pr.set('uSign', sign);
        });
        const t = a; a = b; b = t;
      }
      return a;
    }

    _transpose(src, dst) {
      this._pass(this.pTrans, dst, (pr) => pr.tex('uTex', src.tex, 0));
      return dst;
    }

    copy(src, dst) {
      this._pass(this.pCopy, dst, (pr) => pr.tex('uTex', src.tex, 0));
      return dst;
    }

    /**
     * 完整二维变换。输入纹理若落在工作区之外（如 texS）会先复制，保证不被破坏。
     * @param {object} src  源 FBO
     * @param {number} dir  0 = DIF（自然序入，位反转序出）；1 = DIT（位反转序入，自然序出）
     * @param {number} sign -1 正变换 / +1 逆变换
     * @returns 结果 FBO（texA 或 texB）
     */
    transform(src, dir, sign) {
      const t0 = performance.now();
      const A = this.texA, B = this.texB;
      let work = src;
      if (src !== A && src !== B) { this.copy(src, A); work = A; }

      let cur = this._fft1D(work, (work === A ? B : A), dir, sign);
      cur = this._transpose(cur, (cur === A ? B : A));
      cur = this._fft1D(cur, (cur === A ? B : A), dir, sign);
      cur = this._transpose(cur, (cur === A ? B : A));
      this.stats.lastMs = performance.now() - t0;
      return cur;
    }

    /** S = |X|²·scale，结果写入 texS */
    magSq(src, scale) {
      this._pass(this.pMag, this.texS, (pr) => {
        pr.tex('uTex', src.tex, 0);
        pr.set('uScale', scale === undefined ? 1 : scale);
      });
      return this.texS;
    }

    /** 对 texS 做滤波（二值化 / 纯相位 / 高通 / 量化 / 离焦低通）
     *  注意：不能把 texS 同时作为采样源与渲染目标（WebGL 反馈环 → 非法且空操作）。
     *  故先渲染到 texB，再拷回 texS。 */
    filterS(op, thresh, cut, knee) {
      this._pass(this.pFilter, this.texB, (pr) => {
        pr.tex('uTex', this.texS.tex, 0);
        pr.set('uOp', op | 0);
        pr.set('uThresh', thresh || 0);
        pr.set('uCut', cut || 0);
        pr.set('uKnee', knee || 0);
        pr.set('uN', this.N);
        pr.set('uLog2N', this.p);
        pr.set('uUseFilter', 0);
      });
      this.copy(this.texB, this.texS);
      return this.texS;
    }

    /** 渲染到 RGBA8 显示纹理 */
    display(src, target, o) {
      o = o || {};
      this._pass(this.pDisplay, target, (pr) => {
        pr.tex('uSrc', src.tex, 0);
        pr.set('uN', this.N);
        pr.set('uLog2N', this.p);
        pr.set('uBitrev', o.bitrev ? 1 : 0);
        pr.set('uShift', o.shift === false ? 0 : 1);
        pr.set('uMode', o.mode || 0);
        pr.set('uPalette', o.palette === undefined ? 1 : o.palette);
        pr.set('uGain', o.gain === undefined ? 1 : o.gain);
        pr.set('uFloor', o.floor === undefined ? 0 : o.floor);
        pr.set('uGamma', o.gamma === undefined ? 1 : o.gamma);
        pr.set('uLogMin', 0);
      });
      return target;
    }

    /** 降采样回读到 CPU（M×M，物理坐标以中心为原点，含位反转解缠） */
    reduce(src, M, o) {
      o = o || {};
      const gl = this.gl;
      const K = this.N / M;
      if (!Number.isInteger(K)) throw new Error('降采样比必须为整数');
      if (!this._redFBO || this._redFBO.width !== M) {
        if (this._redFBO) { gl.deleteFramebuffer(this._redFBO.fb); gl.deleteTexture(this._redFBO.tex); }
        this._redFBO = GLX.makeFBO(gl, { width: M, height: M, format: 'rgba32f', filter: 'nearest' });
      }
      this._pass(this.pReduce, this._redFBO, (pr) => {
        pr.tex('uSrc', src.tex, 0);
        pr.set('uN', this.N); pr.set('uM', M); pr.set('uK', K);
        pr.set('uLog2N', this.p);
        pr.set('uBitrev', o.bitrev ? 1 : 0);
        pr.set('uMode', o.mode || 0);
      });
      const out = new Float32Array(M * M * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._redFBO.fb);
      gl.readPixels(0, 0, M, M, gl.RGBA, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // readPixels 自下而上 → 上下翻正；同时只取 R 通道
      const res = new Float32Array(M * M);
      for (let y = 0; y < M; y++) {
        const srcRow = (M - 1 - y) * M;
        for (let x = 0; x < M; x++) res[y * M + x] = out[(srcRow + x) * 4];
      }
      return res;
    }

        /**
     * 读取一行并按位反转解包——用于在**全分辨率**上测谱面结构。
     * 说明：M=N/2 的降采样读回无法表示杨氏条纹（Λ≈3.2 px @N=1024，
     * 降到 512 后周期仅 1.6 px，已超出该网格的 Nyquist 极限），
     * 因此条纹对比度必须在原始分辨率的一行上测量。
     * @param src 位反转序的谱面 FBO（如 texS）
     * @param row 纹理行号（row = 0 ↔ η = 0）
     * @returns Float32Array(N)，自然频率序（k=0..N−1，负频回绕）
     */
    readRowNatural(src, row) {
      const gl = this.gl, N = this.N, p = this.p;
      if (!this._rowBuf || this._rowBuf.length !== N * 4) this._rowBuf = new Float32Array(N * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, src.fb);
      gl.readPixels(0, row, N, 1, gl.RGBA, gl.FLOAT, this._rowBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const out = new Float32Array(N);
      for (let c = 0; c < N; c++) {
        let x = c, r = 0;
        for (let i = 0; i < p; i++) { r = (r << 1) | (x & 1); x >>= 1; }
        out[r] = this._rowBuf[c * 4];
      }
      return out;
    }

/** 对纹理做整体求和（降采样后求和，用于 Parseval 能量校验 / 峰值比） */
    sumEnergy(src, M, bitrev) {
      const r = this.reduce(src, M === undefined ? Math.min(256, this.N) : M,
        { mode: 0, bitrev: !!bitrev });
      let s = 0;
      for (let i = 0; i < r.length; i++) s += r[i];
      return s;
    }
  }

  /* ── Float32 → Float16 位模式（降级路径用） ── */
  const _f2h = new Float32Array(1);
  const _i2h = new Int32Array(_f2h.buffer);
  function floatToHalf(arr, out) {
    out = out || new Uint16Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (x === 0) { out[i] = 0; continue; }
      _f2h[0] = x;
      const b = _i2h[0];
      const s = (b >> 16) & 0x8000;
      let e = ((b >> 23) & 0xff) - 127 + 15;
      let m = b & 0x7fffff;
      if (e <= 0) { out[i] = s; continue; }
      if (e >= 31) { out[i] = s | 0x7c00; continue; }
      out[i] = s | (e << 10) | (m >> 13);
    }
    return out;
  }

  global.GPUFFT = GPUFFT;
})(window);
