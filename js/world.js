/* ═══════════════════════════════════════════════════════════
   world.js · 3D 箱庭世界 v2
   光路沿 +X 展开，光轴高度 y = 0，台面 y = −115 mm
   器件按真实光学机械建模：镜筒 / 压圈 / 滚花 / 千分头 /
   燕尾平移台 / 铭牌 / 线缆 / 警示标签
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const CFG = {
    AXIS_Y: 0,
    TABLE_Y: -0.115,
    TABLE_TH: 0.022,
    TABLE_L: 1.80,
    TABLE_W: 0.62,
    TABLE_CX: 0.70,
    PITCH: 0.025,
  };

  /* 光路严格按讲义图 3 的元件顺序排布：
     激光 → 空间滤波器 → 准直透镜 → 照明光阑 → 起偏器 P1 → SLM → 检偏器 P2
     → 傅里叶透镜 L → CMOS(谱面) ；第二步把 SLM 换成回放 JPS，同一套 L/CMOS 再变换一次。
     台面上把两步摊平成一条线（讲义图 3 也是上下两条光路），故 SLM₂/L₂ 是第二步的复用件。 */
  const LAYOUT = {
    laser: -0.020, iris1: 0.155, sf: 0.260, collim: 0.4388, iris2: 0.550,
    pol1: 0.600, input: 0.680, pol2: 0.722,
    lens1: 0.830, focal: 0.980, slm2: 1.130, lens2: 1.280, output: 1.430,
  };

  const PART_INFO = [
    { tag: 'laser', label: 'HeNe 激光器', spec: '632.8 nm · 2 mW', idx: '1', desc: '单频氦氖激光，TEM₀₀ 模，束腰在出光口附近（w₀≈1.6 mm）。电源为 3.2 kV 高压模块，注意高压线。' },
    { tag: 'iris1', label: '可变光阑（高度基准）', spec: 'φ1–25 mm · 基准', idx: '2', desc: '用近场/远场都能通过来判断光束是否与台面平行，是整条光路的高度基准。' },
    { tag: 'sf', label: '空间滤波器', spec: '×20 物镜 + φ15 µm 针孔', idx: '3', desc: '物镜把光束会聚到约 φ19 µm 的焦斑，针孔只让基模通过，滤掉高频噪声并产生干净球面波。' },
    { tag: 'collim', label: '准直透镜', spec: 'f = 150 mm · SM1 镜筒', idx: '4', desc: '针孔位于前焦面时出射平面波；偏离焦面则出射球面波，等效于频谱面离焦。' },
    { tag: 'iris2', label: '照明光阑', spec: '限制照明口径', idx: '5', desc: '把照明限制在刚好覆盖两个目标的范围内。关得太小会切掉目标轮廓，使一级相关项失真。' },
    { tag: 'pol1', label: '起偏器 P1', spec: '线偏振 · 0°', idx: '6', desc: '液晶只调制特定偏振分量，P1 把入射光变成线偏振。P1 与 P2 的相对角度决定 SLM 的振幅调制深度。' },
    { tag: 'input', label: '输入面 SLM', spec: 'f(x−a) + g(x+a)', idx: '7', desc: '反射式 LCOS 空间光调制器，显示待识别目标 f 与参考目标 g，中心分别位于 ∓a。第二步改为回放 JPS。' },
    { tag: 'pol2', label: '检偏器 P2', spec: '线偏振 · 90°（正交）', idx: '8', desc: '与 P1 正交时把液晶的偏振调制转换成强度调制，对比度最高；角度一偏，条纹对比度立刻下降。' },
    { tag: 'lens1', label: '傅里叶变换透镜 L₁', spec: 'f₁ = 150 mm', idx: '9', desc: '第一次傅里叶变换：后焦面得到 h 的复振幅谱，其强度即联合功率谱 JPS。' },
    { tag: 'focal', label: 'CMOS 谱面探测器', spec: '记录联合功率谱', idx: '10', desc: '靶面位于 L₁ 后焦面。离焦会让 JPS 被模糊圆卷积，条纹对比度与相关峰同时劣化。' },
    { tag: 'slm2', label: '读出 SLM₂（第二步）', spec: '回放 JPS', idx: '11', desc: '真实装置里第二步是同一片 SLM 改显示 JPS；这里为便于观察摊平成第二个器件，物理等价。' },
    { tag: 'lens2', label: '傅里叶变换透镜 L₂', spec: 'f₂ = 150 mm', idx: '12', desc: '第二次傅里叶变换（真实装置复用同一片 L），把 JPS 变换回相关面，在 ξ = ±2a·f₂/f₁ 处形成互相关峰。' },
    { tag: 'output', label: '相关输出面', spec: '互相关峰 @ ξ = ±2a', idx: '13', desc: '中心为零级自相关叠加，两侧为 f⋆g 与 g⋆f 的互相关峰。峰越锐、越亮，说明两目标越相似。' },
  ];

  /* ───────── 材质库（阳极氧化 / 不锈钢 / 黄铜 / 玻璃 …） ───────── */
  const mk = (o) => Object.assign({ kind: 'pbr', castShadow: true }, o);
  const MAT = {
    anodBlack: mk({ albedo: [0.088, 0.092, 0.102], metal: 0.26, rough: 0.35, wear: 0.66 }),
    anodDark: mk({ albedo: [0.145, 0.152, 0.166], metal: 0.42, rough: 0.33, wear: 0.72 }),
    anodClear: mk({ albedo: [0.520, 0.540, 0.572], metal: 0.86, rough: 0.30, wear: 0.50 }),
    aluFine: mk({ albedo: [0.610, 0.625, 0.648], metal: 0.95, rough: 0.22, wear: 0.42 }),
    steel: mk({ albedo: [0.660, 0.678, 0.706], metal: 1.0, rough: 0.20, wear: 0.34 }),
    steelDark: mk({ albedo: [0.260, 0.272, 0.292], metal: 0.92, rough: 0.30, wear: 0.5 }),
    chrome: mk({ albedo: [0.780, 0.800, 0.830], metal: 1.0, rough: 0.075, wear: 0.18 }),
    brass: mk({ albedo: [0.720, 0.548, 0.262], metal: 1.0, rough: 0.26, wear: 0.55 }),
    copper: mk({ albedo: [0.700, 0.390, 0.230], metal: 1.0, rough: 0.32, wear: 0.5 }),
    glass: mk({ albedo: [0.26, 0.34, 0.44], metal: 0.55, rough: 0.045, opacity: 0.11, wear: 0.04, castShadow: false }),
    glassCoat: mk({ albedo: [0.54, 0.46, 0.66], metal: 0.62, rough: 0.070, opacity: 0.58, wear: 0.04, castShadow: false }),
    rubber: mk({ albedo: [0.032, 0.033, 0.036], metal: 0.0, rough: 0.92, wear: 0.95 }),
    /* 偏振膜：偏青绿的半透明片，正反两面都有淡淡的反光 */
    /* 偏振膜：偏青绿的半透明片。粗糙度不能低——低粗糙度金属膜会把环境灯箱
       镜面反射成一块星形亮斑，看着像「膜上破了个洞」。 */
    polFilm: mk({ albedo: [0.045, 0.085, 0.075], metal: 0.0, rough: 0.55, opacity: 0.34, wear: 0.10, castShadow: false }),
    anodRed: mk({ albedo: [0.42, 0.075, 0.060], metal: 0.30, rough: 0.36, wear: 0.35 }),
    pcb: mk({ albedo: [0.028, 0.115, 0.075], metal: 0.06, rough: 0.66, wear: 0.6 }),
    chip: mk({ albedo: [0.045, 0.048, 0.052], metal: 0.22, rough: 0.52, wear: 0.3 }),
    panel: mk({ albedo: [0.070, 0.077, 0.088], metal: 0.30, rough: 0.40, wear: 0.45 }),
    white: mk({ albedo: [0.780, 0.790, 0.805], metal: 0.03, rough: 0.46, wear: 0.25 }),
    ceramic: mk({ albedo: [0.820, 0.815, 0.790], metal: 0.0, rough: 0.42, wear: 0.2 }),
    holeBody: mk({ albedo: [0.010, 0.011, 0.013], metal: 0.05, rough: 0.96, doubleSided: true, wear: 0.1, castShadow: false }),
    holeRim: mk({ albedo: [0.055, 0.058, 0.064], metal: 0.20, rough: 0.72, doubleSided: true, wear: 0.3, castShadow: false }),
    /* 台面：磁性不锈钢台面板——深灰、略带金属光泽，掠射角不能反得太亮 */
    tableTop: mk({ albedo: [0.030, 0.032, 0.036], metal: 0.14, rough: 0.80, wear: 0.45 }),
    screenMat: mk({ albedo: [0.020, 0.021, 0.024], metal: 0.0, rough: 0.94, wear: 0.2 }),
    /* 光阑叶片：发黑弹簧钢，哑光，不能像镜面一样反光 */
    blade: mk({ albedo: [0.040, 0.042, 0.047], metal: 0.28, rough: 0.52, wear: 0.60 }),
    /* 光阑喉部 / 遮光筒内壁：非金属、极暗、极糙，避免内壁被环境镜面反射照亮 */
    lightTrap: mk({ albedo: [0.014, 0.015, 0.018], metal: 0.0, rough: 0.94, wear: 0.2 }),
    hoodBlack: mk({ albedo: [0.026, 0.028, 0.032], metal: 0.0, rough: 0.95, wear: 0.2 }),
    /* 氦氖管身：哑光黑漆（不是阳极氧化亮面），高光要宽而弱 */
    tubeMatte: mk({ albedo: [0.042, 0.045, 0.052], metal: 0.12, rough: 0.56, wear: 0.66 }),
  };

  const BEAM_RED = { kind: 'beam', color: [1.0, 0.075, 0.065], intensity: 0.85, softness: 1.45, fade: 0.05, alphaScale: 1.0, castShadow: false };

  /* ───────── 典型错误 ───────── */
  const FAULTS = [
    {
      id: 'pin', name: '针孔偏心 20 µm',
      hint: '透过率骤降、照明偏心 → 一个目标变暗，互相关峰变弱',
      apply: (a) => { a._pinSaved = [a.hw.pinU, a.hw.pinV]; a.setPinhole(14e-6, -14e-6, true); },
      reset: (a) => { const s = a._pinSaved || [0, 0]; a.setPinhole(s[0], s[1], true); },
    },
    {
      id: 'collim', name: '准直镜偏离焦面 25 mm',
      hint: '出射球面波 → 等效谱面离焦，杨氏条纹变钝',
      apply: (a) => { a._collimSaved = a.lab.parts.get('collim').pos[0]; a.lab.movePartX('collim', a._collimSaved + 0.025); },
      reset: (a) => a.lab.movePartX('collim', a._collimSaved !== undefined ? a._collimSaved : LAYOUT.collim),
    },
    {
      id: 'cmos', name: 'CMOS 离焦 25 mm',
      hint: '模糊圆约 0.5 mm → 条纹与相关峰一起被抹平',
      apply: (a) => { a._cmosSaved = a.lab.parts.get('focal').pos[0]; a.lab.movePartX('focal', a._cmosSaved + 0.025); },
      reset: (a) => a.lab.movePartX('focal', a._cmosSaved !== undefined ? a._cmosSaved : LAYOUT.focal),
    },
    {
      id: 'iris', name: '照明光阑关到 φ4.8 mm',
      hint: '切掉目标外缘 → 一级项失真、通量下降、信噪比变差',
      apply: (a) => { a._irisSaved = a.hw.apIris2; a.setIrisAp(0.0024); },
      /* 复原要回到施加前的开度，而不是写死的 11 mm（默认已改成 4 mm）——
         原来点一次「复原」，光阑会停在 11 mm，连「重置全部」都回不到出厂状态 */
      reset: (a) => a.setIrisAp(a._irisSaved !== undefined ? a._irisSaved : 0.0040),
    },
    {
      id: 'gap', name: '目标间距过小（w ≥ 2a）',
      hint: '一级相关项与零级重叠 → 峰被零级淹没，位置也读不准',
      apply: (a) => { a.jtc.setParams({ aFac: 0.085 }); a.ui.syncControls(); a.lab.rebuildBeams(); },
      reset: (a) => { a.jtc.setParams({ aFac: JTC_DEFAULTS.aFac }); a.ui.syncControls(); a.lab.rebuildBeams(); },
    },
    {
      id: 'weak', name: '激光功率衰减到 12%',
      hint: '记录信噪比按 1/φ² 崩塌 → 条纹被噪声淹没，峰不可信',
      apply: (a) => { a._powerSaved = a.hw.power; a.hw.power = 0.12; a.requestSolve(); },
      reset: (a) => { a.hw.power = a._powerSaved !== undefined ? a._powerSaved : 1.0; a.requestSolve(); },
    },
    {
      id: 'pol', name: '偏振片未正交（P2 → 8°）',
      hint: '振幅调制变浅 → 条纹对比度按 sinΔ 衰减，相关峰变钝甚至消失',
      apply: (a) => { a._polSaved = a.hw.pol2; a.setPolarizer('pol2', 8); },
      reset: (a) => a.setPolarizer('pol2', a._polSaved !== undefined ? a._polSaved : 90),
    },
    {
      id: 'match', name: '参考目标换成另一个字',
      hint: 'f ≢ g → 互相关峰必然变弱（这一条不是操作错误，是物理规律）',
      apply: (a) => { a._gSaved = a.jtc.gName; a.setPattern('g', 'xue'); },
      reset: (a) => { if (a._gSaved) a.setPattern('g', a._gSaved); },
    },
  ];

  /* ═══════════════════════════════════════════════════════════ */
  class Lab {
    constructor(rnd) {
      this.rnd = rnd;
      this.gl = rnd.gl;
      this.parts = new Map();
      this.screens = {};
      this.beams = [];
      this.beamRings = [];
      this.sectionsOn = true;
      this.hoverPanels = [];
      this.hover = null;
      this.hoverLink = null;
      this._geo = new Map();
      this._tex = new Map();
      this.build();
    }

    /* ── 资源 ── */
    mesh(geo, key) { return this.rnd.upload(geo, key); }

    geo(key, fn) {
      let g = this._geo.get(key);
      if (!g) { g = fn(); this._geo.set(key, g); }
      return g;
    }

    tex(key, fn) {
      let t = this._tex.get(key);
      if (!t) { t = this.rnd.texture(fn(), key); this._tex.set(key, t); }
      return t;
    }

    node(parent, geo, mat, o) {
      o = o || {};
      const n = new RND.Node({
        name: o.name || 'part',
        mesh: geo.isMesh ? geo : this.mesh(geo, o.key),
        material: mat,
        pos: o.pos || [0, 0, 0],
        rot: o.rot || [0, 0, 0],
        scale: o.scale || [1, 1, 1],
        tag: o.tag || null,
        pickable: o.pickable !== false,
        castShadow: o.castShadow !== false,
        userData: o.userData || {},
      });
      parent.add(n);
      return n;
    }

    decal(parent, geo, tex, o) {
      o = o || {};
      return this.node(parent, geo, {
        kind: 'pbr', decal: true, map: tex, castShadow: false, wear: 0.12,
      }, o);
    }

    static AXIS_X = [0, 0, -90];

    /** 通用立柱：底座 + 1/2" 支杆 + 叉式夹块 + 滚花螺钉 */
    _stand(g, yBottomLocal, r) {
      const rodR = r || 0.00635;
      const yTop = yBottomLocal;
      const yBase = CFG.TABLE_Y + 0.005;
      const h = yTop - yBase;
      if (h <= 0.008) return;
      const s = new RND.Node({ name: 'stand' });
      const kk = h.toFixed(4);
      // 底座（带倒角）
      this.node(s, this.geo('postBase', () => GEO.lathe([
        [0, 0], [0.0118, 0], [0.0128, 0.0008], [0.0128, 0.0042], [0.0122, 0.005], [0.0072, 0.005], [0.0070, 0.0085], [0, 0.0085],
      ], 40)), MAT.anodDark, { pos: [0, CFG.TABLE_Y, 0], key: 'postBase' });
      // 支杆
      this.node(s, this.geo('rod_' + kk, () => GEO.cylinder(rodR, rodR, h, 20, true, true, 0.0004)),
        MAT.steel, { pos: [0, yBase + h / 2, 0], key: 'rod_' + kk });
      // 叉式夹块
      this.node(s, this.geo('clamp', () => GEO.roundedBox(0.021, 0.017, 0.016, 0.0018, 3)),
        MAT.anodDark, { pos: [0, yTop - 0.006, 0], key: 'clamp' });
      this.node(s, this.geo('clampScrew', () => GEO.cylinder(0.0034, 0.0034, 0.012, 14, true, true, 0.0005)),
        MAT.steel, { pos: [0.011, yTop - 0.006, 0], rot: [0, 0, -90], key: 'clampScrew' });
      this.node(s, this.geo('clampKnob', () => GEO.knurledGrip(0.0062, 0.007, 20, 0.00035, 3)),
        MAT.anodBlack, { pos: [0.0175, yTop - 0.006, 0], rot: [0, 0, -90], key: 'clampKnob' });
      s.pos[1] = 0;
      s.updateMatrix();
      g.add(s);
    }

    /* ────────── 光学平台 ────────── */
    breadboard() {
      const C = CFG;
      const root = new RND.Node({ name: 'breadboard', pos: [C.TABLE_CX, C.TABLE_Y, 0] });
      const L = C.TABLE_L, W = C.TABLE_W, TH = C.TABLE_TH;

      // 主面板：轻微圆角，深色阳极氧化
      this.node(root, GEO.roundedBox(L, TH, W, 0.0035, 2), MAT.tableTop,
        { pos: [0, -TH / 2, 0], key: 'tableTop' });

      // 侧裙边（内凹面板 + 上下沿）
      const skirt = 0.036;
      for (const sz of [-1, 1]) {
        this.node(root, GEO.roundedBox(L, skirt, 0.006, 0.0015, 2), MAT.anodBlack,
          { pos: [0, -TH - skirt / 2 + 0.002, sz * (W / 2 - 0.002)], key: 'skirt' + sz });
        this.node(root, GEO.box(L * 0.995, 0.004, 0.0035, 1, 1, 1), MAT.anodClear,
          { pos: [0, -TH - 0.001, sz * (W / 2 + 0.001)], key: 'skirtLip' + sz });
        this.node(root, GEO.box(L * 0.995, 0.004, 0.0035, 1, 1, 1), MAT.anodClear,
          { pos: [0, -TH - skirt + 0.004, sz * (W / 2 + 0.001)], key: 'skirtLip2' + sz });
      }
      for (const sx of [-1, 1]) {
        this.node(root, GEO.roundedBox(0.006, skirt, W, 0.0015, 2), MAT.anodBlack,
          { pos: [sx * (L / 2 - 0.002), -TH - skirt / 2 + 0.002, 0], key: 'skirtEnd' + sx });
      }

      // 台面销孔阵列
      const nx = Math.floor(L / C.PITCH), nz = Math.floor(W / C.PITCH);
      const x0 = -((nx - 1) * C.PITCH) / 2, z0 = -((nz - 1) * C.PITCH) / 2;
      const caps = new GEO.Builder(), rims = new GEO.Builder();
      const R = 0.0031, RC = 0.0050;
      const seg = 10;
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          const px = x0 + i * C.PITCH, pz = z0 + j * C.PITCH;
          // 孔底（深色）
          const c0 = caps.vert(px, 0.00030, pz, 0, 1, 0, .5, .5);
          const st = caps.count;
          for (let k = 0; k <= seg; k++) {
            const a = k / seg * Math.PI * 2;
            caps.vert(px + R * Math.cos(a), 0.00030, pz + R * Math.sin(a), 0, 1, 0,
              .5 + .5 * Math.cos(a), .5 + .5 * Math.sin(a));
          }
          for (let k = 0; k < seg; k++) caps.triA(c0, st + k, st + k + 1);
          // 沉头倒角环
          const A = [], B = [];
          for (let k = 0; k <= seg; k++) {
            const a = k / seg * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
            A.push(rims.vert(px + R * ca, 0.00034, pz + R * sa, 0, 1, 0, .5 + .5 * ca, .5 + .5 * sa));
            B.push(rims.vert(px + RC * ca, 0.0, pz + RC * sa, 0, 1, 0, .5 + .5 * ca, .5 + .5 * sa));
          }
          for (let k = 0; k < seg; k++) rims.quadA(A[k], B[k], B[k + 1], A[k + 1]);
        }
      }
      this.node(root, caps.build(), MAT.holeBody, { pos: [0, 0, 0], key: 'holes', castShadow: false, pickable: false });
      this.node(root, rims.build(), MAT.holeRim, { pos: [0, 0, 0], key: 'holeRims', castShadow: false, pickable: false });

      // 前后缘标尺（贴花）：真实光学平台的导轨刻度，靠近相机的一侧也要有
      const rulerTex = this.tex('ruler', () => TEX.boardRuler());
      for (const sz of [-1, 1]) {
        this.decal(root, GEO.plane(L * 0.97, 0.008, 1, 1), rulerTex,
          { pos: [0, 0.0002, sz * (W / 2 - 0.007)], rot: [-90, sz > 0 ? 180 : 0, 0],
            key: 'rulerDecal' + sz, pickable: false });
      }

      // 四角 M6 内六角螺钉
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        this.node(root, this.geo('capScrew', () => GEO.lathe([
          [0, 0], [0.0042, 0], [0.0046, 0.0006], [0.0046, 0.0030], [0.0042, 0.0036], [0.0026, 0.0036], [0.0026, 0.0016], [0, 0.0016],
        ], 24)), MAT.steelDark,
          { pos: [sx * (L / 2 - 0.020), 0.0006, sz * (W / 2 - 0.020)], key: 'capScrew' });
      }

      this.rnd.root.add(root);
      this.table = root;
      return root;
    }

    /* ────────── 激光器 ────────── */
    laser() {
      const g = new RND.Node({ name: 'laser', pos: [LAYOUT.laser, CFG.AXIS_Y, 0], tag: 'laser' });
      const AX = Lab.AXIS_X;

      // 管身：前端稍细的圆柱，带端部倒角
      this.node(g, this.geo('laserBody', () => GEO.lathe([
        [0, -0.132], [0.0205, -0.132], [0.0215, -0.131], [0.0215, -0.020],
        [0.0220, -0.014], [0.0220, 0.104], [0.0212, 0.112], [0.0190, 0.118],
        [0.0150, 0.124], [0.0132, 0.130], [0.0132, 0.134], [0, 0.134],
      ], 48)), MAT.tubeMatte, { rot: AX, key: 'laserBody' });

      // 尾部散热槽
      for (let i = 0; i < 7; i++) {
        this.node(g, this.geo('laserGroove', () => GEO.torus(0.0217, 0.0009, 40, 8)), MAT.anodDark,
          { pos: [-0.108 + i * 0.0075, 0, 0], rot: [0, 90, 0], key: 'laserGroove' });
      }

      // 前端镜座 + 出光口
      this.node(g, this.geo('laserNose', () => GEO.lathe([
        [0, 0.130], [0.0140, 0.130], [0.0152, 0.134], [0.0152, 0.139], [0.0120, 0.141], [0, 0.141],
      ], 40)), MAT.anodClear, { rot: AX, key: 'laserNose' });
      this.node(g, this.geo('laserAperture', () => GEO.lathe([
        [0, 0.1410], [0.0060, 0.1410], [0.0060, 0.1418], [0.0032, 0.1422], [0, 0.1422],
      ], 32)), MAT.anodBlack, { rot: AX, key: 'laserAperture' });
      const glow = this.node(g, GEO.disc(0.0028, 28), {
        kind: 'screen', field: null, gain: 1, gamma: 1, tint3: [1, 0.20, 0.14],
        pixelGrid: false, castShadow: false, fieldRes: [64, 64],
      }, { pos: [0.1424, 0, 0], rot: [0, 90, 0], key: 'portglow' });

      // 尾部端盖 + 高压接头
      this.node(g, this.geo('laserTail', () => GEO.lathe([
        [0, -0.140], [0.0180, -0.140], [0.0205, -0.136], [0.0205, -0.132], [0, -0.132],
      ], 40)), MAT.anodDark, { rot: AX, key: 'laserTail' });
      this.node(g, this.geo('hvConn', () => GEO.lathe([
        [0, 0], [0.0058, 0], [0.0062, 0.001], [0.0062, 0.012], [0.0048, 0.014], [0, 0.014],
      ], 20)), MAT.ceramic, { pos: [-0.140, -0.006, 0.012], rot: [0, 0, -90], key: 'hvConn' });
      this.node(g, this.geo('hvCable', () => GEO.tubePath([
        [-0.148, -0.008, 0.014], [-0.172, -0.030, 0.044], [-0.182, -0.066, 0.086],
        [-0.170, -0.098, 0.120], [-0.140, -0.1128, 0.148], [-0.105, -0.1128, 0.160],
        [-0.085, -0.100, 0.165], [-0.078, -0.088, 0.166],
      ], 0.0036, 72, 8)), MAT.rubber, { key: 'hvCable', castShadow: false });
      // 台面上的线夹（线缆不再悬空收尾）
      for (const cx of [-0.140, -0.104]) {
        this.node(g, this.geo('cableClip', () => GEO.roundedBox(0.011, 0.0075, 0.014, 0.0012, 2)),
          MAT.anodDark, { pos: [cx, -0.1115, 0.155], key: 'cableClip' });
      }

      // 两只夹持环
      for (const dx of [-0.072, 0.064]) {
        this.node(g, this.geo('laserRing', () => GEO.lathe([
          [0.0216, -0.007], [0.0250, -0.007], [0.0262, -0.005], [0.0262, 0.005], [0.0250, 0.007], [0.0216, 0.007],
        ], 48)), MAT.anodDark, { pos: [dx, 0, 0], rot: AX, key: 'laserRing' });
        // 夹紧螺钉
        this.node(g, this.geo('ringScrew', () => GEO.cylinder(0.0026, 0.0026, 0.008, 12, true, true, 0.0004)),
          MAT.steel, { pos: [dx, 0.028, 0], key: 'ringScrew' });
        this.node(g, this.geo('ringKnob', () => GEO.knurledGrip(0.0055, 0.006, 18, 0.0003, 3)),
          MAT.anodBlack, { pos: [dx, 0.034, 0], key: 'ringKnob' });
      }

      // 铭牌贴花（上侧 60° 弧）
      this.decal(g, GEO.arcShell(0.0222, -0.062, 0.010, Math.PI * 0.22, Math.PI * 0.52, 24, { axisUV: true, nv: 4, flipU: true, flipV: true }),
        this.tex('laserDanger', () => TEX.laserDanger()), { rot: AX, key: 'laserDanger' });
      this.decal(g, GEO.arcShell(0.0222, -0.030, 0.052, -Math.PI * 0.46, -Math.PI * 0.20, 24, { axisUV: true, nv: 4, flipU: true, flipV: true }),
        this.tex('laserPlate', () => TEX.laserPlate()), { rot: AX, key: 'laserPlate' });

      // 支撑 V 型座
      for (const dx of [-0.085, 0.082]) {
        this.node(g, this.geo('vBlock', () => GEO.roundedBox(0.026, 0.024, 0.046, 0.002, 2)),
          MAT.anodDark, { pos: [dx, -0.036, 0], key: 'vBlock' });
        this.node(g, this.geo('vBlockBase', () => GEO.roundedBox(0.032, 0.008, 0.052, 0.0015, 2)),
          MAT.anodDark, { pos: [dx, -0.052, 0], key: 'vBlockBase' });
      }
      this.node(g, this.geo('laserStem', () => GEO.roundedBox(0.20, 0.018, 0.030, 0.002, 2)),
        MAT.anodDark, { pos: [0, -0.060, 0], key: 'laserStem' });
      this._stand(g, -0.069, 0.0068);

      // 电源（台面上，带散热孔与指示灯）
      const ps = new RND.Node({ name: 'psu', pos: [-0.09, CFG.TABLE_Y, 0.165] });
      this.node(ps, this.geo('psuBody', () => GEO.roundedBox(0.150, 0.058, 0.098, 0.003, 3)),
        MAT.panel, { pos: [0, 0.029, 0], key: 'psuBody' });
      this.node(ps, this.geo('psuTop', () => GEO.roundedBox(0.140, 0.004, 0.088, 0.002, 2)),
        MAT.anodDark, { pos: [0, 0.059, 0], key: 'psuTop' });
      for (let i = 0; i < 9; i++) {
        this.node(ps, this.geo('psuVent', () => GEO.box(0.0022, 0.0022, 0.070, 1, 1, 1)), MAT.holeBody,
          { pos: [-0.055 + i * 0.013, 0.052, 0], key: 'psuVent', castShadow: false });
      }
      this.node(ps, this.geo('psuLed', () => GEO.sphere(0.0022, 12, 8)), {
        kind: 'pbr', albedo: [1, 0.25, 0.18], emissive: [1, 0.18, 0.10], emissiveI: 2.2,
        metal: 0, rough: 0.3, castShadow: false,
      }, { pos: [0.058, 0.044, 0.050], key: 'psuLed' });
      this.node(ps, this.geo('psuSwitch', () => GEO.roundedBox(0.014, 0.010, 0.008, 0.0015, 2)),
        MAT.anodClear, { pos: [-0.062, 0.040, 0.050], key: 'psuSwitch' });
      this.decal(ps, GEO.plane(0.086, 0.034, 1, 1), this.tex('powerPlate', () => TEX.powerPlate()),
        { pos: [0, 0.030, 0.0492], key: 'psuLabel' });
      // 电源到激光器的线缆
      this.node(ps, this.geo('psuCable', () => GEO.tubePath([
        [0.018, 0.050, 0.048], [-0.012, 0.044, 0.055], [-0.052, 0.016, 0.060],
        [-0.082, 0.0032, 0.074], [-0.058, 0.0032, 0.090], [-0.030, 0.0032, 0.082],
      ], 0.0036, 48, 8)), MAT.rubber, { key: 'psuCable', castShadow: false });
      this.rnd.root.add(ps);

      this.rnd.root.add(g);
      this.parts.set('laser', g);
      this.laserGlow = glow;
      return g;
    }

    /* ────────── 可变光阑 ────────── */
    iris(tag, x, opts) {
      opts = opts || {};
      const g = new RND.Node({ name: tag, pos: [x, CFG.AXIS_Y, 0], tag });
      const AX = Lab.AXIS_X;
      const RAP = opts.ap !== undefined ? opts.ap : 0.011;
      const ROUT = 0.030;
      const sig = RAP.toFixed(5);

      // 外壳环（带滚花外缘）
      this.node(g, this.geo('irisHousing', () => GEO.lathe([
        [0.0268, -0.0075], [0.0300, -0.0075], [0.0300, 0.0075], [0.0268, 0.0075],
      ], 64)), MAT.anodBlack, { rot: AX, key: 'irisHousing' });
      this.node(g, this.geo('irisKnurl_' + sig, () => GEO.knurledGrip(0.0301, 0.0090, 52, 0.00026, 3, RAP + 0.002)),
        MAT.anodBlack, { rot: AX, key: 'irisKnurl' });
      // 前后端面（黑色隔膜盘）
      this.node(g, this.geo('irisFace_' + sig, () => GEO.annulus(RAP, 0.0268, 64)), MAT.screenMat,
        { pos: [0.0076, 0, 0], rot: [0, 90, 0], key: 'irisFace_' + sig });
      this.node(g, this.geo('irisFaceB_' + sig, () => GEO.annulus(RAP, 0.0268, 64)), MAT.screenMat,
        { pos: [-0.0076, 0, 0], rot: [0, -90, 0], key: 'irisFaceB_' + sig });

      // 叶片：12 片薄板，沿圆周切向排布，内缘围出多边形孔
      /* 光圈叶片：用 12 边形的锥形「喉部」代替一片片薄板。
         薄板沿切向排布时，相邻叶片之间必然留下楔形缝，正面看就是一个星形洞；
         而真实的 12 叶光阑从正面看就是多边形光孔 + 一圈叶片倒角。 */
      this.node(g, this.geo('irisThroat_' + sig, () => GEO.lathe([
        [RAP, 0.0022], [RAP * 1.015, 0.0014], [RAP * 1.10, -0.0012], [0.0266, -0.0062],
      ], 12)), MAT.lightTrap, { rot: AX, key: 'irisThroat', castShadow: false });
      // 孔径亮边
      this.node(g, this.geo('irisRim_' + sig, () => GEO.torus(RAP, 0.00055, 48, 8)), MAT.steelDark,
        { rot: [0, 90, 0], key: 'irisRim_' + sig, castShadow: false });

      // 前脸刻度环（贴花）
      this.decal(g, this.geo('irisScale', () => GEO.annulus(0.0195, 0.0266, 96, true)),
        this.tex('irisScale', () => TEX.irisScale()),
        { pos: [0.0077, 0, 0], rot: [0, 90, 0], key: 'irisScaleDecal' });

      /* 调节手柄 + 旋钮：做成**一根**车削件（杆 + 端部旋钮），
         避免两件各自定位时对不上、看起来悬空。沿 45° 径向伸出。
         手柄角度随孔径变化（全开 28° → 全关 120°）：真实光阑拧动时手柄是转的，
         孔径变了手柄不动，等于仪器没有回应操作。 */
      const leverAng = 28 + (1 - (RAP - 0.0012) / 0.0268) * 92;
      this.node(g, this.geo('irisLever', () => GEO.lathe([
        [0, 0.0225], [0.0030, 0.0225], [0.0030, 0.0465],
        [0.0082, 0.0472], [0.0086, 0.0495], [0.0086, 0.0575], [0.0076, 0.0592], [0, 0.0592],
      ], 24)), MAT.anodClear, { rot: [leverAng, 0, 0], key: 'irisLever' });

      // 支臂与立柱
      this.node(g, this.geo('irisArm', () => GEO.roundedBox(0.010, 0.030, 0.012, 0.0012, 2)),
        MAT.anodDark, { pos: [0, -0.040, 0], key: 'irisArm' });
      this._stand(g, -0.054, 0.0062);

      this.rnd.root.add(g);
      this.parts.set(tag, g);
      this.irisAp = this.irisAp || {};
      this.irisAp[tag] = RAP;
      return g;
    }

    setIrisOpening(tag, ap) {
      ap = Math.max(0.0012, Math.min(0.028, ap));
      if (this.irisAp && Math.abs(this.irisAp[tag] - ap) < 1e-5) return false;
      if (this.rnd.invalidateShadow) this.rnd.invalidateShadow();
      const old = this.parts.get(tag);
      const x = old ? old.pos[0] : LAYOUT[tag];
      if (old) this.rnd.root.remove(old);
      this.iris(tag, x, { ap });
      this.updateBeams();
      return true;
    }

    static PIN_VIS_MAG = 150;
    setPinholeOffset(u, v) {
      const k = Lab.PIN_VIS_MAG;
      if (this.pinPlate) { this.pinPlate.pos = [0.0292, v * k, u * k]; this.pinPlate.updateMatrix(); }
      if (this.pinHole) { this.pinHole.pos = [0.0304, v * k, u * k]; this.pinHole.updateMatrix(); }
      /* 千分头鼓轮跟着转：真实微调是「拧鼓轮 → 针孔板平移」，
         只让藏在夹板里的针孔板平移，用户从外面看不到任何回应。
         100 µm 一圈（0.1 mm 螺距），±60 µm 对应 ±216°。 */
      const dpm = 3.6;
      if (this.micDrumY) { this.micDrumY.rot[1] = v * 1e6 * dpm; this.micDrumY.updateMatrix(); }
      if (this.micDrumZ) { this.micDrumZ.rot[1] = u * 1e6 * dpm; this.micDrumZ.updateMatrix(); }
    }

    /* ────────── 偏振片（旋转镜架） ────────── */
    polarizer(tag, x, opts) {
      opts = opts || {};
      const g = new RND.Node({ name: tag, pos: [x, CFG.AXIS_Y, 0], tag });
      const AX = Lab.AXIS_X;
      const RIN = 0.0210, ROUT = 0.0300;
      const ang = opts.angle || 0;

      // 固定外壳：带前后台阶的环（通光孔 φ42）
      this.node(g, this.geo('polBody', () => GEO.lathe([
        [RIN, -0.0076], [ROUT, -0.0076], [ROUT, -0.0050], [ROUT * 0.996, -0.0044],
        [ROUT * 0.996, 0.0044], [ROUT, 0.0050], [ROUT, 0.0076], [RIN, 0.0076],
      ], 56)), MAT.anodBlack, { rot: AX, key: 'polBody' });
      // 前后压圈
      for (const sx of [1, -1]) {
        this.node(g, this.geo('polRetainer', () => GEO.torus(RIN + 0.0013, 0.0010, 56, 8)), MAT.anodDark,
          { pos: [sx * 0.0077, 0, 0], rot: [0, 90, 0], key: 'polRetainer' + sx, castShadow: false });
      }

      // 转动环（滚花 + 刻度 + 指标 + 拨杆）—— 整体绕光轴旋转
      const rotor = new RND.Node({ name: 'polRotor' });
      this.node(rotor, this.geo('polRing', () => GEO.knurledGrip(0.0302, 0.0102, 56, 0.00026, 3, RIN + 0.001)),
        MAT.anodClear, { rot: AX, key: 'polRing' });
      this.decal(rotor, this.geo('polScaleRing', () => GEO.annulus(RIN + 0.0008, ROUT - 0.0022, 96, true)),
        this.tex('polScale', () => TEX.polScale()),
        { pos: [-0.0079, 0, 0], rot: [0, -90, 0], key: 'polScaleDecal', pickable: false });
      /* 指标刻在**固定外壳**上（刻度环在转子上）：原来两者都挂在转子上，
         转的时候刻度与指标一起转，读数永远不变 —— 转了等于没转。 */
      this.node(g, this.geo('polIndex', () => GEO.box(0.0018, 0.0068, 0.0014, 1, 1, 1)),
        MAT.anodRed, { pos: [-0.0081, ROUT * 0.80, 0], key: 'polIndex', castShadow: false });
      // 拨杆（径向伸出，方便用手指拧）
      this.node(rotor, this.geo('polLever', () => GEO.cylinder(0.0017, 0.0017, 0.013, 10, true, true, 0.0003)),
        MAT.steel, { pos: [0, ROUT + 0.0055, 0], key: 'polLever' });
      this.node(rotor, this.geo('polLeverKnob', () => GEO.knurledGrip(0.0036, 0.0056, 16, 0.0003, 3)),
        MAT.anodBlack, { pos: [0, ROUT + 0.0135, 0], key: 'polLeverKnob' });
      rotor.rot = [ang, 0, 0];
      rotor.updateMatrix();
      g.add(rotor);

      // 偏振膜（两片夹在镜架里，中间一条极细的分隔环）
      this.node(g, this.geo('polFilm', () => GEO.disc(RIN - 0.0012, 48)), MAT.polFilm,
        { pos: [0, 0, 0], rot: [0, 90, 0], key: 'polFilm', castShadow: false, pickable: false });

      // 支臂 + 立柱
      this.node(g, this.geo('polArm', () => GEO.roundedBox(0.0095, 0.026, 0.014, 0.0012, 2)),
        MAT.anodDark, { pos: [0, -ROUT - 0.009, 0], key: 'polArm' });
      this._stand(g, -ROUT - 0.022, 0.0062);

      this.rnd.root.add(g);
      this.parts.set(tag, g);
      this.polRotors = this.polRotors || {};
      this.polRotors[tag] = rotor;
      return g;
    }

    /** 旋转偏振片到指定角度（度，绕光轴） */
    setPolarizerAngle(tag, deg) {
      const r = this.polRotors && this.polRotors[tag];
      if (!r) return;
      r.rot[0] = deg;
      r.updateMatrix();
      if (this.rnd.invalidateShadow) this.rnd.invalidateShadow();
      this.polAngles = this.polAngles || {};
      this.polAngles[tag] = deg;
    }

    /* ────────── 空间滤波器 ────────── */
    spatialFilter() {
      const g = new RND.Node({ name: 'sf', pos: [LAYOUT.sf, CFG.AXIS_Y, 0], tag: 'sf' });
      const AX = Lab.AXIS_X;

      // 燕尾 Z 平移台（底座 + 移动块 + 千分头）
      this.node(g, this.geo('sfBase', () => GEO.roundedBox(0.052, 0.016, 0.050, 0.002, 2)),
        MAT.anodDark, { pos: [-0.004, -0.030, 0], key: 'sfBase' });
      this.node(g, this.geo('sfSlide', () => GEO.roundedBox(0.040, 0.018, 0.036, 0.002, 2)),
        MAT.anodClear, { pos: [0.004, -0.014, 0], key: 'sfSlide' });
      // 千分头（-X 方向）
      // 千分头从滑块后端面（x = -0.016）向外伸，不能悬空
      this.node(g, this.geo('micBody', () => GEO.lathe([
        [0, 0], [0.0072, 0], [0.0078, 0.0012], [0.0078, 0.024], [0.0068, 0.026], [0, 0.026],
      ], 28)), MAT.chrome, { pos: [-0.0155, -0.014, 0], rot: [0, 0, 90], key: 'micBody' });
      this.node(g, this.geo('micDrum', () => GEO.knurledGrip(0.0092, 0.013, 30, 0.0006, 3)),
        MAT.anodBlack, { pos: [-0.0295, -0.014, 0], rot: [0, 0, 90], key: 'micDrum' });
      this.node(g, this.geo('micCap', () => GEO.cylinder(0.0052, 0.0052, 0.008, 20, true, true, 0.0005)),
        MAT.chrome, { pos: [-0.0395, -0.014, 0], rot: [0, 0, 90], key: 'micCap' });

      // 物镜：锥形镜筒 + 滚花 + 色环 + 前端
      this.node(g, this.geo('objRear', () => GEO.lathe([
        [0, -0.034], [0.0175, -0.034], [0.0192, -0.031], [0.0192, -0.010], [0.0178, -0.0062], [0, -0.0062],
      ], 40)), MAT.anodBlack, { rot: AX, key: 'objRear' });
      this.node(g, this.geo('objGrip', () => GEO.knurledGrip(0.0194, 0.011, 32, 0.0005, 3)),
        MAT.anodBlack, { rot: AX, key: 'objGrip' });
      this.node(g, this.geo('objCone', () => GEO.lathe([
        [0, -0.006], [0.0186, -0.006], [0.0170, 0.002], [0.0102, 0.014], [0.0092, 0.020], [0, 0.020],
      ], 40)), MAT.anodDark, { rot: AX, key: 'objCone' });
      this.node(g, this.geo('objBand', () => GEO.lathe([
        [0.0090, 0.0175], [0.0099, 0.0175], [0.0099, 0.0200], [0.0090, 0.0200],
      ], 40)), MAT.brass, { rot: AX, key: 'objBand' });
      this.node(g, this.geo('objTip', () => GEO.lathe([
        [0, 0.020], [0.0062, 0.020], [0.0062, 0.024], [0.0046, 0.026], [0, 0.026],
      ], 32)), MAT.anodBlack, { rot: AX, key: 'objTip' });
      // 物镜前组：小口径镀膜透镜（藏在黑色镜口里，不该是一颗亮银球）
      this.node(g, GEO.disc(0.0036, 24), MAT.glassCoat,
        { pos: [0.0261, 0, 0], rot: [0, 90, 0], key: 'objLens', castShadow: false, pickable: false });

      // 针孔 XY 微调架：两块叠板 + 两个千分头（Y / Z）
      this.node(g, this.geo('xyPlateA', () => GEO.roundedBox(0.034, 0.036, 0.008, 0.0018, 2)),
        MAT.anodDark, { pos: [0.024, 0, 0], key: 'xyPlateA' });
      this.node(g, this.geo('xyPlateB', () => GEO.roundedBox(0.030, 0.032, 0.008, 0.0018, 2)),
        MAT.anodClear, { pos: [0.034, 0, 0], key: 'xyPlateB' });
      // Y 向千分头（竖直）
      this.node(g, this.geo('micSmall', () => GEO.lathe([
        [0, 0], [0.0058, 0], [0.0062, 0.001], [0.0062, 0.018], [0.0052, 0.020], [0, 0.020],
      ], 24)), MAT.chrome, { pos: [0.024, 0.0175, 0], key: 'micSmallY' });
      this.micDrumY = this.node(g, this.geo('micSmallDrum', () => GEO.knurledGrip(0.0076, 0.011, 26, 0.0005, 3)),
        MAT.anodBlack, { pos: [0.024, 0.0325, 0], key: 'micSmallDrumY' });
      // Z 向千分头（水平侧向）
      this.node(g, this.geo('micSmall', () => GEO.lathe([
        [0, 0], [0.0058, 0], [0.0062, 0.001], [0.0062, 0.018], [0.0052, 0.020], [0, 0.020],
      ], 24)), MAT.chrome, { pos: [0.034, 0, 0.0155], rot: [90, 0, 0], key: 'micSmallZ' });
      this.micDrumZ = this.node(g, this.geo('micSmallDrum', () => GEO.knurledGrip(0.0076, 0.011, 26, 0.0005, 3)),
        MAT.anodBlack, { pos: [0.034, 0, 0.0305], rot: [90, 0, 0], key: 'micSmallDrumZ' });

      // 针孔板（可动）+ 针孔
      this.pinPlate = this.node(g, this.geo('pinPlate', () => GEO.box(0.0012, 0.016, 0.016, 1, 1, 1)),
        MAT.steelDark, { pos: [0.0292, 0, 0], key: 'pinPlate', castShadow: false });
      this.pinHole = this.node(g, GEO.disc(0.0012, 14), MAT.holeBody,
        { pos: [0.0304, 0, 0], rot: [0, 90, 0], key: 'pinhole', castShadow: false, pickable: false });
      // 针孔板压环
      this.node(g, this.geo('pinRetainer', () => GEO.annulus(0.0032, 0.0078, 32)), MAT.brass,
        { pos: [0.0300, 0, 0], rot: [0, 90, 0], key: 'pinRetainer', castShadow: false });

      // 支臂
      this.node(g, this.geo('sfArm', () => GEO.roundedBox(0.012, 0.026, 0.014, 0.0015, 2)),
        MAT.anodDark, { pos: [0.006, -0.044, 0], key: 'sfArm' });
      this._stand(g, -0.057, 0.0064);

      this.rnd.root.add(g);
      this.parts.set('sf', g);
      return g;
    }

    /* ────────── 透镜组件（镜筒 + 运动学调整架） ────────── */
    lensUnit(tag, x, opts) {
      opts = opts || {};
      const g = new RND.Node({ name: tag, pos: [x, CFG.AXIS_Y, 0], tag });
      const AX = Lab.AXIS_X;
      const D = opts.dia || 0.030;
      const ap = opts.ap || 0.0115;
      const barrel = opts.barrel || 0.030;
      const Rc = opts.Rc || 0.030;
      const t = opts.thick || 0.0075;

      // 镜筒（外壁 + 前后螺纹）：前端做成环形端面（中间留出通光孔），
      // 否则车削体自带的前盖板会把镜片完全挡住——镜头看起来就是个黑洞。
      this.node(g, this.geo('barrel_' + D + '_' + barrel, () => GEO.lathe([
        [0, -barrel / 2], [D / 2 - 0.0012, -barrel / 2], [D / 2, -barrel / 2 + 0.0012],
        [D / 2, barrel / 2 - 0.0012], [D / 2 - 0.0012, barrel / 2], [ap * 0.985, barrel / 2],
      ], 48)), Object.assign({}, MAT.anodBlack, { doubleSided: true }), { rot: AX, key: 'barrel_' + D + '_' + barrel });
      // 筒内挡光环（消光螺纹的近似）：让镜片后面有层次而不是虚空
      this.node(g, this.geo('baffle_' + D, () => GEO.lathe([
        [ap * 1.02, 0], [D / 2 - 0.0014, 0], [D / 2 - 0.0014, 0.0016], [ap * 1.02, 0.0016],
      ], 40)), Object.assign({}, MAT.hoodBlack, { doubleSided: true }),
        { pos: [barrel / 2 - 0.006, 0, 0], rot: AX, key: 'baffle_' + D });
      // 滚花调焦/锁紧环
      this.node(g, this.geo('focusRing_' + D, () => GEO.knurledGrip(D / 2 + 0.0016, 0.0095, 36, 0.00055, 3)),
        MAT.anodDark, { rot: AX, key: 'focusRing_' + D });
      // 前后压圈（带扳手槽的环）
      for (const s of [-1, 1]) {
        this.node(g, this.geo('retainer_' + D, () => GEO.lathe([
          [ap * 0.98, 0], [D / 2 - 0.0012, 0], [D / 2 - 0.0012, 0.0024], [ap * 0.98, 0.0024],
        ], 44)), MAT.anodClear,
          { pos: [s * (barrel / 2 - 0.0024), 0, 0], rot: s > 0 ? AX : [0, 0, 90], key: 'retainer_' + D });
      }

      // 镜片（双凸 + 镀膜）
      const sig = ap.toFixed(4) + '_' + Rc.toFixed(4) + '_' + t.toFixed(5);
      // biconvex 的光轴沿 +Z，必须绕 Y 转 90° 才能与光路（+X）同轴
      this.node(g, this.geo('lens_' + sig, () => GEO.biconvex(ap * 1.28, Rc, t, t * 0.24, 26, 64)),
        MAT.glass, { rot: [0, 90, 0], key: 'lens_' + sig });
      this.node(g, this.geo('coat_' + sig, () => GEO.biconvex(ap * 1.275, Rc, t * 1.006, t * 0.24, 18, 48)),
        MAT.glassCoat, { rot: [0, 90, 0], key: 'coat_' + sig, castShadow: false, pickable: false });

      // 焦距贴花环（镜筒前端外壁）
      this.decal(g, this.geo('lensRing_' + barrel, () => GEO.arcShell(D / 2 + 0.0002, -0.006, 0.006, Math.PI * 0.18, Math.PI * 0.82, 28, { axisUV: true, nv: 3 })),
        this.tex('lensRing', () => TEX.lensRing('f = 150 mm')), { rot: AX, key: 'lensRing' });

      // 运动学调整架：方形前板（厚度沿光轴，正面朝 −X）+ 3 个调节螺钉
      this.node(g, this.geo('kinPlate', () => GEO.roundedBox(0.009, 0.056, 0.056, 0.0015, 3)),
        MAT.anodDark, { pos: [-0.0035, 0, 0], key: 'kinPlate' });
      // 背面机构仓：让调整架从侧面看有体积（真实运动学座前板后还有一段机构）
      this.node(g, this.geo('kinBody', () => GEO.roundedBox(0.017, 0.040, 0.040, 0.0025, 2)),
        MAT.anodBlack, { pos: [0.011, 0, 0], key: 'kinBody' });
      // 底部燕尾夹块
      this.node(g, this.geo('kinDovetail', () => GEO.roundedBox(0.028, 0.013, 0.030, 0.0018, 2)),
        MAT.anodDark, { pos: [0.002, -0.031, 0], key: 'kinDovetail' });
      this.node(g, this.geo('kinBore', () => GEO.lathe([
        [0, -0.0055], [0.0200, -0.0055], [0.0212, -0.0042], [0.0212, 0.0042], [0.0200, 0.0055], [0, 0.0055],
      ], 48)), MAT.anodBlack, { pos: [-0.0035, 0, 0], rot: AX, key: 'kinBore' });
      // 3 个 100TPI 调节螺钉（2 个可调 + 1 个枢轴）
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + i * Math.PI * 2 / 3;
        const py = Math.sin(a) * 0.0225, pz = Math.cos(a) * 0.0225;
        this.node(g, this.geo('kinScrew', () => GEO.cylinder(0.0022, 0.0022, 0.012, 12, true, true, 0.0004)),
          MAT.steel, { pos: [-0.007, py, pz], rot: [0, 0, 90], key: 'kinScrew' });
        this.node(g, this.geo('kinKnob', () => GEO.knurledGrip(0.0058, 0.0065, 20, 0.0004, 3)),
          MAT.anodClear, { pos: [-0.014, py, pz], rot: [0, 0, 90], key: 'kinKnob' });
      }
      // 前脸黄铜压圈
      this.node(g, this.geo('kinLock', () => GEO.torus(0.0205, 0.0014, 48, 10)), MAT.brass,
        { pos: [-0.0079, 0, 0], rot: [0, 90, 0], key: 'kinLock', castShadow: false });

      // 正面激光刻字：型号 + 焦距（真实调整架在镜孔下方刻的就是这两行）
      const lblMain = opts.label || 'KM100', lblSub = opts.sub || 'f = 150 mm';
      const ltex = this.tex('mountLabel|' + lblMain + '|' + lblSub, () => TEX.mountLabel(lblMain, lblSub));
      this.decal(g, GEO.plane(0.018, 0.0042, 1, 1), ltex,
        { pos: [-0.0081, 0.0252, 0], rot: [0, -90, 0], key: 'mountLabel' });

      // 支臂 + 立柱
      this.node(g, this.geo('lensArm', () => GEO.roundedBox(0.014, 0.024, 0.016, 0.0016, 2)),
        MAT.anodDark, { pos: [0, -0.040, 0], key: 'lensArm' });
      this._stand(g, -0.052, 0.0064);

      this.rnd.root.add(g);
      this.parts.set(tag, g);
      return g;
    }

    /* ────────── 输入面 / SLM ────────── */
    slmUnit(tag, x, opts) {
      opts = opts || {};
      const g = new RND.Node({ name: tag, pos: [x, CFG.AXIS_Y, 0], tag });
      const s = opts.size || 0.075;
      const ks = s.toFixed(4);
      // 面板组：内部按朝 +Z 建模，整体绕 Y 转 90° → 屏面垂直光轴
      const face = new RND.Node({ name: tag + '_face', rot: [0, 90, 0] });
      g.add(face);
      const win = s * 0.66;
      const dep = 0.024;

      // 外壳（圆角）
      this.node(face, this.geo('slmCase_' + ks, () => GEO.roundedBox(s, s * 0.94, dep, 0.0025, 3)),
        MAT.panel, { key: 'slmCase_' + ks });
      // 前面板（略小一圈，形成台阶）
      this.node(face, this.geo('slmBezel_' + ks, () => GEO.roundedBox(s * 0.97, s * 0.91, 0.004, 0.002, 2)),
        MAT.anodBlack, { pos: [0, 0, dep / 2 + 0.0012], key: 'slmBezel_' + ks });
      // 开窗（内凹）
      this.node(face, this.geo('slmWell_' + ks, () => GEO.box(win * 1.06, win * 1.06, 0.003, 1, 1, 1)),
        MAT.screenMat, { pos: [0, 0, dep / 2 + 0.0030], key: 'slmWell_' + ks });
      // 屏幕
      const scr = this.node(face, GEO.plane(win, win, 1, 1), {
        kind: 'screen', field: null, gain: 1.0, gamma: 1.85,
        tint3: [1, 0.95, 0.90], pixelGrid: true, scanline: false, glass: true,
        castShadow: false, fieldRes: [320, 320],
      }, { pos: [0, 0, dep / 2 + 0.0046], key: 'slmScreen_' + ks });
      scr.userData.isFieldScreen = true;
      // 覆盖玻璃（细边）
      this.node(face, this.geo('slmCover_' + ks, () => GEO.roundedBox(win * 1.02, win * 1.02, 0.0012, 0.0008, 2)),
        MAT.glass, { pos: [0, 0, dep / 2 + 0.0052], key: 'slmCover_' + ks, castShadow: false, pickable: false });

      // 后盖 / PCB / 芯片
      this.node(face, this.geo('slmBack_' + ks, () => GEO.roundedBox(s * 1.01, s * 0.95, 0.004, 0.002, 2)),
        MAT.anodDark, { pos: [0, 0, -dep / 2 - 0.0015], key: 'slmBack_' + ks });
      this.node(face, this.geo('slmPcb_' + ks, () => GEO.box(s * 0.62, s * 0.46, 0.004, 1, 1, 1)),
        MAT.pcb, { pos: [0, -s * 0.10, -dep / 2 - 0.004], key: 'slmPcb_' + ks });
      for (let i = 0; i < 3; i++) {
        this.node(face, this.geo('slmChip', () => GEO.roundedBox(0.010, 0.008, 0.0022, 0.0006, 2)),
          MAT.chip, { pos: [-0.018 + i * 0.016, -s * 0.10, -dep / 2 - 0.0065], key: 'slmChip' });
      }
      // 排线（HDMI 样）
      this.node(face, this.geo('slmRibbon', () => GEO.tubePath([
        [s * 0.30, -s * 0.36, -dep / 2 - 0.002], [s * 0.42, -s * 0.46, -dep / 2 - 0.020],
        [s * 0.48, -s * 0.60, -dep / 2 - 0.044], [s * 0.48, -0.084, -dep / 2 - 0.060],
        [s * 0.46, -0.1128, -dep / 2 - 0.062], [s * 0.30, -0.1128, -dep / 2 - 0.070],
      ], 0.0042, 64, 6)), MAT.rubber, { key: 'slmRibbon', castShadow: false });
      // 四角螺钉
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        this.node(face, this.geo('slmScrew', () => GEO.lathe([
          [0, 0], [0.0024, 0], [0.0028, 0.0004], [0.0028, 0.0018], [0.0020, 0.0022], [0, 0.0022],
        ], 16)), MAT.steel,
          { pos: [sx * s * 0.42, sy * s * 0.38, dep / 2 + 0.0032], key: 'slmScrew' });
      }
      // 铭牌（外壳下沿）
      this.decal(face, GEO.plane(s * 0.62, s * 0.16, 1, 1),
        this.tex('slmPlate', () => TEX.slmPlate()),
        { pos: [0, -s * 0.58, dep / 2 + 0.0008], key: 'slmLabel' });
      // 状态灯
      this.node(face, GEO.sphere(0.0018, 10, 8), {
        kind: 'pbr', albedo: [0.2, 1, 0.6], emissive: [0.2, 1, 0.5], emissiveI: 1.6,
        metal: 0, rough: 0.3, castShadow: false,
      }, { pos: [s * 0.40, s * 0.40, dep / 2 + 0.0022], key: 'slmLed' });

      // 支臂 + 立柱
      this.node(g, this.geo('slmArm', () => GEO.roundedBox(0.012, 0.030, 0.014, 0.0015, 2)),
        MAT.anodDark, { pos: [0, -s * 0.50, 0], key: 'slmArm' });
      this._stand(g, -s * 0.50 - 0.010, 0.0064);

      this.rnd.root.add(g);
      this.parts.set(tag, g);
      this.screens = this.screens || {};
      this.screens[tag] = scr;
      return g;
    }

    /* ────────── CMOS 相机 ────────── */
    cameraUnit(tag, x) {
      const g = new RND.Node({ name: tag, pos: [x, CFG.AXIS_Y, 0], tag });
      const AX = Lab.AXIS_X;
      const bw = 0.056, bh = 0.056, bd = 0.058;

      // 机身（圆角）+ 前法兰
      this.node(g, this.geo('camBody', () => GEO.roundedBox(bw, bh, bd, 0.0035, 3)),
        MAT.panel, { key: 'camBody' });
      this.node(g, this.geo('camFront', () => GEO.roundedBox(bw * 1.01, bh * 1.01, 0.006, 0.0025, 2)),
        MAT.anodDark, { pos: [-bd / 2 - 0.001, 0, 0], key: 'camFront' });
      // C 口镜筒
      this.node(g, this.geo('camMount', () => GEO.lathe([
        [0, -0.010], [0.0145, -0.010], [0.0158, -0.0085], [0.0158, 0.0], [0.0145, 0.0015], [0, 0.0015],
      ], 44)), MAT.chrome, { pos: [-bd / 2 - 0.010, 0, 0], rot: AX, key: 'camMount' });
      this.node(g, this.geo('camMountRing', () => GEO.knurledGrip(0.0164, 0.009, 40, 0.00026, 3)),
        MAT.anodBlack, { pos: [-bd / 2 - 0.016, 0, 0], rot: AX, key: 'camMountRing' });
      // 传感器窗口（朝 −X）
      const scr = this.node(g, GEO.plane(0.020, 0.020, 1, 1), {
        kind: 'screen', field: null, gain: 1.0, gamma: 1.65,
        tint3: [1, 0.96, 0.93], pixelGrid: true, scanline: false, glass: true,
        castShadow: false, fieldRes: [256, 256],
      }, { pos: [-bd / 2 - 0.0078, 0, 0], rot: [0, -90, 0], key: 'camSensor' });
      scr.userData.isFieldScreen = true;
      // 保护窗
      this.node(g, this.geo('camWindow', () => GEO.disc(0.0118, 32)), MAT.glass,
        { pos: [-bd / 2 - 0.0086, 0, 0], rot: [0, -90, 0], key: 'camWindow', castShadow: false, pickable: false });

      // 顶部散热鳍片
      for (let i = 0; i < 7; i++) {
        this.node(g, this.geo('camFin', () => GEO.box(bw * 0.86, 0.009, 0.0022, 1, 1, 1)),
          MAT.anodDark, { pos: [0.002, bh / 2 + 0.0045, -0.020 + i * 0.0068], key: 'camFin' });
      }
      this.node(g, this.geo('camFinBase', () => GEO.box(bw * 0.90, 0.003, 0.050, 1, 1, 1)),
        MAT.anodDark, { pos: [0.002, bh / 2 + 0.0015, 0], key: 'camFinBase' });

      // 侧面：USB-C + SMA + 指示灯
      this.node(g, this.geo('usbC', () => GEO.roundedBox(0.0085, 0.0032, 0.0030, 0.0008, 2)),
        MAT.steel, { pos: [0.004, -0.012, bd / 2 + 0.0015], key: 'usbC' });
      this.node(g, this.geo('sma', () => GEO.lathe([
        [0, 0], [0.0036, 0], [0.0036, 0.004], [0.0024, 0.005], [0, 0.005],
      ], 20)), MAT.chrome, { pos: [0.018, -0.012, bd / 2], rot: [90, 0, 0], key: 'sma' });
      this.node(g, GEO.sphere(0.0016, 10, 8), {
        kind: 'pbr', albedo: [0.2, 1, 0.4], emissive: [0.15, 1, 0.35], emissiveI: 1.8,
        metal: 0, rough: 0.3, castShadow: false,
      }, { pos: [-0.018, 0.020, bd / 2 + 0.001], key: 'camLed' });

      // 底部 1/4 螺孔座
      this.node(g, this.geo('camFoot', () => GEO.cylinder(0.010, 0.012, 0.005, 24, true, true, 0.0006)),
        MAT.anodDark, { pos: [0, -bh / 2 - 0.002, 0], key: 'camFoot' });

      // 铭牌（侧面）
      this.decal(g, GEO.plane(0.040, 0.020, 1, 1), this.tex('camPlate', () => TEX.cameraPlate()),
        { pos: [0.0, 0.008, bd / 2 + 0.0008], key: 'camLabel' });

      // USB 线缆（垂到台面）
      this.node(g, this.geo('camCable', () => GEO.tubePath([
        [0.004, -0.013, bd / 2 + 0.003], [0.010, -0.030, bd / 2 + 0.030],
        [0.020, -0.068, bd / 2 + 0.058], [0.032, -0.104, bd / 2 + 0.072],
        [0.044, -0.1128, bd / 2 + 0.078], [0.066, -0.1128, bd / 2 + 0.062],
      ], 0.0028, 64, 8)), MAT.rubber, { key: 'camCable', castShadow: false });
      this.node(g, this.geo('camClip', () => GEO.roundedBox(0.010, 0.0075, 0.013, 0.0011, 2)),
        MAT.anodDark, { pos: [0.050, -0.1115, bd / 2 + 0.075], key: 'camClip' });

      this.node(g, this.geo('camArm', () => GEO.roundedBox(0.014, 0.026, 0.016, 0.0016, 2)),
        MAT.anodDark, { pos: [0, -bh / 2 - 0.016, 0], key: 'camArm' });
      this._stand(g, -bh / 2 - 0.028, 0.0064);

      this.rnd.root.add(g);
      this.parts.set(tag, g);
      this.screens = this.screens || {};
      this.screens[tag] = scr;
      return g;
    }

    /* ────────── 输出屏 ────────── */
    screenUnit(tag, x) {
      const g = new RND.Node({ name: tag, pos: [x, CFG.AXIS_Y, 0], tag });
      const face = new RND.Node({ name: tag + '_face', rot: [0, 90, 0] });
      g.add(face);
      const W = 0.090, H = 0.082;

      // 外框（四边，带台阶）
      this.node(face, this.geo('scrFrame', () => GEO.roundedBox(W, H, 0.010, 0.003, 3)),
        MAT.anodDark, { key: 'scrFrame' });
      this.node(face, this.geo('scrInner', () => GEO.box(W * 0.88, H * 0.86, 0.004, 1, 1, 1)),
        MAT.screenMat, { pos: [0, 0, 0.0042], key: 'scrInner' });
      // 屏面（必须位于内嵌板之前，否则被 box 前表面遮挡）
      const scr = this.node(face, GEO.plane(0.072, 0.068, 1, 1), {
        kind: 'screen', field: null, gain: 1.0, gamma: 1.0,
        tint3: [1, 0.97, 0.95], pixelGrid: false, castShadow: false, fieldRes: [512, 512],
      }, { pos: [0, 0, 0.0069], key: 'scrFace' });
      scr.userData.isFieldScreen = true;
      // 遮光罩（上沿 + 两侧）—— 哑光黑，避免高光把罩体打成白板
      this.node(face, this.geo('scrHood', () => GEO.box(W, 0.004, 0.034, 1, 1, 1)), MAT.hoodBlack,
        { pos: [0, H / 2 - 0.002, 0.019], rot: [26, 0, 0], key: 'scrHood' });
      for (const s of [-1, 1]) {
        this.node(face, this.geo('scrHoodSide', () => GEO.box(0.003, H * 0.96, 0.024, 1, 1, 1)), MAT.hoodBlack,
          { pos: [s * (W / 2 - 0.0015), 0, 0.014], key: 'scrHoodSide' });
      }
      // 四角螺钉
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        this.node(face, this.geo('scrScrew', () => GEO.lathe([
          [0, 0], [0.0022, 0], [0.0025, 0.0004], [0.0025, 0.0016], [0.0018, 0.002], [0, 0.002],
        ], 14)), MAT.steel,
          { pos: [sx * W * 0.43, sy * H * 0.42, 0.0066], key: 'scrScrew' });
      }
      this.node(g, this.geo('scrArm', () => GEO.roundedBox(0.014, 0.028, 0.016, 0.0016, 2)),
        MAT.anodDark, { pos: [0, -H / 2 - 0.010, 0], key: 'scrArm' });
      this._stand(g, -H / 2 - 0.024, 0.0064);

      this.rnd.root.add(g);
      this.parts.set(tag, g);
      this.screens = this.screens || {};
      this.screens[tag] = scr;
      return g;
    }

    /* ────────── 光束 ────────── */
    _posMap() {
      const m = {};
      for (const [k, n] of this.parts) m[k] = n.pos[0];
      m.__state = this.beamState || null;
      return m;
    }

    attachBeamSource(getJtc) {
      this._getJtc = getJtc;
      this.rebuildBeams();
    }

    /* 每个器件平面的通光半径（m）。光束在任何平面上都不允许画得比孔还粗——
       否则 ×2 加粗后光柱会直接「穿过」光阑环、镜筒壁，看起来像光束把金属切开了。
       数值取自各自建模时的实际开孔（光阑 = 叶片喉部半径，镜筒 = 端面内孔，
       SLM = 显示窗口半幅，CMOS = 靶面半幅）。 */
    beamApertures() {
      const P = this._posMap();
      const ap = this.irisAp || {};
      const out = [];
      const add = (x, r, tag) => {
        if (isFinite(x) && r > 0) out.push({ x, r, tag });
      };
      add(P.laser !== undefined ? P.laser : LAYOUT.laser, 0.0030, 'laser');   // HeNe 出光口（随器件移动）
      add(P.iris1 !== undefined ? P.iris1 : LAYOUT.iris1, (ap.iris1 || 0.011), 'iris1');
      add((P.sf !== undefined ? P.sf : LAYOUT.sf) + 0.0288, 0.0012, 'sf');   // 针孔
      add(P.collim !== undefined ? P.collim : LAYOUT.collim, 0.0113, 'collim');
      add(P.iris2 !== undefined ? P.iris2 : LAYOUT.iris2, (ap.iris2 || 0.011), 'iris2');
      add(P.pol1 !== undefined ? P.pol1 : LAYOUT.pol1, 0.0206, 'pol1');
      add(P.input !== undefined ? P.input : LAYOUT.input, 0.0240, 'input');  // SLM 显示窗口
      add(P.pol2 !== undefined ? P.pol2 : LAYOUT.pol2, 0.0206, 'pol2');
      add(P.lens1 !== undefined ? P.lens1 : LAYOUT.lens1, 0.0113, 'lens1');
      add((P.focal !== undefined ? P.focal : LAYOUT.focal) - 0.0368, 0.0100, 'focal'); // CMOS 靶面
      add(P.slm2 !== undefined ? P.slm2 : LAYOUT.slm2, 0.0240, 'slm2');
      add(P.lens2 !== undefined ? P.lens2 : LAYOUT.lens2, 0.0113, 'lens2');
      return out;
    }

    /** x 处的通光半径；没有器件时返回 Infinity */
    _apAt(x, aps) {
      let r = Infinity;
      for (const a of aps) if (Math.abs(a.x - x) < 1.2e-3) r = Math.min(r, a.r);
      return r;
    }

    /* 把物理光斑宽度转成「能画出来的宽度」：
       ① 乘显示加粗倍率（×1/×2/×3）；
       ② 在每个器件平面夹到该器件的通光半径；
       ③ 被夹的平面在前后各插一个节点，让光柱在孔口处「齐茬」收住，
          而不是从几十毫米外就开始慢慢收成锥形（那是聚焦，不是截断）。 */
    _drawnPoints(model, scale) {
      const aps = this.beamApertures();
      const src = (model.nodes || []).slice().sort((a, b) => a.x - b.x);
      const pts = [];
      for (const n of src) {
        const wScaled = n.w * scale;
        const lim = this._apAt(n.x, aps);
        const w = Math.min(wScaled, lim * 0.985);
        pts.push({ x: n.x, w, cut: w < wScaled * 0.995, ap: isFinite(lim) ? lim : null });
      }
      const D = 0.0018;
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.cut && i > 0 && i < pts.length - 1) {
          if (p.x - pts[i - 1].x > D * 2.5) out.push({ x: p.x - D, w: p.w, cut: true });
          out.push(p);
          if (pts[i + 1].x - p.x > D * 2.5) out.push({ x: p.x + D, w: p.w, cut: true });
        } else out.push(p);
      }
      return out;
    }

    rebuildBeams() {
      if (!this._getJtc) return;
      const jtc = this._getJtc();
      if (!jtc) return;
      let model;
      try { model = window.BEAM_MODEL.beamModel(jtc, this._posMap()); }
      catch (e) { return; }
      this.beamModel = model;

      for (const n of this.beams) this.rnd.root.remove(n);
      this.beams.length = 0;

      // 整条光束共用一份单位几何（锥度/长度由着色器展开），避免分段接缝
      const geo = this.geo('beamRibbon', () => GEO.beamRibbon(14, 2));
      const mesh = this.mesh(geo, 'beamRibbon');
      const rq = (v) => Math.max(0.0004, Math.round(v * 1e5) / 1e5);

      /* 宽度不是直接用物理值，而是过一遍「通光孔径」：
         光柱在每个器件平面上被夹到该器件的开孔半径，孔口前后各插一个节点让光柱齐茬收住。 */
      const scale = this.rnd.beamScale || 1;
      const pts = this._drawnPoints(model, scale);
      model.drawn = pts;
      model.phys = this._drawnPoints(model, 1);   // 不加粗、但已按孔径夹紧：读数用
      this.beamPts = pts;

      const P = this._posMap();
      const coldLo = P.focal !== undefined ? P.focal : 0.980;
      const coldHi = P.slm2 !== undefined ? P.slm2 : 1.130;
      const wIn = (model.meta && model.meta.illum && model.meta.illum.eff) || 0.003;
      const segs = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (b.x - a.x < 1e-4) continue;
        const mid = (a.x + b.x) / 2;
        const wm = Math.sqrt(Math.max(1e-6, a.w * b.w));
        segs.push({
          x0: a.x, w0: a.w, x1: b.x, w1: b.w,
          kind: (mid > coldLo && mid < coldHi) ? 'cold' : 'red',
          gain: Math.min(1.55, Math.max(0.42, (wIn / wm) * 0.62)),
        });
      }
      this.beamSegs = segs;

      for (const seg of segs) {
        // 谱面 → SLM₂ 是「电子学读出」而非光：画成断续的虚线段，
        // 一眼能看出这是数据链路，不会误认为光从相机里穿过去了
        if (seg.kind === 'cold') {
          const N = 5, span = seg.x1 - seg.x0;
          for (let i = 0; i < N; i++) {
            const t0 = i / N + 0.06 / N, t1 = (i + 1) / N - 0.06 / N;
            const x0 = seg.x0 + span * t0, x1 = seg.x0 + span * t1;
            const dn = new RND.Node({
              name: 'beam', mesh,
              material: Object.assign({}, BEAM_RED, {
                color: [0.34, 0.84, 1.0], alphaScale: 0.34, softness: 1.9,
                w0: rq(seg.w0), w1: rq(seg.w1), len: Math.max(1e-4, x1 - x0),
                fade: 0.25,
              }),
              pos: [x0, CFG.AXIS_Y, 0], rot: [0, 0, 0],
              pickable: false, castShadow: false,
            });
            dn.userData.isBeam = true;
            dn.userData.x0 = x0;
            dn.visible = this.beamsVisible !== false;
            dn.material.intensity = seg.gain * 0.22;
            this.rnd.root.add(dn);
            this.beams.push(dn);
          }
          continue;
        }
        // 两端各缩进：光带是面向相机的公告板，若一直顶到镜筒端面
        // 就会「穿过」器件面板显示出来；缩进后由端部淡出接管，视觉上像光束没入镜筒。
        // 缩进量必须小于孔径处的「齐茬」节点间距，否则刚夹住的窄段会被吃掉。
        const span = seg.x1 - seg.x0;
        const inset = span > 0.010 ? 0.0012 : span * 0.10;
        const x0 = seg.x0 + inset, x1 = seg.x1 - inset;
        const len = Math.max(1e-4, x1 - x0);
        const n = new RND.Node({
          name: 'beam',
          mesh,
          material: Object.assign({}, BEAM_RED, {
            w0: rq(seg.w0), w1: rq(seg.w1), len,
            softness: Math.max(0.9, 1.5 - (seg.w0 + seg.w1) * 40),
            fade: Math.min(0.20, Math.max(0.018, 0.010 / len)),
          }),
          pos: [x0, CFG.AXIS_Y, 0],
          rot: [0, 0, 0],
          pickable: false, castShadow: false,
        });
        n.userData.isBeam = true;
        n.userData.x0 = x0;
        n.visible = this.beamsVisible !== false;
        n.userData.gainBase = seg.gain * 0.72;
        n.material.intensity = n.userData.gainBase;
        this.rnd.root.add(n);
        this.beams.push(n);
      }
      if (this._beamAttenuate) this._beamAttenuate(this.beams);
      this._buildBeamRings(model);
      if (this._onBeam) this._onBeam(model);
      this.updateBeamBillboards(this.rnd.camera ? this.rnd.camera.eye : [0, 0, 1]);
    }

    /** 在每个光学平面画一圈「光斑截面」细环 + 十字刻度：半径 = 该处 1/e² 光斑半径。
        用 1 px 线段画（不随距离变细），所以缩到看全台面时也看得见光斑大小，
        拉近时它就是贴着光束的一圈真实尺寸的圆 —— 光阑一收，整排圆立刻变小。 */
    _buildBeamRings(model) {
      for (const n of (this._ringNodes || [])) this.rnd.root.remove(n);
      this._ringNodes = [];
      this.beamRings.length = 0;
      if (!model || !model.nodes || !model.nodes.length) return;

      const aps = this.beamApertures();
      const phys = model.phys || model.nodes;
      const wAt = (x) => {
        let best = phys[0], bd = Infinity;
        for (const q of phys) { const d = Math.abs(q.x - x); if (d < bd) { bd = d; best = q; } }
        return best.w;
      };
      const ring = (b, x, r, seg, tick) => {
        for (let k = 0; k < seg; k++) {
          const a0 = k / seg * Math.PI * 2, a1 = (k + 1) / seg * Math.PI * 2;
          b.vert(x, r * Math.cos(a0), r * Math.sin(a0), 0, 1, 0, 0, 0);
          b.vert(x, r * Math.cos(a1), r * Math.sin(a1), 0, 1, 0, 1, 0);
        }
        if (tick) for (let k = 0; k < 4; k++) {
          const a = k * Math.PI / 2;
          b.vert(x, r * Math.cos(a), r * Math.sin(a), 0, 1, 0, 0, 0);
          b.vert(x, r * 1.30 * Math.cos(a), r * 1.30 * Math.sin(a), 0, 1, 0, 1, 0);
        }
      };

      // ① 光斑截面：在物理节点处画一圈（半径 = 该处实际通过孔径的光斑半径）
      const bOn = new GEO.Builder(), bCut = new GEO.Builder();
      const seen = new Set();
      let cnt = 0;
      for (const nd of model.nodes) {
        const key = nd.x.toFixed(4);
        if (seen.has(key)) continue;
        seen.add(key);
        const w = wAt(nd.x);
        const ap = this._apAt(nd.x, aps);
        const cut = isFinite(ap) && w > ap * 0.94;      // 已经顶到孔径
        ring(cut ? bCut : bOn, nd.x, Math.max(0.0009, w), 40, true);
        cnt++;
      }
      /* ② 通光孔径环：只画「真的在限制光束」的那几个（光阑 / 镜筒）。
         不加筛选地给每个器件都画一圈，会在没有实体的地方留下一个悬空线圈，
         看起来像模型又缺件了。 */
      const bAp = new GEO.Builder();
      for (const a of aps) {
        if (a.tag !== 'iris1' && a.tag !== 'iris2' && a.tag !== 'collim' &&
            a.tag !== 'lens1' && a.tag !== 'lens2') continue;
        if (a.r < 0.0016) continue;
        ring(bAp, a.x + 0.0002, a.r, 56, false);
      }

      const mkLine = (b, col, name) => {
        const node = new RND.Node({
          name,
          mesh: this.mesh(b.build(), name),
          material: { kind: 'line', color4: col, castShadow: false },
          pickable: false, castShadow: false,
        });
        node.userData.isLine = true;
        node.visible = this.sectionsOn !== false;
        this.rnd.root.add(node);
        this._ringNodes.push(node);
        return node;
      };
      mkLine(bOn, [0.34, 0.88, 1.0, 0.62], 'beamRings');
      if (bCut.count) mkLine(bCut, [1.0, 0.66, 0.22, 0.95], 'beamRingsCut');
      if (bAp.count) mkLine(bAp, [0.72, 0.80, 0.92, 0.20], 'apRings');
      this.beamRings.push(this._ringNodes[0]);
      this.ringCount = cnt;
    }

    setBeamSections(v) {
      this.sectionsOn = !!v;
      for (const r of (this._ringNodes || [])) r.visible = this.sectionsOn;
    }

    /** 某个 x 位置的光束 1/e² 半径（m）；找不到返回 null */
    beamRadiusAt(x) {
      const m = this.beamModel;
      if (!m) return null;
      const src = m.phys || m.nodes;
      if (!src || !src.length) return null;
      let best = src[0], bd = Infinity;
      for (const n of src) {
        const d = Math.abs(n.x - x);
        if (d < bd) { bd = d; best = n; }
      }
      return best.w;
    }

    /** 该器件的通光半径（m）；用于提示「光斑已顶到孔径」 */
    apertureAt(x) {
      const r = this._apAt(x, this.beamApertures());
      return isFinite(r) ? r : null;
    }

    /** 每帧让光带绕光轴滚转，使其横向始终垂直于视线 → 平滑体积感 */
    updateBeamBillboards(eye) {
      if (!this.beams || !this.beams.length) return;
      for (const n of this.beams) {
        const vy = eye[1] - n.pos[1], vz = eye[2] - n.pos[2];
        const roll = Math.atan2(-vy, vz) * 180 / Math.PI;
        if (Math.abs(roll - n.rot[0]) > 0.05) n.setRot(roll, 0, 0);
      }
    }

    _resolveAnchor(a) {
      if (a[0] === 'const') return a[1];
      const p = this.parts.get(a[1]);
      return (p ? p.pos[0] : 0) + (a[2] || 0);
    }

    updateBeams() {
      if (this._getJtc) { this.rebuildBeams(); return; }
    }

    buildBeams() { this.rebuildBeams(); }

    /* ────────── 悬浮光场面板 ────────── */
    hoverPanel(tag, x, y, opts) {
      opts = opts || {};
      const g = new RND.Node({ name: 'hover_' + tag, pos: [x, y, 0] });
      const s = opts.size || 0.052;
      const fb = new RND.Node({ name: 'hpBillboard' });
      this.node(fb, this.geo('hpFrame', () => GEO.roundedBox(s * 1.16, s * 1.16, 0.003, 0.0025, 2)), MAT.anodBlack,
        { pos: [0, 0, -0.0016], key: 'hpFrame' });
      this.node(fb, GEO.box(s * 1.10, s * 1.10, 0.0012, 1, 1, 1), MAT.screenMat,
        { pos: [0, 0, -0.0002], key: 'hpMat' });
      const scr = this.node(fb, GEO.plane(s, s, 1, 1), {
        kind: 'screen', field: null, gain: 1.0, gamma: 1.0,
        tint3: [1, 1, 1], pixelGrid: false, castShadow: false, fieldRes: [512, 512],
      }, { pos: [0, 0, 0.0008], key: 'hpFace' });
      this.node(fb, this.geo('hpTitle', () => GEO.roundedBox(s * 1.16, s * 0.15, 0.003, 0.0015, 2)), MAT.anodDark,
        { pos: [0, s * 0.57, -0.0014], key: 'hpTitle' });
      g.add(fb);
      scr.userData.isFieldScreen = true;
      scr.userData.hpKey = tag;            // 点击这块屏 → 打开对应光场的大图
      /* 注册到渲染器：拾取时只查这几块屏，不做整树遍历 */
      (this.rnd.screenNodes || (this.rnd.screenNodes = [])).push(scr);

      /* 支架：台面立杆 + 横臂 + 球头万向节
         面板要朝相机做 billboard，只有「下沿中点」在旋转中保持不动，
         所以把球头放在那里，杆从台面（z 偏后）升上来，横臂伸过去 —— 看起来就是
         一根真实的显示器支臂，而不是凭空飘着的屏幕。 */
      const yEdge = -s * 0.58;                     // 面板下沿（局部 y）
      const rodZ = -0.052;                         // 立杆在台面上的 z 位置（光路后方）
      const yTable = CFG.TABLE_Y + 0.011 - y;      // 台面在局部坐标里的高度
      const hRod = yEdge - yTable;
      if (hRod > 0.02) {
        this.node(g, this.geo('hpPost_' + hRod.toFixed(4), () => GEO.cylinder(0.0026, 0.0030, hRod, 12, true, true, 0.0004)),
          MAT.anodDark, { pos: [0, (yEdge + yTable) / 2, rodZ], key: 'hpPost' });
        // 底座压块
        this.node(g, this.geo('hpFoot', () => GEO.roundedBox(0.020, 0.006, 0.016, 0.0012, 2)),
          MAT.anodDark, { pos: [0, yTable + 0.003, rodZ], key: 'hpFoot' });
        // 横臂（沿 +Z 伸到面板下沿）
        this.node(g, this.geo('hpArm', () => GEO.cylinder(0.0018, 0.0018, Math.abs(rodZ), 10, true, true, 0.0003)),
          MAT.anodDark, { pos: [0, yEdge, rodZ / 2], rot: [90, 0, 0], key: 'hpArm' });
        // 球头
        this.node(g, this.geo('hpBall', () => GEO.sphere(0.0042, 16, 12)), MAT.steelDark,
          { pos: [0, yEdge, 0], key: 'hpBall' });
      }

      this.rnd.root.add(g);
      this.hoverPanels.push({ node: g, tag, screen: scr, billboard: fb });
      return { node: g, screen: scr, billboard: fb };
    }

    updateHoverBillboards(eye) {
      if (!eye) return;
      for (const hp of this.hoverPanels) {
        if (!hp.billboard || !hp.node.visible) continue;
        const p = hp.node.pos;
        const dx = eye[0] - p[0], dy = eye[1] - p[1], dz = eye[2] - p[2];
        const elev = Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
        const az = Math.atan2(dz, dx) * 180 / Math.PI;
        // 面板 +Z 需指向相机：Ry(az-90) 把 +Z 转到水平朝向，再 Rx(elev) 抬起
        hp.billboard.setRot(elev, az - 90, 0);
      }
    }

    buildHoverPanels() {
      const L = LAYOUT;
      const Y = 0.118;
      const P = [['input', 'input', L.input], ['jps', 'focal', L.focal], ['output', 'output', L.output]];
      this.hover = {};
      this.hoverLink = {};
      for (const [k, tag, x] of P) {
        const hp = this.hoverPanel(k, x, Y, { size: 0.066 });
        this.hover[k] = hp.screen;
        this.hoverLink[k] = tag;
        // 悬浮面板以「全息」方式独立悬浮，不再用立柱（避免远看像天线）
        hp.node.userData.stem = null;
      }
    }

    /* ────────── 天穹与地台 ────────── */
    buildSky() {
      const n = new RND.Node({
        name: 'sky',
        mesh: this.mesh(GEO.sphere(30, 32, 20), 'skySphere'),
        material: { kind: 'sky', castShadow: false },
        pickable: false, castShadow: false,
      });
      n.userData.isSky = true;
      this.rnd.root.add(n);
    }

    buildStage() {
      const CX = CFG.TABLE_CX;
      const y = CFG.TABLE_Y - 0.40;
      this.node(this.rnd.root, this.geo('stageBase', () => GEO.roundedBox(2.30, 0.05, 0.96, 0.008, 2)), MAT.anodBlack,
        { pos: [CX, y, 0], key: 'stageBase', pickable: false });
      this.node(this.rnd.root, GEO.box(2.32, 0.005, 0.98, 1, 1, 1), MAT.holeBody,
        { pos: [CX, y - 0.027, 0], key: 'stageLip', pickable: false });
      const gn = new RND.Node({
        name: 'gridFloor',
        mesh: this.mesh(GEO.plane(2.6, 1.3, 1, 1), 'gridPlane'),
        material: {
          kind: 'grid', cell: 0.05, major: 5, fade: 6.0,
          gridA: [0.060, 0.100, 0.140], gridB: [0.115, 0.235, 0.330],
          castShadow: false,
        },
        pos: [CX, y + 0.0255, 0], rot: [-90, 0, 0],
        pickable: false, castShadow: false,
      });
      this.rnd.root.add(gn);
    }

    /* ────────── 装配 ────────── */
    build() {
      this.buildSky();
      this.buildStage();
      this.breadboard();
      this.laser();
      this.iris('iris1', LAYOUT.iris1);
      this.spatialFilter();
      this.lensUnit('collim', LAYOUT.collim, { Rc: 0.028, thick: 0.0080, label: 'LFM-30', sub: 'f = 150 mm' });
      this.iris('iris2', LAYOUT.iris2);
      // 讲义仪器清单里的「偏振片 ×2」：P1 起偏、P2 检偏，夹住 SLM
      this.polarizer('pol1', LAYOUT.pol1, { angle: 0 });
      this.slmUnit('input', LAYOUT.input, { size: 0.078 });
      this.polarizer('pol2', LAYOUT.pol2, { angle: 90 });
      this.lensUnit('lens1', LAYOUT.lens1, { Rc: 0.030, thick: 0.0075, label: 'L₁  KM100', sub: 'f₁ = 150 mm' });
      this.cameraUnit('focal', LAYOUT.focal);
      this.slmUnit('slm2', LAYOUT.slm2, { size: 0.070 });
      this.lensUnit('lens2', LAYOUT.lens2, { Rc: 0.030, thick: 0.0075, label: 'L₂  KM100', sub: 'f₂ = 150 mm' });
      this.screenUnit('output', LAYOUT.output);
      this.buildBeams();
      this.buildHoverPanels();

      this.selBox = this._makeWireBox();
      this.rnd.root.add(this.selBox);

      this._buildInfo();
      this._buildPickBoxes();
      return this;
    }

    /* 拾取盒：只用「本体」的包围盒，排除支杆 / 线缆 / 线夹。
       线缆从器件一路拖到台面边缘，若把它算进器件的 worldAABB，
       点光阑①时射线会先撞上激光器的线缆盒 → 选中的是激光器。
       （同理，拖动时的半尺寸也用同一套判据，见 app._partHalfX。） */
    _buildPickBoxes() {
      this.rnd.root.updateWorld(null);
      const axisY = (window.CFG && CFG.AXIS_Y !== undefined) ? CFG.AXIS_Y : 0;
      const p = new Float32Array(3);
      this.parts.forEach((root) => {
        let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        const acc = (n) => {
          const bb = n.mesh && n.mesh.geo && n.mesh.geo.aabb;
          if (bb && n.visible !== false) {
            const cy = (bb.min[1] + bb.max[1]) / 2;
            if (cy > axisY - 0.030) {
              for (let i = 0; i < 8; i++) {
                p[0] = (i & 1) ? bb.max[0] : bb.min[0];
                p[1] = (i & 2) ? bb.max[1] : bb.min[1];
                p[2] = (i & 4) ? bb.max[2] : bb.min[2];
                M4.transformPoint(p, n.world, p);
                for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
              }
            }
          }
          for (const c of n.children) acc(c);
        };
        acc(root);
        if (!isFinite(mn[0])) return;
        root.userData.pickBox = {
          min: [mn[0] - root.pos[0], mn[1] - root.pos[1], mn[2] - root.pos[2]],
          max: [mx[0] - root.pos[0], mx[1] - root.pos[1], mx[2] - root.pos[2]],
        };
      });
    }

    _makeWireBox() {
      const g = new RND.Node({ name: 'selbox', visible: false, pickable: false });
      const n = new RND.Node({
        name: 'selwire',
        mesh: this.mesh(wireBoxGeo(), 'selwire'),
        material: { kind: 'line', color4: [0.28, 0.92, 1.0, 0.95], castShadow: false },
        pickable: false, castShadow: false,
      });
      n.userData.isLine = true;
      g.add(n);
      this.selWire = n;
      return g;
    }

    showSelection(node) {
      if (!node || !node.hasAABB) { this.selBox.visible = false; return; }
      // 只框「器件本体」：支杆 / 线缆会把包围盒一路拉到台面，
      // 选一个 7 cm 的镜架却框出一个 20 cm 的大盒子，看起来像框错了东西。
      const skip = /^(stand|rod_|postBase|clamp|clampScrew|clampKnob|hvCable|psuCable|camCable|camClip|cableClip|slmRibbon|hpPost|hpArm|hpBall|hpFoot|beamRing)/;
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      const acc = (n) => {
        if (n.mesh && n.visible !== false && !skip.test(n.name)) {
          const b = n.worldAABB;
          // 叶子网格的 worldAABB 已是自身变换后的盒子（不含子树时与自身一致）
          const g = n.mesh.geo;
          if (g && g.aabb) {
            const p = new Float32Array(3);
            for (let i = 0; i < 8; i++) {
              p[0] = (i & 1) ? g.aabb.max[0] : g.aabb.min[0];
              p[1] = (i & 2) ? g.aabb.max[1] : g.aabb.min[1];
              p[2] = (i & 4) ? g.aabb.max[2] : g.aabb.min[2];
              M4.transformPoint(p, n.world, p);
              for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
            }
          }
        }
        for (const c of n.children) acc(c);
      };
      acc(node);
      if (!isFinite(mn[0])) { this.selBox.visible = false; return; }
      const pad = 0.004;
      const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
      const s = [mx[0] - mn[0] + pad, mx[1] - mn[1] + pad, mx[2] - mn[2] + pad];
      this.selBox.visible = true;
      this.selBox.pos = c;
      this.selBox.scale = s;
      this.selBox.updateMatrix();
    }

    /** 选中框变琥珀色：拖到顶住邻居时用（青色 = 正常选中，琥珀 = 被挡住） */
    setSelectionWarn(on) {
      if (!this.selWire) return;
      if (this._selWarn === on) return;
      this._selWarn = on;
      this.selWire.material.color4 = on ? [1.0, 0.66, 0.16, 0.98] : [0.28, 0.92, 1.0, 0.95];
    }

    _buildInfo() {
      this.info = new Map(PART_INFO.map(p => [p.tag, p]));
      this.order = PART_INFO.map(p => p.tag);
    }

    setField(tag, tex, opts) {
      const sc = (this.screens || {})[tag];
      if (sc) {
        sc.material.field = tex;
        if (opts) {
          if (opts.gain !== undefined) sc.material.gain = opts.gain;
          if (opts.gamma !== undefined) sc.material.gamma = opts.gamma;
          if (opts.tint3) sc.material.tint3 = opts.tint3;
          if (opts.pixelGrid !== undefined) sc.material.pixelGrid = opts.pixelGrid;
        }
      }
      // 悬浮面板按 hoverLink 映射（jps 面板对应 focal 元件）
      if (this.hover && this.hoverLink) {
        for (const k in this.hoverLink) {
          if (this.hoverLink[k] !== tag) continue;
          const hp = this.hover[k];
          if (!hp) continue;
          hp.material.field = tex;
          if (opts && opts.gain !== undefined) hp.material.gain = opts.gain * 0.80;
          if (opts && opts.gamma !== undefined) hp.material.gamma = opts.gamma;
        }
      }
    }

    setBeamsVisible(v) { this.beamsVisible = v; for (const b of this.beams) b.visible = v; }
    setHoverVisible(v) {
      for (const h of this.hoverPanels) {
        h.node.visible = v;
        const st = h.node.userData.stem;
        if (st) st.visible = v;          // 立柱跟随面板一起显隐
      }
    }

    movePartX(tag, x) {
      const p = this.parts.get(tag);
      if (!p) return;
      p.pos[0] = x;
      p.updateMatrix();
      if (this.rnd.invalidateShadow) this.rnd.invalidateShadow();
      this.updateBeams();
      if (this.hoverLink) {
        for (const k in this.hoverLink) {
          if (this.hoverLink[k] !== tag) continue;
          const hp = this.hoverPanels.find(h => h.tag === k);
          if (hp) { hp.node.pos[0] = x; hp.node.updateMatrix(); }
          const st = hp.node.userData.stem;
          if (st) { st.pos[0] = x; st.updateMatrix(); }
        }
      }
    }

    resetLayout() {
      for (const k in LAYOUT) {
        const p = this.parts.get(k);
        if (p) { p.pos[0] = LAYOUT[k]; p.updateMatrix(); }
      }
      this.updateBeams();
      this.updateHover();
    }

    updateHover() {
      if (!this.hoverLink) return;
      for (const k in this.hoverLink) {
        const tag = this.hoverLink[k];
        const p = this.parts.get(tag);
        const hp = this.hoverPanels.find(h => h.tag === k);
        if (!p || !hp) continue;
        hp.node.pos[0] = p.pos[0];
        hp.node.updateMatrix();
        if (hp.node.userData.stem) {
          hp.node.userData.stem.pos[0] = p.pos[0];
          hp.node.userData.stem.updateMatrix();
        }
      }
    }
  }

  function wireBoxGeo() {
    const b = new GEO.Builder();
    const c = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, d] of E) {
      const p = c[a], q = c[d];
      b.vert(p[0] * .5, p[1] * .5, p[2] * .5, 0, 0, 1, 0, 0);
      b.vert(q[0] * .5, q[1] * .5, q[2] * .5, 0, 0, 1, 1, 0);
    }
    return b.build();
  }

  global.LAB = { Lab, LAYOUT, CFG, PART_INFO, MAT, FAULTS };
})(window);
