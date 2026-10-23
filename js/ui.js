/* ═══════════════════════════════════════════════════════════
   ui.js · 界面层
   参数控件 / 光场视图 / 剖面曲线 / 指标 / 数据链 / 诊断
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  /* ───────── 伪彩（与着色器保持一致的配色） ───────── */
  function palGray(t) { const v = Math.round(t * 255); return [v, v, v]; }
  function palHeNe(t) { t = Math.max(0, Math.min(1, t)); return [255 * Math.pow(t, 0.85), 255 * Math.pow(t, 2.4) * 0.42, 255 * Math.pow(t, 3.4) * 0.34]; }
  function palCyan(t) { t = Math.max(0, Math.min(1, t)); return [255 * Math.pow(t, 2.1) * 0.30, 255 * Math.pow(t, 0.9), 255 * Math.pow(t, 0.75)]; }
  function palHeat(t) {
    t = Math.max(0, Math.min(1, t));
    const C = [[2, 3, 5], [16, 13, 52], [41, 133, 158], [237, 194, 59], [255, 255, 245]];
    const stops = [0, 0.25, 0.5, 0.78, 1];
    for (let i = 0; i < 4; i++) {
      if (t <= stops[i + 1]) {
        const k = (t - stops[i]) / (stops[i + 1] - stops[i]);
        const a = C[i], b = C[i + 1];
        return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      }
    }
    return C[4];
  }
  const PALS = [palGray, palHeat, palHeNe, palCyan];

  /* ───────── 参数定义 ───────── */
  const CTRL_DEFS = [
    { key: 'lambda', label: '激光波长 λ', unit: 'nm', min: 405, max: 680, step: 0.1, s: 1e9, d: 1, hint: 'HeNe 632.8' },
    { key: 'f1', label: '傅里叶透镜 L₁', unit: 'mm', min: 85, max: 220, step: 1, s: 1e3, d: 0, hint: '受台面长度限制 85–220' },
    { key: 'f2', label: '二次变换透镜 L₂', unit: 'mm', min: 60, max: 250, step: 1, s: 1e3, d: 0, hint: '受台面长度限制 60–250' },
    { key: 'dx', label: '输入面采样间距', unit: 'µm', min: 4, max: 40, step: 0.5, s: 1e6, d: 1, hint: 'SLM 像素尺寸' },
    { key: 'aFac', label: '半间距 a / L', unit: '', min: 0.06, max: 0.235, step: 0.001, s: 1, d: 3 },
    { key: 'wFac', label: '目标尺寸 w / L', unit: '', min: 0.08, max: 0.33, step: 0.002, s: 1, d: 3 },
    { key: 'sigma', label: '照明高斯 σ', unit: '·L/2', min: 0.2, max: 2.5, step: 0.01, s: 1, d: 2 },
    { key: 'illum', label: '照明非均匀度', unit: '', min: 0, max: 1, step: 0.01, s: 1, d: 2 },
    // 仅在对应 JPS 处理方式下才有意义，做条件显示
    { key: 'jpsThresh', label: '二值化 / 相位化阈值', unit: '', min: 0.005, max: 0.6, step: 0.005, s: 1, d: 3, show: (p) => p.jpsMode === 1 || p.jpsMode === 2 },
    { key: 'hpCut', label: '高通径向截止', unit: '·f_N', min: 0, max: 0.4, step: 0.005, s: 1, d: 3, show: (p) => p.jpsMode === 3 },
    { key: 'quantum', label: '记录量化位数', unit: 'bit', min: 1, max: 8, step: 0.25, s: 1, d: 2, hint: '8 = 连续' },
  ];

  /* ═══════════ UI 类 ═══════════ */
  class UI {
    constructor(app) {
      this.app = app;
      this.slot = 'f';                 // 当前编辑的目标槽
      this.fieldTab = 'input';
      this.logJps = true;
      this.cache = {};
      this._lastField = null;
    }

    /* ── 初始化 ── */
    init() {
      this._buildControls();
      this._buildPatterns();
      this._buildSteps();
      this._buildParts();
      this._buildChain();
      this._bindTop();
      this._bindField();
      this._bindMisc();
      this._buildFaults();
      this._buildLabAdj();
      this.updatePatternMarks();
      /* 提示条位置跟随弹窗开合（弹窗内 → 底部，弹窗外 → 顶部中央） */
      try {
        const obs = new MutationObserver(() => this.syncToastPlacement());
        document.querySelectorAll('.modal, .fieldfull').forEach(el =>
          obs.observe(el, { attributes: true, attributeFilter: ['class'] }));
      } catch (e) { /* 老浏览器无 MutationObserver：toast() 里仍会同步一次 */ }
      /* 图例：以前这个元素一直是空的（setLegend 从没被调用过），
         左下角就挂着一个 24×14 的空盒子。补上三条真正需要解释的编码。 */
      this.setLegend([
        { c: 'linear-gradient(90deg,#ff2f2a,#ff8a5c)', t: '光路' },
        { c: '#57d7ff', t: '数据链路（JPS 电子读出）' },
        { c: '#fbbf24', t: '光斑截面（1/e² 半径）' },
        { c: '#22d3ee', t: '选中器件' },
      ]);
    }

    /* ───────── 参数控件 ───────── */
    _buildControls() {
      const host = $('#ctrlList');
      host.innerHTML = '';
      this.ctrlEls = {};
      for (const d of CTRL_DEFS) {
        const wrap = document.createElement('div');
        wrap.className = 'ctrl';
        const head = document.createElement('div');
        head.className = 'ctrl-h';
        const cur = this.app.jtc.p[d.key] * d.s;
        head.innerHTML = `<label>${d.label}${d.hint ? ` <span style="opacity:.5">· ${d.hint}</span>` : ''}</label>` +
          `<b class="val">${cur.toFixed(d.d)}<span class="unit">${d.unit}</span></b>`;
        const inp = document.createElement('input');
        inp.type = 'range';
        inp.min = d.min; inp.max = d.max; inp.step = d.step; inp.value = cur;
        wrap.appendChild(head); wrap.appendChild(inp);
        host.appendChild(wrap);
        const valEl = $('.val', head);
        this.ctrlEls[d.key] = { inp, valEl, def: d };
        inp.addEventListener('input', () => {
          const v = parseFloat(inp.value);
          valEl.innerHTML = v.toFixed(d.d) + `<span class="unit">${d.unit}</span>`;
          this.app.setParam(d.key, v / d.s);
        });
      }
      this.refreshCtrlVisibility();
    }

    /** 条件控件：只在相关模式下显示（避免"看起来能调、其实没用"的旋钮） */
    refreshCtrlVisibility() {
      const p = this.app.jtc.p;
      for (const k in this.ctrlEls) {
        const e = this.ctrlEls[k], d = e.def;
        if (!d.show) continue;
        const vis = !!d.show(p);
        e.inp.parentNode.style.display = vis ? '' : 'none';
      }
    }

    syncControls() {
      for (const k in this.ctrlEls) {
        const e = this.ctrlEls[k], d = e.def;
        const v = this.app.jtc.p[k] * d.s;
        e.inp.value = v;
        e.valEl.innerHTML = v.toFixed(d.d) + `<span class="unit">${d.unit}</span>`;
      }
    }

    /* ───────── 图案网格 ───────── */
    _buildPatterns() {
      const host = $('#patternGrid');
      host.innerHTML = '';
      this.patEls = {};
      for (const p of PATTERNS.LIST) {
        const d = document.createElement('div');
        d.className = 'pat';
        d.dataset.id = p.id;
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        cv.getContext('2d').drawImage(thumbCanvas(p.id, 64), 0, 0);
        const sp = document.createElement('span');
        sp.textContent = p.label;
        d.appendChild(cv); d.appendChild(sp);
        d.title = `${p.group} · ${p.label}`;
        d.addEventListener('click', () => {
          this.app.setPattern(this.slot, p.id);
          this.updatePatternMarks();
        });
        host.appendChild(d);
        this.patEls[p.id] = d;
      }
      // 槽选择
      const tabs = $('#slotTabs');
      if (tabs) {
        $$('button', tabs).forEach(b => b.addEventListener('click', () => {
          this.slot = b.dataset.slot;
          $$('button', tabs).forEach(x => x.classList.toggle('on', x === b));
          this.updatePatternMarks();
        }));
      }
    }

    updatePatternMarks() {
      const f = this.app.jtc.fName, g = this.app.jtc.gName;
      for (const id in this.patEls) {
        const el = this.patEls[id];
        el.classList.toggle('on', id === f);
        el.classList.toggle('g', id === g);
        const sp = $('span', el);
        sp.textContent = (PATTERNS.LIST.find(p => p.id === id) || {}).label || id;
      }
      // 用角标标出 g
      for (const id in this.patEls) {
        const el = this.patEls[id];
        el.style.boxShadow = '';
        if (id === this.app.jtc.gName) el.style.boxShadow = 'inset 0 0 0 2px rgba(244,114,182,.75)';
      }
      const fr = this.app.jtc.fName, gr = this.app.jtc.gName;
      const same = fr === gr;
      const info = $('#patternInfo');
      if (info) info.textContent = same ? 'f ≡ g · 应出现锐利相关峰' : 'f ≠ g · 峰强度与锐度下降';

      // 面板内的 f / g 预览
      const lab = (id) => (PATTERNS.LIST.find(p => p.id === id) || {}).label || id;
      for (const [el, id] of [['#pnF', fr], ['#pnG', gr]]) {
        const cv = $(el);
        if (!cv) continue;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.drawImage(thumbCanvas(id, 64), 0, 0, cv.width, cv.height);
      }
      const names = $('#pnNames');
      if (names) names.textContent = same ? `${lab(fr)} ≡ ${lab(gr)}` : `${lab(fr)} ⋆ ${lab(gr)}`;
    }

    /* ───────── 步骤 ───────── */
    _buildSteps() {
      const host = $('#stepList');
      host.innerHTML = '';
      this.stepEls = [];
      for (const s of this.app.steps) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="sn">${s.n}</span><div class="st"><b>${s.title}</b><span>${s.brief || ''}</span></div>`;
        li.title = s.brief || s.title;       // 收起的说明用悬停补全
        li.addEventListener('click', () => this.app.gotoStep(s.i));
        host.appendChild(li);
        this.stepEls.push(li);
      }
    }

    markSteps(cur, doneSet) {
      this.stepEls.forEach((el, i) => {
        el.classList.toggle('on', i === cur);
        el.classList.toggle('done', doneSet && doneSet.has(i));
      });
      // 左栏高度有限，当前步骤可能滚出视野——始终把它带回可见区
      const el = this.stepEls[cur];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      this._updateFades();
    }

    /** 列表还有内容没露出来时，底部做渐隐，避免「只有 3 步」的错觉 */
    _updateFades() {
      for (const sel of ['#stepList', '#diagList', '#partList']) {
        const el = $(sel);
        if (!el) continue;
        el.classList.toggle('more', el.scrollHeight - el.clientHeight - el.scrollTop > 4);
      }
    }

    /* ───────── 元件列表 ───────── */
    _buildParts() {
      const host = $('#partList');
      host.innerHTML = '';
      this.partEls = {};
      for (const p of LAB.PART_INFO) {
        const d = document.createElement('div');
        d.className = 'part';
        d.innerHTML = `<div class="part-i">${p.idx}</div>
          <div class="part-t"><b>${p.label}</b><span>${p.spec}</span></div>
          <div class="part-s"></div>`;
        d.addEventListener('click', () => this.app.focusPart(p.tag));
        host.appendChild(d);
        this.partEls[p.tag] = d;
      }
    }

    markPart(tag, state) {
      for (const t in this.partEls) {
        this.partEls[t].classList.toggle('on', t === tag);
        const s = $('.part-s', this.partEls[t]);
        s.className = 'part-s' + (state && state[t] ? ' ' + state[t] : '');
      }
    }

    /* ───────── 数据链 ───────── */
    _buildChain() {
      const host = $('#chain');
      host.innerHTML = '';
      this.chainEls = [];
      const nodes = [
        ['输入面', 'h(x,y)'], ['光谱面', '|FT|²'], ['JPS', 'S(u,v)'],
        ['二次变换', 'FT{S}'], ['相关面', 'o(ξ,η)'], ['判决', 'peak'],
      ];
      nodes.forEach((n, i) => {
        if (i) {
          const a = document.createElement('span');
          a.className = 'arrow'; a.textContent = '›';
          host.appendChild(a);
        }
        const d = document.createElement('div');
        d.className = 'node';
        d.innerHTML = `<b class="nb">${n[0]}</b><span class="nv">${n[1]}</span>`;
        host.appendChild(d);
        this.chainEls.push(d);
      });
    }

    setChain(activeIdx, vals) {
      this.chainEls.forEach((el, i) => {
        el.classList.toggle('act', i === activeIdx);
        if (vals && vals[i] !== undefined) $('.nv', el).textContent = vals[i];
      });
    }

    /* ───────── 诊断 ─────────
       两列排布；与右栏「识别结果」重复的质量指标（V / SNR / 分离度 / 截断 / 均匀度）
       不再重复列 —— 17 行挤在 132 px 里只能看见三分之一，等于没写。 */
    renderDiag(list) {
      const host = $('#diagList');
      const items = list.filter(d => !d.dup);
      host.innerHTML = items.map(d =>
        `<div class="drow"><span class="k" title="${d.note || ''}">${d.k}</span><span class="v ${d.st}" title="${d.note || ''}">${d.v}</span></div>`
      ).join('');
      this._updateFades();
    }

    /** 挑出最严重的一项判据，给出「原因 + 动作」 */
    _advice(q) {
      if (q.pinFlux < 0.70) return ['bad', `针孔透过率只剩 ${(q.pinFlux * 100).toFixed(0)}% —— 焦斑没落在针孔上，点「一键对中」或按 ←→↑↓ 微调`];
      if (q.fringeVis < 0.35) return ['bad', `条纹对比度 V=${q.fringeVis.toFixed(2)} —— 谱面/输出面离焦或照明不均，先把 CMOS 拖回 L₁ 后焦面`];
      if (q.blocked > 0.08) return ['warn', `光阑截断 ${(q.blocked * 100).toFixed(0)}% —— 照明光阑②开得太小，已经切掉目标轮廓`];
      if (q.sepMargin < 1.05) return ['warn', `一级/零级分离度 ${q.sepMargin.toFixed(2)} —— 半间距 a 偏小，一级峰会被零级淹没`];
      if (q.snr < 60) return ['warn', `记录信噪比 ${q.snr.toFixed(0)} —— 到达探测器的光太弱，相关峰被噪声淹没`];
      if (q.illumU < 0.40) return ['warn', `照明均匀度 ${q.illumU.toFixed(2)} —— 高斯照明太窄，目标边缘照度不足`];
      return ['ok', '六项判据全部达标 —— 可以记录功率谱并读相关峰了'];
    }

    /** 光束半径剖面：横轴 = 台面位置，纵轴 = 该处 1/e² 光斑半径 */
    drawBeamChart(model) {
      const cv = $('#bcCanvas');
      if (!cv || !model || !model.nodes || model.nodes.length < 2) return;
      const W = cv.width, H = cv.height, ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      // 用「按孔径夹紧后的物理值」：光阑关小后曲线会跟着掉下来，而不是画一条穿墙的直线
      const nodes = (model.phys || model.nodes).slice().sort((a, b) => a.x - b.x);
      const x0 = nodes[0].x, x1 = nodes[nodes.length - 1].x;
      const span = Math.max(1e-3, x1 - x0);
      let wMax = 0;
      for (const n of nodes) wMax = Math.max(wMax, n.w);
      wMax = Math.max(wMax * 1.25, 1e-4);
      const PADL = 26, PADR = 8, PADT = 10, PADB = 20;
      const px = (x) => PADL + (x - x0) / span * (W - PADL - PADR);
      const py = (w) => H - PADB - (w / wMax) * (H - PADT - PADB);

      // 网格 + 纵轴刻度（mm）
      ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
      ctx.font = '9px ui-monospace,monospace'; ctx.fillStyle = 'rgba(255,255,255,.35)';
      for (let i = 0; i <= 2; i++) {
        const wv = wMax * i / 2, y = Math.round(py(wv)) + .5;
        ctx.beginPath(); ctx.moveTo(PADL, y); ctx.lineTo(W - PADR, y); ctx.stroke();
        ctx.fillText((wv * 1e3).toFixed(1), 2, y + 3);
      }

      // 曲线下的填充
      const g = ctx.createLinearGradient(0, PADT, 0, H - PADB);
      g.addColorStop(0, 'rgba(34,211,238,.42)');
      g.addColorStop(1, 'rgba(34,211,238,.04)');
      ctx.beginPath();
      ctx.moveTo(px(nodes[0].x), H - PADB);
      for (const n of nodes) ctx.lineTo(px(n.x), py(n.w));
      ctx.lineTo(px(nodes[nodes.length - 1].x), H - PADB);
      ctx.closePath(); ctx.fillStyle = g; ctx.fill();

      // 曲线
      ctx.beginPath();
      nodes.forEach((n, i) => i ? ctx.lineTo(px(n.x), py(n.w)) : ctx.moveTo(px(n.x), py(n.w)));
      ctx.strokeStyle = 'rgba(120,230,255,.95)'; ctx.lineWidth = 1.6; ctx.stroke();

      // 元件刻度 + 编号
      const list = (window.LAB && LAB.PART_INFO) || [];
      const partsMap = this.app.lab && this.app.lab.parts;
      const tagAt = (x) => {
        if (!partsMap) return null;
        for (const [tag, node] of partsMap) if (Math.abs(node.pos[0] - x) < 2e-4) return tag;
        return null;
      };
      ctx.font = '8px ui-monospace,monospace';
      ctx.textAlign = 'center';
      for (const n of nodes) {
        const X = Math.round(px(n.x)) + .5;
        ctx.strokeStyle = 'rgba(255,255,255,.16)';
        ctx.beginPath(); ctx.moveTo(X, PADT); ctx.lineTo(X, H - PADB); ctx.stroke();
        ctx.fillStyle = 'rgba(140,225,255,.95)';
        ctx.beginPath(); ctx.arc(X, py(n.w), 2.2, 0, Math.PI * 2); ctx.fill();
        const tag = tagAt(n.x);
        const p = tag && list.find(q => q.tag === tag);
        if (p) {
          ctx.fillStyle = 'rgba(255,255,255,.42)';
          ctx.fillText(p.idx, X, H - 8);
        }
      }
      ctx.textAlign = 'left';
      // 峰值读数
      let pk = nodes[0];
      for (const n of nodes) if (n.w > pk.w) pk = n;
      ctx.fillStyle = 'rgba(255,255,255,.62)';
      ctx.font = '9px ui-monospace,monospace';
      ctx.fillText(`max ⌀${(pk.w * 2e3).toFixed(1)} mm`, PADL + 4, PADT + 8);
      // 横轴：0 → 全长 mm
      ctx.fillStyle = 'rgba(255,255,255,.28)';
      ctx.fillText('0', PADL - 2, H - 3);
      ctx.fillText(`${(span * 1e3).toFixed(0)} mm`, W - PADR - 34, H - 3);
    }

    /* ───────── 指标 ───────── */
    renderMetrics(res, jtc) {
      const host = $('#metrics');
      const a = res.analysis;
      const q = this.app.quality();
      const pct = (v) => (v * 100).toFixed(1) + '%';
      const mm = (v) => (v * 1e3).toFixed(3);

      const err = a.err;
      const verdict = this._verdict(res, jtc);
      host.innerHTML = `
        <div class="met"><label title="相关峰实测位置 ξ">峰位 ξ</label><b>${a.peakValid === false ? '—' : (a.peakXi * 1e3).toFixed(3) + '<span style="font-size:8px;color:var(--txt-3)"> mm</span>'}</b></div>
        <div class="met"><label title="理论位置 2a·f₂/f₁">理论 ξ</label><b style="color:var(--cyan)">${(a.theory * 1e3).toFixed(3)}<span style="font-size:8px;color:var(--txt-3)"> mm</span></b></div>
        <div class="met"><label title="峰位相对理论位置的偏差">偏差</label><b class="${a.peakValid === false ? 'bad' : err < 0.06 ? 'ok' : err < 0.15 ? 'warn' : 'bad'}">${a.peakValid === false ? '—' : pct(err)}</b></div>
        <div class="met"><label title="一级峰与零级的强度比">峰/零级</label><b class="${a.ratio > 0.6 ? 'ok' : a.ratio > 0.15 ? 'warn' : 'bad'}">${a.ratio.toFixed(2)}</b></div>
        <div class="met"><label title="峰/旁瓣比 PSR">PSR</label><b class="${a.psr > 30 ? 'ok' : a.psr > 8 ? 'warn' : 'bad'}">${a.psr.toFixed(1)}</b></div>
        <div class="met"><label title="相关峰半高全宽">FWHM</label><b>${a.fwhmUm.toFixed(1)}<span style="font-size:8px;color:var(--txt-3)"> µm</span></b></div>
        <div class="met"><label title="能量守恒校验 Σ|H|²/Σ|h|²">能量守恒</label><b class="${Math.abs(res.parseval - 1) < 0.02 ? 'ok' : 'warn'}">${res.parseval.toFixed(4)}</b></div>
        <div class="met"><label title="${res.applied}">谱面</label><b style="font-size:10px">${String(res.applied).split('·')[0].trim()}</b></div>
        <div class="met"><label title="记录信噪比（峰 / 背景）">SNR</label><b>${q.snr > 999 ? '∞' : Math.round(q.snr)}</b></div>
        <div class="met wide"><label>识别判决</label><b class="${verdict.st}">${verdict.txt}</b></div>`;

      // 质量判据：把「学生做错了什么」翻译成一眼能看懂的数字
      const qh = $('#quality');
      if (qh) {
        const cls = (v, ok, warn) => v >= ok ? 'ok' : v >= warn ? 'warn' : 'bad';
        qh.innerHTML =
          `<div class="q"><label>条纹对比度 V</label><b class="${cls(q.fringeVis, 0.5, 0.15)}">${q.fringeVis.toFixed(2)}</b></div>` +
          `<div class="q"><label>针孔透过率</label><b class="${cls(q.pinFlux, 0.8, 0.3)}">${(q.pinFlux * 100).toFixed(0)}%</b></div>` +
          `<div class="q"><label>一级/零级分离度</label><b class="${cls(q.sepMargin, 1.15, 1.0)}">${q.sepMargin.toFixed(2)}</b></div>` +
          `<div class="q"><label>记录信噪比</label><b class="${cls(q.snr, 120, 30)}">${q.snr > 999 ? '∞' : q.snr.toFixed(0)}</b></div>` +
          `<div class="q"><label>照明均匀度</label><b class="${cls(q.illumU, 0.5, 0.35)}">${q.illumU.toFixed(2)}</b></div>` +
          `<div class="q"><label>光阑截断</label><b class="${q.blocked < 0.05 ? 'ok' : q.blocked < 0.25 ? 'warn' : 'bad'}">${(q.blocked * 100).toFixed(1)}%</b></div>`;
        // 一句话解释「为什么红了 + 该怎么改」，把判据从结果变成指导
        const ad = this._advice(q);
        qh.innerHTML += `<div class="q-adv ${ad[0]}"><b>${ad[1]}</b></div>`;
      }
    }

    _verdict(res, jtc) {
      const same = jtc.fName === jtc.gName;
      const a = res.analysis, q = res.quality || {};
      /* 「没有峰」只有在光路本身是好的时候才能当成「不相关」的证据。
         离焦 / 偏心 / 光弱时任何一对目标都不会出峰 —— 这时报「判别正确 ✓」
         会把一台坏掉的系统说成工作正常，是本实验最误导人的结论。 */
      const healthy = (q.fringeVis === undefined || q.fringeVis > 0.15) &&
        (q.snr === undefined || q.snr > 60) && a.err < 0.06;
      if (a.valid === false) {
        if (same) {
          return { st: 'bad', txt: '无有效相关峰 —— 峰不显著或位置偏离（离焦 / 偏心 / 光弱，见光路诊断）' };
        }
        if (!healthy) {
          return { st: 'warn', txt: '判决不可信 —— 光路没调好（条纹 / 信噪比 / 峰位不达标），先看「光路诊断」' };
        }
        return { st: 'ok', txt: '不相关 —— 未形成有效峰 ✓（f ≢ g，判别正确）' };
      }
      const sharp = a.psr > 12 && a.fwhmUm < jtc.w * 1e6 * 0.9;
      const strong = a.ratio > 0.22;
      if (same) {
        if (sharp && strong) return { st: 'ok', txt: '相关 —— f ≡ g，出现锐利互相关峰 ✓' };
        if (strong) return { st: 'warn', txt: '相关但峰较弥散（受照明/量化/阈值影响）' };
        return { st: 'bad', txt: '峰被零级淹没，建议减小 a 或启用二值化 JPS' };
      } else {
        if (!strong || !sharp) return { st: 'ok', txt: '不相关 —— 未形成明显峰 ✓（判别正确）' };
        return { st: 'warn', txt: '出现可疑峰，两目标可能部分相似' };
      }
    }

    /* ───────── 光场视图 ───────── */
    _bindField() {
      this.cmpOn = false;
      this.cmpSplit = 0.5;
      $$('#fieldTabs button').forEach(b => b.addEventListener('click', () => {
        this.fieldTab = b.dataset.f;
        $$('#fieldTabs button').forEach(x => x.classList.toggle('on', x === b));
        this.app.redrawField();
      }));
      // 冻结参考 → 再次点击取消
      const ref = $('#btnFieldRef');
      if (ref) ref.addEventListener('click', () => this.app.toggleFieldRef());
      const full = $('#btnFieldFull');
      if (full) full.addEventListener('click', () => this.app.openFieldFull());
      // 剖面方向 ξ / η
      this.profileAxis = 'x';
      $$('#pvTabs button').forEach(b => b.addEventListener('click', () => {
        this.profileAxis = b.dataset.a;
        $$('#pvTabs button').forEach(x => x.classList.toggle('on', x === b));
        const lab = $('#pvAxis');
        if (lab) lab.textContent = this.profileAxis === 'x' ? 'ξ' : 'η';
        this.app.redrawField();
      }));

      // 双击光场直接全屏
      const fc = $('#fieldCanvas');
      if (fc) {
        fc.addEventListener('dblclick', () => this.app.openFieldFull());
        // 对比模式下可直接拖动分界线
        let sdrag = false;
        const setSplit = (e) => {
          const rc = fc.getBoundingClientRect();
          const x = (e.clientX - rc.left) / Math.max(1, rc.width);
          this.cmpSplit = Math.max(0.02, Math.min(0.98, x));
          this.app.redrawField();
        };
        fc.addEventListener('mousedown', (e) => {
          if (!this.cmpOn || !this.app.fieldRef) return;
          e.preventDefault(); sdrag = true; setSplit(e);
        });
        window.addEventListener('mousemove', (e) => { if (sdrag) setSplit(e); });
        window.addEventListener('mouseup', () => { sdrag = false; });
      }
    }

    /** 绘制一张光场（data 为 M×M 数组，行 0 = 顶部） */
    drawField(data, M, el, opts) {
      opts = opts || {};
      const cv = el || $('#fieldCanvas');
      if (cv.width !== M) { cv.width = M; cv.height = M; }
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(M, M);
      const d = img.data;
      let mx = 0;
      for (let i = 0; i < data.length; i++) if (data[i] > mx) mx = data[i];
      mx = opts.max || mx || 1;
      const inv = 1 / mx;
      const pal = PALS[opts.palette === undefined ? 1 : opts.palette];
      /* floor / gain / gamma 必须能精确复现 GPU 屏的显示链：
         v = data/max → log(1+v/floor)/log(1+1/floor) → ×gain → ^gamma
         这样 3D 悬浮屏、右栏小图、大图看到的是同一张图（连噪点都一样）。
         旧版 `opts.floor || 0.004` 把「floor = 0（线性）」也变成了 0.004。 */
      const log = !!opts.log && opts.floor !== 0;
      const floor = opts.floor === undefined ? 0.004 : Math.max(1e-9, opts.floor);
      const lgNorm = 1 / Math.log(1 + 1 / floor);
      const gain = opts.gain === undefined ? 1 : opts.gain;
      const gamma = opts.gamma === undefined ? 1 : opts.gamma;
      for (let i = 0; i < M * M; i++) {
        let v = data[i] * inv;
        if (log) v = Math.log(1 + v / floor) * lgNorm;
        if (gain !== 1) v *= gain;
        v = Math.max(0, Math.min(1, Math.pow(v, gamma)));
        const c = pal(v);
        d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      if (opts.marks) this._drawMarks(ctx, M, opts.marks);
      return mx;
    }

    _drawMarks(ctx, M, marks, lw) {
      const half = M / 2;
      ctx.save();
      ctx.lineWidth = lw || Math.max(1, M / 300);
      for (const m of marks) {
        if (m.kind === 'cross') {
          ctx.strokeStyle = m.color || 'rgba(163,230,53,.9)';
          ctx.beginPath();
          ctx.arc(m.x, m.y, m.r || 12, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(m.x - 18, m.y); ctx.lineTo(m.x - 6, m.y);
          ctx.moveTo(m.x + 6, m.y); ctx.lineTo(m.x + 18, m.y);
          ctx.moveTo(m.x, m.y - 18); ctx.lineTo(m.x, m.y - 6);
          ctx.moveTo(m.x, m.y + 6); ctx.lineTo(m.x, m.y + 18);
          ctx.stroke();
        } else if (m.kind === 'line') {
          ctx.strokeStyle = m.color || 'rgba(255,255,255,.35)';
          ctx.setLineDash(m.dash || [4, 4]);
          ctx.beginPath();
          if (m.v) { ctx.moveTo(m.v, 0); ctx.lineTo(m.v, M); }
          if (m.h) { ctx.moveTo(0, m.h); ctx.lineTo(M, m.h); }
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.restore();
    }

    /** 调色板的 CSS 渐变（用于全屏视图的色标条） */
    palCss(i) {
      const p = PALS[i === undefined ? 1 : i];
      const st = [];
      for (let k = 0; k <= 12; k++) {
        const c = p(k / 12);
        st.push(`rgb(${c[0]},${c[1]},${c[2]}) ${(k / 12 * 100).toFixed(1)}%`);
      }
      return 'linear-gradient(90deg,' + st.join(',') + ')';
    }

    /** 剖面曲线 */
    drawProfile(prof, M, scale, opts) {
      const cv = $('#profileCanvas');
      const W = cv.width, H = cv.height;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#04070c'; ctx.fillRect(0, 0, W, H);

      let mx = 0;
      for (let i = 0; i < prof.length; i++) if (prof[i] > mx) mx = prof[i];
      mx = mx || 1;
      const lg = opts && opts.log;
      const floor = 0.004, lgN = 1 / Math.log(1 + 1 / floor);
      const val = (v) => { let x = v / mx; if (lg) x = Math.log(1 + x / floor) * lgN; return Math.max(0, Math.min(1, x)); };

      // 网格
      ctx.strokeStyle = 'rgba(255,255,255,.055)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = Math.round(H * i / 4) + .5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      // 理论峰位刻度
      const half = M / 2;
      const xOf = (px) => (px / M) * W;
      if (opts && opts.theoryPx !== undefined) {
        for (const s of [-1, 1]) {
          const px = half + s * opts.theoryPx;
          if (px < 0 || px > M) continue;
          ctx.strokeStyle = 'rgba(34,211,238,.5)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(xOf(px), 0); ctx.lineTo(xOf(px), H); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      // 曲线
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(244,114,182,.85)');
      grad.addColorStop(1, 'rgba(244,114,182,.06)');
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < M; i++) {
        const x = (i / (M - 1)) * W;
        const y = H - val(prof[i]) * (H - 3) - 2;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.strokeStyle = 'rgba(244,114,182,1)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let i = 0; i < M; i++) {
        const x = (i / (M - 1)) * W;
        const y = H - val(prof[i]) * (H - 3) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 坐标轴标注
      ctx.font = '9px ui-monospace,monospace';
      ctx.fillStyle = 'rgba(147,163,184,.85)';
      const span = (M * scale);
      ctx.fillText('−' + (span / 2 * 1e3).toFixed(1) + ' mm', 4, H - 4);
      const t = '+' + (span / 2 * 1e3).toFixed(1) + ' mm';
      ctx.fillText(t, W - ctx.measureText(t).width - 4, H - 4);
      ctx.fillStyle = 'rgba(34,211,238,.8)';
      ctx.fillText('ξ = 0', W / 2 - 14, 11);
    }

    /* ───────── 元件检视 ───────── */
    /** 关闭检视面板：记下「用户主动关掉了」，否则下一次参数刷新又会自己弹回来 */
    closeInspect() {
      this._insClosed = true;
      $('#inspect').classList.add('hidden');
    }

    showInspect(node, info) {
      const el = $('#inspect');
      if (!node) { el.classList.add('hidden'); this._insTag = null; return; }
      if (this._insClosed) return;          // 用户按过 ✕，等重新选器件再显示
      el.classList.remove('hidden');
      $('#insName').textContent = info.label;
      const j = this.app.jtc;
      const x = node.pos[0];
      /* 规格里的「可调项」要显示**当前值**：P2 已经转到 30° 了，
         面板还写着「线偏振 · 90°（正交）」，等于仪器读数不跟着操作走。 */
      const hw = this.app.hw;
      let spec = info.spec;
      if (node.tag === 'pol1') spec = `线偏振 · ${hw.pol1.toFixed(0)}°`;
      else if (node.tag === 'pol2') spec = `线偏振 · ${hw.pol2.toFixed(0)}°${Math.abs(((hw.pol2 - hw.pol1 + 180) % 180) - 90) < 8 ? '（正交）' : '（未正交）'}`;
      else if (node.tag === 'iris2') spec = `通光半径 ${(hw.apIris2 * 1e3).toFixed(1)} mm`;
      else if (node.tag === 'sf') spec = `×20 物镜 + φ15 µm 针孔 · 偏心 ${(Math.hypot(hw.pinU, hw.pinV) * 1e6).toFixed(0)} µm`;
      $('#insBody').innerHTML = `
        <div class="r"><span>编号</span><b>${info.idx}</b></div>
        <div class="r"><span>规格</span><b>${spec}</b></div>
        <div class="r"><span>轴向位置</span><b>${(x * 1e3).toFixed(1)} mm</b></div>
        <div class="r"><span>距前一元件的间距</span><b>${this._gapText(node.tag, x)}</b></div>`;
      this._placeInspect(el, x);
      this._insTag = node.tag;
    }

    /** 检视面板贴着被选中的器件放：**优先放在器件下方**（台面那片空区），
        下方放不下再放上方。放在左右会挡住隔壁 2–4 件器件（器件是横向排成一排的），
        放在下方只压住台面，不会挡住任何器件，也不会挡住光束。
        原来固定钉在舞台左上角：选中最右边的输出屏时，面板离它 760 px，
        而且正好压住左上角的 HUD。 */
    _placeInspect(el, worldX) {
      const app = this.app;
      const pt = app._projectToCanvas([worldX, 0, 0]);
      if (!pt) return;                       // 器件在相机背后：保持原位
      const W = app.canvas.clientWidth || 1, H = app.canvas.clientHeight || 1;
      const w = el.offsetWidth || 238, h = el.offsetHeight || 132;
      let left = pt[0] - w / 2;
      left = Math.max(8, Math.min(W - w - 8, left));
      let top = pt[1] + 46;                  // 器件本体半径约 40 px，再留 6 px
      if (top + h > H - 8) top = Math.max(8, pt[1] - 46 - h);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    _gapText(tag, x) {
      /* 必须用 lab.order（含两块偏振片），不能用写死的旧列表：
         旧列表漏了 pol1 / pol2，于是「输入面 SLM 距前一元件」算成到光阑②的 130 mm，
         实际前一件是 P1（600 mm），真实间距只有 80 mm；P2 更是直接显示「—」。 */
      const order = (this.app.lab && this.app.lab.order) || [];
      const i = order.indexOf(tag);
      if (i <= 0) return '—';
      const prev = this.app.lab.parts.get(order[i - 1]);
      if (!prev) return '—';
      return ((x - prev.pos[0]) * 1e3).toFixed(1) + ' mm';
    }

    /* ───────── 顶栏 / 其他 ───────── */
    _bindTop() {
      $$('#modeSwitch button').forEach(b => b.addEventListener('click', () => {
        this.app.setMode(b.dataset.mode);
      }));
      $$('#viewSwitch button').forEach(b => b.addEventListener('click', () => {
        this.app.setView(b.dataset.view);
      }));
      $$('#viewTool button').forEach(b => b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'autorotate') { b.classList.toggle('on'); this.app.autoRotate = b.classList.contains('on'); }
        else this.app.viewAction(a);
      }));
    }

    _bindMisc() {
      // 左栏双页签：流程（步骤 + 典型错误） / 元件（11 件列表）
      $$('#leftTabs button').forEach(b => b.addEventListener('click', () => {
        $$('#leftTabs button').forEach(x => x.classList.toggle('on', x === b));
        const t = b.dataset.t;
        $('#paneSteps').classList.toggle('hidden', t !== 'steps');
        $('#paneParts').classList.toggle('hidden', t !== 'parts');
      }));
      $('#btnSolve').addEventListener('click', () => this.app.solve(true));
      $('#btnReset').addEventListener('click', () => this.app.resetParams());
      // 参数面板折叠
      const pp = $('#paramPanel');
      const fold = () => {
        if (!pp) return;
        pp.classList.toggle('folded');
        const folded = pp.classList.contains('folded');
        const b = $('#btnFold');
        if (b) {
          // 箭头必须跟着状态变：一直显示 ▾ 时用户不知道点了是展开还是收起
          b.textContent = folded ? '▸' : '▾';
          b.title = folded ? '展开参数（12 项）' : '收起参数';
        }
      };
      const fb = $('#btnFold');
      if (fb) fb.addEventListener('click', fold);
      if (pp) {
        const head = pp.querySelector('.panel-h');
        head.style.cursor = 'pointer';
        head.title = '点击展开 / 收起参数滑块';
        head.addEventListener('click', (e) => {
          if (e.target.tagName === 'BUTTON') return;
          fold();
        });
      }
      $('#btnSwap').addEventListener('click', () => this.app.swapPatterns());
      $('#btnRandom').addEventListener('click', () => this.app.randomPatterns());
      // 目标图案选择弹窗
      const pm = $('#patModal');
      const openPat = () => pm && pm.classList.remove('hidden');
      $('#btnPickPat').addEventListener('click', openPat);
      $('#patClose').addEventListener('click', () => pm && pm.classList.add('hidden'));
      if (pm) pm.addEventListener('click', (e) => { if (e.target === pm) pm.classList.add('hidden'); });
      $('#btnAutoRun').addEventListener('click', () => this.app.toggleFaultDemo());
      $('#btnHelp').addEventListener('click', () => $('#helpModal').classList.remove('hidden'));
      $('#helpClose').addEventListener('click', () => $('#helpModal').classList.add('hidden'));
      $('#helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') $('#helpModal').classList.add('hidden'); });
      $('#btnShot').addEventListener('click', () => this.app.saveScreenshot());
      $('#btnUndo').addEventListener('click', () => this.app.undo());
      $('#btnRedo').addEventListener('click', () => this.app.redo());
      const br = $('#btnResetAll');
      if (br) br.addEventListener('click', () => {
        if (this.app._resetArmed) { this.app._resetArmed = false; this.app.resetSession(); br.classList.remove('armed'); return; }
        this.app._resetArmed = true; br.classList.add('armed');
        this.toast('再点一次「⨯」确认重置全部（3 秒内有效）', 'warn', 3000);
        clearTimeout(this._resetT);
        this._resetT = setTimeout(() => { this.app._resetArmed = false; br.classList.remove('armed'); }, 3000);
      });
      $('#btnExport').addEventListener('click', () => this.app.exportRecord());
      $('#insClose').addEventListener('click', () => this.closeInspect());
      $('#cbLogJps').addEventListener('change', (e) => { this.logJps = e.target.checked; this.app.redrawField(); });
      $('#cbAutocompute').addEventListener('change', (e) => { this.app.autoCompute = e.target.checked; });
      $('#gcPrev').addEventListener('click', () => this.app.gotoStep(this.app.stepIndex - 1));
      // 收起 / 展开：引导卡片占着舞台下半部，拖动器件时会挡住光路
      const gf = $('#gcFold');
      if (gf) gf.addEventListener('click', () => {
        const card = $('#guideCard');
        card.classList.toggle('folded');
        gf.textContent = card.classList.contains('folded') ? '⌃' : '⌄';
        gf.title = card.classList.contains('folded') ? '展开说明' : '收起说明（不挡光路）';
      });
      $('#gcNext').addEventListener('click', () => this.app.gotoStep(this.app.stepIndex + 1));
    }

    /* ───────── JPS 处理方式（让现代方法真正可及） ───────── */
    _bindJps() {
      const tabs = $('#jpsTabs');
      if (!tabs) return;
      $$('button', tabs).forEach(b => b.addEventListener('click', () => {
        const m = parseInt(b.dataset.jps, 10);
        this.app.setParam('jpsMode', m);
        $$('button', tabs).forEach(x => x.classList.toggle('on', x === b));
        this.refreshCtrlVisibility();
      }));
    }

    /* ───────── 光路调节：针孔微调盘 + 照明光阑 ───────── */
    _buildLabAdj() {
      this._bindJps();
      const pad = $('#pinPad');
      if (pad) {
        /* 针孔盘的坐标：视觉上 ±60 µm 对应盘的 ±46%（与指示点同步），
           所以「点哪儿 = 孔移到哪儿」，拖动也按同一比例，指示点正好跟着指针走。
           之前只支持拖动（点击完全没反应），而且拖动灵敏度（1.15 µm/px）与
           指示点的视觉比例（≈1.8 µm/px）不一致，拖到头指示点还没到头。 */
        const LIM = 60e-6, SPAN = 0.46;
        const scale = () => {
          const r = pad.getBoundingClientRect();
          return [LIM / Math.max(1, SPAN * r.width), LIM / Math.max(1, SPAN * r.height)];
        };
        let dragging = false, px = 0, py = 0;
        const apply = (dxPix, dyPix) => {
          const a = this.app, k = scale();
          a.setPinhole(a.hw.pinU + dxPix * k[0],
            a.hw.pinV - dyPix * k[1]);           // 屏幕 y 向下 → 竖直偏移反向
        };
        pad.addEventListener('pointerdown', (e) => {
          dragging = true; px = e.clientX; py = e.clientY;
          this.app._dragPreview = true; this.app._interacting = true;   // 拖动中走预览解 + 允许降分辨率
          // 点哪儿跳到哪儿（相对盘心的绝对定位）
          const r = pad.getBoundingClientRect(), k = scale();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          this.app.setPinhole((e.clientX - cx) * k[0], -(e.clientY - cy) * k[1]);
          try { pad.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件 */ }
          e.preventDefault();
        });
        pad.addEventListener('pointermove', (e) => {
          if (!dragging) return;
          apply(e.clientX - px, e.clientY - py);
          px = e.clientX; py = e.clientY;
        });
        const stop = () => { dragging = false; };
        pad.addEventListener('pointerup', stop);
        pad.addEventListener('pointercancel', stop);
        pad.addEventListener('pointerleave', stop);
      }
      const ir = $('#irisRange');
      if (ir) {
        ir.addEventListener('pointerdown', () => { this.app._dragPreview = true; this.app._interacting = true; });
        ir.addEventListener('input', () => {
          this.app.setIrisAp(parseFloat(ir.value) * 1e-3);
          this._syncIrisLabel();
        });
      }
      const pr = $('#polRange');
      if (pr) {
        pr.addEventListener('pointerdown', () => { this.app._dragPreview = true; this.app._interacting = true; });
        pr.addEventListener('input', () => {
          this.app.setPolarizer('pol2', parseFloat(pr.value));
        });
      }
      const bc = $('#btnPinCenter');
      if (bc) bc.addEventListener('click', () => this.app._autoCenterPinhole());
      $('#btnClearFaults') && $('#btnClearFaults').addEventListener('click', () => {
        this.app.stopFaultDemo();
        this.app.clearFaults();
        this.markFaults(this.app.faults);
      });
      /* 典型错误清单可折叠：低高度屏（1366×768）默认收起，
         否则它会把「实验流程」和「光路诊断」都挤到屏幕外。 */
      const ft = $('#faultsT');
      const faults = ft && ft.closest('.faults');
      if (ft && faults) {
        const setFolded = (folded) => {
          faults.classList.toggle('folded', folded);
          const c = $('#faultsCaret');
          if (c) c.textContent = folded ? '▸' : '▾';
        };
        let manual = false;                 // 用户手动开合过就不再自动跟随窗口
        this._setFaultsFolded = (v) => { manual = false; setFolded(!!v); };
        setFolded(window.innerHeight <= 840);
        ft.addEventListener('click', () => { manual = true; setFolded(!faults.classList.contains('folded')); });
        window.addEventListener('resize', () => { if (!manual) setFolded(window.innerHeight <= 840); });
      }
      this.syncPinholePad();
      this._syncIrisLabel();
    }

    _syncIrisLabel() {
      const el = $('#irisVal'), ir = $('#irisRange');
      if (el) el.textContent = (this.app.hw.apIris2 * 1e3).toFixed(1) + ' mm';
      if (ir) ir.value = (this.app.hw.apIris2 * 1e3).toFixed(1);
    }

    /** 针孔盘上的指示点与读数（偏心放大显示，便于观察） */
    syncPinholePad() {
      const a = this.app, dot = $('#pinDot');
      const q = a.quality();
      const lim = 60e-6;                        // 可视范围 ±60 µm
      if (dot) {
        const u = Math.max(-1, Math.min(1, a.hw.pinU / lim));
        const v = Math.max(-1, Math.min(1, a.hw.pinV / lim));
        dot.style.left = (50 + u * 46) + '%';
        dot.style.top = (50 - v * 46) + '%';
        dot.style.background = q.pinFlux > 0.8 ? 'var(--ok,#34d399)'
          : q.pinFlux > 0.3 ? 'var(--amber,#fbbf24)' : 'var(--bad,#f87171)';
      }
      const o = $('#pinOffVal'), f = $('#pinFluxVal');
      if (o) o.textContent = (q.pinOffset * 1e6).toFixed(1) + ' µm';
      if (f) {
        f.textContent = (q.pinFlux * 100).toFixed(0) + ' %';
        f.className = q.pinFlux > 0.8 ? 'ok' : q.pinFlux > 0.3 ? 'warn' : 'bad';
      }
    }

    /** 重新求解后同步与计算强相关的控件显示 */
    /** 偏振片读数：夹角 / 对比度系数 */
    syncPolUI() {
      const a = this.app, el = $('#polVal'), pr = $('#polRange'), note = $('#polNote');
      if (el) el.textContent = a.hw.pol2.toFixed(0) + '°';
      if (pr) pr.value = a.hw.pol2.toFixed(0);
      if (note) {
        const d = a._geom ? a._geom.polDelta : 90;
        const c = a._geom ? a._geom.polContrast : 1;
        note.textContent = d >= 82
          ? `Δ=${d.toFixed(0)}° · 对比度系数 ${c.toFixed(2)}（正交，最佳）`
          : `Δ=${d.toFixed(0)}° · 对比度系数 ${c.toFixed(2)}，条纹正在变淡`;
        note.style.color = d >= 82 ? '' : (d < 60 ? '#fca5a5' : '#fcd34d');
      }
    }

    syncLabControls() {
      this.syncPinholePad();
      this._syncIrisLabel();
      this.syncPolUI();
      const p = this.app.jtc.p;
      const tabs = $('#jpsTabs');
      if (tabs) $$('button', tabs).forEach(b => b.classList.toggle('on', +b.dataset.jps === p.jpsMode));
      this.refreshCtrlVisibility();
    }

    /* ───────── 典型错误清单 ───────── */
    _buildFaults() {
      const host = $('#faultList');
      if (!host) return;
      host.innerHTML = '';
      this.faultEls = {};
      for (const f of LAB.FAULTS) {
        const b = document.createElement('button');
        b.className = 'fchip';
        b.textContent = f.name;
        b.title = f.hint;
        b.addEventListener('click', () => {
          this.app.stopFaultDemo();
          this.app.toggleFault(f);      // 施加 / 复原都在这里，且一定会重新求解
        });
        host.appendChild(b);
        this.faultEls[f.id] = b;
      }
    }

    markFaults(set) {
      if (!this.faultEls) return;
      for (const id in this.faultEls) this.faultEls[id].classList.toggle('on', set.has(id));
    }

    /* ───────── 引导卡片 ───────── */
    setGuide(step, marks, devs) {
      const el = $('#guideCard');
      if (!step) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      $('#gcIdx').textContent = 'STEP ' + step.n;
      $('#gcTitle').textContent = step.title;
      $('#gcBody').textContent = step.body;
      const host = $('#gcCheck');
      host.innerHTML = (marks || []).map(m =>
        `<div class="${m.hit ? 'hit' : ''}"><span class="bx">${m.hit ? '✓' : ''}</span>${m.text}</div>`
      ).join('');
      // 偏差总览：与当前步骤无关的、全局正在发生的问题也一并列出
      const dh = $('#gcDevs');
      if (dh) {
        const list = (devs || []);
        dh.innerHTML = list.length
          ? '<div class="dv-h">当前偏差</div>' + list.map(d =>
            `<div class="dv ${d.sev}"><b>${d.k}</b>${d.txt}</div>`).join('')
          : '<div class="dv ok"><b>状态良好</b>所有关键判据都在容差内</div>';
      }
      $('#gcPrev').disabled = this.app.stepIndex <= 0;
      const act = $('#gcAct');
      if (act) {
        act.classList.toggle('hidden', !step.action);
        if (step.action) act.textContent = step.action;
      }
      $('#gcNext').textContent = this.app.stepIndex >= this.app.steps.length - 1 ? '完成' : '下一步';
    }

    /* ───────── HUD ───────── */
    setHud(o) {
      $('#tmFps').textContent = o.fps !== undefined ? o.fps.toFixed(0) : '—';
      $('#tmCompute').textContent = o.computeMs !== undefined ? o.computeMs.toFixed(1) + ' ms' : '—';
      $('#tmFft').textContent = o.fftMs !== undefined ? o.fftMs.toFixed(1) + ' ms' : '—';
      $('#tmRes').textContent = o.res || '—';
      if (o.tl !== undefined) $('#hudTL').innerHTML = o.tl;
      if (o.tr !== undefined) $('#hudTR').innerHTML = o.tr;
    }

    setLegend(items) {
      $('#legend3d').innerHTML = items.map(i =>
        `<span><i style="background:${i.c}"></i>${i.t}</span>`).join('');
    }

    /* ───────── Toast ───────── */
    /** 弹窗打开时把提示条挪到底部：顶部中央会正好压住弹窗标题栏与缩放按钮。
        用 MutationObserver 跟随弹窗开合 —— 否则「弹窗打开前就在显示的提示」
        会一直停在顶部，压住刚打开的大图标题栏。 */
    syncToastPlacement() {
      const host = $('#toast');
      if (!host) return;
      const modal = document.querySelector('.fieldfull:not(.hidden), .modal:not(.hidden)');
      host.classList.toggle('inmodal', !!modal);
    }

    toast(msg, kind, ms) {
      const host = $('#toast');
      this.syncToastPlacement();
      const el = document.createElement('div');
      el.className = 'tst' + (kind ? ' ' + kind : '');
      el.textContent = msg;
      host.appendChild(el);
      host.classList.add('show');
      setTimeout(() => {
        el.style.transition = 'opacity .3s, transform .3s';
        el.style.opacity = '0'; el.style.transform = 'translateY(-6px)';
        setTimeout(() => {
          el.remove();
          if (!host.children.length) host.classList.remove('show');
        }, 320);
      }, ms || 2200);
    }

    boot(p, msg) {
      const bar = $('#bootBar'), log = $('#bootLog');
      if (bar) bar.style.width = Math.round(p * 100) + '%';
      if (log && msg) log.textContent = msg;
    }
    bootDone() {
      const b = $('#boot');
      b.classList.add('gone');
      const app = $('#app');
      app.classList.remove('hidden');
      // 不依赖 requestAnimationFrame：页面处于后台时 rAF 不会触发，
      // 会让界面永远停在 opacity:0。直接加类，并保留一帧后的二次确认。
      app.classList.add('ready');
      requestAnimationFrame(() => app.classList.add('ready'));
      setTimeout(() => b.remove(), 900);
    }
  }

  /* 缩略图：直接用 PATTERNS 的数据绘制 */
  const _thumbCache = new Map();
  function thumbCanvas(id, px) {
    const key = id + '#' + px;
    if (_thumbCache.has(key)) return _thumbCache.get(key);
    const f = PATTERNS.get(id, px);
    const cv = document.createElement('canvas');
    cv.width = cv.height = px;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(px, px);
    for (let y = 0; y < px; y++) {
      const sy = px - 1 - y;                       // 数据行 0 = 底部 → 画布顶部
      for (let x = 0; x < px; x++) {
        const v = Math.max(0, Math.min(1, f[sy * px + x]));
        const c = palHeNe(v);
        const i = (y * px + x) * 4;
        img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    _thumbCache.set(key, cv);
    return cv;
  }

  global.OUI = { UI, PALS, palHeat, palHeNe };
})(window);
