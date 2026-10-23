/* ═══════════════════════════════════════════════════════════
   math.js · 最小但完整的线性代数 / 数值工具
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const M4 = {
    create() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    identity(o) { o.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); return o; },

    /** out = a · b  (先施加 b，再施加 a) */
    mul(o, a, b) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3],
        a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11],
        a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      for (let i = 0; i < 4; i++) {
        const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
        o[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
        o[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
        o[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
        o[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      }
      return o;
    },

    perspective(o, fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      o.set([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0]);
      return o;
    },

    ortho(o, l, r, b, t, n, f) {
      const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
      o.set([-2 * lr, 0, 0, 0, 0, -2 * bt, 0, 0, 0, 0, 2 * nf, 0,
        (l + r) * lr, (t + b) * bt, (f + n) * nf, 1]);
      return o;
    },

    lookAt(o, eye, center, up) {
      let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
      let len = Math.hypot(z0, z1, z2);
      if (len < 1e-9) { z0 = 0; z1 = 0; z2 = 1; len = 1; }
      len = 1 / len; z0 *= len; z1 *= len; z2 *= len;
      let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
      len = Math.hypot(x0, x1, x2);
      if (len < 1e-9) { x0 = 1; x1 = 0; x2 = 0; } else { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; }
      const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
      o.set([x0, y0, z0, 0, x1, y1, z1, 0, x2, y2, z2, 0,
        -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]),
        -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
        -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]), 1]);
      return o;
    },

    fromTRS(o, t, rDeg, s) {
      const rx = rDeg[0] * Math.PI / 180, ry = rDeg[1] * Math.PI / 180, rz = rDeg[2] * Math.PI / 180;
      const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry),
        cz = Math.cos(rz), sz = Math.sin(rz);
      // R = Rz · Ry · Rx
      const m00 = cz * cy, m01 = cz * sy * sx - sz * cx, m02 = cz * sy * cx + sz * sx;
      const m10 = sz * cy, m11 = sz * sy * sx + cz * cx, m12 = sz * sy * cx - cz * sx;
      const m20 = -sy, m21 = cy * sx, m22 = cy * cx;
      o[0] = m00 * s[0]; o[1] = m01 * s[0]; o[2] = m02 * s[0]; o[3] = 0;
      o[4] = m10 * s[1]; o[5] = m11 * s[1]; o[6] = m12 * s[1]; o[7] = 0;
      o[8] = m20 * s[2]; o[9] = m21 * s[2]; o[10] = m22 * s[2]; o[11] = 0;
      o[12] = t[0]; o[13] = t[1]; o[14] = t[2]; o[15] = 1;
      return o;
    },

    invert(o, a) {
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3],
        a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11],
        a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10,
        b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
        b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12,
        b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
        b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31,
        b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return M4.identity(o);
      det = 1 / det;
      o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return o;
    },

    /** 3×3 逆转置写入 3×3（法线矩阵） */
    normalMat3(o9, m) {
      const a = M4.invert(new Float32Array(16), m);
      o9[0] = a[0]; o9[1] = a[4]; o9[2] = a[8];
      o9[3] = a[1]; o9[4] = a[5]; o9[5] = a[9];
      o9[6] = a[2]; o9[7] = a[6]; o9[8] = a[10];
      return o9;
    },

    /** 支持 o 与 p 为同一数组（原地变换） */
    transformPoint(o, m, p) {
      const x = p[0], y = p[1], z = p[2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      const iw = w ? 1 / w : 1;
      o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw;
      o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw;
      o[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw;
      return o;
    },
  };

  const V3 = {
    add(o, a, b) { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
    sub(o, a, b) { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
    scale(o, a, s) { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
    dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross(o, a, b) {
      o[0] = a[1] * b[2] - a[2] * b[1];
      o[1] = a[2] * b[0] - a[0] * b[2];
      o[2] = a[0] * b[1] - a[1] * b[0]; return o;
    },
    len(a) { return Math.hypot(a[0], a[1], a[2]); },
    norm(o, a) {
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o;
    },
    dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); },
    lerp(o, a, b, t) {
      o[0] = a[0] + (b[0] - a[0]) * t;
      o[1] = a[1] + (b[1] - a[1]) * t;
      o[2] = a[2] + (b[2] - a[2]) * t; return o;
    },
    copy(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  };

  const U = {
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    lerp(a, b, t) { return a + (b - a) * t; },
    smoothstep(e0, e1, x) { const t = U.clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); },
    damp(cur, tgt, lambda, dt) { return U.lerp(cur, tgt, 1 - Math.exp(-lambda * dt)); },
    /** 数值 → 带 SI 前缀的工程字符串 */
    eng(v, digits, unit) {
      if (!isFinite(v)) return '—';
      let a = Math.abs(v);
      const pre = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'],
        [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
      for (const [f, p] of pre) {
        if (a >= f || f === 1e-12) {
          const s = (v / f).toFixed(digits === undefined ? 3 : digits);
          return s + ' ' + p + (unit || '');
        }
      }
      return v + ' ' + (unit || '');
    },
    /** 抑制浮点噪声的四舍五入 */
    q(v, step) { return Math.round(v / step) * step; },
    /** 伪随机（可复现） */
    mulberry32(seed) {
      let a = seed >>> 0;
      return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    },
  };

  /** 定点迭代 FBO 尺寸 */
  U.texSize = function (n) { return Math.max(2, Math.min(4096, n | 0)); };

  global.M4 = M4; global.V3 = V3; global.U = U;
})(window);
