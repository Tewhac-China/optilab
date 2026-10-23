/* ═══════════════════════════════════════════════════════════
   optics.js · 联合傅里叶变换相关器（JTC）数值引擎

   物理模型
   ─────────────────────────────────────────────────────────
   输入面   h(x,y) = A(x,y)·[ f(x+a, y) + g(x−a, y) ]
            A 为激光照明包络（高斯光束），另有输入面光阑限制口径
   谱面     S(u,v) = |FT{h}|²                     （平方律记录）
   输出面   o(ξ,η) = FT{S}                        （第二次傅里叶变换）
                    = (f⋆f) + (g⋆g) + (f⋆g)(ξ−2a) + (g⋆f)(ξ+2a)
            互相关峰位于 ξ = ±2a · (f₂/f₁)

   标定     du = 1/(N·dx)       频率采样
            dξ_s = λ f₁ · du   谱面采样
            dξ_o = dx · f₂/f₁  输出面采样
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* 谱面显示的对数底：既要看到弱旁瓣，又不能被读出噪声（≈0.25% 峰值）糊满。
     1e-4 时读出噪声落在 0.30（可见的细散斑）、一级条纹 0.45–0.6、直流 1.0，
     三层都分得开；1e-6 会让噪声糊满整块屏，1e-3 又几乎全黑。
     3D 悬浮屏、右栏小图、大图共用这一个值。 */
  const JPS_LOG_FLOOR = 1e-4;

  const DEFAULTS = {
    N: 1024,
    dx: 10e-6,          // 输入面采样间距 (m)
    lambda: 632.8e-9,   // HeNe
    f1: 150e-3,         // 傅里叶变换透镜焦距
    f2: 150e-3,         // 第二次变换焦距（SLM2 读出）
    aFac: 0.156,        // 半间距 a / L
    wFac: 0.25,         // 目标尺寸 w / L
    aperture: 1.0,      // 输入面圆形光阑半径 / (L/2)，1 = 全通
    sigma: 0.62,        // 照明高斯 σ / (L/2)
    illum: 0.55,        // 高斯照明权重 0=均匀平面波 1=强高斯
    fillFactor: 1.0,    // SLM 像素填充因子（1 = 无像素化损失）
    jpsMode: 0,         // 0 原始 | 1 二值化 | 2 纯相位 | 3 高通
    jpsThresh: 0.12,    // 二值化相对阈值（对 |H|² 归一化后）
    hpCut: 0.02,        // 高通径向截止
    quantum: 1.0,       // 探测器量化位数（1 = 连续）
    noise: 0.0,         // 记录噪声（相对）
  };

  /* ────────── 小工具 ────────── */
  function resampleBilinear(src, srcN, dstN) {
    if (srcN === dstN) return src;
    const out = new Float32Array(dstN * dstN);
    const k = (srcN - 1) / Math.max(1, dstN - 1);
    for (let y = 0; y < dstN; y++) {
      const sy = y * k, y0 = Math.floor(sy), fy = sy - y0, y1 = Math.min(srcN - 1, y0 + 1);
      for (let x = 0; x < dstN; x++) {
        const sx = x * k, x0 = Math.floor(sx), fx = sx - x0, x1 = Math.min(srcN - 1, x0 + 1);
        const a = src[y0 * srcN + x0], b = src[y0 * srcN + x1];
        const c = src[y1 * srcN + x0], d = src[y1 * srcN + x1];
        out[y * dstN + x] = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
      }
    }
    return out;
  }

  /* ═══════════ JTC 引擎 ═══════════ */
  class JTC {
    constructor(gl, caps, params) {
      this.gl = gl; this.caps = caps;
      this.p = Object.assign({}, DEFAULTS, params || {});
      this.fft = null;
      this._allocFft();

      this.fField = null; this.gField = null;
      this.fName = 'guang'; this.gName = 'guang';
      this.busy = false;
      this.lastSolveMs = 0;
      this.result = null;
    }

    _allocFft() {
      if (this.fft) this.fft.dispose();
      this.fft = new GPUFFT(this.gl, this.caps, this.p.N);
      this.M = 512;
      if (this.p.N / this.M < 2) this.M = this.p.N / 2;
      this._inKey = null;            // 纹理是新分配的，输入副本必须重传
    }

    setParams(o) {
      const needRealloc = (o.N && o.N !== this.p.N);
      Object.assign(this.p, o);
      if (needRealloc) {
        if (o.N > this.caps.maxTexture) { this.p.N = this.caps.maxTexture; }
        this._allocFft();
      }
      return this;
    }

    setPatterns(fField, gField, fName, gName) {
      this.fField = fField; this.gField = gField;
      if (fName) this.fName = fName;
      if (gName) this.gName = gName;
    }

    /**
     * 注入 3D 元件实际位置/状态派生的几何状态，使学生的操作真实影响计算：
     * @param {object} geom
     *   specDefocus  (m)  CMOS 谱面探测器偏离 L₁ 后焦面的量（+ 过焦）
     *   outDefocus   (m)  输出屏偏离 L₂ 后焦面的量
     *   collimOffset (m)  准直透镜偏离「针孔后 f」的量 → 球面波照明，
     *                     等效为谱面额外离焦（条纹变钝）
     *   lensRadius   (m)  透镜处光束半径（决定会聚锥半角→模糊圆）
     *   illumScale   (-)  准直镜拖动导致的照明口径缩放（1 = 标称）
     *   pinOffset    (m)  针孔偏心量 → 透过率下降 + 照明偏心
     *   illumOffsetX (m)  照明中心在输入面的横向偏移（由针孔偏心几何导出）
     *   flux         (-)  相对光通量 0…1（针孔透过 × 光阑截断）→ 记录信噪比
     *   apHalf       (m)  照明光阑实际通光半径（用于诊断是否切到目标）
     */
    setGeom(geom) { this.geom = geom || null; return this; }

    /* ── 派生量 ── */
    get L() { return this.p.N * this.p.dx; }                       // 输入面宽度
    get aPx() { return Math.round(this.p.aFac * this.p.N); }        // 半间距（像素）
    get wPx() { return Math.max(8, Math.round(this.p.wFac * this.p.N)); }
    get a() { return this.aPx * this.p.dx; }                        // 半间距 (m)
    get w() { return this.wPx * this.p.dx; }
    get dxi() { return this.p.dx; }                                 // 输入面采样
    get dS() { return this.p.lambda * this.p.f1 / this.L; }         // 谱面采样 (m)
    get dO() { return this.p.dx * this.p.f2 / this.p.f1; }          // 输出面采样
    get fringe() { return this.p.lambda * this.p.f1 / (2 * this.a); } // 杨氏条纹周期 (m)
    get fringePx() { return this.fringe / this.dS; }
    get peakXi() { return 2 * this.a * this.p.f2 / this.p.f1; }     // 互相关峰 ξ
    get peakPx() { return this.peakXi / this.dO; }

    /* ── 诊断 ── */
    diagnose() {
      const d = [];
      const L = this.L, N = this.p.N;
      const sep = this.peakXi / (L / 2);                 // 峰位 / 半幅
      d.push({
        k: '互相关峰位 ξ', v: U.eng(this.peakXi, 2, 'm'),
        st: sep > 0.94 ? 'bad' : sep > 0.82 ? 'warn' : 'ok',
        note: '应 < L/2 = ' + U.eng(L / 2, 2, 'm'),
      });
      const fr = this.fringePx;
      d.push({
        k: '杨氏条纹周期', v: fr.toFixed(2) + ' px',
        st: fr < 2.0 ? 'bad' : fr < 3.0 ? 'warn' : 'ok',
        note: '≥2 px 才不欠采样',
      });
      const need = this.w / this.a;                       // 需 < 1 才能与 0 级分离
      d.push({
        k: '目标/间距比', v: (this.w * 1e3).toFixed(2) + ':' + (this.a * 1e3).toFixed(2),
        st: need > 1.25 ? 'bad' : need > 1.0 ? 'warn' : 'ok',
        note: '目标宽度 w : 半间距 a（mm）· 越小一级项与零级越分离',
      });
      const fx = this.p.lambda * this.p.f1 / this.p.dx;   // 最高可表示空间频率对应的位置
      d.push({
        k: '谱面 Nyquist', v: '±' + U.eng(fx / 2, 3, 'm'),
        st: 'ok', note: '由 dx 决定',
      });
      const fnum = this.p.f1 / (2 * this.w);
      d.push({
        k: '透镜 F 数', v: 'f/' + fnum.toFixed(1),
        st: fnum < 2 ? 'warn' : 'ok', note: '越小像差影响越明显（本模型取理想透镜）',
      });
      // 空间滤波与扩束的物理量（与 3D 光束模型同源）
      const NAimg = 0.40 / 20;
      const w0pin = 0.61 * this.p.lambda / NAimg;
      d.push({
        k: '针孔衍射焦斑', v: '⌀' + (w0pin * 2e6).toFixed(0) + ' µm',
        st: 'ok', note: '0.61λ/NA′ · 决定滤波后基模束腰',
      });
      const wColl = NAimg * 0.150;
      d.push({
        k: '准直光束 ⌀', v: (wColl * 2e3).toFixed(1) + ' mm',
        st: 'ok', note: 'f_准直·θ，经光阑②限光后照明输入面',
      });
      const sNr = 1 / (2 * this.p.dx);
      d.push({
        k: '输入面带宽', v: '±' + U.eng(sNr, 0, 'lp/m'),
        st: 'ok', note: 'Nyquist ' + U.eng(sNr, 0, 'lp/m'),
      });

      /* ── 以下为「操作错误 → 物理后果」的实况诊断 ── */
      const q = this.result && this.result.quality;
      const g = this.geom || {};
      const mm = (x) => (x * 1e3).toFixed(2);

      // 空间滤波器（针孔）对准
      const pinOff = Math.abs(g.pinOffset || 0);
      const pinT = (g.flux || 1);
      d.push({
        k: '针孔偏心', v: (pinOff * 1e6).toFixed(1) + ' µm · ' + (pinT * 100).toFixed(0) + '%',
        st: pinOff > 15e-6 ? 'bad' : pinOff > 6e-6 ? 'warn' : 'ok',
        note: '偏心 → 透过率按 exp(−2δ²/w₀²) 下降，并造成照明偏心',
      });

      // 准直（球面波照明）
      const cOff = Math.abs(g.collimOffset || 0);
      d.push({
        k: '准直离焦 δ', v: mm(cOff) + ' mm',
        st: cOff > 12e-3 ? 'bad' : cOff > 4e-3 ? 'warn' : 'ok',
        note: '离焦 → 球面波照明 → 等效谱面离焦，条纹变钝',
      });

      // 探测器离焦
      const dz = (q && q.defocus) || null;
      const rbUm = dz ? dz.rb * 1e6 : 0;
      d.push({
        k: '探测器离焦模糊圆', v: rbUm.toFixed(0) + ' µm',
        st: rbUm > 200 ? 'bad' : rbUm > 60 ? 'warn' : 'ok',
        note: dz ? ('CMOS ' + mm(dz.dSpec) + ' · 输出屏 ' + mm(dz.dOut) +
          ' · 准直 ' + mm(dz.dColl) + ' mm') : '三处均在焦面',
      });

      // 条纹对比度（JPS 可见度）
      const fv = q ? q.fringeVis : null;
      d.push({
        k: 'JPS 条纹对比度 V', v: fv === null ? '—' : fv.toFixed(3), dup: true,
        st: fv === null ? 'ok' : fv < 0.15 ? 'bad' : fv < 0.45 ? 'warn' : 'ok',
        note: 'V=(max−min)/(max+min)，离焦 / 偏心 / 噪声都会拉低它',
      });

      // 偏振片夹角
      const pd = g.polDelta;
      d.push({
        k: '偏振片 P1⊥P2', v: pd === undefined ? '—' : (90 - pd).toFixed(0) + '° 偏差',
        st: pd === undefined ? 'ok' : pd < 60 ? 'bad' : pd < 82 ? 'warn' : 'ok',
        note: '夹角 Δ=' + (pd === undefined ? '—' : pd.toFixed(0) + '°') +
          ' · 正交(90°)时振幅调制最深，条纹对比度最高',
      });

      // 记录信噪比
      const snr = q ? q.snr : null;
      d.push({
        k: '记录信噪比 SNR', v: snr === null ? '—' : '≈' + snr.toFixed(0), dup: true,
        st: snr === null ? 'ok' : snr < 30 ? 'bad' : snr < 120 ? 'warn' : 'ok',
        note: '通量 φ=' + ((q ? q.flux : 1) * 100).toFixed(0) + '% · 噪声 ∝ 1/φ²',
      });

      // 一级项 / 零级分离度
      const sepM = q ? q.sepMargin : (2 * this.a / Math.max(1e-12, this.w));
      d.push({
        k: '一级 / 零级分离度 2a:w', v: sepM.toFixed(2) + ' : 1', dup: true,
        st: sepM < 1.0 ? 'bad' : sepM < 1.15 ? 'warn' : 'ok',
        note: '≤1 时一级相关项与零级重叠，峰被淹没（减小 w 或增大 a）',
      });

      // 照明截断
      const blk = q ? q.blocked : 0;
      d.push({
        k: '照明光阑截断', v: (blk * 100).toFixed(1) + '%', dup: true,
        st: blk > 0.25 ? 'bad' : blk > 0.05 ? 'warn' : 'ok',
        note: '光阑半径 ' + mm(g.apHalf || this.p.aperture * this.L / 2) +
          ' mm；切到目标会同时降低通量并使一级项失真',
      });

      // 照明均匀度
      const iu = q ? q.illumU : null;
      d.push({
        k: '输入面照明均匀度', v: iu === null ? '—' : iu.toFixed(3), dup: true,
        st: iu === null ? 'ok' : iu < 0.35 ? 'bad' : iu < 0.6 ? 'warn' : 'ok',
        note: '1 = 完全均匀；高斯照明 + 偏心会明显降低',
      });

      return d;
    }

    /* ── 合成输入面（纯振幅透过率，返回 N² 实数场） ── */
    buildInput() {
      const N = this.p.N, n2 = N * N;
      /* 复用缓冲区：每次求解都新分配 4 MB（N=1024）会让拖拽时 GC 抖动，
         而且下面只写图案覆盖的 wPx² 区域，其余必须清零。 */
      if (!this._inBuf || this._inBuf.length !== n2) this._inBuf = new Float32Array(n2);
      const re = this._inBuf;
      re.fill(0);
      const aPx = this.aPx, wPx = this.wPx;
      const half = N / 2;

      const fR = this.fField ? resampleBilinear(this.fField, this.fField.size || PATTERNS.SIZE, wPx) : null;
      const gR = this.gField ? resampleBilinear(this.gField, this.gField.size || PATTERNS.SIZE, wPx) : null;

      // g 在 +a，f 在 −a（循环索引下即 N−a）
      const centers = [];
      if (gR) centers.push([aPx, gR]);
      if (fR) centers.push([((N - aPx) % N + N) % N, fR]);

      // 照明高斯 σ（像素）：受准直镜拖动的照明口径缩放 illumScale 影响，
      // 并被输入面圆形光阑 apR 截断（实际照明口径不超过光阑）
      const illumScale = (this.geom && this.geom.illumScale) || 1.0;
      const sigPx = Math.max(1e-3, this.p.sigma * illumScale * (N / 2));
      const apR = this.p.aperture * (N / 2);
      const sigEff = Math.min(sigPx, Math.max(1e-3, apR));

      // 照明偏心：针孔未对准光轴时，透过光成为偏心球面波，经准直后
      // 照明中心在输入面横向偏移（几何关系见 app._syncGeom）。
      // 后果：一个目标被照亮、另一个变暗 → 互相关项变弱。
      const offX = ((this.geom && this.geom.illumOffsetX) || 0) / this.p.dx;
      const offY = ((this.geom && this.geom.illumOffsetY) || 0) / this.p.dx;

      let sum2 = 0, maxV = 0, sumNoAp = 0, sumW = 0;
      const apActive = apR < N / 2 - 0.5;
      for (const [cx, field] of centers) {
        const off = Math.floor(wPx / 2);
        for (let j = 0; j < wPx; j++) {
          // 竖直方向以原点为中心（索引 0 即原点，故需回绕）
          const Y = ((j - off) % N + N) % N;
          const yr = Y > half ? Y - N : Y;
          for (let i = 0; i < wPx; i++) {
            const v = field[j * wPx + i];
            if (v <= 0) continue;
            let X = (cx - off + i) % N; if (X < 0) X += N;
            const xr = X > half ? X - N : X;

            // 高斯照明包络（中心随针孔偏心平移）
            const dxc = xr - offX, dyc = yr - offY;
            const r2 = (dxc * dxc + dyc * dyc) / (sigEff * sigEff);
            const amp = 1 - this.p.illum + this.p.illum * Math.exp(-0.5 * r2);

            // 照明光阑截断：被挡掉的目标能量既降低通量，也使一级项失真
            const blocked = apActive && (xr * xr + yr * yr) > apR * apR;
            sumNoAp += (v * amp) * (v * amp);
            if (blocked) continue;

            const val = v * amp;
            const idx = Y * N + X;
            re[idx] = val;
            sum2 += val * val;
            sumW += val;                       // 用于照明均匀度
            if (val > maxV) maxV = val;
          }
        }
      }
      this._inputEnergy = sum2;
      this._inputMax = maxV;
      this._blockedFrac = sumNoAp > 0 ? 1 - sum2 / sumNoAp : 0;   // 光阑挡掉比例
      // 照明均匀度：有效像素上的能量分布平坦度（1 = 完全均匀）
      const nEff = Math.max(1, this._countNonZero(re));
      this._illumU = maxV > 0 ? (sum2 / nEff) / (maxV * maxV) : 0;
      return re;
    }

    _countNonZero(a) {
      let c = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== 0) c++;
      return c;
    }

    /** 输入场的「指纹」：这些量不变，输入面 h(x,y) 就一模一样 */
    _inputKey() {
      const g = this.geom || {};
      return [this.fName, this.gName, this.p.N, this.p.sigma, this.p.aperture, this.p.illum,
        (g.illumOffsetX || 0).toFixed(9), (g.illumOffsetY || 0).toFixed(9),
        (g.illumScale || 1).toFixed(6), this.p.wFac, this.p.aFac].join('|');
    }

    /* ── 求解 ──       完整求解 = GPU FFT + 6 次读回（输入面 / 谱面统计 / 输出面 / 条纹行）。
       在软件渲染（SwiftShader）或低端集显上，每次读回都是一次管线同步，
       实测 4 次 reduce 占掉 80% 的求解时间（约 430 ms）。
       拖拽元件 / 拖动滑块时传 preview=true：只算 FFT 与三张贴图，
       完全不做读回（面板数字沿用上一次完整解），松手后再补一次完整求解。
       这样「拖着看光路变化」是连续的，而读数仍然是准的。 */
    solve(preview) {
      const t0 = performance.now();
      const fft = this.fft, N = this.p.N;
      const gl = this.gl;
      const prev = this.result;
      const isPreview = !!preview && !!prev && prev.analysis;

      // 0) 输入场：只有图案 / 光阑 / 照明 / 采样参数变了才重算并上传。
      //    移动透镜、CMOS 这类操作完全不改变输入面，却要重传 4 MB 纹理 ——
      //    实测这是拖动时最大的一笔开销（软件渲染下 40–200 ms）。
      const inKey = this._inputKey();
      if (inKey !== this._inKey) {
        const h = this.buildInput();
        fft.loadReal(h);   // 落到 texA（实部），并留一份常驻副本
        this._inKey = inKey;
      } else {
        fft.restoreInput();
      }

      // 1) 输入面显示 + 回读（供 2D 视图）
      fft.display(fft.texA, fft.dispIn, {
        shift: true, bitrev: false, mode: 1, palette: 2, gain: 1 / Math.max(1e-6, this._inputMax),
      });
      const inArr = isPreview ? prev.inArr : fft.reduce(fft.texA, this.M, { mode: 1, bitrev: false });

      // 2) 第一次变换：H = FT{h} / N（保持能量）
      const H = fft.transform(fft.texA, 0, -1);

      // 3) 联合功率谱 S = |H|²/N²
      fft.magSq(H, 1 / (N * N));
      const S = fft.texS;

      // 3.2) 无噪、**未滤波**的 JPS 统计。
      //      Parseval 校验必须只看傅里叶归一化：下面的离焦低通会真的削掉高频能量，
      //      若在滤波之后统计，能量守恒读数会随离焦一路掉到 0.36 ——
      //      看起来像「FFT 算错了」，其实是被滤波器拿掉了。
      let sArr, sMax, sTotClean = 0;
      if (isPreview) {
        sArr = prev.sArr; sMax = prev.sMax || 1e-30;
      } else {
        sArr = fft.reduce(S, this.M, { mode: 1, bitrev: true });
        sMax = Math.max(1e-30, maxOf(sArr));
        for (let i = 0; i < sArr.length; i++) sTotClean += sArr[i];
      }

      // 3.5) 频谱面离焦：三种学生常见错误的共同物理后果，全部折算成
      //      「探测器偏离后焦面」的等效离焦量 Δ：
      //        · CMOS 不在 L₁ 后焦面            → specDefocus
      //        · 输出屏不在 L₂ 后焦面            → outDefocus
      //        · 准直未到位（球面波照明）        → collimOffset
      //          （点源不在准直镜前焦面时出射为球面波，等价于傅里叶面平移）
      //      物理标定：模糊圆半径 r_b = r_E·|Δ|/f，高斯等效 σ_ξ = r_b/2，
      //      频域窗宽 σ_rr = dx/(π·σ_ξ)（rr 以 Nyquist 归一）。
      //      校验点：Δ=30 mm → r_b≈0.63 mm → 条纹被完全抹平、相关峰坍缩；
      //              Δ=1 mm → 条纹对比度约剩六成。
      if (this.geom) {
        const dSpec = Math.abs(this.geom.specDefocus || 0);
        const dOut = Math.abs(this.geom.outDefocus || 0);
        // 准直误差 → 等效谱面离焦：曲率半径 R = f_c²/δ，谱面平移 Δ ≈ R·f1²/(R²+…)
        // 取一阶等效 Δ ≈ δ·(f1/f_c)²（对焦时 δ=0）
        const dColl = Math.abs(this.geom.collimOffset || 0) *
          Math.pow(this.p.f1 / Math.max(1e-3, this.geom.fCollim || 0.15), 2);
        const dEff = Math.hypot(dSpec + dColl, dOut);                // 合成 (m)
        const rE = Math.max(5e-4, this.geom.lensRadius || 0.011);   // 透镜处光束半径
        const rb = rE * dEff / Math.max(1e-6, this.p.f1);
        if (rb > 3e-6) {                                            // <3 µm 视为对焦
          const sigma = Math.min(0.8, this.p.dx / (Math.PI * rb / 2));
          fft.filterS(5, 0, sigma, 0);
          this._defocus = { dSpec, dOut, dColl, rb };
        } else this._defocus = { dSpec, dOut, dColl, rb: 0 };
      }

      // 3.9) 条纹对比度：在「记录下来的谱面」上测（此时含离焦效应、尚未加噪）
      if (!isPreview) this._fv = this._fringeMetrics(S);
      // 偏振片夹角不当时，液晶的振幅调制深度下降 → 条纹对比度按 sinΔ 衰减。
      // Δ = 90°（正交）时系数为 1，完全不改动；Δ → 0 时条纹彻底消失。
      const polC = (this.geom && this.geom.polContrast);
      if (!isPreview && polC !== undefined && polC < 1) this._fv.vis *= polC;

      // 4) JPS 统计（S 为实数非负 → 取 |c| 即自身，不能再平方）
      //    统计已在 3.2) 完成（无噪、未滤波），此处不再回读。

      // 5) 记录信噪比：探测器读出噪声（加性、确定性，同参数下可重复）。
      //    通量越低（针孔偏心 / 光阑过小 / 照明过弱）→ 相对噪声越大
      //    → 条纹与相关峰被噪声淹没。这是"信号太弱"这类错误的真实后果。
      const flux = Math.max(0.02, Math.min(1, (this.geom && this.geom.flux) || 1));
      const noiseRel = Math.max(0, this.p.noise) + 0.0025 / (flux * flux);
      this._snr = 1 / noiseRel;
      let snrNote = '';
      if (noiseRel > 1e-4) {
        fft.filterS(6, noiseRel * sMax, 0, 0);
        snrNote = ' · SNR ' + (1 / noiseRel).toFixed(0);
      }

      // 6) 记录器件效应：有限量化位数
      let quantNote = '';
      if (this.p.quantum < 0.999) {
        const qb = Math.max(1, Math.round(this.p.quantum * 8));
        fft.filterS(4, sMax, 0, Math.pow(2, qb));
        quantNote = ' · ' + qb + ' bit 量化';
      }

      // 7) JPS 显示（在「谱面处理」之前：屏上看到的是记录下来的原始 JPS）
      const logS = this.p.jpsMode === 0;
      /* mode 必须是 1（取 |c|），不能是 0（取 |c|²）：
         S 已经是 |H|²/N²，再平方一次等于把动态范围翻倍 —— 以 sMax 归一后
         半个平面的值都 >1e-6 的对数底，整块屏被推到饱和（看起来是一片
         均匀的青噪点），而 2D 光场视图用的是 S 本身。两者因此对不上。 */
      fft.display(S, fft.dispJps, {
        shift: true, bitrev: true, mode: 1, palette: 1,
        gain: 1 / sMax, floor: logS ? JPS_LOG_FLOOR : 0, gamma: logS ? 1.0 : 0.85,
      });

      // 8) 现代方法：谱面处理（与噪声 / 量化共用一条 pass 链，中间不回读）
      let applied = '原始 JPS';
      if (this.p.jpsMode === 1) {
        fft.filterS(1, this.p.jpsThresh * sMax, 0, 0);
        applied = '二值化 JPS';
      } else if (this.p.jpsMode === 2) {
        fft.filterS(2, this.p.jpsThresh * sMax, 0, 0);
        applied = '相位化 JPS';
      } else if (this.p.jpsMode === 3) {
        fft.filterS(3, 0, this.p.hpCut, 0);
        applied = '高通 JPS';
      }
      /* 回读「屏上真正显示的那张谱面」（含读出噪声 / 量化 / 谱面处理）。
         旧版在默认模式下复用了加噪之前的统计，于是 3D 屏上满是噪点、
         而右栏小图与大图干干净净 —— 同一块谱面出现了两种样子。
         这里只多一次回读，且只在完整求解（松手 / 改参数）时发生，
         拖动中的预览解仍然零回读。 */
      if (!isPreview) sArr = fft.reduce(S, this.M, { mode: 1, bitrev: true });

      // 9) 第二次变换：DIT（输入位反转序 → 自然序）
      const O = fft.transform(S, 1, -1);

      // 10) 输出面显示
      const oArr = isPreview ? prev.oArr : fft.reduce(O, this.M, { mode: 0, bitrev: false });
      const oMax = isPreview ? prev.oMax : Math.max(1e-30, maxOf(oArr));
      fft.display(O, fft.dispOut, {
        shift: true, bitrev: false, mode: 0, palette: 1,
        // 屏面用更高的对数底：把互相关的旁瓣压暗，让三个峰在实物屏上"跳"出来
        gain: 1 / oMax, floor: 1.2e-2, gamma: 1.0,
      });

      // 11) 分析（含条纹对比度 / 分离度 / 均匀度等质量判据）
      const analysis = isPreview ? prev.analysis : this._analyze(oArr, sArr, oMax, sMax);

      // 12) Parseval 校验：Σ|H|² 应等于 Σ|h|²（H 已按 1/N 归一化）
      //     用无噪 JPS 统计（含噪的 sArr 留给显示与分析）
      const hEnergy = this._inputEnergy;
      const K = N / this.M;
      const sTot = isPreview ? prev.sTot : sTotClean * K * K;      // reduce 为块平均，需还原总量
      const parseval = isPreview ? prev.parseval : (hEnergy > 0 ? sTot / hEnergy : 1);

      this.lastSolveMs = performance.now() - t0;
      this.result = {
        preview: isPreview,
        analysis, applied: applied + quantNote + snrNote, parseval, hEnergy, sTot,
        sMax, oMax, sArr, oArr, inArr,
        quality: {
          fringeVis: analysis.fringeVis,
          vBand: analysis.vBand, vRef: analysis.vRef, valid: analysis.valid,
          sepMargin: analysis.sepMargin,
          illumU: this._illumU,
          flux,
          blocked: this._blockedFrac || 0,
          snr: 1 / noiseRel,
          defocus: this._defocus || null,
        },
        list: PARAMS_DUMP(this),
      };
      return this.result;
    }


    /**
     * 条纹对比度 V（在「记录下来的谱面」上测，即离焦/量化之后、加噪之前）
     * ─────────────────────────────────────────────────────────
     * 做法：在全分辨率谱面的 η=0 行上，用**已知条纹频率**做局部正交解调。
     *   · 必须在全分辨率上测：M=N/2 的降采样读回里条纹周期只剩 1.6 px，
     *     已越过 Nyquist，条纹信息必然丢失。
     *   · 不能用整行 DFT 的幅度：条纹项在谱面上是宽带（取决于目标细节），
     *     单 bin 幅度测不准。
     *   · 不能用局部直流做归一：大离焦时局部直流先被滤掉，商会被噪声放大
     *     （实测会出现 V 反而上升的假象）。改用**整行均值**（≈谱面总能量）
     *     归一，实测随离焦单调塌陷：Δ=0→0.189、2→0.165、5→0.089、
     *     10→0.023、≥15 只剩噪声本底。
     * 返回 V ∈ [0,1]（按对焦时的 0.25 归一到接近 1）。
     */
    _fringeMetrics(S) {
      const NN = this.p.N, row = this.fft.readRowNatural(S, 0);
      const kf = NN * this.dS / this.fringe;              // 条纹在网格中的 bin
      /* 解调窗口必须短于条纹周期：窗内相位跨度 = 2π·L/kf，一旦接近 π，
         cos/sin 两个投影会互相抵消。kf = 2·aPx 随 N 变化（N=512 时 160，
         N=1024 时 320），原来写死 L=84 在 N=512 下跨度 189°，V 从 1.00 假跌到 0.51。 */
      const n0 = 4;
      const n1 = Math.max(n0 + 12, Math.min(84, Math.round(0.26 * kf)));
      const L = n1 - n0;                                  // 条纹包络最强的区段
      let C = 0, Sn = 0, W = 0;
      for (let n = n0; n <= n1; n++) {
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (n - n0) / L);
        const ph = -2 * Math.PI * kf * n / NN;
        C += row[n] * Math.cos(ph) * w;
        Sn += row[n] * Math.sin(ph) * w;
        W += w;
      }
      let tot = 0;
      for (let n = 0; n < NN; n++) tot += row[n];
      const meanRow = tot / NN;
      const amp = W > 0 ? 2 * Math.hypot(C, Sn) / W : 0;
      const ratio = meanRow > 1e-20 ? amp / meanRow : 0;
      return { vis: Math.min(1, ratio / 0.25), A: amp, base: meanRow, kf };
    }

    /* ── 峰值分析（在 M×M 物理坐标数组上） ── */
    _analyze(oArr, sArr, oMax, sMax) {
      const M = this.M;
      const half = M / 2;
      const scale = (this.p.N / M) * this.dO;     // 数组步长 → 米
      const inM = (v) => v * 1000;

      // 排除 0 级：只搜索 |x| > 0.5·a（物理上自相关半径以内）
      const axPx = this.aPx / (this.p.N / M);
      const guard = Math.max(3, Math.round(axPx * 0.55));

      const norm = 1 / Math.max(1e-30, oMax);
      // 互相关峰的位置由几何完全决定（ξ = 2a·f₂/f₁），不可能出现在别处。
      // 所以只在理论峰位 ±35% 的窗口里找峰：否则光弱时全局最大值会落到
      // 边角噪声尖峰上，报出一个比零级还高的「峰」（物理上不可能）。
      const thPx = Math.max(3, this.peakXi / scale);
      const win = Math.max(4, Math.round(thPx * 0.35));
      const cx = half + thPx;
      const x0 = clampI(Math.round(cx - win), Math.max(guard, 0), M - 1);
      const x1 = clampI(Math.round(cx + win), Math.max(guard, 0), M - 1);
      let pk = { v: -1, x: clampI(Math.round(cx), 0, M - 1), y: half };
      for (let y = 0; y < M; y++) {
        for (let x = x0; x <= x1; x++) {
          const v = oArr[y * M + x];
          if (v > pk.v) pk = { v, x, y };
        }
      }
      let peakXi = (pk.x - half) * scale;
      let peakEta = (pk.y - half) * scale;

      // 对称峰（应在 −ξ）
      const mirrorX = M - 1 - pk.x;
      const mirrorV = oArr[pk.y * M + clampI(mirrorX, 0, M - 1)];

      // 0 级峰值
      let dc = 0;
      for (let y = 0; y < M; y++)
        for (let x = 0; x < M; x++) {
          const dx = x - half, dy = y - half;
          if (dx * dx + dy * dy < guard * guard) dc = Math.max(dc, oArr[y * M + x]);
        }

      // 沿 ξ 轴过峰值的剖面
      const prof = new Float32Array(M);
      for (let i = 0; i < M; i++) prof[i] = oArr[pk.y * M + i];
      // 沿 η 轴过峰值的剖面（检查峰的竖直方向是否同样锐利）
      const profEta = new Float32Array(M);
      for (let i = 0; i < M; i++) profEta[i] = oArr[i * M + pk.x];

      // FWHM
      const halfMax = pk.v / 2;
      let l = pk.x, r2 = pk.x;
      while (l > 0 && prof[l] > halfMax) l--;
      while (r2 < M - 1 && prof[r2] > halfMax) r2++;
      const fwhm = (r2 - l) * scale;

      // PSR：峰值 / 旁瓣（环形区域中位/最大值）
      const rIn = Math.max(4, Math.round(2.2 * (r2 - l)));
      let slMax = 0, slSum = 0, slN = 0;
      for (let y = 0; y < M; y++) {
        for (let x = 0; x < M; x++) {
          const dx = x - pk.x, dy = y - pk.y;
          const d = Math.hypot(dx, dy);
          if (d < rIn || d > rIn * 3.2) continue;
          if (Math.abs(x - half) < guard) continue;
          const v = oArr[y * M + x];
          if (v > slMax) slMax = v;
          slSum += v; slN++;
        }
      }
      const slMean = slN ? slSum / slN : 0;
      const psr = slMean > 0 ? pk.v / slMean : 0;
      const psrStrict = slMax > 0 ? pk.v / slMax : 0;

      // 峰分辨力：主峰相对理想位置的偏差
      const theory = this.peakXi;
      const err = Math.abs(Math.abs(peakXi) - theory) / Math.max(1e-12, theory);

      // 相关峰锐度（能量集中）
      let ePeak = 0, eTot = 0;
      for (let y = 0; y < M; y++)
        for (let x = 0; x < M; x++) {
          const v = oArr[y * M + x];
          eTot += v;
          const dx = x - pk.x, dy = y - pk.y;
          if (dx * dx + dy * dy < rIn * rIn * 0.35) ePeak += v;
        }
      const concentration = eTot > 0 ? ePeak / eTot : 0;

      // 条纹对比度：JPS 在 ξ 方向（η=0 行）条纹带内的可见度
      // V = (max−min)/(max+min)；理想平面波照明 ≈1，离焦/偏心/噪声都会拉低它
      // 条纹对比度：在**全分辨率**谱面的 η=0 行上测。
      // 降采样读回（M=N/2）无法表示杨氏条纹（周期 3.2 px @N=1024，
      // 降到 512 后仅 1.6 px，已越过该网格的 Nyquist 极限），故必须用
      // 单行 readPixels 取原始分辨率的一行来测。
      //   V = max(0, rms(条纹带) − rms(参考带)) / mean(行)
      // 条纹带 rr∈[0.45,0.80]；参考带 rr∈[0.86,0.99]（只含噪声本底）。
      // 离焦 → 条纹带被抹平 → V→0；光弱/偏心 → 本底抬升 → V 被扣掉。

      // 一级项 / 零级分离度：2a 与目标尺寸 w 之比（>1 才分离）
      const sepMargin = this.w > 0 ? (2 * this.a) / this.w : 0;

      // 有效相关峰判据：峰要显著高于局部背景、落在理论位置附近、条纹确实
      // 存在。任一不满足 → 这不是「相关」而是噪声伪峰，必须明确报出，
      // 否则会把噪声尖峰显示成一个（看起来还很漂亮的）相关峰。
      const fv = this._fv ? this._fv.vis : 0;
      // 位置判据收紧到 6%：真实相关峰的位置误差只由采样粒度决定（通常 <1%），
      // 而无峰时分析器会找到 guard 边缘或噪声尖峰，位置必然大幅偏离。
      // 峰搜索已限制在理论位置窗口内，psrStrict 只用来排除「窗口内也没峰」；
      // 阈值 2.0 太贴边（80% 光功率时恰好等于 2.00 就被判成无峰），放到 1.5
      const valid = (psrStrict > 1.5) && (err < 0.06) && (fv > 0.15) && ((this._snr || 1e4) > 60);
      // 无有效峰时不要把噪声尖峰当成峰位报出去：光弱 / 未分离时，全局最大值
      // 常常落在边角或旁瓣上（甚至高过零级，物理上不可能）。
      // 这种情况一律回落到理论位置并标 peakValid=false，由界面显示「—」。
      if (!valid) { peakXi = theory; peakEta = 0; }

      return {
        valid,
        peak: pk.v, peakNorm: pk.v * norm,
        peakXi, peakEta, mirrorV, peakValid: valid,
        dc, dcNorm: dc * norm,
        ratio: dc > 0 ? pk.v / dc : 0,
        fwhm, fwhmUm: fwhm * 1e6,
        psr, psrStrict, concentration,
        fringeVis: (this._fv ? this._fv.vis : 0),
        vBand: (this._fv ? this._fv.A : 0), vRef: (this._fv ? this._fv.base : 0),
        sepMargin,
        theory, err,
        profile: prof, profileEta: profEta, scale, guard, half,
        M,
      };
    }
  }

  function maxOf(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
  function sSum(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
  function clampI(v, a, b) { return v < a ? a : v > b ? b : v; }
  function PARAMS_DUMP(j) {
    const p = j.p;
    return {
      lambda: p.lambda, f1: p.f1, f2: p.f2, dx: p.dx, N: p.N,
      L: j.L, a: j.a, w: j.w, dS: j.dS, dO: j.dO,
      fringe: j.fringe, peakXi: j.peakXi,
    };
  }

  /* ═══════════════════════════════════════════════════════════
     光束传播模型（供 3D 光束渲染与物理遥测共用）
     ─────────────────────────────────────────────────────────
     1/q = 1/R − i·λ/(π·w²)。各区段取解析近似：
       · 自由高斯传播：w(z) = √(w₀² + (λ·z/(π·w₀))²)
       · 物镜聚焦针孔：焦斑 w₀ = 0.61·λ/NA'（NA' = NA_obj/M 像方孔径）
         滤波后针孔≈基模点源，远场锥半角 θ = NA'
       · 薄透镜准直：平行光半径 w = f·θ（点源置于前焦面）
       · 硬光阑/透镜框截断：w ← min(w, r_clear)
       · FTL 会聚：锥半角 θ_c = atan(r_eff/f)，焦面受艾里下限
         r_min = 1.22·λ·f/(2·r_eff) 约束，光束不塌缩到 0
       · 4f 读出段：横向缩放 f2/f1
     能量守恒直觉：轴上强度权重 ∝ 通光面积倒数（gain ∝ 1/w²）。
     ═══════════════════════════════════════════════════════════ */
  const CBEAM = {
    // —— 机械几何（m，与 world.js 建模一致）——
    aperture: {
      portX: 0.1185,           // HeNe 出光口
      objFront: -0.030,        // 物镜前焦点（相对 sf 节点）
      objBack: 0.020,          // 物镜后焦点（相对 sf）
      pinhole: 0.0288,         // 针孔平面（相对 sf）
      collimHalf: 0.0115,      // 准直透镜通光半径
      iris1Half: 0.010,        // 光阑①叶片内缘
      iris2Half: 0.010,        // 光阑②
      lens1Half: 0.0115, lens2Half: 0.0115,  // FTL 通光半径
      slmHalf: 0.030,          // SLM 有效区半幅
      sfClear: 0.0075,         // 针孔座通光半径
    },
    NAobj: 0.40, objM: 20,     // ×20 / 0.40 显微物镜
    portW: 0.0016,             // HeNe 原生光束 1/e² 半径（束腰在出光口附近）
  };

  /** 自由高斯传播后的 1/e² 半径 */
  function gW(lam, w0, dz) { return Math.sqrt(w0 * w0 + (lam * dz / (Math.PI * w0)) ** 2); }

  /**
   * 计算全链路光束半径节点。
   * @param jtc  JTC 实例（读 p.lambda/f1/f2/sigma/N/dx）
   * @param pos  当前各元件 x 位置（m）{ laser,iris1,sf,collim,iris2,input,lens1,focal,slm2,lens2,output }
   * @param cfg  CBEAM
   * @returns { nodes:[{x,w}], segs:[{x0,w0,x1,w1,gain}], meta:{…物理量} }
   */
  function beamModel(jtc, pos, cfg) {
    cfg = cfg || CBEAM;
    const p = jtc.p, lam = p.lambda, A = cfg.aperture;
    const st = pos.__state || {};                    // 学生操作注入的真实状态
    const iris2Ap = st.iris2Ap || A.iris2Half;       // 照明光阑实际通光半径
    const out = { nodes: [], meta: {} };
    const push = (x, w) => { if (w > 0 && isFinite(w)) out.nodes.push({ x, w: Math.min(w, 0.05) }); return w; };
    const clampClear = (w, r) => Math.min(w, r);

    /* A) 原生 HeNe：束腰在出光口，w0=1.6mm，发散 θ=λ/(πw0)≈0.13 mrad
       出光口必须跟着激光器走：原来写死世界坐标 0.1185，
       把激光器拖到别处，光束仍从原来的位置射出来（像悬在空中）。 */
    const portX = (pos.laser !== undefined ? pos.laser : -0.02) + (A.portX + 0.02);
    push(portX, cfg.portW);
    const objFrontX = pos.sf + A.objFront;
    const pinX = pos.sf + A.pinhole;
    push(pos.iris1, clampClear(gW(lam, cfg.portW, pos.iris1 - portX), A.iris1Half));
    push(objFrontX, gW(lam, cfg.portW, objFrontX - portX));

    /* B) 物镜聚焦 → 针孔：像方 NA' = NA/M；焦斑 w0=0.61λ/NA' */
    const NAimg = cfg.NAobj / cfg.objM;                 // 0.02
    const w0pin = 0.61 * lam / NAimg;                   // ≈ 19 µm
    const zRpin = Math.PI * w0pin * w0pin / lam;        // ≈ 1.8 mm
    push(pos.sf + A.objBack, w0pin * Math.sqrt(1 + ((A.objBack - A.pinhole) / zRpin) ** 2));
    push(pinX, w0pin);
    out.meta.pinhole = { w0: w0pin, zR: zRpin, phiUm: w0pin * 2e6 };

    /* C) 针孔 → 准直透镜：远场球面波锥 r = NA'·d（z≫zR 高斯一致） */
    const dC = Math.max(1e-4, pos.collim - pinX);
    const wInC = Math.max(NAimg * dC, w0pin);
    push(pos.collim, clampClear(wInC, A.collimHalf));

    /* D) 准直透镜 → 输入面：平行光半径 = min(f_collim·θ, 透镜口径)。
       针孔偏离焦点时残余发散 thetaRes（装调不完美）。 */
    const fCollim = dC;
    const wCollimRaw = NAimg * fCollim;
    const wCollim = clampClear(wCollimRaw, A.collimHalf);
    const thetaRes = 0.0015;   // 残余发散（准直良好时约 1.5 mrad）
    push(pos.collim, wCollim);
    out.meta.collim = { f: fCollim, w: wCollim, clipped: wCollimRaw > A.collimHalf };
    const wAtIris = clampClear(gW(lam, wCollim, pos.iris2 - pos.collim) + thetaRes * (pos.iris2 - pos.collim), iris2Ap);
    push(pos.iris2, wAtIris);

    /* E) 输入面：照明 = 光阑后的实际光束 与 高斯包络 σ·L/2 的交集。
       光阑一收，下游光斑必须跟着变小 —— 否则「拖光阑」在 3D 里看不出任何反应。 */
    const L = p.N * p.dx;
    const wSig = p.sigma * L / 2;
    // 照明光阑之后，输入面的光斑就是「光阑的像」再略微发散。
    // 不能再和 σ·L/2 取 min —— 那个包络就是光束自身宽度，取 min 会把光阑
    // 的作用完全吃掉（光阑从 φ22 收到 φ3，输入面光斑纹丝不动）。
    const wIn = wAtIris + thetaRes * (pos.input - pos.iris2);
    push(pos.input, Math.max(wIn, 0.0015));
    out.meta.illum = { beam: wCollim, sigmaW: wSig, eff: wIn, apHalf: iris2Ap,
      pinFlux: st.pinFlux !== undefined ? st.pinFlux : 1 };

    /* F) 输入面 → L1：高斯衍射发散 θd = λ/(π·w_in)（含目标细节的
       衍射展开用 w_in 的远场角近似） */
    // 照明口径决定整条下游光斑的尺度：光阑收一半，谱面与相关面的光斑也大致收一半。
    // 不乘这个系数的话，只有「光阑→输入面」这一小段会变，整条光路看起来纹丝不动。
    const kIllum = Math.max(0.30, Math.min(1.25, wIn / 0.0034));
    out.meta.kIllum = kIllum;

    const thD = lam / (Math.PI * Math.max(wIn, 1e-4));
    const dIL = Math.max(1e-4, pos.lens1 - pos.input);
    const wAtL1 = gW(lam, wIn, dIL);
    push(pos.lens1, clampClear(wAtL1, A.lens1Half));
    out.meta.thetaD = thD;

    /* G) L1 → 谱面：傅里叶平面光斑 = 扩展目标衍射谱的包络，
       不是单点源的艾里斑。谱填充半径 R_s = 0.45·N·dS（dS = λf1/L）；
       探测器离焦 Δ 时叠加模糊圆 rE1·|Δ|/f1（引导步骤「调焦」的物理响应）。
       艾里斑只是单频分量的最小宽度（下限），不控制包络。 */
    const N = p.N, dS = lam * p.f1 / L;
    const rE1 = Math.max(0.002, Math.min(wAtL1, A.lens1Half));
    const thC1 = Math.atan(rE1 / p.f1);
    const dSF = Math.max(0, pos.focal - pos.lens1);
    const rAiry1 = 1.22 * lam * p.f1 / (2 * rE1);
    const jpsHalf = 0.45 * N * dS;                      // JPS 有效照明半径
    const defocus1 = rE1 * Math.abs(dSF - p.f1) / p.f1; // 离焦模糊圆
    const wSpec = Math.hypot(jpsHalf * kIllum, defocus1);
    push(pos.focal, wSpec);
    out.meta.spec = { rEff: rE1, theta: thC1, airyR: rAiry1, jpsHalf, defocus: defocus1, convDeg: thC1 * 180 / Math.PI };

    /* H) 谱面 → SLM2：电子学读出（非相干传导），SLM2 上回放的 JPS
       按 4f 等比 f2/f1 缩放 */
    const k4 = p.f2 / p.f1;
    const wSlm = clampClear(jpsHalf * k4 * kIllum, A.slmHalf);
    push(pos.slm2, wSlm);

    /* I) SLM2 → L2 → 输出面：第二次 FT。相关斑包络
       R_o = 0.45·N·dO（dO = dx·f2/f1，互相关峰 2a·f2/f1 落于其中），
       输出面离焦同样产生模糊圆 */
    const dO = p.dx * k4;
    const outHalf = 0.45 * N * dO;
    const d2 = Math.max(1e-4, pos.lens2 - pos.slm2);
    const wAtL2 = gW(lam, wSlm, d2);
    const wL2 = clampClear(Math.max(wAtL2, outHalf * 0.55 * kIllum), A.lens2Half);
    push(pos.lens2, wL2);
    const rE2 = Math.max(0.002, wL2);
    const thC2 = Math.atan(rE2 / p.f2);
    const dOut = Math.max(0, pos.output - pos.lens2);
    const rAiry2 = 1.22 * lam * p.f2 / (2 * rE2);
    const defocus2 = rE2 * Math.abs(dOut - p.f2) / p.f2;
    const wOut = Math.hypot(outHalf * kIllum, defocus2);
    push(pos.output, wOut);
    out.meta.out = { rEff: rE2, theta: thC2, airyR: rAiry2, outHalf, defocus: defocus2 };

    /* J) 输出：分段 + 能量守恒权重（∝ 1/w²，归一到输入面，封顶） */
    out.nodes.sort((m, n) => m.x - n.x);
    const coldLo = pos.focal, coldHi = pos.slm2;   // 谱面→SLM2 为电子学读出链路
    const segs = [];
    for (let i = 0; i < out.nodes.length - 1; i++) {
      const a = out.nodes[i], b = out.nodes[i + 1];
      if (b.x - a.x < 1e-4) continue;
      const wm = Math.sqrt(a.w * b.w);
      const mid = (a.x + b.x) / 2;
      segs.push({ x0: a.x, w0: a.w, x1: b.x, w1: b.w, kind: (mid > coldLo && mid < coldHi) ? 'cold' : 'red',
        // 亮度 ∝ 1/w² 会让细腰段亮到削顶、只剩一根白线，粗细反而看不出来。
        // 改成 ∝1/w 并压缩到 0.42…1.55：细处略亮，但不会烧掉光柱的宽度。
        gain: Math.min(1.55, Math.max(0.42, (wIn / wm) * 0.62)) });
    }
    out.segs = segs;
    return out;
  }

  global.JTC = JTC;
  global.JTC_DEFAULTS = DEFAULTS;
  /* 谱面显示的对数底：2D 视图（app.js）直接引用，保证只有一处定义 */
  global.JPS_LOG_FLOOR = JPS_LOG_FLOOR;
  global.BEAM_MODEL = { CBEAM, beamModel, gW };
})(window);
