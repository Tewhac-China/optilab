/* ═══════════════════════════════════════════════════════════
   patterns.js · 目标图案生成
   全部程序化绘制到离屏 canvas，再读成透过率浮点阵列。
   约定：返回数组的第 0 行对应纹理 v=0（即图像底部），与 GL 一致。
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const SIZE = 256;
  const cache = new Map();

  function makeCanvas(s) {
    const c = document.createElement('canvas');
    c.width = s; c.height = s;
    return c;
  }

  /** canvas → 浮点阵列（透明/黑为 0，白为 1），并做上下翻转 */
  function readField(canvas) {
    const s = canvas.width;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, s, s).data;
    const out = new Float32Array(s * s);
    for (let y = 0; y < s; y++) {
      const sy = s - 1 - y;                    // 翻正到 GL 行序
      for (let x = 0; x < s; x++) {
        const i = (sy * s + x) * 4;
        // 权重：alpha × 亮度
        const a = img[i + 3] / 255;
        const l = (img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114) / 255;
        out[y * s + x] = a * (l > 0.004 ? l : 0);
      }
    }
    return out;
  }

  /* ───────── 汉字 / 字母 ───────── */
  function drawGlyph(canvas, text, opt) {
    opt = opt || {};
    const s = canvas.width, ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fam = '"Microsoft YaHei","PingFang SC","Source Han Sans SC","Noto Sans CJK SC","SimHei",sans-serif';
    let fs = Math.round(s * (opt.scale || 0.74));
    ctx.font = `${opt.weight || 600} ${fs}px ${fam}`;
    // 自适应：确保字形不超过 0.86 画布
    let m = ctx.measureText(text);
    const maxW = s * (opt.fit || 0.84);
    const w = (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0) || m.width;
    if (w > maxW) {
      fs = Math.round(fs * maxW / w);
      ctx.font = `${opt.weight || 600} ${fs}px ${fam}`;
      m = ctx.measureText(text);
    }
    const dy = ((m.actualBoundingBoxAscent || fs * 0.5) - (m.actualBoundingBoxDescent || fs * 0.5)) / 2;
    ctx.fillText(text, s / 2, s / 2 - dy + (opt.dy || 0) * s);
    if (opt.italic) { /* 预留 */ }
    return canvas;
  }

  /* ───────── 指纹 ───────── */
  function drawFingerprint(canvas, seed, opt) {
    opt = opt || {};
    const s = canvas.width, ctx = canvas.getContext('2d');
    const rnd = U.mulberry32(seed >>> 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const cx = s * 0.5 + (opt.offX || 0) * s;
    const cy = s * 0.5 + (opt.offY || 0) * s;
    const N = opt.ridges || 13;                    // 脊线数量
    const R = s * 0.44;
    const lw = Math.max(1.1, s * 0.0165) * (opt.weight || 1);
    ctx.lineWidth = lw;

    // 指纹"弓形"基频调制参数（每个指纹独立）
    const p1 = 2 + Math.floor(rnd() * 3), p2 = 4 + Math.floor(rnd() * 4);
    const a1 = 0.05 + rnd() * 0.08, a2 = 0.03 + rnd() * 0.05;
    const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28;
    const tilt = (rnd() - 0.5) * 0.5;

    // 分叉 / 断点
    const breaks = [];
    for (let i = 0; i < (opt.breaks === undefined ? 5 : opt.breaks); i++) {
      breaks.push({
        ring: Math.floor(rnd() * N),
        a0: rnd() * 6.28,
        w: 0.10 + rnd() * 0.30,
      });
    }

    for (let i = 0; i < N; i++) {
      const t = (i + 1) / N;
      const r0 = R * Math.pow(t, 0.92);
      const segs = [];
      let seg = null;
      const steps = 220;
      for (let k = 0; k <= steps; k++) {
        const a = k / steps * Math.PI * 2;
        // 脊线半径的角向调制 → 弓/斗型纹路
        const wob = 1
          + a1 * Math.sin(a * p1 + ph1 + i * 0.62)
          + a2 * Math.sin(a * p2 - ph2 + i * 1.31);
        const rr = r0 * wob;
        const sq = 1.0 + tilt * Math.sin(a);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr * 1.16 * sq;
        // 断点
        let brk = false;
        for (const b of breaks) {
          if (b.ring !== i) continue;
          let da = Math.abs(((a - b.a0 + Math.PI) % (Math.PI * 2)) - Math.PI);
          if (da < b.w * 0.5) { brk = true; break; }
        }
        // 超出有效区（指纹常呈近椭圆，被"采集窗"裁切）
        const ux = (x - cx) / (R * 1.05), uy = (y - cy) / (R * 1.22);
        const outside = (ux * ux + uy * uy) > 1.0;
        if (brk || outside) {
          if (seg && seg.length > 1) segs.push(seg);
          seg = null;
        } else {
          if (!seg) seg = [];
          seg.push([x, y]);
        }
      }
      if (seg && seg.length > 1) segs.push(seg);
      for (const sg of segs) {
        ctx.beginPath();
        ctx.moveTo(sg[0][0], sg[0][1]);
        for (let k = 1; k < sg.length; k++) ctx.lineTo(sg[k][0], sg[k][1]);
        ctx.stroke();
      }
    }

    // 核心区（斗形中心的小环 + 三角点）
    ctx.lineWidth = lw * 0.9;
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * 0.075, R * 0.09, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * 0.135, R * 0.16, 0.4, 0.6, Math.PI * 1.55);
    ctx.stroke();
    return canvas;
  }

  /* ───────── 几何靶标 ───────── */
  function drawShape(canvas, kind, params) {
    const s = canvas.width, ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    const c = s / 2, R = s * 0.36;
    ctx.lineWidth = s * 0.035;
    ctx.lineCap = 'butt';

    switch (kind) {
      case 'cross': {
        const t = s * 0.075;
        ctx.fillRect(c - t / 2, c - R, t, R * 2);
        ctx.fillRect(c - R, c - t / 2, R * 2, t);
        break;
      }
      case 'bullseye': {
        for (let i = 3; i >= 0; i--) {
          ctx.beginPath();
          ctx.arc(c, c, R * (0.3 + 0.235 * i), 0, Math.PI * 2);
          if (i % 2 === 0) { ctx.fillStyle = '#fff'; ctx.fill(); }
          else { ctx.fillStyle = '#000'; ctx.fill(); }
        }
        ctx.beginPath(); ctx.arc(c, c, R * 0.14, 0, Math.PI * 2);
        ctx.fillStyle = '#fff'; ctx.fill();
        break;
      }
      case 'ring': {
        ctx.lineWidth = s * 0.055;
        ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(c, c, R * 0.55, 0, Math.PI * 2); ctx.stroke();
        break;
      }
      case 'star': {
        const n = params && params.points || 5;
        ctx.beginPath();
        for (let i = 0; i < n * 2; i++) {
          const a = i / (n * 2) * Math.PI * 2 - Math.PI / 2;
          const rr = i % 2 ? R * 0.44 : R;
          const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'grid': {
        ctx.lineWidth = s * 0.018;
        for (let i = -3; i <= 3; i++) {
          const d = i * s * 0.085;
          ctx.beginPath(); ctx.moveTo(c - R, c + d); ctx.lineTo(c + R, c + d); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(c + d, c - R); ctx.lineTo(c + d, c + R); ctx.stroke();
        }
        break;
      }
      case 'noise': {
        const rnd = U.mulberry32((params && params.seed) || 7);
        const cell = Math.round(s * 0.055);
        for (let y = 0; y < s; y += cell)
          for (let x = 0; x < s; x += cell)
            if (rnd() > 0.5) ctx.fillRect(x, y, cell, cell);
        break;
      }
      case 'sinc': {
        // 二维 sinc 靶：边缘锐利的高频结构，考验系统传递函数
        const img = ctx.createImageData(s, s);
        for (let y = 0; y < s; y++)
          for (let x = 0; x < s; x++) {
            const ux = (x - c) / (s * 0.155), uy = (y - c) / (s * 0.155);
            const r = Math.hypot(ux, uy) * Math.PI;
            const v = r < 1e-6 ? 1 : Math.sin(r) / r;
            const g = Math.max(0, v) * 255;
            const i = (y * s + x) * 4;
            img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
            img.data[i + 3] = 255;
          }
        ctx.putImageData(img, 0, 0);
        break;
      }
      default: break;
    }
    return canvas;
  }

  /* ───────── 目录 ───────── */
  const LIST = [
    { id: 'guang', label: '光', group: '汉字', make: (c) => drawGlyph(c, '光') },
    { id: 'guang2', label: '光·仿', group: '汉字', make: (c) => drawGlyph(c, '光', { weight: 400, scale: 0.68, dy: 0.012 }) },
    { id: 'xue', label: '学', group: '汉字', make: (c) => drawGlyph(c, '学') },
    { id: 'zhong', label: '中', group: '汉字', make: (c) => drawGlyph(c, '中') },
    { id: 'guo', label: '国', group: '汉字', make: (c) => drawGlyph(c, '国') },
    { id: 'guangMao', label: '光·毛', group: '汉字', make: (c) => drawGlyph(c, '光', { weight: 300, scale: 0.62 }) },

    { id: 'fpA', label: '指纹 α', group: '指纹', make: (c) => drawFingerprint(c, 20250913, { ridges: 13 }) },
    { id: 'fpA2', label: '指纹 α · 同源', group: '指纹', make: (c) => drawFingerprint(c, 20250913, { ridges: 13, offX: 0.012, offY: -0.008, breaks: 6 }) },
    { id: 'fpB', label: '指纹 β', group: '指纹', make: (c) => drawFingerprint(c, 884211, { ridges: 11 }) },
    { id: 'fpC', label: '指纹 γ', group: '指纹', make: (c) => drawFingerprint(c, 77123, { ridges: 15 }) },

    { id: 'letterE', label: 'E', group: '字符', make: (c) => drawGlyph(c, 'E', { scale: 0.72 }) },
    { id: 'letterH', label: 'H', group: '字符', make: (c) => drawGlyph(c, 'H', { scale: 0.72 }) },
    { id: 'letterK', label: 'K', group: '字符', make: (c) => drawGlyph(c, 'K', { scale: 0.72 }) },
    { id: 'digit7', label: '7', group: '字符', make: (c) => drawGlyph(c, '7', { scale: 0.72 }) },

    { id: 'cross', label: '十字', group: '靶标', make: (c) => drawShape(c, 'cross') },
    { id: 'bullseye', label: '同心环', group: '靶标', make: (c) => drawShape(c, 'bullseye') },
    { id: 'star', label: '五角星', group: '靶标', make: (c) => drawShape(c, 'star', { points: 5 }) },
    { id: 'grid', label: '网格', group: '靶标', make: (c) => drawShape(c, 'grid') },
    { id: 'noise', label: '散斑板', group: '靶标', make: (c) => drawShape(c, 'noise', { seed: 4242 }) },
    { id: 'sinc', label: 'Sinc 靶', group: '靶标', make: (c) => drawShape(c, 'sinc') },
  ];

  const BY_ID = new Map(LIST.map(p => [p.id, p]));

  /** 取图案场（缓存）。size 只影响缓存键，实际重采样交给调用方 */
  function get(id, size) {
    const key = id + '@' + (size || SIZE);
    if (cache.has(key)) return cache.get(key);
    const def = BY_ID.get(id) || BY_ID.get('guang');
    const s = size || SIZE;
    const cv = makeCanvas(s);
    def.make(cv);
    const f = readField(cv);
    f.size = s;
    cache.set(key, f);
    return f;
  }

  /** 生成缩略图 dataURL */
  function thumb(id, px) {
    const def = BY_ID.get(id) || BY_ID.get('guang');
    const cv = makeCanvas(px || 64);
    def.make(cv);
    return cv.toDataURL('image/png');
  }

  /** 便捷：生成一对完全相同的图案 */
  function identicalPair(id, size) {
    const f = get(id, size);
    return [f, f.slice()];
  }

  global.PATTERNS = { LIST, get, thumb, SIZE, drawFingerprint, drawGlyph, makeCanvas };
})(window);
