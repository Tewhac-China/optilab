/* ═══════════════════════════════════════════════════════════
   app.js · 主程序
   装配 / 渲染循环 / 交互 / 引导实验流程
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const VIEW_PRESETS = {
    // bench 的 dist 由 _fitDist 按「整条光路都要进画面」自动求，不再写死
    bench: { yaw: -0.80, pitch: 0.155, dist: 1.30, target: [0.69, 0.005, -0.02], fov: 40, fit: true },
    beam: { yaw: -0.26, pitch: 0.11, dist: 1.60, target: [0.70, 0.00, 0], fov: 27 },
    screen: { yaw: -1.06, pitch: 0.17, dist: 0.34, target: [1.43, 0.00, 0], fov: 38 },
  };

  /** 引导流程每步聚焦的元件（自动演示与手动引导共用） */
  /* ═══════════ 引导流程 ═══════════
     设计原则：每一步都用「实时物理判据」代替文字说明——判据直接取自
     计算结果与几何状态，学生做错时判据立刻变红，并能看到后果。
     步骤之间不阻塞，可任意跳转；右侧「偏差总览」列出全部在跑的问题。 */
  const STEPS = [
    {
      n: '1', i: 0, focus: 'laser',
      title: '光轴与照明基准',
      brief: '激光水平 · 光阑①定标 · 照明均匀',
      body: '调整激光管夹持器使出射光水平；固定光阑①的高度与孔径，使其在近处与远处都能通过。判据：输入面照明均匀、记录信噪比充足。照明不均匀会直接削弱互相关项。',
      check: (a) => {
        const q = a.quality();
        /* 这一步只判「光轴与照明基准」本身：光斑是否落在两个光阑孔内、照明是否均匀、
           光阑是否切到目标。信噪比属于「针孔是否调准」（第 2 步），放在这里会让
           第 1 步永远过不去、而且卡片上没有任何可点的动作 —— 用户会卡死。 */
        const L = a.lab;
        const w1 = L.beamRadiusAt(L.parts.get('iris1').pos[0]);
        const a1 = L.apertureAt(L.parts.get('iris1').pos[0]);
        const w2 = L.beamRadiusAt(L.parts.get('iris2').pos[0]);
        const a2 = L.apertureAt(L.parts.get('iris2').pos[0]);
        const fit = (w, ap) => w === null || ap === null || w < ap * 0.98;
        return [
          { text: `输入面照明均匀度 ${q.illumU.toFixed(2)}（> 0.5）`, hit: q.illumU > 0.5 },
          { text: `光斑通过光阑① ⌀${(w1 * 2e3).toFixed(1)} / 孔 ⌀${(a1 * 2e3).toFixed(1)} mm`, hit: fit(w1, a1) },
          { text: `光斑通过光阑② ⌀${(w2 * 2e3).toFixed(1)} / 孔 ⌀${(a2 * 2e3).toFixed(1)} mm`, hit: fit(w2, a2) },
          { text: `照明口径 φ${(q.apHalf * 2e3).toFixed(1)} mm 未切到目标`, hit: q.blocked < 0.05 },
        ];
      },
    },
    {
      n: '2', i: 1, focus: 'sf', action: 'pin',
      title: '空间滤波：把针孔调准',
      brief: '偏心 < 6 µm · 透过率 ≥ 85 %',
      body: '物镜把激光会聚到 φ19 µm 的焦斑上，针孔必须与焦斑重合。偏心 δ 会让透过率按 exp(−2δ²/w₀²) 骤降，并使通过的光变成偏心球面波——后果是照明偏心、一个目标变暗、记录信噪比下降、相关峰变钝。用「针孔微调」盘（或方向键）把它调到最亮。',
      check: (a) => {
        const g = a._geom || {}, d = Math.abs(g.pinOffset || 0), T = g.pinFlux || 0;
        return [
          { text: `针孔偏心 ${(d * 1e6).toFixed(1)} µm（目标 < 6 µm）`, hit: d < 6e-6 },
          { text: `针孔透过率 ${(T * 100).toFixed(0)} %（目标 ≥ 85 %）`, hit: T > 0.85 },
          { text: `记录信噪比 ≈ ${fmtNum(a.quality().snr)}（> 120）`, hit: a.quality().snr > 120 },
        ];
      },
    },
    {
      n: '3', i: 2, focus: 'collim',
      title: '准直扩束',
      brief: '准直镜位于针孔后 f = 150 mm',
      body: '拖动 3D 中的准直透镜，使其与针孔的距离等于焦距 150 mm。距离不对 → 出射为球面波而非平面波 → 等效于频谱面离焦，杨氏条纹变钝；同时照明口径随之改变。判据：间距误差 < 4 mm 且条纹对比度上升。',
      check: (a) => {
        const p = a.lab.parts.get('collim'), sf = a.lab.parts.get('sf');
        const d = (p.pos[0] - (sf.pos[0] + 0.0288)) * 1e3, err = Math.abs(d - 150);
        const q = a.quality();
        return [
          { text: `针孔 → 准直镜间距 ${d.toFixed(1)} mm（目标 150.0 mm）`, hit: err < 4 },
          { text: `未准直量 δ = ${(q.collimOffset * 1e3).toFixed(1)} mm（< 4 mm）`, hit: Math.abs(q.collimOffset) < 4e-3 },
          // 第三条判「扩束后的光斑够不够盖住目标」，不能再用条纹对比度：
          // 对比度还受 CMOS 是否落在后焦面影响（那是第 6 步），否则这一步永远过不去。
          { text: `扩束后光斑 ⌀${(a.lab.beamRadiusAt(a.lab.parts.get('input').pos[0]) * 2e3).toFixed(1)} mm 覆盖目标（≥ 5.2 mm）`,
            hit: a.lab.beamRadiusAt(a.lab.parts.get('input').pos[0]) * 2 > 0.0052 },
        ];
      },
    },
    {
      n: '4', i: 3, focus: 'pol2',
      title: '偏振片 P1 ⊥ P2',
      brief: '夹角 90° · 振幅调制最深',
      body: '液晶只调制特定偏振分量：P1（起偏器）定出入射偏振方向，P2（检偏器）与 P1 正交时，液晶的偏振调制才被转换成强度调制，条纹对比度最高。转动 P2 能看到条纹逐渐消失——这是判断偏振配置是否正确的直接依据。',
      check: (a) => {
        const g = a._geom || {}, d = g.polDelta === undefined ? 90 : g.polDelta;
        const c = g.polContrast === undefined ? 1 : g.polContrast;
        const q = a.quality();
        return [
          { text: `P1 / P2 夹角 Δ = ${d.toFixed(0)}°（目标 90°）`, hit: d >= 82 },
          { text: `振幅调制系数 sinΔ = ${c.toFixed(2)}（> 0.98）`, hit: c > 0.98 },
          // 同上：对比度受对焦影响，这里改成判「偏振片镜架没有挡住光斑」
          { text: `光斑 ⌀${(a.lab.beamRadiusAt(a.lab.parts.get('pol2').pos[0]) * 2e3).toFixed(1)} mm 通过 P2 镜架（孔 ⌀${(a.lab.apertureAt(a.lab.parts.get('pol2').pos[0]) * 2e3).toFixed(0)} mm）`,
            hit: a.lab.beamRadiusAt(a.lab.parts.get('pol2').pos[0]) < a.lab.apertureAt(a.lab.parts.get('pol2').pos[0]) * 0.98 },
        ];
      },
    },
    {
      n: '5', i: 4, focus: 'input',
      title: '装载目标并限制照明',
      brief: 'w < 2a · 光阑②不切目标',
      body: '在输入面放置待识别目标 f 与参考目标 g，中心分别位于 ∓a。用光阑②把照明限制到刚好覆盖两个目标：关得太小会切掉目标轮廓（一级项失真、通量下降），太大则引入杂散光。判据：w < 2a 使一级项与零级分离，且光阑截断 < 5 %。',
      check: (a) => {
        const j = a.jtc, q = a.quality();
        return [
          { text: `f = ${a.patLabel(j.fName)}；g = ${a.patLabel(j.gName)}`, hit: true },
          { text: `半间距 a = ${(j.a * 1e3).toFixed(2)} mm，目标 w = ${(j.w * 1e3).toFixed(2)} mm`, hit: true },
          { text: `分离度 2a : w = ${q.sepMargin.toFixed(2)} : 1（> 1）`, hit: q.sepMargin > 1 },
          { text: `光阑②截断 ${(q.blocked * 100).toFixed(1)} %（< 5 %）`, hit: q.blocked < 0.05 },
        ];
      },
    },
    {
      n: '6', i: 5, focus: 'focal',
      title: 'CMOS 落在后焦面',
      brief: '调焦至条纹最清晰',
      body: '移动 CMOS，使其靶面精确位于 L₁ 后焦面（距 L₁ 为 f₁）。离焦会使记录到的 JPS 被模糊圆卷积，条纹对比度与相关峰同时劣化——这是本实验最灵敏的对准环节（景深仅 ±1–2 mm）。',
      check: (a) => {
        const d = (a.lab.parts.get('focal').pos[0] - a.lab.parts.get('lens1').pos[0]) * 1e3;
        const q = a.quality(), err = Math.abs(d - a.jtc.p.f1 * 1e3);
        return [
          { text: `L₁ → CMOS 间距 ${d.toFixed(1)} mm（目标 f₁ = ${(a.jtc.p.f1 * 1e3).toFixed(1)} mm）`, hit: err < 2 },
          { text: `离焦模糊圆 ${(q.blurUm).toFixed(0)} µm（< 60 µm）`, hit: q.blurUm < 60 },
          { text: `JPS 条纹对比度 V = ${q.fringeVis.toFixed(2)}（> 0.5）`, hit: q.fringeVis > 0.5 },
        ];
      },
    },
    {
      n: '7', i: 6, focus: 'output',
      title: '读出相关输出',
      brief: '峰位 / PSR / 峰零级比',
      body: '对功率谱再做一次傅里叶变换：中心为 f⋆f 与 g⋆g 叠加的零级，两侧 ξ = ±2a·f₂/f₁ 处为互相关峰。峰的强度与锐度即「是否相关」的判据：完全相同 → 明亮锐峰；部分相似 → 暗而弥散；不同 → 无峰。',
      check: (a) => {
        const r = a.results;
        if (!r) return [{ text: '正在求解…', hit: false }];
        const an = r.analysis;
        return [
          { text: `互相关峰 ξ = ${(an.peakXi * 1e3).toFixed(3)} mm（理论 ${(an.theory * 1e3).toFixed(3)} mm）`, hit: an.err < 0.06 },
          { text: `峰 / 零级比 ${an.ratio.toFixed(2)}（> 0.2）`, hit: an.ratio > 0.2 },
          { text: `峰旁瓣比 PSR ${an.psr.toFixed(1)}（> 30）`, hit: an.psr > 30 },
          { text: `识别判决：${a.verdictText()}`, hit: true },
        ];
      },
    },
  ];
  function fmtNum(v) { return v >= 1000 ? v.toFixed(0) : v.toFixed(0); }

  /* ═══════════ App ═══════════ */
  class App {
    constructor() {
      this.canvas = $('#gl');
      this.steps = STEPS;
      this.mode = 'free';
      this.view = 'bench';
      this.stepIndex = 0;
      this.doneSteps = new Set();
      this.autoRotate = false;
      this.autoCompute = true;
      // 学生操作的真实状态（全部 SI 单位）——这些量直接进入光学计算：
      //   针孔偏心 → 透过率按 exp(−2δ²/w₀²) 下降，并造成照明偏心
      //   照明光阑 → 真的截断输入面（通量下降 + 一级项失真）
      //   准直离焦 → 球面波照明，等效谱面额外离焦
      this.hw = {
        pinU: 0,            // 针孔水平偏心 (m)
        pinV: 0,            // 针孔竖直偏心 (m)
        pinFlux: 1,         // 针孔透过率（相对最佳）
        collimOffset: 0,    // 准直镜离焦量 (m)
        /* 照明光阑通光半径 (m)：默认收到 4.0 mm，正好把 6.3 mm 的照明光柱包住
           （讲义步骤 5「调整光阑大小使激光束完全照射目标且不超出」）。
           默认开到 11 mm 时孔是光束的 3.5 倍，看起来「光柱跟孔完全不搭」。 */
        apIris2: 0.0040,
        power: 1.0,         // 激光功率相对值
        pol1: 0,            // 起偏器 P1 方位角 (deg)
        pol2: 90,           // 检偏器 P2 方位角 (deg) —— 与 P1 正交时对比度最高
      };
      this._irisApApplied = -1;    // -1：首次求解时按 hw.apIris2 重建光阑几何
      this.beamScale = 2;          // 光柱显示加粗倍率（只影响显示）
      /* 显隐开关必须有明确的初值：之前是 undefined，第一次按 B/G 只是把
         undefined 取反成 true，画面毫无变化，要按第二次才生效 —— 典型的「按了没反应」。 */
      this.beamsOn = true;
      this.hoverOn = true;
      this.faults = new Set();      // 已注入的故障 id
      this.visited = new Set();
      this.selected = null;
      this.needSolve = true;
      this.lastSolve = 0;
      this.demoTimer = null;
      this.pointer = { down: false, btn: 0, x: 0, y: 0, dragging: null, moved: 0, hpKey: null };
      this.keys = new Set();
      this.camAnim = null;
    }

    patLabel(id) {
      const p = PATTERNS.LIST.find(x => x.id === id);
      return p ? `${p.label}（${p.group}）` : id;
    }

    partsOffAxis() {
      // 本模型中所有元件默认同轴；返回缺省的偏离列表
      return [];
    }

    /* ───────── 实时物理判据（引导与诊断共用同一套数字） ───────── */
    quality() {
      const q = (this.results && this.results.quality) || {};
      const g = this._geom || {};
      const dz = q.defocus || null;
      const j = this.jtc;
      return {
        fringeVis: q.fringeVis !== undefined ? q.fringeVis : 0,
        sepMargin: q.sepMargin !== undefined ? q.sepMargin : (2 * j.a / Math.max(1e-9, j.w)),
        illumU: q.illumU !== undefined ? q.illumU : 0,
        flux: q.flux !== undefined ? q.flux : 1,
        blocked: q.blocked || 0,
        snr: q.snr !== undefined ? q.snr : 1e4,
        apHalf: g.apHalf !== undefined ? g.apHalf : this.hw.apIris2,
        collimOffset: g.collimOffset || 0,
        pinOffset: g.pinOffset || 0,
        pinFlux: g.pinFlux || 0,
        blurUm: dz ? dz.rb * 1e6 : 0,
      };
    }

    /** 当前所有偏差：把「学生的错误」翻译成「物理后果」 */
    deviations() {
      const q = this.quality(), j = this.jtc, L = this.lab, out = [];
      const P = LAB.LAYOUT;
      const push = (k, txt, sev) => out.push({ k, txt, sev });
      const px = (t) => { const n = L.parts.get(t); return n ? n.pos[0] : P[t]; };

      if (q.pinOffset > 6e-6) push('针孔偏心',
        `偏心 ${(q.pinOffset * 1e6).toFixed(0)} µm → 透过率仅 ${(q.pinFlux * 100).toFixed(0)}%，照明偏心`,
        q.pinOffset > 15e-6 ? 'bad' : 'warn');
      if (Math.abs(q.collimOffset) > 4e-3) push('准直未到位',
        `准直镜偏离焦面 ${(q.collimOffset * 1e3).toFixed(1)} mm → 球面波照明，等效谱面离焦`,
        Math.abs(q.collimOffset) > 12e-3 ? 'bad' : 'warn');
      const dF = px('focal') - (px('lens1') + j.p.f1);
      if (Math.abs(dF) > 2e-3) push('CMOS 离焦',
        `偏离后焦面 ${(dF * 1e3).toFixed(1)} mm → 模糊圆 ${q.blurUm.toFixed(0)} µm，条纹与峰同时变钝`,
        Math.abs(dF) > 10e-3 ? 'bad' : 'warn');
      const dO = px('output') - (px('lens2') + j.p.f2);
      if (Math.abs(dO) > 2e-3) push('输出屏离焦',
        `偏离 L₂ 后焦面 ${(dO * 1e3).toFixed(1)} mm → 观察到的相关斑被模糊`,
        Math.abs(dO) > 10e-3 ? 'bad' : 'warn');
      if (q.sepMargin <= 1.0) push('目标过大 / 间距过小',
        `w = ${(j.w * 1e3).toFixed(2)} mm ≥ 2a = ${(2 * j.a * 1e3).toFixed(2)} mm → 一级项与零级重叠，峰被淹没`, 'bad');
      if (q.blocked > 0.05) push('照明光阑截断',
        `光阑②切掉 ${(q.blocked * 100).toFixed(0)}% 目标能量 → 一级项失真、通量下降`,
        q.blocked > 0.25 ? 'bad' : 'warn');
      if (q.snr < 120) push('记录信噪比不足',
        `信噪比 ≈ ${q.snr.toFixed(0)}（通量 φ = ${(q.flux * 100).toFixed(0)}%）→ 条纹被噪声淹没`,
        q.snr < 30 ? 'bad' : 'warn');
      if (j.fName !== j.gName) push('目标不完全相同',
        `f ≠ g（${j.fName} / ${j.gName}）→ 互相关峰必然变弱，属正常物理现象`, 'ok');
      const an = this.results && this.results.analysis;
      if (an && an.valid === false) {
        // 只列真正不达标的项，避免把"对比度正常"也写进错误原因
        const why = [];
        if (q.snr < 60) why.push(`信噪比过低（${q.snr.toFixed(0)}）`);
        if (an.fringeVis < 0.15) why.push(`条纹对比度不足（${an.fringeVis.toFixed(2)}）`);
        if (an.err > 0.06) why.push(`峰位偏离理论值 ${(an.err * 100).toFixed(0)}%`);
        if (an.psrStrict <= 2.0) why.push(`峰不显著（PSR_strict ${an.psrStrict.toFixed(2)}）`);
        // f ≢ g 本来就没有峰；只有「光路本身不健康」时这条才值得报警
        const healthy = q.snr >= 60 && an.fringeVis >= 0.15 && an.err <= 0.06;
        if (j.fName === j.gName) {
          push('无有效相关峰', (why.length ? why.join('、') : '判据未达标') + ' — 当前读数不可信', 'bad');
        } else if (!healthy) {
          push('无峰，但光路未达标', (why.join('、') || '判据未达标') + ' — 此时的「不相关」结论不可信', 'warn');
        }
      }
      return out;
    }

    verdictText() {
      const r = this.results;
      if (!r) return '—';
      return this.ui._verdict(r, this.jtc).txt;
    }

    /* ───────── 启动 ───────── */
    async boot() {
      const ui = this.ui = new OUI.UI(this);
      try {
        ui.boot(0.05, '初始化 GPU 上下文…');
        await wait(16);

        this.rnd = new RND.Renderer(this.canvas);
        this.rnd.beamScale = this.beamScale;   // 光柱显示倍率
        const c = this.rnd.caps;
        ui.boot(0.22, `GPU：${c.rendererName.slice(0, 58)}`);
        if (!c.colorBufferFloat) {
          ui.toast('未检测到浮点渲染目标扩展，FFT 精度将降级为半浮点', 'warn', 5200);
        }
        await wait(16);

        ui.boot(0.34, '构建光学平台与元件…');
        this.lab = new LAB.Lab(this.rnd);
        await wait(16);

        ui.boot(0.56, '编译 GPU FFT 着色器…');
        this.jtc = new JTC(this.rnd.gl, this.rnd.caps, { N: 1024 });
        this.jtc.setPatterns(PATTERNS.get('guang'), PATTERNS.get('guang'), 'guang', 'guang');
        this.lab.attachBeamSource(() => this.jtc);   // 光束半径链改由物理模型驱动
        this.lab._beamAttenuate = (bs) => {          // 针孔透过率 / 激光功率跨重建保持
          const pinX = this.lab.parts.get('sf').pos[0] + 0.0288;
          const pinT = Math.max(0.03, Math.min(1, this.hw.pinFlux));
          /* 激光功率影响**整条**光路（含针孔之前），针孔只影响它之后。
             之前只乘了针孔透过率，「激光功率衰减到 12%」这个故障在 3D 里
             完全看不出来，只有数字变了。 */
          const powT = Math.max(0.12, Math.min(1, this.hw.power));
          for (const b of bs)
            if (b.userData.gainBase)
              b.material.intensity = b.userData.gainBase * powT * (b.userData.x0 >= pinX ? pinT : 1);
        };
        await wait(16);

        ui.boot(0.72, '装配光场显示链路…');
        this._whiteTex = GLX.tex2D(this.rnd.gl, {
          width: 1, height: 1, format: 'rgba8',
          data: new Uint8Array([255, 255, 255, 255]), filter: 'nearest',
        });
        this._bindScreens();
        this._applyViewPreset('bench', true);
        ui.init();
        ui.markSteps(0, this.doneSteps);
        this.setMode('free');
        await wait(16);

        ui.boot(0.88, '首次求解联合变换相关…');
        this.doSolve();
        await wait(16);
        // 历史基线：此后每次操作都可撤销
        this.history = []; this.hIdx = -1;
        this._pushHistory('init');
        // 恢复上次会话（元件位置 / 硬件参数 / 目标图案 / 视角）
        if (this._loadState()) {
          this._pushHistory('restore');
          setTimeout(() => ui.toast('已恢复上次的实验配置 · 点「重置全部」可回到出厂状态', '', 3600), 1400);
        }

        ui.boot(1.0, '就绪');
        ui.bootDone();                     // 先让 #app 脱离 display:none，布局才有尺寸
        // 首次构建光束模型 → 触发 w(x) 剖面图（此前 _onBeam 还没挂上）
        this.lab.rebuildBeams();
        this._onResize();
        /* 适配必须在拿到真实画布尺寸之后做：启动时 #app 还是 display:none，
           clientWidth = 0，按那时的宽高比反解出来的 dist 会偏得离谱。
           若刚才恢复了上次会话的视角，则不覆盖。 */
        if (!this._restoredView) this._applyViewPreset('bench', true);

        this._bindInput();
        window.addEventListener('resize', () => this._onResize());
        if (window.ResizeObserver) new ResizeObserver(() => this._onResize()).observe($('#stage'));
        // 布局稳定后再校正（字体加载 / 滚动条出现等）
        requestAnimationFrame(() => this._onResize());
        setTimeout(() => this._onResize(), 240);

        this._t0 = performance.now();
        requestAnimationFrame(this._loop = this._loop.bind(this));
        setTimeout(() => ui.toast('提示：点击元件可查看参数，拖动可沿导轨移动', '', 4200), 900);
      } catch (e) {
        console.error(e);
        ui.boot(1, '初始化失败');
        $('#bootLog').innerHTML = '<span style="color:#f87171">' + String(e.message || e) + '</span>';
        throw e;
      }
    }

    _bindScreens() {
      // 光束模型重建后同步刷新 w(x) 剖面图
      this.lab._onBeam = (m) => { try { this.ui.drawBeamChart(m); } catch (e) { /* 首次启动时 UI 未就绪 */ } };
      const L = this.lab;
      L.setField('laser', this._whiteTex, { gain: 0.85, pixelGrid: false });
      if (L.laserGlow) L.laserGlow.material.field = this._whiteTex;
    }

    /* ───────── 求解 ───────── */
    /** 由 3D 元件位置 + 学生的调整动作派生几何状态，注入 JTC */
    _syncGeom() {
      const L = this.lab, j = this.jtc;
      if (!L || !j) return;
      const P = LAB.LAYOUT;
      const px = (t) => { const n = L.parts.get(t); return n ? n.pos[0] : P[t]; };
      const pinX = px('sf') + 0.0288;
      // 谱面探测器离焦量：CMOS 实际位置 − (L₁ + f₁)
      const specDefocus = px('focal') - (px('lens1') + j.p.f1);
      // 输出屏离焦量：output − (L₂ + f₂)
      const outDefocus = px('output') - (px('lens2') + j.p.f2);
      // 准直：实际「针孔 → 准直镜」间距即有效焦距
      const dC = px('collim') - pinX;
      const dCnom = P.collim - (P.sf + 0.0288);
      const illumScale = Math.max(0.35, Math.min(2.2, dC / dCnom));
      const collimOffset = dC - dCnom;              // 未准直量（球面波照明）
      // 透镜处光束半径（会聚锥半角来源），取自光束模型
      const bm = L.beamModel && L.beamModel.meta;
      const lensRadius = (bm && bm.spec && bm.spec.rEff) || 0.011;

      /* 空间滤波器：针孔偏心 δ 的物理后果
         ① 透过率 T/T₀ = exp(−2δ²/w₀²)，w₀ = 0.61λ/NA′（物镜焦斑半径）
         ② 透过光成为偏心球面波 → 经准直后照明横移 θ·L，θ = δ/f_c */
      const NAimg = 0.40 / 20;
      const w0pin = 0.61 * j.p.lambda / NAimg;                 // ≈19.3 µm
      const delta = Math.hypot(this.hw.pinU, this.hw.pinV);
      const eta = delta / w0pin;
      const pinFlux = 0.90 * Math.exp(-2 * eta * eta);         // 设计最佳 90%
      /* 必须写回 hw：3D 光柱在针孔之后的亮度衰减（lab._beamAttenuate）、
         「一键对中」提示、导出记录都读这个值。之前只在 _geom 里算，
         结果是针孔偏到 60 µm、下游光束依然满亮度，只有数字在变。 */
      this.hw.pinFlux = pinFlux;
      const lever = Math.max(0, px('input') - px('collim'));
      const kLever = lever / Math.max(1e-3, dC);
      const illumOffsetZ = this.hw.pinU * kLever;              // 模型 x（水平）
      const illumOffsetY = this.hw.pinV * kLever;              // 模型 y（竖直）

      /* 照明光阑：真实通光半径 → 输入面口径参数（小于目标外缘即切光） */
      const halfL = j.L / 2;
      const apHalf = Math.max(0.0012, Math.min(0.028, this.hw.apIris2));
      const apFac = Math.min(1, apHalf / halfL);
      if (Math.abs(j.p.aperture - apFac) > 1e-4) j.setParams({ aperture: apFac });

      // 总通量 = 针孔透过 × 激光功率 × 光阑截断（截断比例取上一次求解的实测值）
      const prevBlocked = (j.result && j.result.quality) ? j.result.quality.blocked : 0;
      this._prevBlockedUsed = prevBlocked;   // 供 doSolve 判断「通量反馈是否需要再迭代一次」
      /* 偏振片：液晶只调制特定偏振分量，P1/P2 夹角 Δ 决定振幅调制深度。
         Δ = 90°（正交）→ 对比度最高；Δ → 0°（平行）→ 只剩直流，条纹消失。 */
      let dPol = Math.abs((this.hw.pol2 - this.hw.pol1) % 180);
      if (dPol > 90) dPol = 180 - dPol;
      const polC = Math.sin(dPol * Math.PI / 180);
      const polT = 0.60 + 0.40 * polC;
      const flux = Math.max(0.01, pinFlux * this.hw.power * polT * (1 - Math.min(0.95, prevBlocked)));

      // 同步到 3D：光阑几何按孔径重建、针孔按偏心平移（放大显示）
      if (Math.abs(this._irisApApplied - apHalf) > 1e-5) {
        this._irisApApplied = apHalf;
        L.setIrisOpening('iris2', apHalf);
      }
      L.setPinholeOffset(this.hw.pinU, this.hw.pinV);
      /* 偏振片转角也要在求解前对齐：撤销 / 重置 / 故障复原都是直接改 hw，
         不经过 setPolarizer()，3D 里的转动环就会停在旧角度（数字变了、环没转）。 */
      this._polApplied = this._polApplied || {};
      for (const tag of ['pol1', 'pol2']) {
        const a = tag === 'pol1' ? this.hw.pol1 : this.hw.pol2;
        if (this._polApplied[tag] !== a) { this._polApplied[tag] = a; L.setPolarizerAngle(tag, a); }
      }
      L.beamState = { iris2Ap: apHalf, pinFlux };

      j.setGeom({
        specDefocus, outDefocus, collimOffset, fCollim: Math.max(0.02, dC),
        lensRadius, illumScale, pinOffset: delta,
        illumOffsetX: illumOffsetZ, illumOffsetY, flux, apHalf,
        polContrast: polC, polDelta: dPol,
      });
      this._geom = { specDefocus, outDefocus, collimOffset, pinOffset: delta, pinFlux, apHalf, flux,
        polContrast: polC, polDelta: dPol };
    }

    /* ───────── 学生操作：针孔微调 / 照明光阑 ───────── */
    /** 针孔横向微调（u 水平、v 竖直，单位 m）。真实技能：调到透过率最大 */
    setPinhole(u, v, quiet) {
      this.hw.pinU = Math.max(-60e-6, Math.min(60e-6, u));
      this.hw.pinV = Math.max(-60e-6, Math.min(60e-6, v));
      this.requestSolve();
      if (!quiet) this._refreshGuide();
      if (this.ui.syncPinholePad) this.ui.syncPinholePad();
      this._refreshInspect();
      if (!quiet) this._pushHistory('pin');
    }

    nudgePinhole(du, dv) { this.setPinhole(this.hw.pinU + du, this.hw.pinV + dv); }

    /** 旋转偏振片（deg），立即反映到 3D 与物理判据 */
    setPolarizer(tag, deg) {
      deg = ((deg % 180) + 180) % 180;
      if (tag === 'pol1') this.hw.pol1 = deg; else this.hw.pol2 = deg;
      this.lab.setPolarizerAngle(tag, deg);
      if (this.ui.syncPolUI) this.ui.syncPolUI();
      this._refreshInspect();
      this.requestSolve();
      this._refreshGuide();
      this._pushHistory('pol:' + tag);
    }

    setIrisAp(r) {
      this.hw.apIris2 = Math.max(0.0012, Math.min(0.028, r));
      this.requestSolve();
      this._refreshGuide();
      if (this.ui.syncLabControls) this.ui.syncLabControls();
      this._refreshInspect();
      this._pushHistory('irisAp');
    }

    doSolve(preview) {
      if (!this.jtc) return;
      const isPreview = !!preview && !!(this.results && this.results.analysis);
      this._syncGeom();
      /* 只在「光阑口径 / 针孔透过率」变了才重建光束：
         拖动元件时 movePartX 已经即时重建过一次，这里再建一遍等于每帧做两次
         （实测 40 帧里 rebuildBeams 被调了 78 次、w(x) 图重绘 78 次）。 */
      const bs = this.lab.beamState || {};
      const sig = (bs.iris2Ap || 0).toFixed(6) + '|' + (bs.pinFlux || 0).toFixed(4);
      if (this._beamSig !== sig) { this._beamSig = sig; this.lab.rebuildBeams(); }
      const t0 = performance.now();
      let res;
      try {
        res = this.jtc.solve(isPreview);
      } catch (e) {
        console.error('求解失败', e);
        this._solveErr = String((e && e.message) || e) + ' @ ' + String((e && e.stack) || '').split('\n')[1];
        this.ui.toast('求解失败：' + e.message, 'err', 4000);
        return;
      }
      /* 通量用「上一次求解的光阑截断率」反馈：把光阑从 1.3 mm 拉回 4 mm 时，
         第一次求解仍按 67% 截断算通量 → SNR 偏低 → 判决依旧红。
         这里检测到截断率发生实质变化就再迭代一次（最多一次），避免界面停在旧状态。
         预览解只更新贴图、不刷新读数，故不参与这一步。 */
      const nb = (res.quality && res.quality.blocked) || 0;
      if (!isPreview && Math.abs(nb - (this._prevBlockedUsed || 0)) > 0.03 && !this._fluxIter) {
        this._fluxIter = true;
        try {
          this._syncGeom();
          this.lab.rebuildBeams();
          res = this.jtc.solve();
        } catch (e) { /* 保持第一次的结果 */ }
        finally { this._fluxIter = false; }
      }
      this._solveErr = null;
      this.results = res;
      this.lastSolve = performance.now();

      // 绑定到 3D 屏幕与悬浮面板
      const fft = this.jtc.fft;
      const L = this.lab;
      L.setField('input', fft.dispIn.tex, { gain: 1.0, gamma: 1.0 });
      L.setField('slm2', fft.dispJps.tex, { gain: 0.62, gamma: 1.85 });
      L.setField('focal', fft.dispJps.tex, { gain: 0.82, gamma: 1.55 });
      L.setField('output', fft.dispOut.tex, { gain: 0.95, gamma: 1.10 });

      /* 预览解（拖动中）：贴图已经是新的，读数保持上一次完整解。
         这里必须跳过面板刷新 —— 否则「拖动顺滑」会被每帧几百次 DOM 写入抵消。 */
      if (isPreview) {
        this._solveMs = performance.now() - t0;
        this._refreshGuide();
        return;
      }

      // 面板
      this.ui.renderMetrics(res, this.jtc);
      this.ui.renderDiag(this.jtc.diagnose());
      if (this.ui.syncLabControls) this.ui.syncLabControls();
      this.redrawField();
      this.ui.setChain(4, [
        'h(x,y)', '|FT|²', 'S(u,v)', 'FT{S}',
        `ξ=${(res.analysis.peakXi * 1e3).toFixed(2)}mm`,
        res.analysis.psr > 8 ? '相关' : '不相关',
      ]);
      this._solveMs = performance.now() - t0;
      this._refreshGuide();
    }

    requestSolve() {
      this.needSolve = true;
    }

    solve(manual) {
      this.needSolve = false;
      this.doSolve();
      if (manual) this.ui.toast(`求解完成 · ${this._solveMs.toFixed(0)} ms · N=${this.jtc.p.N}`, 'ok');
    }

    /* ───────── 参数 ───────── */
    setParam(key, v) {
      this.jtc.setParams({ [key]: v });
      if (key === 'N') this.ui.syncControls();
      if (key === 'jpsMode' && this.ui.refreshCtrlVisibility) this.ui.refreshCtrlVisibility();
      // 光学参数直接决定光束半径链（λ/σ/f/N/dx），需重建 3D 光束
      if (['lambda', 'f1', 'f2', 'dx', 'N', 'sigma', 'aperture'].includes(key)) this.lab.rebuildBeams();
      // 焦距改变时，探测器/输出屏自动跟随新后焦面——否则改焦距即意味着
      // 系统深度离焦（条纹尽失、峰坍缩），学生难以把参数与现象关联起来。
      // 引导步骤 6 仍可通过手动拖动 CMOS 练习调焦。
      if (key === 'f1') {
        const l1 = this.lab.parts.get('lens1');
        this._placePart('focal', l1.pos[0] + v);
      } else if (key === 'f2') {
        const l2 = this.lab.parts.get('lens2');
        this._placePart('output', l2.pos[0] + v);
      }
      this.requestSolve();
      this._updateHudStatic();
      this._pushHistory('param:' + key);
    }

    resetParams() {
      this.jtc.setParams(Object.assign({}, JTC_DEFAULTS));
      this.ui.syncControls();
      this.lab.resetLayout();            // 元件位置一并复位（含焦面跟随）
      this.lab.rebuildBeams();
      this.requestSolve();
      this._pushHistory('resetParams');
      this.ui.toast('光学参数与元件布局已重置为默认值');
    }

    setPattern(slot, id) {
      const f = PATTERNS.get(id);
      /* PATTERNS.get 对未知 id 会回退到「光」，但名字照样写成未知 id ——
         名字与图案场就会脱钩：判决按名字说「两目标不同」，画面却是两个「光」。
         这里直接拒绝，宁可不动也不能让名字和场不一致。 */
      if (!f || !PATTERNS.LIST.some(p => p.id === id)) {
        this.ui.toast('未知的目标图案：' + id, 'warn', 2200);
        return;
      }
      if (slot === 'f') this.jtc.setPatterns(f, this.jtc.gField, id, this.jtc.gName);
      else this.jtc.setPatterns(this.jtc.fField, f, this.jtc.fName, id);
      this.requestSolve();
      // 两个槽位用不同的 key：换 f 紧接着换 g 时不会被合并成一步（撤销要能分开回退）
      this._pushHistory('pattern:' + slot);
    }

    swapPatterns() {
      const j = this.jtc;
      j.setPatterns(j.gField, j.fField, j.gName, j.fName);
      this.ui.updatePatternMarks();
      this.requestSolve();
      this._pushHistory('patternSwap');     // 互换也必须可撤销
      this.ui.toast('已互换 f 与 g');
    }

    randomPatterns() {
      const list = PATTERNS.LIST.filter(p => p.group !== '汉字' || true);
      const rf = list[Math.floor(Math.random() * list.length)];
      const sameChance = Math.random();
      let rg;
      if (sameChance < 0.4) rg = rf;
      else if (sameChance < 0.7) {
        // 同源近似：优先找同组或同族图案
        const kin = list.filter(p => p.group === rf.group && p.id !== rf.id);
        rg = kin.length ? kin[Math.floor(Math.random() * kin.length)] : list[Math.floor(Math.random() * list.length)];
      } else rg = list[Math.floor(Math.random() * list.length)];
      this.jtc.setPatterns(PATTERNS.get(rf.id), PATTERNS.get(rg.id), rf.id, rg.id);
      this.ui.updatePatternMarks();
      this.requestSolve();
      this._pushHistory('patternRandom');
      this.ui.toast(`随机目标：f = ${rf.label} ，g = ${rg.label}${rf.id === rg.id ? '（完全相同）' : ''}`);
    }

    /* ───────── 模式 ───────── */
    setMode(m) {
      this.mode = m;
      document.querySelectorAll('#modeSwitch button').forEach(b =>
        b.classList.toggle('on', b.dataset.mode === m));
      const guide = m === 'guide';
      $('#guideCard').classList.toggle('hidden', !guide);
      /* 引导模式里「典型错误」收起：当前步骤会展开说明，7 步要占 232 px，
         收起后流程列表才不会被挤出一条滚动条。低高度屏同样收起。 */
      if (this.ui._setFaultsFolded) this.ui._setFaultsFolded(guide || window.innerHeight <= 840);
      if (guide) {
        // 首次进入引导：把光路退回「刚搭好、还没调」的状态，
        // 否则出厂态本来就是对准的，8 步判据一进来全绿，引导就没有意义了
        if (!this._guidePrimed) {
          this._guidePrimed = true;
          const L = LAB.LAYOUT;
          this.lab.movePartX('collim', L.collim + 0.018);
          this.lab.movePartX('focal', L.focal + 0.009);
          this.hw.pinU = 12e-6; this.hw.pinV = -7e-6;
          if (this.ui.syncLabControls) this.ui.syncLabControls();
          this.requestSolve();
          this.ui.toast('已把光路恢复为未对准状态：请按步骤把针孔 / 准直 / CMOS 调回来', '', 4600);
        }
        this.gotoStep(this._guideStep !== undefined ? this._guideStep : 0);
      } else {
        this.ui.markSteps(-1, this.doneSteps);
      }
    }

    setView(v) {
      this.view = v;
      document.querySelectorAll('#viewSwitch button').forEach(b =>
        b.classList.toggle('on', b.dataset.view === v));
      this._applyViewPreset(v, false);
    }

    viewAction(a) {
      if (a === 'reset') { this._applyViewPreset(this.view, false); }
      else if (a === 'top') { this._animateCam({ yaw: -1.5708, pitch: 1.28, dist: 1.5, target: [0.70, 0, 0], fov: 34 }); }
      else if (a === 'side') { this._animateCam({ yaw: -1.5708, pitch: 0.06, dist: 1.72, target: [0.70, 0, 0], fov: 26 }); }
      else if (a === 'fit') {
        // 适配 = 保持当前角度，把整条光路刚好装进画面并居中
        const c = this.rnd.camera;
        const save = { dist: c.dist, target: c.target.slice() };
        c.target = [0.69, 0.005, -0.02]; c.dist = 1.30;
        const d = this._fitDist(0.90);
        const t = c.target.slice();
        c.dist = save.dist; c.target = save.target;
        this.rnd.updateCamera();
        this._animateCam({ dist: d, target: t });
      }
      else if (a === 'beamscale') {
        // 真实光斑只有 6–9 mm，看全台面时不到 3 px，所以默认按 ×2 画（仅显示，不影响物理）
        const seq = [1, 2, 3];
        const cur = this.beamScale || 2;
        this.beamScale = seq[(seq.indexOf(cur) + 1) % seq.length];
        this.rnd.beamScale = this.beamScale;
        const btn = document.querySelector('[data-act=beamscale]');
        if (btn) {
          btn.textContent = '光柱 ×' + this.beamScale;
          btn.classList.toggle('on', this.beamScale > 1);
        }
        this.ui.toast(this.beamScale === 1 ? '光柱按真实束径显示（可能只有两三个像素）'
          : `光柱加粗 ×${this.beamScale} 显示（真实 ⌀ 见悬停提示与 w(x) 曲线）`, '', 2200);
      }
      else if (a === 'beams') {
        this.setBeams(!this.beamsOn);
      }
      else if (a === 'beamsection') {
        const on = !(this.lab.sectionsOn !== false);
        this.lab.setBeamSections(on);
        const btn = document.querySelector('[data-act=beamsection]');
        if (btn) btn.classList.toggle('on', on);
        this.ui.toast(on ? '已显示各平面光斑截面（半径 = 1/e²）' : '已隐藏光斑截面', '', 1600);
      }
    }

    /** 选中器件的检视面板刷新（拖动 / 转偏振片 / 调光阑 / 微调针孔后调用） */
    _refreshInspect() {
      const n = this.selected;
      if (!n || !n.tag) return;
      const info = this.lab.info.get(n.tag);
      if (info) this.ui.showInspect(n, info);
    }

    /** 光束显隐（工具条按钮与 B 键共用同一个入口，状态始终一致） */
    setBeams(on) {
      this.beamsOn = !!on;
      this.lab.setBeamsVisible(this.beamsOn);
      const b = document.querySelector('[data-act=beams]');
      if (b) b.classList.toggle('on', this.beamsOn);
      this.ui.toast(this.beamsOn ? '已显示光束' : '已隐藏光束（按 B 恢复）', '', 1300);
      this._autoSave();
    }

    focusPart(tag) {
      const p = this.lab.parts.get(tag);
      if (!p) return;
      this._viewAuto = false;
      this.select(p);
      this._animateCam({ target: [p.pos[0], 0, 0], dist: Math.min(this.rnd.camera.dist, 0.5) });
    }

    _applyViewPreset(name, instant) {
      const v = VIEW_PRESETS[name];
      if (!v) return;
      this._viewAuto = true;                 // 预设机位：窗口比例变化时自动重新适配
      const c = this.rnd.camera;
      if (instant) {
        c.yaw = v.yaw; c.pitch = v.pitch; c.target = v.target.slice();
        c.fov = v.fov * Math.PI / 180; c.dist = v.dist;
        if (v.fit) this._fitDist(0.90);
        this.rnd.updateCamera();
      } else {
        // 先按目标机位试算 fit 距离，再把相机恢复原状做补间
        const save = { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: c.target.slice(), fov: c.fov };
        c.yaw = v.yaw; c.pitch = v.pitch; c.target = v.target.slice();
        c.fov = v.fov * Math.PI / 180; c.dist = v.dist;
        if (v.fit) this._fitDist(0.90);
        const dFit = c.dist, tFit = c.target.slice();
        c.yaw = save.yaw; c.pitch = save.pitch; c.dist = save.dist;
        c.target = save.target; c.fov = save.fov;
        this.rnd.updateCamera();
        this._animateCam(Object.assign({}, v, { dist: dFit, target: tFit }));
      }
    }

    /* 让整条光路（含激光器与输出屏）都进画面，并把它**摆到画面正中**。
       只调 dist 是不够的：透视下靠相机近的一端会被放大，投影包围盒整体偏左，
       于是「全部装下」需要把相机退得很远，台面缩成一小条、右下角留一大片空地板。
       这里交替做两件事 —— 按包围盒调 dist、按包围盒中心平移 target —— 两轮就收敛。 */
    _fitDist(margin) {
      const c = this.rnd.camera;
      if (!this.lab) return c.dist;
      const xs = [-0.16, 0.10, 0.36, 0.62, 0.88, 1.14, 1.40, 1.50];
      const ys = [-0.120, 0.070], zs = [0];
      const p = new Float32Array(3);
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
      const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
      const right = [cy, 0, -sy];                 // 相机右向量（世界）
      const up = [-sy * sp, cp, -cy * sp];        // 相机上向量
      let d = c.dist || 1.2;
      for (let it = 0; it < 5; it++) {
        c.dist = d;
        this.rnd.updateCamera();
        let mx = 0, cx = 0, cyy = 0, n = 0;
        let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
        for (const x of xs) for (const y of ys) for (const z of zs) {
          M4.transformPoint(p, c.vp, [x, y, z]);
          if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
          if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
          mx = Math.max(mx, Math.abs(p[0]), Math.abs(p[1]));
          cx += p[0]; cyy += p[1]; n++;
        }
        if (!isFinite(mx) || mx < 1e-6) break;
        // 1) 先把包围盒中心挪到画面中心（相机右移 → 画面内容左移，故取正号）
        const hw = Math.tan(c.fov / 2) * d * (this.rnd.width / Math.max(1, this.rnd.height));
        const hh = Math.tan(c.fov / 2) * d;
        const shiftX = Math.max(-1.2, Math.min(1.2, ((mnx + mxx) / 2) * hw));
        const shiftY = Math.max(-0.6, Math.min(0.6, ((mny + mxy) / 2) * hh));
        for (let k = 0; k < 3; k++) {
          c.target[k] += right[k] * shiftX + up[k] * shiftY;
        }
        // 2) 再按最大偏移调距离
        const k = mx / margin;
        d = Math.max(0.2, Math.min(9, d * (k > 1.02 || k < 0.98 ? k : 1)));
        if (Math.abs(k - 1) < 0.02 && Math.abs(shiftX) + Math.abs(shiftY) < 0.004) break;
      }
      c.dist = d;
      this.rnd.updateCamera();
      return d;
    }

    _animateCam(v) {
      const c = this.rnd.camera;
      // 取最短弧：yaw 相差超过 π 时改走另一侧，避免镜头绕一整圈
      let yawTo = v.yaw !== undefined ? v.yaw : c.yaw;
      let d = yawTo - c.yaw;
      if (d > Math.PI) yawTo -= Math.PI * 2;
      else if (d < -Math.PI) yawTo += Math.PI * 2;
      this.camAnim = {
        t0: performance.now(), dur: 620,
        from: { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: c.target.slice(), fov: c.fov },
        to: {
          yaw: yawTo,
          pitch: v.pitch !== undefined ? v.pitch : c.pitch,
          dist: v.dist !== undefined ? v.dist : c.dist,
          target: (v.target || c.target).slice(),
          fov: v.fov !== undefined ? v.fov * Math.PI / 180 : c.fov,
        },
      };
    }

    select(node) {
      this.selected = node;
      /* 重新选器件时清掉「用户关过检视面板」的标记：
         否则关过一次之后，点任何器件都不会再弹出参数面板。 */
      if (node && this.ui) this.ui._insClosed = false;
      const info = node ? this.lab.info.get(node.tag) : null;
      this.ui.showInspect(info ? node : null, info || { label: '', spec: '', idx: '' });
      this.lab.showSelection(node);
      if (node) {
        this.visited.add(node.tag);
        this._refreshGuide();
      }
      this.ui.markPart(node ? node.tag : null);
    }

    /* ───────── 引导 ───────── */
    gotoStep(i, focus) {
      const n = this.steps = STEPS;
      this.stepIndex = Math.max(0, Math.min(n.length - 1, i));
      this._guideStep = this.stepIndex;      // 记住进度：切到自由探索再回来不会回到第 1 步
      // 从自由模式切进来时交给 setMode 统一处理（它会用 _guideStep 回到当前步），
      // 这里直接返回，避免相机动画被安排两次
      if (this.mode !== 'guide') { this.setMode('guide'); return; }
      this._refreshGuide();
      if (focus !== false) {
        const tag = STEPS[this.stepIndex].focus;
        const p = tag && this.lab.parts.get(tag);
        /* 目标点略低于光轴 + 稍微退远：器件落在画面上半部，
           底部引导卡（约 215 px 高）就不会压住它。 */
        if (p) this._animateCam({ target: [p.pos[0], -0.045, 0], dist: 0.86, pitch: 0.24, yaw: -0.95 });
      }
    }

    _refreshGuide() {
      if (this.mode !== 'guide') return;
      const st = STEPS[this.stepIndex];
      let marks = [];
      try { marks = st.check(this) || []; } catch (e) { marks = []; }
      if (marks.length && marks.every(m => m.hit)) this.doneSteps.add(this.stepIndex);
      // 判据 + 偏差总览一起送进引导卡：学生做错时立刻看到「哪不对、后果是什么」
      this.ui.setGuide(st, marks, this.deviations());
      this.ui.markSteps(this.stepIndex, this.doneSteps);
    }

    /* ───────── 交互 ───────── */
    /** 当前最上层可见弹窗（帮助 / 图案 / 全屏光场），没有则返回 null */
    _topModal() {
      for (const id of ['fieldFull', 'patModal', 'helpModal']) {
        const el = $('#' + id);
        if (el && !el.classList.contains('hidden')) return el;
      }
      return null;
    }

    _bindInput() {
      const cv = this.canvas;
      const P = this.pointer;

      cv.addEventListener('contextmenu', e => e.preventDefault());

      cv.addEventListener('pointerdown', (e) => {
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件 / 部分浏览器会抛 */ }
        P.down = true; P.btn = e.button; P.x = e.clientX; P.y = e.clientY; P.moved = 0;
        /* 3D 悬浮光场屏：点它就开大图，不选中 / 不拖动它后面的器件 */
        const scr = e.button === 0 ? this.rnd.pickScreens(e.offsetX, e.offsetY) : null;
        P.hpKey = scr ? scr.userData.hpKey : null;
        const hit = P.hpKey ? null : this.rnd.pickSoft(e.offsetX, e.offsetY);
        P.hit = hit;
        P.dragging = (e.button === 0 && hit && !e.shiftKey) ? hit : null;
        /* 记录抓取点：拖动用「相对抓取点的总位移」而不是逐帧增量。
           用增量时，一旦顶到邻居被夹住，位移就丢了；手往回移时元件会突然
           跳到指针前面（脱手）。改成绝对量后，元件始终贴着指针，夹住后
           往回移也是立刻跟着回来。 */
        P.grab = P.dragging ? { x: e.clientX, y: e.clientY, partX: hit.pos[0] } : null;
        /* 一按下就收起悬停提示：拖动过程中指针在动但不会再走 hover 分支，
           提示会僵在原地显示旧位置（实测拖到 245 mm 还写着 438.8 mm）。 */
        this._hoverTip(null);
        if (P.dragging) this.select(hit);
      });

      cv.addEventListener('pointermove', (e) => {
        const dx = e.clientX - P.x, dy = e.clientY - P.y;
        P.x = e.clientX; P.y = e.clientY;
        if (!P.down) {
          /* 悬浮屏在器件之前：指针落在屏上时给「放大镜」光标，
             否则会显示背后器件的「抓手」，让人以为点下去是拖器件。 */
          const scr = this.rnd.pickScreens(e.offsetX, e.offsetY);
          if (scr) {
            cv.style.cursor = 'zoom-in';
            this._hoverTipScreen(scr.userData.hpKey, e.offsetX, e.offsetY);
            return;
          }
          const h = this.rnd.pickSoft(e.offsetX, e.offsetY);
          cv.style.cursor = h ? 'grab' : 'default';
          this._hoverTip(h, e.offsetX, e.offsetY);
          return;
        }
        P.moved += Math.abs(dx) + Math.abs(dy);
        if (P.dragging && P.moved > 3) {
          cv.style.cursor = 'grabbing';
          this._interacting = true;        // 交互中：允许自适应分辨率再降一档保跟手
          this._dragPart(P.dragging, e.clientX - (P.grab ? P.grab.x : P.x), e.clientY - (P.grab ? P.grab.y : P.y));
        } else if (P.btn === 2 || e.shiftKey) {
          this._viewAuto = false;
          this.rnd.pan(dx, dy, cv.clientHeight);
        } else {
          this._viewAuto = false;
          this.rnd.orbit(dx, dy);
        }
      });

      const up = (e) => {
        /* 悬浮屏上的「单击」（没有拖动）→ 打开对应光场大图。
           拖一下就变成绕轨，所以用 4 px 阈值区分，避免手抖误触。 */
        const clickScreen = P.hpKey && P.moved <= 4;
        const hpKey = P.hpKey;
        P.hpKey = null;
        if (P.dragging && P.moved > 3) {
          this.ui.toast(`${this.lab.info.get(P.dragging.tag).label} → ${(P.dragging.pos[0] * 1e3).toFixed(1)} mm`, '', 1400);
          this._pushHistory('drag:' + P.dragging.tag);
        } else if (P.moved > 3) {
          this._autoSave();                    // 视角也记住
        }
        P.down = false; P.dragging = null; P.moved = 0; P.grab = null;
        cv.style.cursor = 'default';
        this._blockTip(null);              // 松手清掉「顶住」提示与琥珀色选中框
        this._interacting = false; this._qt = 0;   // 松手后让分辨率立刻回到常态
        // 松手后补一次完整求解：预览解只更新贴图，判据与读数必须落到真实值
        if (this._dragPreview) { this._dragPreview = false; this.requestSolve(); }
        if (clickScreen) { this._hoverTip(null); this.openFieldFull(hpKey); }
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      /* 滑块 / 针孔盘的拖拽在 canvas 之外结束，这里统一收尾：
         预览解 → 松手补一次完整求解（否则面板读数会停在拖动前） */
      window.addEventListener('pointerup', () => {
        if (this._dragPreview) { this._dragPreview = false; this.requestSolve(); }
        if (this._interacting) { this._interacting = false; this._qt = 0; }
      });

      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        this._viewAuto = false;
        this.rnd.zoom(1 + Math.sign(e.deltaY) * 0.09);
      }, { passive: false });

      // 双击元件 → 聚焦（相机推进到该器件）
      cv.addEventListener('dblclick', (e) => {
        const hit = this.rnd.pickSoft(e.offsetX, e.offsetY);
        if (!hit) return;
        this.select(hit);
        this._animateCam({
          target: [hit.pos[0], 0, 0],
          dist: 0.30, fov: 34,
        }, 620);
      });

      cv.addEventListener('pointerleave', () => {
        const el = $('#hoverTip'); if (el) el.classList.remove('on');
        this._hoverTag = null;
        cv.style.cursor = 'default';
      });

      window.addEventListener('keydown', (e) => {
        // 只在「真的在输入文字」时拦截；复选框/单选框聚焦后仍应能用快捷键
        const tg = e.target;
        if (tg && (tg.tagName === 'TEXTAREA' ||
          (tg.tagName === 'INPUT' && /^(text|number|search|email|password)$/i.test(tg.type)))) return;
        const k = e.key.toLowerCase();

        // 弹窗打开时：只允许 Esc 关最上层，其余快捷键一律不穿透
        const modalTop = this._topModal();
        if (modalTop) {
          // 大图里 Ctrl+C = 复制当前图像（与「复制」按钮同一入口）
          if (modalTop.id === 'fieldFull' && (e.ctrlKey || e.metaKey) && k === 'c') {
            e.preventDefault();
            this._ffCopy();
            return;
          }
          // 弹窗里只允许「关自己」的键：Esc 一律关，F 关全屏光场，? 关帮助
          const closeKey = k === 'escape' ||
            (k === 'f' && modalTop.id === 'fieldFull') ||
            ((k === '?' || k === '/') && modalTop.id === 'helpModal');
          if (closeKey) {
            e.preventDefault();
            if (modalTop.id === 'fieldFull') this.closeFieldFull();
            else modalTop.classList.add('hidden');
          }
          return;
        }
        this.keys.add(k);
        // ←→↑↓ 微调针孔（1 µm），这是空间滤波器对准的真实操作
        if (k.startsWith('arrow')) {
          const st = e.shiftKey ? 5e-6 : 1e-6;
          if (k === 'arrowleft') this.nudgePinhole(-st, 0);
          else if (k === 'arrowright') this.nudgePinhole(st, 0);
          else if (k === 'arrowup') this.nudgePinhole(0, st);
          else if (k === 'arrowdown') this.nudgePinhole(0, -st);
          e.preventDefault();
          return;
        }
        if (k === 'r') { this._applyViewPreset(this.view, false); }
        if (k === '1') this.setView('bench');
        if (k === '2') this.setView('beam');
        if (k === '3') this.setView('screen');
        if (k === 'b') { this.setBeams(!this.beamsOn); }
        if (k === 'g') {
          this.hoverOn = !(this.hoverOn !== false);
          this.lab.setHoverVisible(this.hoverOn);
          this.ui.toast(this.hoverOn ? '已显示悬浮光场面板' : '已隐藏悬浮光场面板（按 G 恢复）', '', 1300);
        }
        if (k === 'h') { this.hoverOn = false; this.lab.setHoverVisible(false); }
        if (k === 'escape') { this.select(null); }
        if (k === 'enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.solve(true); }
        if (k === ' ') { e.preventDefault(); this.autoRotate = !this.autoRotate; document.querySelector('[data-act=autorotate]').classList.toggle('on', this.autoRotate); }
        // ── 撤销 / 重做 ──
        if ((e.ctrlKey || e.metaKey) && k === 'z') {
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); this.redo(); return; }
        // ── 导出 / 截图 / 帮助 ──
        if (k === 'p') { e.preventDefault(); this.saveScreenshot(); return; }
        if (k === 'e' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.exportRecord(); return; }
        if (k === 'f' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this._ffOpen ? this.closeFieldFull() : this.openFieldFull(); return; }
        if (k === '?' || k === '/') { e.preventDefault(); $('#helpModal').classList.toggle('hidden'); return; }
        // ── Tab 循环选中元件 ──
        if (k === 'tab') {
          e.preventDefault();
          const order = this.lab.order || [];
          if (!order.length) return;
          const cur = this.selected ? order.indexOf(this.selected.tag) : -1;
          const nx = order[(cur + (e.shiftKey ? order.length - 1 : 1)) % order.length];
          const n = this.lab.parts.get(nx);
          if (n) this.focusPart(nx);
          return;
        }
        // ── Delete / Backspace 把选中元件放回理论位置 ──
        if (k === 'delete' || k === 'backspace') {
          if (!this.selected) return;
          e.preventDefault();
          const th = this._theoryX(this.selected.tag);
          if (th !== null) {
            this.lab.movePartX(this.selected.tag, th);
            this.lab.showSelection(this.selected);
            this.requestSolve();
            this._pushHistory('reset:' + this.selected.tag);
            this.ui.toast(`${this.lab.info.get(this.selected.tag).label} 已复位到理论位置`, 'ok', 1600);
          }
          return;
        }
      });
      window.addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));

      $('#gcAct') && $('#gcAct').addEventListener('click', () => this.stepAction());
    }

    /** 悬停提示：显示元件名与当前位置，双击可聚焦 */
    _hoverTip(node, x, y) {
      const el = $('#hoverTip');
      if (!el) return;
      if (!node) { el.classList.remove('on'); this._hoverTag = null; return; }
      const info = this.lab.info.get(node.tag);
      if (!info) { el.classList.remove('on'); return; }
      const w = this.lab.beamRadiusAt ? this.lab.beamRadiusAt(node.pos[0]) : null;
      const ap = this.lab.apertureAt ? this.lab.apertureAt(node.pos[0]) : null;
      let sub = `${(node.pos[0] * 1e3).toFixed(1)} mm`;
      if (w) {
        sub += ` · 光斑 ⌀${(w * 2e3).toFixed(2)} mm`;
        // 光斑顶到孔径时直接标出来：这是「光束与开孔匹配」最直接的读数
        if (ap && w > ap * 0.94) sub += ` ⚠ 已被 ⌀${(ap * 2e3).toFixed(1)} 孔径截断`;
        else if (ap) sub += ` / 孔 ⌀${(ap * 2e3).toFixed(1)} mm`;
      }
      sub += ' · 双击聚焦';
      if (this._hoverTag !== node.tag) {
        this._hoverTag = node.tag;
        el.innerHTML = `<b>${info.label}</b><i>${sub}</i>`;
      } else {
        const i = el.querySelector('i');
        if (i) i.textContent = sub;
      }
      this._placeTip(el, x, y);
      el.classList.add('on');
    }

    /** 悬浮光场屏的悬停提示：告诉用户「这块屏可以点开」。
        屏体本身被 pick() 跳过，如果不给提示，用户会以为它只是装饰。 */
    _hoverTipScreen(key, x, y) {
      const el = $('#hoverTip');
      if (!el) return;
      const T = {
        input: ['输入面 h(x,y)', '点击看大图 · 当前目标图案'],
        jps: ['联合功率谱 |FT{h}|²', '点击看大图 · 条纹与谱面细节'],
        output: ['相关面 |o(ξ,η)|²', '点击看大图 · 相关峰与旁瓣'],
      };
      const t = T[key] || [key, '点击看大图'];
      const id = 'hp:' + key;
      if (this._hoverTag !== id) {
        this._hoverTag = id;
        el.innerHTML = `<b>${t[0]}</b><i>${t[1]}</i>`;
      }
      this._placeTip(el, x, y);
      el.classList.add('on');
    }

    /** 提示框定位：默认在指针右下方；贴近右/下/上边缘时翻到另一侧并夹在舞台内。
        原来固定 translate(12px,-50%)，右侧器件（L₁ / CMOS / SLM₂ / 输出屏）的提示
        有 5 件会伸出舞台被 overflow:hidden 裁掉，末尾「孔 ⌀xx mm · 双击聚焦」直接丢失。 */    _placeTip(el, x, y) {
      const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
      const w = el.offsetWidth || 180, h = el.offsetHeight || 40;
      let left = x + 14;
      if (left + w > W - 6) left = x - 14 - w;          // 右边放不下 → 翻到左侧
      left = Math.max(6, Math.min(W - w - 6, left));
      let top = y - h / 2;
      top = Math.max(6, Math.min(H - h - 6, top));      // 上下夹住，别贴边裁切
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    /** 世界坐标 → 画布内像素（左上角为原点）；在相机背后时返回 null */
    _projectToCanvas(world) {
      try {
        const c = this.rnd.camera;
        this.rnd.updateCamera();
        const vp = M4.mul(M4.create(), c.proj, c.view);
        const q = M4.transformPoint(new Float32Array(3), vp, world);
        if (q[2] < -1 || q[2] > 1) return null;
        return [(q[0] * 0.5 + 0.5) * this.canvas.clientWidth, (-q[1] * 0.5 + 0.5) * this.canvas.clientHeight];
      } catch (e) { return null; }
    }

    /** 世界 +X 轴在屏幕上的 NDC 方向（含每米幅度），拖拽跟随指针的关键 */
    _screenAxisX(worldPos) {
      try {
        const c = this.rnd.camera;
        this.rnd.updateCamera();               // 确保矩阵与当前相机参数同步（首帧前也正确）
        const vp = M4.mul(M4.create(), c.proj, c.view);
        const a = M4.transformPoint(new Float32Array(3), vp, [worldPos[0], worldPos[1], worldPos[2]]);
        const b = M4.transformPoint(new Float32Array(3), vp, [worldPos[0] + 0.01, worldPos[1], worldPos[2]]);
        return [b[0] - a[0], b[1] - a[1]];      // Δndc / 0.01 m
      } catch (e) { return null; }
    }

    /** 器件本体沿光轴的左右伸出量（m，相对器件中心）。
        左右通常不对称（镜架 +x 侧多出压圈、-x 侧是支臂），
        只用一个「半宽」去夹邻居会让实际间隙在 0–8 mm 之间飘。 */
    _partExt(tag) {
      this._ext = this._ext || {};
      if (this._ext[tag]) return this._ext[tag];
      const root = this.lab.parts.get(tag);
      const axisY = (window.CFG && CFG.AXIS_Y !== undefined) ? CFG.AXIS_Y : 0;
      let mn = Infinity, mx = -Infinity;
      /* 用「相对器件原点」的局部矩阵累乘，绝不能用 n.world：
         movePartX 只刷新器件自身的矩阵，子节点的 world 要等下一次渲染
         才更新。此刻用 world 量出的伸出量会整体偏移一个位移量，一旦被
         缓存下来，夹紧区间就永久算错 —— 器件再也拖不动。 */
      const walk = (n, pm) => {
        const w = M4.mul(M4.create(), pm, n.matrix);
        const a = n.mesh && n.mesh.geo && n.mesh.geo.aabb;
        if (a && n.visible !== false) {
          const p = new Float32Array(3);
          let x0 = Infinity, x1 = -Infinity, cy = 0;
          for (let i = 0; i < 8; i++) {
            p[0] = (i & 1) ? a.max[0] : a.min[0];
            p[1] = (i & 2) ? a.max[1] : a.min[1];
            p[2] = (i & 4) ? a.max[2] : a.min[2];
            M4.transformPoint(p, w, p);
            if (p[0] < x0) x0 = p[0];
            if (p[0] > x1) x1 = p[0];
            cy += p[1] / 8;
          }
          // 支杆 / 线缆 / 线夹都在光轴下方，按高度排除（名字不可靠）
          if (cy > axisY - 0.030) {
            if (x0 < mn) mn = x0;
            if (x1 > mx) mx = x1;
          }
        }
        for (const c of n.children) walk(c, w);
      };
      if (root) for (const c of root.children) walk(c, M4.identity(M4.create()));
      /* 上下限只是防呆：HeNe 管身本身就有 ±150 mm，上限卡在 90 mm 会让
         光阑①可以插进激光管里（实测重叠 1.1 mm）。
         注意 mn/mx 已经是「相对器件原点」的量，不能再减 root.pos[0] ——
         减了会把每件都算成 ±180 mm（正好被防呆上限截断），夹紧区间全错。 */
      const clamp = (v) => Math.max(0.006, Math.min(0.180, v));
      const e = isFinite(mn)
        ? { l: clamp(-mn), r: clamp(mx) }
        : { l: 0.012, r: 0.012 };
      this._ext[tag] = e;
      return e;
    }

    /** 器件沿光轴的半尺寸（m）：用于「器件之间不能互相穿过」的约束。
        只算本体，排除支杆 / 线缆 / 线夹（否则每个器件都会被算成半米长）。 */
    _partHalfX(tag) {
      const e = this._partExt(tag);
      return (e.l + e.r) / 2;
    }

    /** 把器件放到 x（不穿越邻居、不出台面）；被夹住时给出提示。
        改焦距时探测器/输出屏要跟着后焦面走，但台面长度有限，
        直接 movePartX 会让 CMOS 压到 SLM₂ 上或把输出屏推出台面。 */
    _placePart(tag, x) {
      const rg = this._dragRange(tag);
      const px = Math.max(rg[0], Math.min(rg[1], x));
      this.lab.movePartX(tag, px);
      if (Math.abs(px - x) > 1e-4) {
        const info = this.lab.info.get(tag);
        this.ui.toast(`「${info ? info.label : tag}」只能到 ${(px * 1e3).toFixed(1)} mm：再远就顶到相邻器件 / 台面尽头`, 'warn', 2600);
      }
      return px;
    }

    /** 台面（导轨）两端的世界坐标。写死 −0.16/1.56 会让激光器的管身
        探出台面外侧，进而把「往左拖」判成越界、反向推回来。 */
    _rail() {
      const C = window.CFG || {};
      const cx = C.TABLE_CX !== undefined ? C.TABLE_CX : 0.70;
      const L = C.TABLE_L !== undefined ? C.TABLE_L : 1.80;
      return [cx - L / 2 + 0.002, cx + L / 2 - 0.002];
    }

    /** 拖动时的可用区间。**硬约束只有「不重叠」**（0.8 mm 视觉间隙），
        不再把 3 mm 当铁律：把 3 mm 当硬约束时，一串器件互相顶住之后
        每件的可用区间只剩 0.2 mm，整条导轨会被锁死 —— 用户看到的就是
        「完全拖不动」，而且没有任何办法解开（邻居同样被夹死）。 */
    _dragRange(tag) {
      const order = (this.lab.order || []).slice();
      const i = order.indexOf(tag);
      const me = this._partExt(tag);
      const rail = this._rail();
      if (i < 0) return [rail[0], rail[1]];
      const px = (t) => this.lab.parts.get(t).pos[0];
      const GAP = 0.0008;
      let lo = rail[0] + me.l, hi = rail[1] - me.r;
      if (i > 0) {
        const p = this._partExt(order[i - 1]);
        lo = Math.max(lo, px(order[i - 1]) + p.r + me.l + GAP);
      }
      if (i < order.length - 1) {
        const n = this._partExt(order[i + 1]);
        hi = Math.min(hi, px(order[i + 1]) - n.l - me.r - GAP);
      }
      /* 旧存档（间隙更小的旧版本摆出来的）可能已经互相压住，此时 lo > hi。
         退化成零宽会让器件彻底锁死，这里给 2 mm 的「挣扎空间」，
         配合启动时的 _sanitizeLayout 把压住的布局推开。 */
      if (lo > hi) { lo = px(tag) - 0.002; hi = px(tag) + 0.002; }
      return [lo, hi];
    }

    /** 沿导轨推动：拖动件顶到邻居时把邻居一起带走（真实导轨上镜架就是
        这样互相顶着的），而不是硬邦邦停住。返回 { x, blockedBy }：
        x 是拖动件实际到达的位置，blockedBy 是真正挡住它的器件（null = 导轨尽头）。 */
    _moveChain(tag, targetX) {
      const order = this.lab.order || [];
      const i = order.indexOf(tag);
      if (i < 0) return { x: targetX, blockedBy: null };
      const GAP = 0.0012;
      const P = (t) => this.lab.parts.get(t).pos[0];
      const E = (t) => this._partExt(t);
      const cur = P(tag);
      const d = targetX - cur;
      if (Math.abs(d) < 1e-9) return { x: cur, blockedBy: null };
      const dir = d > 0 ? 1 : -1;
      /* 沿拖动方向建立一维坐标 u：往哪边拖，u 就往哪边增大。
         这样左右两个方向可以共用同一套「谁挡谁」的判断。 */
      const U = (x) => dir * x;
      const near = (t) => { const e = E(t); return dir > 0 ? e.r : e.l; };  // 迎向拖动方向的一侧
      const far = (t) => { const e = E(t); return dir > 0 ? e.l : e.r; };   // 背向的一侧

      // 1) 谁会被带着走：位移超过间隙才会接触，逐个往外传
      const chain = [tag];
      const want = new Map([[tag, targetX]]);
      const rows = this._dbgChain ? [] : null;
      let carry = Math.abs(d);
      for (let k = i + dir; k >= 0 && k < order.length; k += dir) {
        const prev = order[k - dir], t = order[k];
        /* 间隙 = 「后一件背向拖动方向的边」到「前一件迎向拖动方向的边」。
           注意 far(t) / near(prev) —— 写成 near(t)/far(prev) 会把间隙算成
           两个错开的边之间的距离，链条会在任意位置乱断。 */
        const gap = (U(P(t)) - far(t)) - (U(P(prev)) + near(prev)) - GAP;
        if (rows) rows.push([t, +(gap * 1e3).toFixed(1), +(carry * 1e3).toFixed(1)]);
        if (carry <= Math.max(0, gap) + 1e-9) break;
        carry -= Math.max(0, gap);
        chain.push(t);
        want.set(t, P(t) + dir * carry);
      }
      if (rows) this._chainRows = rows;

      // 2) 从链尾往链头夹紧：链尾先被「链外的邻居 / 导轨尽头」挡住，
      //    再依次回传，前面每一件最多顶到后一件的新位置
      const beyond = order[i + dir * chain.length];
      const rail = this._rail();
      let lim = beyond
        ? U(P(beyond)) - far(beyond) - GAP
        : (dir > 0 ? rail[1] : -rail[0]);     // 导轨两端（u 坐标）
      let blockedBy = null;
      const detail = this._dbgChain ? [] : null;
      for (let n = chain.length - 1; n >= 0; n--) {
        const t = chain[n];
        const cap = lim - near(t);
        const before = P(t);
        let u = U(want.get(t));
        if (u > cap) {
          u = cap;
          if (n === 0) blockedBy = beyond || null;   // null = 导轨尽头
        }
        /* 推送只能往前，绝不能把器件往回拉：
           链条里各件的间隙并不相同（有的贴在一起、有的空着几十毫米），
           若允许「夹紧到上限」，一件被挡住就会把前面几十毫米的间隙
           一次性收掉，整串器件会突然倒退一大截并互相压住。 */
        if (u < U(P(t))) u = U(P(t));
        want.set(t, dir * u);
        lim = u - far(t) - GAP;
        if (detail) detail.push([t, +(before * 1e3).toFixed(1), +((dir * u) * 1e3).toFixed(1), +(cap * 1e3).toFixed(1)]);
      }

      // 3) 应用
      let got = cur;
      for (const t of chain) {
        const x = want.get(t);
        if (Math.abs(x - P(t)) > 1e-7) this.lab.movePartX(t, x);
        if (t === tag) got = x;
      }
      if (this._dbgChain) this._chainDbg = { tag, targetX, cur, chain: chain.slice(), beyond, lim, got, blockedBy, detail };
      return { x: got, blockedBy };
    }

    /** 启动时整理布局：旧存档可能是在间隙更小的版本里摆的，恢复后器件
        互相压住 → 夹紧区间退化 → 拖不动。这里顺次推开 1.2 mm 并收进台面。 */
    _sanitizeLayout() {
      const order = this.lab.order || [];
      if (!order.length) return;
      const GAP = 0.0012;
      const rail = this._rail();
      const P = (t) => this.lab.parts.get(t).pos[0];
      const E = (t) => this._partExt(t);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < order.length; i++) {
          const a = order[i - 1], b = order[i];
          const need = P(a) + E(a).r + E(b).l + GAP;
          if (P(b) < need - 1e-6) this.lab.movePartX(b, need);
        }
        // 若被推到台面右端之外，再从右往左把前面的一起收回来
        for (let i = order.length - 1; i >= 0; i--) {
          const hi = rail[1] - E(order[i]).r;
          if (P(order[i]) > hi) this.lab.movePartX(order[i], hi);
          if (i > 0) {
            const a = order[i - 1], b = order[i];
            const need = P(b) - E(b).l - E(a).r - GAP;
            if (P(a) > need) this.lab.movePartX(a, Math.max(rail[0] + E(a).l, need));
          }
        }
      }
      this._ext = null;      // 位置变了，伸出量重新量（虽然与位置无关，保险）
    }

    _dragPart(node, dxPix, dyPix) {
      /* 求 px，使「器件在屏幕上的位移」严格等于「指针位移」。
         透视投影下 1 px 对应的毫米数随位置变化（近大远小），只按起点
         尺度换算会短 3–8%，拖起来就是「跟不上手」。这里对投影式做牛顿
         迭代（每一步用该处的导数），两次就收敛到 0.1 px 以内。 */
      const ndx = 2 * dxPix / Math.max(1, this.canvas.clientWidth);
      const ndy = -2 * dyPix / Math.max(1, this.canvas.clientHeight);
      /* 绝对定位：抓取时的位置 + 相对抓取点的总位移（dxPix 传的是总位移）。
         用逐帧增量的话，一旦被邻居夹住，这一段位移就永久丢失，
         手往回移时元件会突然跳到指针前面。 */
      const base = (this.pointer.grab && this.pointer.grab.partX !== undefined) ? this.pointer.grab.partX : node.pos[0];

      this.rnd.updateCamera();
      const cam = this.rnd.camera;
      const vp = M4.mul(M4.create(), cam.proj, cam.view);
      const proj = (x) => M4.transformPoint(new Float32Array(3), vp, [x, 0, 0]);
      const kAt = (x) => {                       // 每 10 mm 的 NDC 位移
        const a = proj(x), b = proj(x + 0.01);
        return [b[0] - a[0], b[1] - a[1]];
      };
      const s0 = proj(base);
      const k0 = kAt(base);
      const kk0 = k0[0] * k0[0] + k0[1] * k0[1];
      let px;
      if (kk0 > 1e-14) px = base + (ndx * k0[0] + ndy * k0[1]) * 0.01 / kk0;
      else px = base + dxPix * 2 * Math.tan(cam.fov / 2) * cam.dist / this.canvas.clientHeight;

      for (let it = 0; it < 4; it++) {
        const sp = proj(px);
        const ex = (sp[0] - s0[0]) - ndx, ey = (sp[1] - s0[1]) - ndy;
        if (Math.abs(ex) < 2e-6 && Math.abs(ey) < 2e-6) break;   // < 1e-3 px
        const k = kAt(px);
        const kk = k[0] * k[0] + k[1] * k[1];
        if (kk < 1e-14) break;
        px -= (ex * k[0] + ey * k[1]) * 0.01 / kk;
      }
      if (this._dbgChain) this._dbgDrag = { dxPix, base: +(base * 1e3).toFixed(2), px: +(px * 1e3).toFixed(2) };
      // 吸附：默认 0.25 mm 网格（导轨刻度），按住 Shift 进入 0.02 mm 精调；
      // 引导模式下若接近理论位置（±2 mm）则直接吸附到理论值。
      const shift = this.keys.has('shift');
      if (this.mode === 'guide') {
        const th = this._theoryX(node.tag);
        if (th !== null && Math.abs(px - th) < 2.0e-3) px = th;
        else px = shift ? Math.round(px / 2e-5) * 2e-5 : Math.round(px / 2.5e-4) * 2.5e-4;
      } else {
        px = shift ? Math.round(px / 2e-5) * 2e-5 : Math.round(px / 2.5e-4) * 2.5e-4;
      }

      // 器件不能互相穿过：顶到邻居就推着它走，推不动才是真的到极限
      const res = this._moveChain(node.tag, px);
      if (Math.abs(res.x - px) > 1e-6) {
        /* 顶住后重新锚定抓取基准：不锚定的话手指会「越推越远」，
           往回移一大段元件却还不动（橡皮筋感）。锚定后往回移立即跟手。 */
        if (this.pointer.grab) this.pointer.grab.partX = res.x - (px - base);
        const info = res.blockedBy ? this.lab.info.get(res.blockedBy) : null;
        this._blockTip(info ? info.label : null, !info);
        if (!this._bumpT || performance.now() - this._bumpT > 700) {
          this._bumpT = performance.now();
          this.ui.toast(info ? `顶到「${info.label}」了，先把它挪开` : '已到导轨尽头', 'warn', 1400);
        }
      } else {
        this._blockTip(null);
      }

      this.lab.showSelection(node);
      this._refreshInspect();
      this._dragPreview = true;          // 拖动中只做预览解（不读回，界面不卡）
      this.requestSolve();
    }

    /** 顶住时的即时反馈：跟随指针的红框提示 + 选中框变琥珀色。
        原来只有顶部一条 toast，离手底下的元件很远，用户看到「元件不动了」却不知道为什么。 */
    _blockTip(label, atEnd) {
      const el = $('#hoverTip');
      const on = !!(label || atEnd);
      if (this.lab) this.lab.setSelectionWarn(on);
      if (!el) return;
      if (!on) {
        if (this._blockOn) { el.classList.remove('on'); this._blockOn = false; this._hoverTag = null; }
        return;
      }
      const key = atEnd ? '__end' : label;
      if (this._blockLabel !== key) {
        this._blockLabel = key;
        el.innerHTML = atEnd
          ? '<b>⛔ 已到导轨尽头</b><i>整条台面只有这么长</i>'
          : `<b>⛔ 顶到「${label}」</b><i>松手后可先把它挪开</i>`;
      }
      const r = this.canvas.getBoundingClientRect();
      this._placeTip(el, this.pointer.x - r.left, this.pointer.y - r.top);
      el.classList.add('on');
      this._blockOn = true;
    }

    /** 元件的理论位置（引导吸附用）；无理论值时返回 null */
    _theoryX(tag) {
      const L = this.lab, P = LAB.LAYOUT, j = this.jtc;
      if (!L || !j) return null;
      const px = (t) => { const n = L.parts.get(t); return n ? n.pos[0] : P[t]; };
      switch (tag) {
        case 'collim': return px('sf') + 0.0288 + j.p.f1;
        case 'focal': return px('lens1') + j.p.f1;
        case 'output': return px('lens2') + j.p.f2;
        // 其余器件（含偏振片、光阑、SLM₂）复位到台面布局位
        default: return P[tag] !== undefined ? P[tag] : null;
      }
    }

    stepAction() {
      const st = STEPS[this.stepIndex];
      if (!st || !st.action) return;
      if (st.action === 'pin') this._autoCenterPinhole();
      else if (st.action === 'faults') this.toggleFaultDemo();
    }

    /* ───────── 针孔自动对中（真实把偏心归零，可手动替代） ───────── */
    _autoCenterPinhole() {
      const u0 = this.hw.pinU, v0 = this.hw.pinV;
      const t0 = performance.now(), dur = 900;
      const tick = () => {
        const t = Math.min(1, (performance.now() - t0) / dur);
        const e = 1 - Math.pow(1 - t, 3);
        this.setPinhole(u0 * (1 - e), v0 * (1 - e), true);
        this._refreshGuide();
        if (t < 1) setTimeout(tick, 16);
        else this.ui.toast('针孔已对中 · 透过率恢复到 ' + (this.hw.pinFlux * 100).toFixed(0) + '%', 'ok');
      };
      tick();
    }

    /* ═════════ 故障演练：把学生常犯的错误一键施加，看结果如何崩 ═════════
       每个故障都真实改变状态（不改判据、不做假动画），
       学生可以直接看到「识别结果」与「光路诊断」里的物理量劣化。 */
    injectFault(f) {
      if (!f) return;
      f.apply(this);
      this.faults.add(f.id);
      this.requestSolve();
      this._refreshGuide();
      if (this.ui.markFaults) this.ui.markFaults(this.faults);
      this._pushHistory('fault:' + f.id);
    }

    /** 点击 chip：施加 / 复原。复原也必须 requestSolve —— 像「准直镜偏焦」「CMOS 离焦」
        这类故障的 reset 只是把器件挪回去，不求解的话画面和判据会停在故障状态。 */
    toggleFault(f) {
      if (!f) return;
      if (this.faults.has(f.id)) {
        f.reset(this);
        this.faults.delete(f.id);
      } else {
        f.apply(this);
        this.faults.add(f.id);
      }
      this.requestSolve();
      this._refreshGuide();
      if (this.ui.markFaults) this.ui.markFaults(this.faults);
      this._pushHistory('fault:' + f.id);
    }

    clearFaults() {
      LAB.FAULTS.forEach(f => f.reset(this));
      this.faults.clear();
      this.requestSolve();
      this._refreshGuide();
      if (this.ui.markFaults) this.ui.markFaults(this.faults);
      this._pushHistory('faults');
    }

    /* ═════════ 历史记录：撤销 / 重做 ═════════
       快照内容 = 元件位置 + 硬件状态 + JTC 参数 + 故障集。
       同一操作的连续变化（拖动元件、拖滑块）用 key 合并为一条，
       撤销时不会退回到「拖到一半」的中间态。 */
    _snapshot() {
      const parts = {};
      this.lab.parts.forEach((n, k) => { parts[k] = +n.pos[0].toFixed(6); });
      const p = {};
      if (this.jtc && this.jtc.p) {
        for (const k in this.jtc.p) {
          const v = this.jtc.p[k];
          if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') p[k] = v;
        }
      }
      return { parts, hw: Object.assign({}, this.hw), p, faults: Array.from(this.faults),
        f: this.jtc ? this.jtc.fName : null, g: this.jtc ? this.jtc.gName : null };
    }

    _pushHistory(key) {
      if (!this.lab || !this.jtc) return;
      if (this._silent) return;                 // 回放/复位期间不记录
      if (!this.history) { this.history = []; this.hIdx = -1; }
      const s = this._snapshot();
      const now = performance.now();
      const same = key && this._hKey === key && (now - this._hAt) < 1500;
      this._hKey = key; this._hAt = now;
      if (same && this.hIdx >= 0 && this.hIdx === this.history.length - 1) {
        this.history[this.hIdx] = s;          // 覆盖同一操作的中间态
        this._syncHistUI();
        return;
      }
      this.history.length = this.hIdx + 1;     // 新操作截断重做栈
      this.history.push(s);
      if (this.history.length > 80) this.history.shift();
      this.hIdx = this.history.length - 1;
      this._syncHistUI();
      this._autoSave();                        // 每次可撤销操作后延迟落盘
    }

    _syncHistUI() {
      const u = $('#btnUndo'), r = $('#btnRedo');
      if (u) u.classList.toggle('dis', this.hIdx <= 0);
      if (r) r.classList.toggle('dis', this.hIdx >= (this.history ? this.history.length - 1 : 0));
    }

    _restore(s) {
      if (!s) return;
      this._silent = true;                      // 回放期间不产生新的历史记录
      try {
        // 故障先全部复位，再按快照重新施加（保证硬件状态与集合一致）
        LAB.FAULTS.forEach(f => { try { f.reset(this); } catch (e) { /* 忽略 */ } });
        this.faults.clear();
        Object.assign(this.hw, s.hw);
        if (this.jtc && this.jtc.p) {
          /* N 变了必须重建 FFT 缓冲：直接 Object.assign 会把 p.N 改回旧值、
             而 fft 仍是新尺寸的纹理 —— 之后所有求解都在错位的网格上做，
             Parseval 掉到 0.6、条纹对比度归零，而且不报任何错。 */
          const wantN = s.p && s.p.N;
          if (wantN && wantN !== this.jtc.p.N) {
            this.jtc.setParams({ N: Math.min(wantN, this.jtc.caps.maxTexture) });
          }
          Object.assign(this.jtc.p, s.p);
          /* 快照可能来自更强的 GPU（N=2048），本机 maxTexture 不够时不能硬套：
             直接 Object.assign 会把 p.N 写成 2048，再按它分配纹理就会失败。 */
          if (this.jtc.p.N > this.jtc.caps.maxTexture) this.jtc.p.N = this.jtc.caps.maxTexture;
          if (this.jtc.fft.N !== this.jtc.p.N) this.jtc._allocFft();
        }
        // 目标图案也要回到快照里的那一对（换图案 / 互换同样可撤销）
        if (s.f && s.g && window.PATTERNS) {
          const fF = PATTERNS.get(s.f), gF = PATTERNS.get(s.g);
          if (fF && gF) this.jtc.setPatterns(fF, gF, s.f, s.g);
          if (this.ui.updatePatternMarks) this.ui.updatePatternMarks();
        }
        for (const id of (s.faults || [])) {
          const f = LAB.FAULTS.find(x => x.id === id);
          if (f) { try { f.apply(this); } catch (e) { /* 忽略 */ } this.faults.add(id); }
        }
        // 元件位置以快照为准（放在最后：故障的 apply/reset 也会挪元件）
        for (const k in s.parts) {
          const n = this.lab.parts.get(k);
          if (n && Math.abs(n.pos[0] - s.parts[k]) > 1e-9) {
            n.pos[0] = s.parts[k]; n.updateMatrix();
          }
        }
        if (this.ui.markFaults) this.ui.markFaults(this.faults);
        this.lab.updateBeams();
        if (this.ui.syncControls) this.ui.syncControls();
        this.solve(false);
        this._refreshGuide();
      } finally {
        this._silent = false;
      }
    }

    /* ═════════ 会话持久化：刷新/重开浏览器后接着上次做 ═════════ */
    _flushSave() {
      if (this._silent) return;
      try {
        const s = this._snapshot();
        s.v = 1; s.t = Date.now();
        if (this.jtc) { s.f = this.jtc.fName; s.g = this.jtc.gName; }
        const c = this.rnd && this.rnd.camera;
        if (c) s.view = { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: c.target.slice(0, 3), fov: c.fov };
        localStorage.setItem('optilab.state.v1', JSON.stringify(s));
      } catch (e) { /* 隐私模式 / 配额不足：静默失败，不影响使用 */ }
    }

    /** 延迟落盘（拖拽过程中不写，停手 0.6 s 后写一次） */
    _autoSave() {
      if (this._silent || this._noSave) return;
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => this._flushSave(), 600);
    }

    _loadState() {
      let s = null;
      try { s = JSON.parse(localStorage.getItem('optilab.state.v1') || 'null'); } catch (e) { return false; }
      if (!s || s.v !== 1) return false;
      try {
        this._noSave = true;
        if (s.f && window.PATTERNS) {
          const f = PATTERNS.get(s.f);
          if (f) this.jtc.setPatterns(f, this.jtc.gField, s.f, this.jtc.gName);
        }
        if (s.g && window.PATTERNS) {
          const g = PATTERNS.get(s.g);
          if (g) this.jtc.setPatterns(this.jtc.fField, g, this.jtc.fName, s.g);
        }
        this._restore(s);
        /* 旧存档可能是「间隙更小的旧版本」摆出来的，恢复后器件互相压住，
           夹紧区间退化 → 拖不动。这里顺次推开，保证任何存档都能继续操作。 */
        this._sanitizeLayout();
        if (s.view && this.rnd) {
          const c = this.rnd.camera;
          c.yaw = s.view.yaw; c.pitch = s.view.pitch; c.dist = s.view.dist;
          c.target = s.view.target.slice(); c.fov = s.view.fov;
          this.rnd.updateCamera();
          this._restoredView = true;
          this._viewAuto = false;          // 用户自己的机位，窗口变化时不要自动改
        }
        if (this.ui.updatePatternMarks) this.ui.updatePatternMarks();
        this._refreshGuide();
        return true;
      } catch (e) {
        return false;
      } finally {
        this._noSave = false;
      }
    }

    /** 清空本地存档，回到出厂状态 */
    resetSession() {
      try { localStorage.removeItem('optilab.state.v1'); } catch (e) { /* 忽略 */ }
      this._noSave = true;
      try {
        LAB.FAULTS.forEach(f => { try { f.reset(this); } catch (e) { /* 忽略 */ } });
        this.faults.clear();
        /* 出厂状态必须逐项写死：故障的 reset 现在是「回到施加前」，
           若某条故障被施加过，光靠 reset 得不到出厂值。 */
        this.hw.power = 1.0; this.hw.pinU = 0; this.hw.pinV = 0;
        this.hw.apIris2 = 0.0040; this.hw.pol1 = 0; this.hw.pol2 = 90;
        if (this.jtc && this.jtc.p) Object.assign(this.jtc.p, window.JTC_DEFAULTS || {});
        this.lab.parts.forEach((n, k) => {
          const th = this._theoryX(k);
          if (th !== null) { n.pos[0] = th; n.updateMatrix(); }
        });
        if (this.ui.markFaults) this.ui.markFaults(this.faults);
        if (this.ui.syncControls) this.ui.syncControls();
        this._sanitizeLayout();          // 理论位置若挤在一起，也先推开
        this.lab.updateBeams();
        this.solve(false);
        this._refreshGuide();
      } finally {
        this._noSave = false;
      }
      this._pushHistory('resetAll');
      this.ui.toast('已恢复到出厂状态', 'ok', 1800);
    }

    undo() {
      if (!this.history || this.hIdx <= 0) { this.ui.toast('已到最早状态', 'warn', 1400); return; }      this.hIdx--;
      this._restore(this.history[this.hIdx]);
      this._syncHistUI();
      this.ui.toast('撤销 · 剩余 ' + this.hIdx + ' 步可回退', '', 1300);
    }

    redo() {
      if (!this.history || this.hIdx >= this.history.length - 1) { this.ui.toast('没有可重做的操作', 'warn', 1400); return; }
      this.hIdx++;
      this._restore(this.history[this.hIdx]);
      this._syncHistUI();
      this.ui.toast('重做', '', 1100);
    }

    /* ═════════ 导出实验记录（JSON + 报告） ═════════ */
    exportRecord() {
      const r = this.results, j = this.jtc;
      if (!r || !j) { this.ui.toast('尚未完成求解', 'warn'); return; }
      const an = r.analysis || {}, q = this.quality();
      const parts = {};
      this.lab.parts.forEach((n, k) => {
        const info = this.lab.info.get(k);
        parts[k] = { label: info ? info.label : k, x_mm: +(n.pos[0] * 1e3).toFixed(3) };
      });
      const rec = {
        app: 'OPTILAB · 联合傅里叶变换相关识别',
        time: new Date().toISOString(),
        model: {
          lambda_nm: +(j.p.lambda * 1e9).toFixed(2),
          f1_mm: +(j.p.f1 * 1e3).toFixed(2),
          f2_mm: +(j.p.f2 * 1e3).toFixed(2),
          dx_um: +(j.p.dx * 1e6).toFixed(2),
          N: j.p.N,
          jpsMode: j.p.jpsMode,
          pattern_f: j.fName, pattern_g: j.gName,
        },
        hardware: {
          pin_offset_um: +((Math.hypot(this.hw.pinU, this.hw.pinV)) * 1e6).toFixed(2),
          pin_flux: +this.hw.pinFlux.toFixed(4),
          collim_offset_mm: +(this.hw.collimOffset * 1e3).toFixed(3),
          iris2_radius_mm: +(this.hw.apIris2 * 1e3).toFixed(2),
          laser_power: +this.hw.power.toFixed(3),
        },
        parts,
        result: {
          peak_xi_mm: +(an.peakXi * 1e3).toFixed(4),
          theory_mm: +(an.theory * 1e3).toFixed(4),
          rel_err: +(an.err || 0).toFixed(4),
          psr: +(an.psr || 0).toFixed(2),
          fwhm_um: +(an.fwhmUm || 0).toFixed(1),
          peak_ratio: +(an.ratio || 0).toFixed(3),
          fringe_vis: +(an.fringeVis || 0).toFixed(3),
          snr: +(q.snr || 0).toFixed(1),
          valid: !!an.valid,
          verdict: this.verdictText(),
          parseval: r.parseval,
        },
        faults: Array.from(this.faults),
      };
      const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'optilab-record-' + Date.now() + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.ui.toast('已导出实验记录（含参数、判据与峰位）', 'ok', 2600);
    }

    toggleFaultDemo() {
      if (this.demoTimer) { this.stopFaultDemo(); return; }
      this.clearFaults();
      this._demoStep = 0;
      const btn = $('#btnAutoRun');
      if (btn) { btn.classList.add('on'); btn.textContent = '停止演练'; }
      this.ui.toast('故障演练：逐个施加典型错误，观察结果如何劣化', 'ok', 2800);
      this._faultNext(600);
    }

    stopFaultDemo(finished) {
      if (this.demoTimer) { clearTimeout(this.demoTimer); this.demoTimer = null; }
      const btn = $('#btnAutoRun');
      if (btn) { btn.classList.remove('on'); btn.textContent = '故障演练'; }
      this._demoStep = 0;
      this._faultCurrent = null;
      if (finished) {
        this.clearFaults();
        this.ui.toast('演练结束：已恢复正确光路', 'ok', 3000);
      }
    }

    _faultNext(delay) {
      this.demoTimer = setTimeout(() => {
        this.demoTimer = null;
        const i = this._demoStep;
        if (i >= LAB.FAULTS.length) { this.stopFaultDemo(true); return; }
        this.clearFaults();
        const f = LAB.FAULTS[i];
        this._faultCurrent = f.id;
        this.injectFault(f);
        this.ui.toast(`故障 ${i + 1}/${LAB.FAULTS.length}：${f.name} —— ${f.hint}`, 'warn', 3000);
        this._demoStep = i + 1;
        this._faultNext(3400);
      }, delay);
    }

    /* ───────── 视图重绘 ───────── */
    /** 当前光场标签页的完整描述（数据 / 显示参数 / 物理尺度），供小窗与全屏共用 */
    _fieldFrame(which) {
      const r = this.results;
      if (!r) return null;
      const j = this.jtc, M = j.M, half = M / 2;
      const K = j.p.N / M;
      const tab = which || this.ui.fieldTab;
      if (tab === 'input') {
        return {
          tab, M, data: r.inArr,
          opts: { log: false, palette: 2, gamma: 1.0 },
          title: '输入面 h(x,y)',
          sub: `L = ${(j.L * 1e3).toFixed(2)} mm`,
          mmPerPx: j.L * 1e3 / M,
          unit: 'x',
        };
      }
      if (tab === 'jps') {
        const fringePx = j.fringePx / K;
        return {
          tab, M, data: r.sArr,
          /* 与 3D 悬浮屏上的那张显示纹理**完全同一套参数**
             （`fft.display(S, dispJps, {floor: 1e-6, gamma: 1.0, gain: 1/sMax})`）：
             对数底 1e-6、γ1.0、按最大值归一。此前这里用 floor 0.004 + γ0.95，
             把弱散斑全压成黑 —— 于是「屏上满是噪点、点开大图却干干净净」。 */
          opts: {
            log: this.ui.logJps, palette: 1,
            floor: this.ui.logJps ? (window.JPS_LOG_FLOOR || 1e-4) : 0,
            gamma: this.ui.logJps ? 1.0 : 0.85,
            gain: 1,
            marks: [{ kind: 'line', v: half, color: 'rgba(34,211,238,.35)' },
            { kind: 'line', h: half, color: 'rgba(34,211,238,.35)' }],
          },
          title: '联合功率谱 |FT{h}|²',
          sub: `条纹 Λ = ${(j.fringe * 1e6).toFixed(1)} µm`,
          mmPerPx: j.p.lambda * j.p.f1 / (j.p.N * j.p.dx) * K * 1e3,
          unit: 'u',
          fringePx,
        };
      }
      const an = r.analysis;
      const pk = an.peakXi / j.dO / K + half;
      const marks = [
        { kind: 'cross', x: pk, y: an.half, r: 14, color: 'rgba(163,230,53,.95)' },
        { kind: 'cross', x: M - 1 - pk, y: an.half, r: 14, color: 'rgba(163,230,53,.55)' },
        { kind: 'line', v: half, color: 'rgba(34,211,238,.5)' },
        { kind: 'line', h: half, color: 'rgba(34,211,238,.5)' },
      ];
      return {
        tab, M, data: r.oArr,
        opts: { log: true, palette: 1, gamma: 1.0, floor: 0.003, marks },
        title: '相关输出 |o(ξ,η)|²',
        sub: `峰位 ${(an.peakXi * 1e3).toFixed(3)} mm`,
        mmPerPx: j.dO * K * 1e3,
        unit: 'ξ',
      };
    }

    _maxOf(a) {
      let mx = 0;
      for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];
      return mx || 1;
    }

    /** 冻结当前光场为参考；再次调用取消 */
    toggleFieldRef() {
      const fr = this._fieldFrame();
      if (!fr) return;
      const btn = $('#btnFieldRef');
      if (this.fieldRef) {
        this.fieldRef = null;
        this.ui.cmpOn = false;
        if (btn) btn.classList.remove('on');
        this.ui.toast('已取消参考对比', '', 1400);
      } else {
        this.fieldRef = {
          tab: fr.tab, M: fr.M, data: Float32Array.from(fr.data),
          max: this._maxOf(fr.data), title: fr.title,
        };
        this.ui.cmpOn = true;
        if (btn) btn.classList.add('on');
        this.ui.toast(`已冻结「${fr.title}」为参考 · 左半为参考、右半为当前`, 'ok', 2600);
      }
      this.redrawField();
      if (this._ffOpen) this._ffDraw();
    }

    redrawField() {
      const fr = this._fieldFrame();
      if (!fr) return;
      const M = fr.M;
      let data = fr.data, opts = fr.opts;
      const ref = this.fieldRef;
      if (ref && ref.tab === fr.tab && this.ui.cmpOn) {
        const s = Math.max(0, Math.min(M, Math.round(this.ui.cmpSplit * M)));
        const comp = new Float32Array(M * M);
        for (let y = 0; y < M; y++) {
          const row = y * M;
          for (let x = 0; x < M; x++) comp[row + x] = x < s ? ref.data[row + x] : data[row + x];
        }
        data = comp;
        opts = Object.assign({}, opts, {
          max: Math.max(ref.max, this._maxOf(fr.data)),
          marks: (opts.marks || []).concat([
            { kind: 'line', v: s, color: 'rgba(255,255,255,.72)', dash: [3, 3] },
          ]),
        });
      }
      this.ui.drawField(data, M, null, opts);
      $('#fvBadge').textContent = `${fr.title} · ${fr.sub}` +
        (ref && ref.tab === fr.tab && this.ui.cmpOn ? ' · A/B' : '');
      // 剖面：ξ 方向带理论峰位刻度，η 方向峰在中心、不加刻度
      const an = this.results.analysis;
      const alongX = (this.ui.profileAxis || 'x') === 'x';
      const prof = (alongX || !an.profileEta) ? an.profile : an.profileEta;
      this.ui.drawProfile(prof, M, an.scale, {
        log: true, theoryPx: alongX ? this.jtc.peakPx / (this.jtc.p.N / M) : undefined,
      });
      if (this._ffOpen) this._ffDraw();
    }

    /* ───────── 全屏光场 ───────── */
    /** 打开大图。tab 省略时跟随右栏当前页签；
        从 3D 悬浮屏点进来时传入该屏对应的 tab（输入 / 谱面 / 相关），
        这样「点哪块屏就看哪块」，不用先去右栏切换页签。 */
    openFieldFull(tab) {
      const fr = this._fieldFrame(tab || undefined);
      if (!fr) { this.ui.toast('还没有求解结果，先按「求解」或等自动计算完成', 'warn', 2200); return; }
      this._ffOpen = true;
      this._ffTab = tab || null;
      this._ffOpenedAt = performance.now();
      this._ffZoom = 1;
      this._ffPan = [0, 0];
      $('#fieldFull').classList.remove('hidden');
      const rd = $('#ffRead');
      if (rd) rd.textContent = '移动指针读取像素 · 滚轮缩放 · 拖动平移';
      this._ffDraw();
      if (!this._ffBound) this._bindFieldFull();
    }

    closeFieldFull() {
      this._ffOpen = false;
      this._ffTab = null;
      $('#fieldFull').classList.add('hidden');
    }

    _bindFieldFull() {
      this._ffBound = true;
      const wrap = $('#fieldFull');
      $('#ffClose').addEventListener('click', () => this.closeFieldFull());
      /* 空白处单击退出：点弹窗外（背景遮罩）直接关 */
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) this.closeFieldFull(); });
      $('#ffIn').addEventListener('click', () => this._ffSetZoom(this._ffZoom * 1.35));
      $('#ffOut').addEventListener('click', () => this._ffSetZoom(this._ffZoom / 1.35));
      $('#ffFit').addEventListener('click', () => { this._ffZoom = 1; this._ffPan = [0, 0]; this._ffDraw(); });
      $('#ffCopy').addEventListener('click', () => this._ffCopy());
      $('#ffSave').addEventListener('click', () => this._ffSave());

      const cv = $('#ffCanvas');
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        this._ffSetZoom(this._ffZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      }, { passive: false });

      let drag = null, downPt = null;
      cv.addEventListener('mousedown', (e) => {
        downPt = { x: e.clientX, y: e.clientY };
        drag = { x: e.clientX, y: e.clientY, pan: this._ffPan.slice() };
        cv.style.cursor = 'grabbing';
      });
      window.addEventListener('mousemove', (e) => {
        if (!this._ffOpen) return;
        if (drag) {
          this._ffPan = [drag.pan[0] + (e.clientX - drag.x), drag.pan[1] + (e.clientY - drag.y)];
          this._ffDraw();
        }
      });
      window.addEventListener('mouseup', (e) => {
        if (drag) { drag = null; cv.style.cursor = 'crosshair'; }
        if (!this._ffOpen || !downPt) return;
        const moved = Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
        downPt = null;
        /* 空白处单击退出：图像以外的地方点一下就关（拖动平移不算）。
           缩放到 >1 时图像铺满整个画布，此时不存在「空白」，自然不会误关。 */
        if (moved > 5) return;
        /* 刚打开的前 350 ms 不响应「空白退出」：双击 3D 悬浮屏时第二下
           正好落在刚弹出的大图上，会把窗口立刻关掉（闪一下就没了）。 */
        if (performance.now() - (this._ffOpenedAt || 0) < 350) return;
        const g = this._ffGeo(), rc = cv.getBoundingClientRect();
        const px = e.clientX - rc.left, py = e.clientY - rc.top;
        const inside = px >= g.ox && py >= g.oy && px <= g.ox + g.M * g.s && py <= g.oy + g.M * g.s;
        if (!inside) this.closeFieldFull();
      });
      cv.addEventListener('mousemove', (e) => this._ffProbe(e));
      cv.addEventListener('mouseleave', () => {
        const el = $('#ffRead');
        if (el) el.textContent = '移动指针读取像素 · 滚轮缩放 · 拖动平移';
      });
    }

    /* ── 导出用离屏画布：图像 + 标题 + 比例尺（1024²，粘贴进报告即可用） ── */
    _ffShot() {
      const fr = this._fieldFrame(this._ffTab || undefined);
      if (!fr) return null;
      const M = fr.M, S = 1024, PAD = 8, FOOT = 54;
      const shot = this._ffCompose(fr);
      const src = document.createElement('canvas');
      this.ui.drawField(shot.data, M, src, shot.opts);
      const out = document.createElement('canvas');
      out.width = S + PAD * 2;
      out.height = S + PAD * 2 + FOOT;
      const x = out.getContext('2d');
      x.fillStyle = '#04070c';
      x.fillRect(0, 0, out.width, out.height);
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, PAD, PAD, S, S);

      // 比例尺（与屏幕上一致：取视场 1/5 附近最接近的整数）
      const target = M / 5 * fr.mmPerPx;
      const cands = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
      let best = cands[0];
      for (const c of cands) if (Math.abs(c - target) < Math.abs(best - target)) best = c;
      const barPx = best / fr.mmPerPx / M * S;
      const by = PAD + S - 22;
      x.fillStyle = 'rgba(0,0,0,.55)';
      x.fillRect(PAD + 10, by - 18, Math.max(96, barPx + 20), 34);
      x.strokeStyle = 'rgba(255,255,255,.85)';
      x.lineWidth = 2;
      x.beginPath();
      x.moveTo(PAD + 20, by); x.lineTo(PAD + 20 + barPx, by);
      x.moveTo(PAD + 20, by - 5); x.lineTo(PAD + 20, by + 5);
      x.moveTo(PAD + 20 + barPx, by - 5); x.lineTo(PAD + 20 + barPx, by + 5);
      x.stroke();
      x.font = '600 15px ui-monospace,monospace';
      x.fillStyle = 'rgba(255,255,255,.9)';
      x.textBaseline = 'bottom';
      x.fillText(best < 1 ? (best * 1000).toFixed(0) + ' µm' : best.toFixed(best < 10 ? 1 : 0) + ' mm',
        PAD + 20, by - 8);

      // 页脚：标题 + 参数
      const fy = PAD + S + 6;
      x.textBaseline = 'middle';
      x.font = '600 20px system-ui,sans-serif';
      x.fillStyle = 'rgba(228,238,250,.96)';
      x.fillText(fr.title, PAD + 4, fy + 20);
      x.font = '400 15px ui-monospace,monospace';
      x.fillStyle = 'rgba(140,160,180,.95)';
      x.textAlign = 'right';
      x.fillText(`${fr.sub}   ${M}×${M}   ${(fr.mmPerPx * 1000).toFixed(1)} µm/px`, out.width - PAD - 4, fy + 20);
      return out;
    }

    async _ffCopy() {
      const cv = this._ffShot();
      if (!cv) return;
      /* 先给即时反馈：1024² 的 PNG 编码要几十到几百毫秒（软件渲染下更久），
         按钮点下去没动静会让人以为坏了。 */
      this.ui.toast('正在复制图像…', '', 1200);
      try {
        const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
        if (!blob) throw new Error('toBlob failed');
        if (!navigator.clipboard || !window.ClipboardItem) throw new Error('no clipboard');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        this.ui.toast('图像已复制到剪贴板', 'ok', 1800);
      } catch (e) {
        /* 浏览器不给剪贴板权限（或非安全上下文）时退化为下载，
           不能让「复制」这个按钮点了没反应。 */
        this._ffDownload(cv);
        this.ui.toast('剪贴板不可用，已改为下载 PNG', 'warn', 2800);
      }
    }

    _ffSave() {
      const cv = this._ffShot();
      if (!cv) return;
      this.ui.toast('正在生成 PNG…', '', 1000);
      this._ffDownload(cv);
    }

    _ffDownload(cv) {
      const fr = this._fieldFrame(this._ffTab || undefined);
      const name = (fr ? fr.tab : 'field') + '_' + Date.now() + '.png';
      cv.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        this.ui.toast('已保存 ' + name, 'ok', 2200);
      }, 'image/png');
    }

    _ffSetZoom(z) {
      this._ffZoom = Math.max(1, Math.min(8, z));
      if (this._ffZoom === 1) this._ffPan = [0, 0];
      this._ffDraw();
    }

    /** 大图里真正要画的数据：A/B 冻结对比时左半用参考、右半用当前。
        屏幕与导出（复制 / 保存）必须走同一份合成，否则导出的图与看到的不一致。 */
    _ffCompose(fr) {
      const M = fr.M, ref = this.fieldRef;
      let data = fr.data, opts = fr.opts;
      if (ref && ref.tab === fr.tab && this.ui.cmpOn) {
        const sp = Math.max(0, Math.min(M, Math.round(this.ui.cmpSplit * M)));
        const comp = new Float32Array(M * M);
        for (let y = 0; y < M; y++) {
          const row = y * M;
          for (let x = 0; x < M; x++) comp[row + x] = x < sp ? ref.data[row + x] : data[row + x];
        }
        data = comp;
        opts = Object.assign({}, opts, {
          max: Math.max(ref.max, this._maxOf(fr.data)),
          marks: (opts.marks || []).concat([{ kind: 'line', v: sp, color: 'rgba(255,255,255,.72)', dash: [3, 3] }]),
        });
      }
      return { data, opts };
    }

    /** 全屏视图的几何：图像在画布中的偏移与每像素尺寸 */
    _ffGeo() {
      const cv = $('#ffCanvas'), body = cv.parentElement;
      const W = body.clientWidth, H = body.clientHeight;
      const fr = this._fieldFrame(this._ffTab || undefined);
      const M = fr ? fr.M : 512;
      const fit = Math.min(W, H) / M;
      const s = fit * this._ffZoom;
      const ox = (W - M * s) / 2 + this._ffPan[0];
      const oy = (H - M * s) / 2 + this._ffPan[1];
      return { W, H, M, s, ox, oy };
    }

    _ffDraw() {
      const fr = this._fieldFrame(this._ffTab || undefined);
      if (!fr || !this._ffOpen) return;
      const cv = $('#ffCanvas'), body = cv.parentElement;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = body.clientWidth, H = body.clientHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#04070c'; ctx.fillRect(0, 0, W, H);

      // 数据（含 A/B 合成）画到离屏画布，再平滑放大
      const M = fr.M;
      const ref = this.fieldRef;
      const { data, opts } = this._ffCompose(fr);
      const src = this._ffSrc || (this._ffSrc = document.createElement('canvas'));
      this.ui.drawField(data, M, src, opts);

      const g = this._ffGeo();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, M, M, g.ox, g.oy, M * g.s, M * g.s);

      // 刻度线 / 峰位标记（在屏幕空间绘制，保证线宽恒定）
      const marks = (opts.marks || []).filter(m => m.kind !== 'line');
      if (marks.length) {
        ctx.save();
        ctx.translate(g.ox, g.oy); ctx.scale(g.s, g.s);
        this.ui._drawMarks(ctx, M, marks, 1.4 / g.s);
        ctx.restore();
      }
      if (ref && ref.tab === fr.tab && this.ui.cmpOn) {
        const sx = g.ox + this.ui.cmpSplit * M * g.s;
        ctx.strokeStyle = 'rgba(255,255,255,.8)';
        ctx.setLineDash([5, 5]); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(sx, g.oy); ctx.lineTo(sx, g.oy + M * g.s); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '600 11px ui-monospace,monospace';
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 5;
        ctx.fillText('参考', g.ox + 8, g.oy + 16);
        ctx.fillText('当前', sx + 8, g.oy + 16);
        ctx.shadowBlur = 0;
      }

      // 标题 / 色标 / 比例尺
      $('#ffTitle').textContent = fr.title;
      $('#ffSub').textContent = fr.sub;
      $('#ffZoom').textContent = this._ffZoom.toFixed(1) + '×';
      const cb = $('#ffCbar');
      cb.style.background = this.ui.palCss(opts.palette === undefined ? 1 : opts.palette);
      cb.innerHTML = '<span>' + (opts.log ? 'log' : '线性') + '</span>';

      // 比例尺：取 1/5 画面宽度附近最接近的整数值
      const target = (M * g.s) / 5 / g.s * fr.mmPerPx;   // 目标毫米数
      const cands = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
      let best = cands[0];
      for (const c of cands) if (Math.abs(c - target) < Math.abs(best - target)) best = c;
      const px = best / fr.mmPerPx * g.s;
      $('#ffScale').innerHTML = `${best < 1 ? (best * 1000).toFixed(0) + ' µm' : best.toFixed(best < 10 ? 1 : 0) + ' mm'}<i style="width:${px.toFixed(1)}px"></i>`;

      $('#ffFoot').innerHTML =
        `<span><b>分辨率</b> ${M}×${M}</span>` +
        `<span><b>像素尺寸</b> ${(fr.mmPerPx * 1000).toFixed(1)} µm/px</span>` +
        `<span><b>视场</b> ${(M * fr.mmPerPx).toFixed(2)} mm</span>` +
        `<span><b>缩放</b> ${this._ffZoom.toFixed(2)}×</span>` +
        `<span>滚轮缩放 · 拖动平移 · 点空白处或 Esc 关闭 · Ctrl+C 复制</span>`;
    }

    _ffProbe(e) {
      const fr = this._fieldFrame(this._ffTab || undefined);
      if (!fr) return;
      const g = this._ffGeo();
      const cv = $('#ffCanvas');
      const rc = cv.getBoundingClientRect();
      const px = e.clientX - rc.left, py = e.clientY - rc.top;
      const ix = Math.floor((px - g.ox) / g.s), iy = Math.floor((py - g.oy) / g.s);
      const el = $('#ffRead');
      if (ix < 0 || iy < 0 || ix >= g.M || iy >= g.M) {
        el.textContent = '移动指针读取像素 · 滚轮缩放 · 拖动平移';
        return;
      }
      const v = fr.data[iy * g.M + ix];
      const mx = this._maxOf(fr.data);
      const half = g.M / 2;
      const xm = (ix - half) * fr.mmPerPx, ym = (iy - half) * fr.mmPerPx;
      el.textContent =
        `${fr.unit} = ${(xm >= 0 ? '+' : '') + xm.toFixed(3)} mm\n` +
        `η = ${(ym >= 0 ? '+' : '') + ym.toFixed(3)} mm\n` +
        `I = ${(v / mx).toFixed(3)}  (${(v / mx * 100).toFixed(1)}%)\n` +
        `像素 (${ix}, ${iy})`;
    }


    /* ───────── HUD ───────── */
    _updateHudStatic() {
      const j = this.jtc;
      /* 光束几何（束腰 / 准直 / 艾里斑）挪到 w(x) 曲线标题上：
         那里本来就是讲光束的，底部那一行遥测再塞四项会被截断（实测要 1036 px，
         而可用宽度只有 542 px，末尾直接丢字）。 */
      const bm = this.lab.beamModel && this.lab.beamModel.meta;
      const sub = $('#bcSub');
      if (sub && bm) {
        sub.textContent = `1/e² · 束腰 ⌀${(bm.pinhole.w0 * 2e6).toFixed(0)} µm` +
          ` · 准直 ⌀${(bm.illum.beam * 2e3).toFixed(1)} mm` +
          ` · 艾里 ⌀${(bm.spec.airyR * 2e6).toFixed(1)} µm`;
        sub.title = `滤波束腰 ⌀${(bm.pinhole.w0 * 2e6).toFixed(0)} µm · z_R ${(bm.pinhole.zR * 1e3).toFixed(1)} mm` +
          ` · 准直口径 ⌀${(bm.illum.beam * 2e3).toFixed(1)} mm` +
          ` · 衍射半角 ${(bm.thetaD * 1e3).toFixed(1)} mrad` +
          ` · 谱面艾里斑 ⌀${(bm.spec.airyR * 2e6).toFixed(1)} µm`;
      }
      const q = this.quality();
      $('#crosshairReadout').textContent =
        `λ ${(j.p.lambda * 1e9).toFixed(1)} nm   L ${(j.L * 1e3).toFixed(2)} mm   a ${(j.a * 1e3).toFixed(2)} mm   ` +
        `Λ ${(j.fringe * 1e6).toFixed(1)} µm   ξ_peak ${(j.peakXi * 1e3).toFixed(2)} mm` +
        `   ┃ 条纹 V ${q.fringeVis.toFixed(2)} · 针孔 T ${(q.pinFlux * 100).toFixed(0)}%` +
        ` · 分离度 ${q.sepMargin.toFixed(2)} · SNR ${q.snr > 999 ? '∞' : q.snr.toFixed(0)}`;
    }

    /** 帧时间自适应：>26 ms 连续偏高就降渲染比例，<13 ms 稳定后再逐步升回 */
    _adaptQuality(dt, now) {
      if (this._noAdapt) return;
      const ft = dt * 1000;
      this._ftAvg = this._ftAvg ? this._ftAvg * 0.92 + ft * 0.08 : ft;
      if (!this._qt) this._qt = now;
      if (now - this._qt < 900) return;
      this._qt = now;
      let sc = this.renderScale || 1;
      /* 拖动期间允许再降一档（0.62 → 0.45），但只在帧时间 >45 ms（<22 fps）时才这么做：
         30 fps 的机器上为了几帧去牺牲清晰度并不划算。松手后自动升回。 */
      if (this._ftAvg > 26 && sc > 0.62) sc = Math.max(0.62, sc * 0.85);
      else if (this._interacting && this._ftAvg > 45 && sc > 0.45) sc = Math.max(0.45, sc * 0.80);
      else if (this._ftAvg < 13 && sc < 0.999) sc = Math.min(1, sc * 1.10);
      if (!this._interacting && sc < 0.62) sc = Math.min(0.62, sc * 1.15);   // 松手后升回
      if (Math.abs(sc - (this.renderScale || 1)) > 0.01) {
        this.renderScale = sc;
        this._onResize();
      }
    }

    saveScreenshot() {
      this._wantShot = true;
      this.ui.toast('正在保存画面…', '', 1200);
    }

    /* ───────── 渲染循环 ───────── */
    _onResize() {
      // renderScale 由帧率自适应（见 _adaptQuality），高 DPI 屏上不再无条件 ×2
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75) * (this.renderScale || 1);
      const st = $('#stage');
      const w = Math.max(2, Math.round(st.clientWidth * dpr));
      const h = Math.max(2, Math.round(st.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
        this.rnd.setSize(w, h);
      }
      /* 窗口宽高比变了（旋转屏 / 拖窗口 / 分屏），而用户没有自己转过镜头时，
         重新按整条光路适配一次 —— 否则窄窗口下激光器或输出屏会被切出画面。 */
      const asp = w / h;
      if (this._lastAsp && Math.abs(asp / this._lastAsp - 1) > 0.10 && this._viewAuto) {
        this._applyViewPreset(this.view, true);
      }
      this._lastAsp = asp;
    }

    _loop(now) {
      requestAnimationFrame(this._loop);
      try {
      const dt = Math.min(0.05, (now - (this._prev || now)) / 1000);
      this._prev = now;
      const time = (now - this._t0) / 1000;

      // 相机阻尼 / 动画
      const c = this.rnd.camera;
      if (this.camAnim) {
        const a = this.camAnim;
        const t = Math.min(1, (now - a.t0) / a.dur);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        c.yaw = U.lerp(a.from.yaw, a.to.yaw, e);
        c.pitch = U.lerp(a.from.pitch, a.to.pitch, e);
        c.dist = U.lerp(a.from.dist, a.to.dist, e);
        c.fov = U.lerp(a.from.fov, a.to.fov, e);
        for (let i = 0; i < 3; i++) c.target[i] = U.lerp(a.from.target[i], a.to.target[i], e);
        if (t >= 1) this.camAnim = null;
      }

      // 键盘漫游
      if (this.keys.size) {
        const sp = (this.keys.has('shift') ? 1.9 : 1.0) * dt * 0.55;
        const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
        const fx = -Math.cos(c.pitch) * Math.sin(c.yaw), fz = -Math.cos(c.pitch) * Math.cos(c.yaw);
        let mx = 0, my = 0, mz = 0;
        if (this.keys.has('w')) { mx += fx; mz += fz; }
        if (this.keys.has('s')) { mx -= fx; mz -= fz; }
        if (this.keys.has('a')) { mx -= cy; mz += sy; }
        if (this.keys.has('d')) { mx += cy; mz -= sy; }
        if (this.keys.has('q')) my -= 1;
        if (this.keys.has('e')) my += 1;
        if (mx || my || mz) {
          const L = Math.hypot(mx, my, mz) || 1;
          c.target[0] += mx / L * sp; c.target[1] += my / L * sp; c.target[2] += mz / L * sp;
          this.camAnim = null;
        }
      }
      if (this.autoRotate) c.yaw += dt * 0.12;

      /* 悬浮屏是「看全局」时的辅助，拉太近会挡住器件本体，所以近景自动收起。
         阈值从 0.60 放宽到 0.46：0.6 m 时屏只有 40 px 宽、字看不清，
         而 0.46 m 时约 90 px，既能读又不挡器件（屏在器件上方 118 mm）。 */
      const wantHover = this.hoverOn !== false && c.dist >= 0.46;
      if (wantHover !== this._hoverShown) {
        this._hoverShown = wantHover;
        this.lab.setHoverVisible(wantHover);
      }

      // 节流求解：拖动元件 / 滑块时走「预览解」（只更新贴图，不做 GPU 回读）
      if (this.needSolve && this.autoCompute && now - this.lastSolve > 110) {
        this.needSolve = false;
        this.doSolve(this._dragPreview);
      }

      // 渲染
      this.lab.updateHoverBillboards(this.rnd.camera.eye);
      /* 检视面板跟着相机走：不跟的话转个视角，面板就停在原处指向空白，
         与它描述的那件器件彻底脱钩。只在相机真的动了才重算，避免每帧读布局。 */
      if (this.selected && this.ui && this.ui._insTag) {
        const cc = this.rnd.camera;
        const sig = cc.yaw * 1.7 + cc.pitch * 3.1 + cc.dist * 7.3 + cc.target[0] * 2.9 + cc.target[2] * 5.7;
        if (sig !== this._insSig) {
          this._insSig = sig;
          const el = $('#inspect');
          if (el && !el.classList.contains('hidden')) this.ui._placeInspect(el, this.selected.pos[0]);
        }
      }
      // 光束最小可见宽度随相机距离缩放：远景不至于细到看不见，近景仍是真实束径
      this.rnd._beamMinW = Math.max(0.00025, this.rnd.camera.dist * 0.0009);
      // 加粗倍率只在「看全台面」时生效；拉近看器件时自动回到真实束径，
      // 否则光柱会粗到把光阑孔塞满，反而失真
      const bs = this.beamScale || 1;
      const k = Math.max(0, Math.min(1, (this.rnd.camera.dist - 0.32) / (0.85 - 0.32)));
      const ease = k * k * (3 - 2 * k);
      const eff = 1 + (bs - 1) * ease;
      /* 加粗倍率现在是在建模阶段乘进宽度的（因为每个器件平面要按通光孔径夹一次，
         着色器里没法逐平面夹），所以倍率变化时必须重建光柱几何。
         阈值 3% + 140 ms 节流：缩放时看不出延迟，也不会每帧重建。 */
      if (Math.abs(eff - (this._bsUsed === undefined ? 1 : this._bsUsed)) > 0.03 &&
          performance.now() - (this._bsAt || 0) > 140) {
        this._bsUsed = eff;
        this._bsAt = performance.now();
        this.rnd.beamScale = eff;
        this.lab.rebuildBeams();
      } else if (this._bsUsed === undefined) {
        this.rnd.beamScale = eff;
      }
      this.lab.updateBeamBillboards(this.rnd.camera.eye);
      this.rnd.render(null, { time, shadowExtent: 0.95 });

      // 截图
      if (this._wantShot) {
        this._wantShot = false;
        try {
          const url = this.canvas.toDataURL('image/png');
          const a = document.createElement('a');
          a.href = url; a.download = 'optilab-' + Date.now() + '.png';
          a.click();
          this.ui.toast('画面已保存', 'ok');
        } catch (e) { this.ui.toast('保存失败：' + e.message, 'err'); }
      }

      // 自适应渲染分辨率：低端 GPU / 高 DPI 屏上优先保帧率
      this._adaptQuality(dt, now);

      // HUD（低频刷新）
      if (!this._hudT || now - this._hudT > 250) {
        this._hudT = now;
        this.ui.setHud({
          fps: this.rnd.fps, computeMs: this._solveMs || 0,
          fftMs: this.jtc ? this.jtc.fft.stats.lastMs : 0,
          res: this.jtc ? `N=${this.jtc.p.N}² · ${this.jtc.M}²读回` : '—',
          tl: `光轴长度 <b>${(1.43 * 1e3).toFixed(0)} mm</b><br>箱庭尺度 <b>1.80 m</b><br>` +
            `波长 <b>${(this.jtc.p.lambda * 1e9).toFixed(1)} nm</b><br>` +
            `谱面尺寸 <b>${(this.jtc.dS * this.jtc.p.N * 1e3).toFixed(2)} mm</b>`,
          tr: `输入面 <b>${(this.jtc.L * 1e3).toFixed(2)} mm</b><br>` +
            `谱面采样 <b>${(this.jtc.dS * 1e6).toFixed(2)} µm</b><br>` +
            `输出面采样 <b>${(this.jtc.dO * 1e6).toFixed(2)} µm</b><br>` +
            `<span class="warm">互相关峰 ${(this.jtc.peakXi * 1e3).toFixed(2)} mm</span>`,
        });
        this._updateHudStatic();
      }
      } catch (e) {
        if (!this._loopErr) {
          this._loopErr = String(e.message) + ' @@ ' + String(e.stack || '').split('\n')[1];
          console.error('[loop]', e);
        }
      }
    }
  }

  /* ───────── 启动 ───────── */
  window.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    global.APP = app;
    app.boot().catch(e => console.error(e));
    window.addEventListener('error', (ev) => {
      if (app.ui) app.ui.toast('脚本错误：' + (ev.message || ''), 'err', 6000);
    });
  });
})(window);
