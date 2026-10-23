/* ═══════════════════════════════════════════════════════════
   geometry.js · 程序化几何构造（v2）
   顶点格式：pos(3) | normal(3) | uv(2) | extra(4) = 12 floats
   ───────────────────────────────────────────────────────────
   全部基元按「参数曲面 + 数值法线」生成，并用面法线与顶点法线
   一致性自动校正绕序，避免手工 winding 出错导致的翻面/黑洞。
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  class Builder {
    constructor() {
      this.v = []; this.i = []; this.n = 0;
    }
    vert(px, py, pz, nx, ny, nz, u, v, e0, e1, e2, e3) {
      this.v.push(px, py, pz, nx, ny, nz, u, v,
        e0 || 0, e1 || 0, e2 || 0, e3 || 0);
      return this.n++;
    }
    tri(a, b, c) { this.i.push(a, b, c); return this; }
    quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); return this; }

    /** 自动绕序四边形：与顶点法线一致性检查后决定是否翻转 */
    quadA(a, b, c, d) {
      const V = this.v;
      const ax = V[a * 12], ay = V[a * 12 + 1], az = V[a * 12 + 2];
      const bx = V[b * 12], by = V[b * 12 + 1], bz = V[b * 12 + 2];
      const cx = V[c * 12], cy = V[c * 12 + 1], cz = V[c * 12 + 2];
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const gx = e1y * e2z - e1z * e2y;
      const gy = e1z * e2x - e1x * e2z;
      const gz = e1x * e2y - e1y * e2x;
      let nx = 0, ny = 0, nz = 0;
      for (const k of [a, b, c, d]) { nx += V[k * 12 + 3]; ny += V[k * 12 + 4]; nz += V[k * 12 + 5]; }
      if (gx * nx + gy * ny + gz * nz < 0) this.i.push(a, c, b, a, d, c);
      else this.i.push(a, b, c, a, c, d);
      return this;
    }
    triA(a, b, c) {
      const V = this.v;
      const ax = V[a * 12], ay = V[a * 12 + 1], az = V[a * 12 + 2];
      const bx = V[b * 12], by = V[b * 12 + 1], bz = V[b * 12 + 2];
      const cx = V[c * 12], cy = V[c * 12 + 1], cz = V[c * 12 + 2];
      const gx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const gy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const gz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const nx = V[a * 12 + 3] + V[b * 12 + 3] + V[c * 12 + 3];
      const ny = V[a * 12 + 4] + V[b * 12 + 4] + V[c * 12 + 4];
      const nz = V[a * 12 + 5] + V[b * 12 + 5] + V[c * 12 + 5];
      if (gx * nx + gy * ny + gz * nz < 0) this.i.push(a, c, b);
      else this.i.push(a, b, c);
      return this;
    }
    build() {
      return {
        vertices: new Float32Array(this.v),
        indices: new Uint32Array(this.i),
        vertexCount: this.n,
        triCount: this.i.length / 3,
      };
    }
    get count() { return this.n; }
  }

  /* ───────── 通用参数曲面 ─────────
     fn(u,v) -> [x,y,z]（u∈[0,1] 环绕方向，v∈[0,1] 轴向）
     法线由偏导叉积求得，自动校正朝向（与参考方向 ref 一致） */
  function surface(fn, nu, nv, opts) {
    opts = opts || {};
    const b = new Builder();
    const flip = !!opts.flip;
    const ref = opts.ref || null;         // (u,v)->[x,y,z] 参考外法线
    const grid = [];
    const eps = 1e-4;
    for (let j = 0; j <= nv; j++) {
      const row = [];
      const v = j / nv;
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const p = fn(u, v);
        const p1 = fn(Math.min(1, u + eps), v), p0 = fn(Math.max(0, u - eps), v);
        const q1 = fn(u, Math.min(1, v + eps)), q0 = fn(u, Math.max(0, v - eps));
        let ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
        let bx = q1[0] - q0[0], by = q1[1] - q0[1], bz = q1[2] - q0[2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        let L = Math.hypot(nx, ny, nz);
        if (L < 1e-12) { nx = 0; ny = 1; nz = 0; L = 1; }
        nx /= L; ny /= L; nz /= L;
        if (ref) {
          const r = ref(u, v);
          if (nx * r[0] + ny * r[1] + nz * r[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
        }
        if (flip) { nx = -nx; ny = -ny; nz = -nz; }
        row.push(b.vert(p[0], p[1], p[2], nx, ny, nz, u, v));
      }
      grid.push(row);
    }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++)
        b.quadA(grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]);
    return b.build();
  }

  /* ───────── 平面（XY，朝 +Z） ───────── */
  function plane(w, h, sx, sy) {
    w = w === undefined ? 1 : w; h = h === undefined ? 1 : h;
    sx = sx || 1; sy = sy || 1;
    const b = new Builder();
    for (let j = 0; j <= sy; j++)
      for (let k = 0; k <= sx; k++)
        b.vert((k / sx - .5) * w, (j / sy - .5) * h, 0, 0, 0, 1, k / sx, j / sy);
    for (let j = 0; j < sy; j++)
      for (let k = 0; k < sx; k++) {
        const a = j * (sx + 1) + k;
        b.quadA(a, a + 1, a + sx + 2, a + sx + 1);
      }
    return b.build();
  }

  /* ───────── 立方体 ───────── */
  function box(w, h, d, sx, sy, sz) {
    w = w || 1; h = h || 1; d = d || 1;
    sx = sx || 1; sy = sy || 1; sz = sz || 1;
    const b = new Builder();
    const hx = w / 2, hy = h / 2, hz = d / 2;
    const faces = [
      { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], o: [hx, 0, 0], su: d, sv: h, nu: sz, nv: sy },
      { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], o: [-hx, 0, 0], su: d, sv: h, nu: sz, nv: sy },
      { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], o: [0, hy, 0], su: w, sv: d, nu: sx, nv: sz },
      { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], o: [0, -hy, 0], su: w, sv: d, nu: sx, nv: sz },
      { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], o: [0, 0, hz], su: w, sv: h, nu: sx, nv: sy },
      { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], o: [0, 0, -hz], su: w, sv: h, nu: sx, nv: sy },
    ];
    for (const f of faces) {
      const idx = [];
      for (let j = 0; j <= f.nv; j++)
        for (let k = 0; k <= f.nu; k++) {
          const a = k / f.nu - .5, c = j / f.nv - .5;
          idx.push(b.vert(
            f.o[0] + f.u[0] * a * f.su + f.v[0] * c * f.sv,
            f.o[1] + f.u[1] * a * f.su + f.v[1] * c * f.sv,
            f.o[2] + f.u[2] * a * f.su + f.v[2] * c * f.sv,
            f.n[0], f.n[1], f.n[2], k / f.nu, j / f.nv));
        }
      for (let j = 0; j < f.nv; j++)
        for (let k = 0; k < f.nu; k++) {
          const q = j * (f.nu + 1) + k;
          b.quadA(idx[q], idx[q + 1], idx[q + f.nu + 2], idx[q + f.nu + 1]);
        }
    }
    return b.build();
  }

  /* ───────── 圆角立方体（倒角盒） ─────────
     6 个内缩面 + 12 条 1/4 圆柱边 + 8 个球面角，法线连续 */
  function roundedBox(w, h, d, r, seg) {
    w = w || 1; h = h || 1; d = d || 1;
    const hx = w / 2, hy = h / 2, hz = d / 2;
    r = Math.min(r === undefined ? Math.min(hx, hy, hz) * 0.12 : r, Math.min(hx, hy, hz) * 0.98);
    const sg = Math.max(2, seg || 4);
    const ix = Math.max(1e-5, hx - r), iy = Math.max(1e-5, hy - r), iz = Math.max(1e-5, hz - r);
    const b = new Builder();
    const E = 1e-4;

    // 面
    const faces = [
      { n: [1, 0, 0], o: [hx, 0, 0], u: [0, 0, -1], v: [0, 1, 0], su: 2 * iz, sv: 2 * iy },
      { n: [-1, 0, 0], o: [-hx, 0, 0], u: [0, 0, 1], v: [0, 1, 0], su: 2 * iz, sv: 2 * iy },
      { n: [0, 1, 0], o: [0, hy, 0], u: [1, 0, 0], v: [0, 0, -1], su: 2 * ix, sv: 2 * iz },
      { n: [0, -1, 0], o: [0, -hy, 0], u: [1, 0, 0], v: [0, 0, 1], su: 2 * ix, sv: 2 * iz },
      { n: [0, 0, 1], o: [0, 0, hz], u: [1, 0, 0], v: [0, 1, 0], su: 2 * ix, sv: 2 * iy },
      { n: [0, 0, -1], o: [0, 0, -hz], u: [-1, 0, 0], v: [0, 1, 0], su: 2 * ix, sv: 2 * iy },
    ];
    for (const f of faces) {
      const idx = [];
      for (let j = 0; j <= sg; j++)
        for (let k = 0; k <= sg; k++) {
          const a = k / sg - .5, c = j / sg - .5;
          idx.push(b.vert(
            f.o[0] + f.u[0] * a * f.su + f.v[0] * c * f.sv,
            f.o[1] + f.u[1] * a * f.su + f.v[1] * c * f.sv,
            f.o[2] + f.u[2] * a * f.su + f.v[2] * c * f.sv,
            f.n[0], f.n[1], f.n[2], k / sg, j / sg));
        }
      for (let j = 0; j < sg; j++)
        for (let k = 0; k < sg; k++) {
          const q = j * (sg + 1) + k;
          b.quadA(idx[q], idx[q + 1], idx[q + sg + 2], idx[q + sg + 1]);
        }
    }

    // 12 条边：axis = 棱方向；另两轴为圆弧所在平面
    const AX = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
    for (const [a1, a2, ax] of AX) {
      for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
        const h1 = [hx, hy, hz][a1], h2 = [hx, hy, hz][a2], ha = [hx, hy, hz][ax];
        const i1 = [ix, iy, iz][a1], i2 = [ix, iy, iz][a2], ia = [ix, iy, iz][ax];
        const grid = [];
        for (let j = 0; j <= sg; j++) {
          const t = j / sg, aa = (t - .5) * 2 * ia;
          const row = [];
          for (let k = 0; k <= sg; k++) {
            const th = (k / sg) * Math.PI / 2;
            const ca = Math.cos(th), sa = Math.sin(th);
            const p = [0, 0, 0], n = [0, 0, 0];
            // 圆角轴心必须落在 s1·i1 / s2·i2 上（负半轴曾写成 +i1，导致
            // 三个负方向的圆角被镜像到盒体内部，对应棱边留下透光缝）
            p[a1] = s1 * (i1 + ca * r); p[a2] = s2 * (i2 + sa * r); p[ax] = aa;
            n[a1] = s1 * ca; n[a2] = s2 * sa;
            row.push(b.vert(p[0], p[1], p[2], n[0], n[1], n[2], k / sg, t));
          }
          grid.push(row);
        }
        for (let j = 0; j < sg; j++)
          for (let k = 0; k < sg; k++)
            b.quadA(grid[j][k], grid[j][k + 1], grid[j + 1][k + 1], grid[j + 1][k]);
      }
    }

    // 8 个角：1/8 球
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const grid = [];
      for (let j = 0; j <= sg; j++) {
        const ph = (j / sg) * Math.PI / 2;
        const row = [];
        for (let k = 0; k <= sg; k++) {
          const th = (k / sg) * Math.PI / 2;
          const nx = Math.cos(ph) * Math.cos(th) * sx;
          const ny = Math.sin(ph) * sy;
          const nz = Math.cos(ph) * Math.sin(th) * sz;
          row.push(b.vert(ix * sx + nx * r, iy * sy + ny * r, iz * sz + nz * r,
            nx, ny, nz, k / sg, j / sg));
        }
        grid.push(row);
      }
      for (let j = 0; j < sg; j++)
        for (let k = 0; k < sg; k++)
          b.quadA(grid[j][k], grid[j][k + 1], grid[j + 1][k + 1], grid[j + 1][k]);
    }
    return b.build();
  }

  /* ───────── 圆柱 / 圆台（轴 = Y，带倒角） ───────── */
  function cylinder(rTop, rBot, h, seg, capTop, capBot, chamfer) {
    if (typeof rTop === 'number' && h === undefined) { h = rTop; rTop = .5; rBot = .5; }
    seg = seg || 48; capTop = capTop !== false; capBot = capBot !== false;
    const ch = chamfer === undefined ? Math.min(rTop, rBot, h / 2) * 0.06 : chamfer;
    const hy = h / 2;
    const prof = [];
    if (capBot) prof.push([0, -hy]);
    prof.push([rBot - ch, -hy]);
    if (ch > 1e-6) prof.push([rBot, -hy + ch]);
    prof.push([rTop, hy - ch]);
    if (ch > 1e-6) prof.push([rTop - ch, hy]);
    if (capTop) prof.push([0, hy]);
    return lathe(prof, seg, { closed: false });
  }

  /* ───────── 球 ───────── */
  function sphere(r, segU, segV) {
    segU = segU || 48; segV = segV || 32;
    return surface((u, v) => {
      const ph = v * Math.PI, th = u * TAU;
      return [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)];
    }, segU, segV, { ref: (u, v) => {
      const ph = v * Math.PI, th = u * TAU;
      return [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
    } });
  }

  /* ───────── 圆盘 / 圆环带（XY 平面，朝 +Z） ───────── */
  function disc(r, seg, innerR) {
    seg = seg || 64; innerR = innerR || 0;
    const b = new Builder();
    if (innerR <= 0) {
      const c = b.vert(0, 0, 0, 0, 0, 1, .5, .5);
      const st = b.count;
      for (let k = 0; k <= seg; k++) {
        const a = k / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
        b.vert(r * ca, r * sa, 0, 0, 0, 1, .5 + ca * .5, .5 + sa * .5);
      }
      for (let k = 0; k < seg; k++) b.triA(c, st + k, st + k + 1);
      return b.build();
    }
    const A = [], B = [];
    for (let k = 0; k <= seg; k++) {
      const a = k / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
      A.push(b.vert(innerR * ca, innerR * sa, 0, 0, 0, 1, .5 + ca * .5 * innerR / r, .5 + sa * .5 * innerR / r));
      B.push(b.vert(r * ca, r * sa, 0, 0, 0, 1, .5 + ca * .5, .5 + sa * .5));
    }
    for (let k = 0; k < seg; k++) b.quadA(A[k], B[k], B[k + 1], A[k + 1]);
    return b.build();
  }

  /** 圆环面。angular=true 时 UV 为「周向 u / 径向 v」，
      贴刻度环（光阑、偏振片）必须用这种映射，否则条纹会被摊成放射状扇面。 */
  function annulus(rIn, rOut, seg, angular) {
    seg = seg || 64;
    const b = new Builder();
    const A = [], B = [];
    for (let k = 0; k <= seg; k++) {
      const a = k / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
      if (angular) {
        A.push(b.vert(rIn * ca, rIn * sa, 0, 0, 0, 1, k / seg, 0));
        B.push(b.vert(rOut * ca, rOut * sa, 0, 0, 0, 1, k / seg, 1));
      } else {
        A.push(b.vert(rIn * ca, rIn * sa, 0, 0, 0, 1, .5 + ca * .5 * rIn / rOut, .5 + sa * .5 * rIn / rOut));
        B.push(b.vert(rOut * ca, rOut * sa, 0, 0, 0, 1, .5 + ca * .5, .5 + sa * .5));
      }
    }
    for (let k = 0; k < seg; k++) b.quadA(A[k], B[k], B[k + 1], A[k + 1]);
    return b.build();
  }

  /* ───────── 圆环体 ───────── */
  function torus(R, r, segU, segV) {
    segU = segU || 64; segV = segV || 20;
    return surface((u, v) => {
      const a = u * TAU, b = v * TAU;
      return [(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b)];
    }, segU, segV, { ref: (u, v) => {
      const a = u * TAU, b = v * TAU;
      return [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)];
    } });
  }

  /* ───────── 回转体（轴 = Y） ─────────
     profile: [[r, y], …]；r=0 的端点自动收成极点
     hard: 数组标记硬边点（法线不跨点平均） */
  function lathe(profile, seg, opts) {
    opts = opts || {};
    seg = seg || 48;
    const n = profile.length;
    if (n < 2) return new Builder().build();

    // 逐点法线（r-y 平面内的外法线）
    const nrm = [];
    for (let i = 0; i < n; i++) {
      const p0 = profile[Math.max(0, i - 1)], p1 = profile[Math.min(n - 1, i + 1)];
      let dr = p1[0] - p0[0], dy = p1[1] - p0[1];
      if (Math.hypot(dr, dy) < 1e-9) { dr = 0; dy = 1; }
      const L = Math.hypot(dr, dy);
      nrm.push([dy / L, -dr / L]);
    }
    // 尖锐转角：复制法线
    const pts = [], nrs = [];
    for (let i = 0; i < n; i++) {
      pts.push(profile[i]); nrs.push(nrm[i]);
    }

    const b = new Builder();
    const rings = [];
    const UVS = opts.vScale || 1;
    for (let i = 0; i < n; i++) {
      const [r, y] = pts[i];
      const [nr, ny] = nrs[i];
      if (r <= 1e-7) {
        rings.push([b.vert(0, y, 0, 0, ny >= 0 ? 1 : -1, 0, 0.5, i / (n - 1) * UVS)]);
      } else {
        const row = [];
        for (let k = 0; k <= seg; k++) {
          const a = k / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
          row.push(b.vert(r * ca, y, r * sa, nr * ca, ny, nr * sa,
            k / seg, i / (n - 1) * UVS));
        }
        rings.push(row);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      if (A.length === 1 && B.length === 1) continue;
      if (A.length === 1) {
        for (let k = 0; k < seg; k++) b.triA(A[0], B[k], B[k + 1]);
      } else if (B.length === 1) {
        for (let k = 0; k < seg; k++) b.triA(A[k], B[0], A[k + 1]);
      } else {
        for (let k = 0; k < seg; k++) b.quadA(A[k], A[k + 1], B[k + 1], B[k]);
      }
    }
    return b.build();
  }

  /* ───────── 弧面壳（用于铭牌 / 刻度环等贴花） ───────── */
  function arcShell(r, y0, y1, a0, a1, seg, opts) {
    opts = opts || {};
    const b = new Builder();
    const rows = [];
    const nv = opts.nv || 1;
    for (let j = 0; j <= nv; j++) {
      const y = y0 + (y1 - y0) * j / nv;
      const row = [];
      for (let k = 0; k <= seg; k++) {
        const a = a0 + (a1 - a0) * k / seg;
        const ca = Math.cos(a), sa = Math.sin(a);
        const uu0 = opts.axisUV ? j / nv : k / seg;
        const vv0 = opts.axisUV ? k / seg : j / nv;
        const uu = opts.flipU ? 1 - uu0 : uu0;
        const vv = opts.flipV ? 1 - vv0 : vv0;
        row.push(b.vert(r * ca, y, r * sa, ca, 0, sa, uu, vv));
      }
      rows.push(row);
    }
    for (let j = 0; j < nv; j++)
      for (let k = 0; k < seg; k++)
        b.quadA(rows[j][k], rows[j][k + 1], rows[j + 1][k + 1], rows[j + 1][k]);
    return b.build();
  }

  /* ───────── 沿折线的管（线缆 / 导线） ───────── */
  function tubePath(points, radius, seg, radial) {
    seg = seg || 40; radial = radial || 10;
    // Catmull-Rom 重采样
    const P = [];
    const n = points.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(n - 1, i + 2)];
      const sub = Math.max(2, Math.round(seg / (n - 1)));
      for (let k = 0; k < sub; k++) {
        const t = k / sub, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        P.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])]);
      }
    }
    P.push(points[n - 1]);
    // 平行传输标架
    const T = [], N = [], Bn = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], c = P[Math.min(P.length - 1, i + 1)];
      let t = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const L = Math.hypot(t[0], t[1], t[2]) || 1;
      T.push([t[0] / L, t[1] / L, t[2] / L]);
    }
    let up = [0, 1, 0];
    if (Math.abs(T[0][1]) > 0.9) up = [1, 0, 0];
    let nn = cross(up, T[0]);
    nn = norm(nn);
    for (let i = 0; i < P.length; i++) {
      if (i > 0) {
        const axis = cross(T[i - 1], T[i]);
        const s = Math.hypot(axis[0], axis[1], axis[2]);
        if (s > 1e-8) nn = rotAxis(nn, norm(axis), Math.asin(Math.min(1, s)));
      }
      // 正交化
      const d = dot(nn, T[i]);
      nn = norm([nn[0] - T[i][0] * d, nn[1] - T[i][1] * d, nn[2] - T[i][2] * d]);
      N.push(nn);
      Bn.push(cross(T[i], nn));
    }
    const b = new Builder();
    const rings = [];
    for (let i = 0; i < P.length; i++) {
      const row = [];
      for (let k = 0; k <= radial; k++) {
        const a = k / radial * TAU, ca = Math.cos(a), sa = Math.sin(a);
        const nx = N[i][0] * ca + Bn[i][0] * sa;
        const ny = N[i][1] * ca + Bn[i][1] * sa;
        const nz = N[i][2] * ca + Bn[i][2] * sa;
        row.push(b.vert(P[i][0] + nx * radius, P[i][1] + ny * radius, P[i][2] + nz * radius,
          nx, ny, nz, k / radial, i / (P.length - 1)));
      }
      rings.push(row);
    }
    for (let i = 0; i < P.length - 1; i++)
      for (let k = 0; k < radial; k++)
        b.quadA(rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]);
    return b.build();
  }

  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm(a) { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; }
  function rotAxis(v, k, ang) {
    const c = Math.cos(ang), s = Math.sin(ang), d = dot(k, v);
    const cr = cross(k, v);
    return [v[0] * c + cr[0] * s + k[0] * d * (1 - c),
      v[1] * c + cr[1] * s + k[1] * d * (1 - c),
      v[2] * c + cr[2] * s + k[2] * d * (1 - c)];
  }

  /* ───────── 六角棱柱（轴 = Y） ───────── */
  function hexPrism(r, h, chamfer) {
    const ch = chamfer === undefined ? Math.min(r, h) * 0.08 : chamfer;
    const prof = [[0, -h / 2], [r - ch, -h / 2], [r, -h / 2 + ch], [r, h / 2 - ch], [r - ch, h / 2], [0, h / 2]];
    const g = lathe(prof, 6, {});
    return g;
  }

  /* ───────── 滚花圆柱（直纹/菱形滚花） ───────── */
  function knurledGrip(r, h, teeth, depth, segPer, hole) {
    teeth = teeth || 28; depth = depth || r * 0.045; segPer = segPer || 4;
    hole = hole || 0;   // 端面内孔半径：环类零件必须开孔，否则会把光孔整个封死
    const seg = teeth * segPer;
    const b = new Builder();
    const rows = [];
    const nv = 6;
    const ch = Math.min(r, h) * 0.07;
    for (let j = 0; j <= nv; j++) {
      const t = j / nv;
      const y = -h / 2 + ch + (h - 2 * ch) * t;
      // 端部收边
      const edge = Math.min(1, Math.min(t, 1 - t) * 8 + 0.15);
      const row = [];
      for (let k = 0; k <= seg; k++) {
        const a = k / seg * TAU;
        const kn = (0.5 + 0.5 * Math.cos(teeth * a)) * (0.5 + 0.5 * Math.cos(teeth * 2.2 * y / h * 6));
        const rr = r + depth * (kn - 0.5) * edge;
        const ca = Math.cos(a), sa = Math.sin(a);
        // 数值法线
        const da = TAU / seg;
        const kn1 = (0.5 + 0.5 * Math.cos(teeth * (a + da))) * (0.5 + 0.5 * Math.cos(teeth * 2.2 * y / h * 6));
        const rr1 = r + depth * (kn1 - 0.5) * edge;
        const p1 = [rr1 * Math.cos(a + da), y, rr1 * Math.sin(a + da)];
        const p0 = [rr * ca, y, rr * sa];
        const dy = 1e-4;
        const kn2 = (0.5 + 0.5 * Math.cos(teeth * a)) * (0.5 + 0.5 * Math.cos(teeth * 2.2 * (y + dy) / h * 6));
        const rr2 = r + depth * (kn2 - 0.5) * edge;
        const p2 = [rr2 * ca, y + dy, rr2 * sa];
        let n1 = cross([p1[0] - p0[0], 0, p1[2] - p0[2]], [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]);
        n1 = norm(n1);
        if (n1[0] * ca + n1[2] * sa < 0) n1 = [-n1[0], -n1[1], -n1[2]];
        row.push(b.vert(p0[0], p0[1], p0[2], n1[0], n1[1], n1[2], k / seg, t));
      }
      rows.push(row);
    }
    /* 滚花面的相邻四边形法线差异极大，quadA 的「按平均法线翻面」在齿侧
       点积≈0 时会随机翻面 → 一半三角形被背面剔除，表面出现黑洞。
       这里绕序是确定的（与 lathe 一致：先周向后轴向），直接 quad 即可。
       注意顺序不能反 —— 反了外表面会被背面剔除，看到的全是筒内壁，
       滚花环就变成一片「薄薄的弧形壳」。 */
    for (let j = 0; j < nv; j++)
      for (let k = 0; k < seg; k++)
        b.quad(rows[j][k], rows[j][k + 1], rows[j + 1][k + 1], rows[j + 1][k]);
    /* 两端端面：hole>0 时是环形端面（滚花环、光阑外筒、偏振片转环），
       hole=0 时是实心端面（旋钮、鼓轮）。早期版本一律做成实心盘，
       结果每个滚花环都把光孔封成一块灰盘 —— 光阑看起来像块磨砂玻璃。 */
    for (const sgn of [1, -1]) {
      const y = sgn > 0 ? h / 2 : -h / 2;
      const outer = [], inner = [];
      for (let k = 0; k <= seg; k++) {
        const a = k / seg * TAU;
        const rr = r + depth * ((0.5 + 0.5 * Math.cos(teeth * a)) *
          (0.5 + 0.5 * Math.cos(teeth * 2.2 * (sgn > 0 ? 1 : 0) * 6)) - 0.5) * 0.15;
        outer.push(b.vert(rr * Math.cos(a), y, rr * Math.sin(a), 0, sgn, 0, k / seg, 0));
        if (hole > 0) inner.push(b.vert(hole * Math.cos(a), y, hole * Math.sin(a), 0, sgn, 0, k / seg, 1));
      }
      if (hole > 0) {
        for (let k = 0; k < seg; k++) {
          if (sgn > 0) b.quad(inner[k], inner[k + 1], outer[k + 1], outer[k]);
          else b.quad(inner[k + 1], inner[k], outer[k], outer[k + 1]);
        }
      } else {
        const c = b.vert(0, y, 0, 0, sgn, 0, 0.5, 0.5);
        for (let k = 0; k < seg; k++) {
          if (sgn > 0) b.tri(c, outer[k], outer[k + 1]);
          else b.tri(c, outer[k + 1], outer[k]);
        }
      }
    }
    return b.build();
  }

  /* ───────── 双凸透镜（轴 = Z） ───────── */
  function biconvex(aperture, Rc, centerT, edgeT, segR, segT) {
    segR = segR || 24; segT = segT || 64;
    const b = new Builder();
    const sagMax = Rc - Math.sqrt(Math.max(0, Rc * Rc - aperture * aperture));
    const h0 = centerT / 2, h1 = Math.max(0.0004, edgeT / 2);
    const kk = (h0 - h1) / Math.max(1e-6, sagMax);

    function surf(sign) {
      const grid = [];
      for (let j = 0; j <= segR; j++) {
        const r = aperture * Math.pow(j / segR, 0.62);
        const sag = Rc - Math.sqrt(Math.max(0, Rc * Rc - r * r));
        const z = sign * (h0 - kk * sag);
        const dzdr = -sign * kk * (r / Math.sqrt(Math.max(1e-9, Rc * Rc - r * r)));
        const row = [];
        for (let k = 0; k <= segT; k++) {
          const a = k / segT * TAU, ca = Math.cos(a), sa = Math.sin(a);
          let nx = -dzdr * ca, ny = -dzdr * sa, nz = sign;
          const L = Math.hypot(nx, ny, nz) || 1;
          row.push(b.vert(r * ca, r * sa, z, nx / L, ny / L, nz / L,
            .5 + ca * r / aperture * .5, .5 + sa * r / aperture * .5));
        }
        grid.push(row);
      }
      for (let j = 0; j < segR; j++)
        for (let k = 0; k < segT; k++)
          b.quadA(grid[j][k], grid[j][k + 1], grid[j + 1][k + 1], grid[j + 1][k]);
    }
    surf(1); surf(-1);
    // 边缘
    const rt = [], rb = [];
    for (let k = 0; k <= segT; k++) {
      const a = k / segT * TAU, ca = Math.cos(a), sa = Math.sin(a);
      rt.push(b.vert(aperture * ca, aperture * sa, h1, ca, 0, sa, k / segT, 0));
    }
    for (let k = 0; k <= segT; k++) {
      const a = k / segT * TAU, ca = Math.cos(a), sa = Math.sin(a);
      rb.push(b.vert(aperture * ca, aperture * sa, -h1, ca, 0, sa, k / segT, 1));
    }
    for (let k = 0; k < segT; k++) b.quadA(rt[k], rt[k + 1], rb[k + 1], rb[k]);
    return b.build();
  }

  /* ───────── 通用透镜（R1/R2，0 = 平面） ───────── */
  function lensGeneric(aperture, R1, R2, centerT, segR, segT) {
    segR = segR || 22; segT = segT || 56;
    const b = new Builder();
    const sagOf = (R, r) => (!R ? 0 : Math.abs(R) - Math.sqrt(Math.max(0, R * R - r * r)));
    const s1 = sagOf(R1, aperture), s2 = sagOf(R2, aperture);
    const h0 = centerT / 2;
    const h1 = Math.max(0.12 * centerT, h0 - 0.5 * Math.max(s1, s2));
    const k1 = (h0 - h1) / (s1 || 1e-6), k2 = (h0 - h1) / (s2 || 1e-6);
    function surf(sign, R, kk) {
      const grid = [];
      for (let j = 0; j <= segR; j++) {
        const r = aperture * Math.pow(j / segR, 0.62);
        const sag = sagOf(R, r);
        const z = sign * (h0 - kk * sag);
        const dzdr = -sign * kk * (R ? r / Math.sqrt(Math.max(1e-9, R * R - r * r)) : 0);
        const row = [];
        for (let k = 0; k <= segT; k++) {
          const a = k / segT * TAU, ca = Math.cos(a), sa = Math.sin(a);
          let nx = -dzdr * ca, ny = -dzdr * sa, nz = sign;
          const L = Math.hypot(nx, ny, nz) || 1;
          row.push(b.vert(r * ca, r * sa, z, nx / L, ny / L, nz / L,
            .5 + ca * .5 * r / aperture, .5 + sa * .5 * r / aperture));
        }
        grid.push(row);
      }
      for (let j = 0; j < segR; j++)
        for (let k = 0; k < segT; k++)
          b.quadA(grid[j][k], grid[j][k + 1], grid[j + 1][k + 1], grid[j + 1][k]);
    }
    surf(1, R1, k1); surf(-1, R2, k2);
    const rt = [], rb = [];
    for (let k = 0; k <= segT; k++) {
      const a = k / segT * TAU, ca = Math.cos(a), sa = Math.sin(a);
      rt.push(b.vert(aperture * ca, aperture * sa, h1, ca, 0, sa, k / segT, 0));
    }
    for (let k = 0; k <= segT; k++) {
      const a = k / segT * TAU, ca = Math.cos(a), sa = Math.sin(a);
      rb.push(b.vert(aperture * ca, aperture * sa, -h1, ca, 0, sa, k / segT, 1));
    }
    for (let k = 0; k < segT; k++) b.quadA(rt[k], rt[k + 1], rb[k + 1], rb[k]);
    return b.build();
  }

  /* ───────── 螺纹环（外观用，细密沟槽） ───────── */
  function threadRing(r, h, pitch, seg) {
    seg = seg || 96;
    const prof = [];
    const n = Math.max(6, Math.round(h / (pitch || 0.0006)));
    prof.push([r, -h / 2]);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = -h / 2 + h * t;
      const rr = r + ((i % 2) ? 0.00012 : -0.00012);
      prof.push([rr, y]);
    }
    prof.push([r, h / 2]);
    return lathe(prof, seg, {});
  }

  /* ───────── 光束带（单位空间，供加性体积渲染） ─────────
     局部坐标：x∈[0,1] 轴向，y∈[-1,1] 横向（半径归一化），z=0 平面；
     交叉 planes 片（默认 2 片，互成 90°）。真实半径/长度由顶点着色器的
     uW0/uW1/uLen 决定，因此整条光束共用同一份几何，无需按段重建。
     uv.x = 横向 0→1，uv.y = 轴向 0→1 */
  function beamRibbon(slices, planes) {
    slices = slices || 12; planes = planes || 2;
    const b = new Builder();
    for (let p = 0; p < planes; p++) {
      const a = p / planes * Math.PI;
      const cy = Math.cos(a), sy = Math.sin(a);
      // 面法线恒指向该片的 +侧，加性渲染不使用光照，仅用于背面判定
      const nx = 0, ny = -sy, nz = cy;
      const rows = [];
      for (let j = 0; j <= slices; j++) {
        const t = j / slices;
        const row = [];
        for (let k = 0; k <= 1; k++) {
          const s = k ? 1 : -1;
          row.push(b.vert(t, s * cy, s * sy, nx, ny, nz, k, t));
        }
        rows.push(row);
      }
      for (let j = 0; j < slices; j++)
        b.quadA(rows[j][0], rows[j][1], rows[j + 1][1], rows[j + 1][0]);
    }
    return b.build();
  }

  /* ───────── 合并 / 变换 ───────── */
  function merge(list) {
    let vn = 0, inn = 0;
    for (const g of list) { if (!g) continue; vn += g.vertices.length; inn += g.indices.length; }
    const V = new Float32Array(vn), I = new Uint32Array(inn);
    let vo = 0, io = 0, base = 0;
    for (const g of list) {
      if (!g) continue;
      V.set(g.vertices, vo);
      const nv = g.vertices.length / 12;
      for (let k = 0; k < g.indices.length; k++) I[io + k] = g.indices[k] + base;
      vo += g.vertices.length; io += g.indices.length; base += nv;
    }
    return { vertices: V, indices: I, vertexCount: vn / 12, triCount: inn / 3 };
  }

  function transform(geo, matrix) {
    const V = new Float32Array(geo.vertices.length);
    const n = geo.vertices.length / 12;
    const nm = M4.normalMat3(new Float32Array(9), matrix);
    const p = new Float32Array(3);
    for (let i = 0; i < n; i++) {
      const o = i * 12;
      p[0] = geo.vertices[o]; p[1] = geo.vertices[o + 1]; p[2] = geo.vertices[o + 2];
      V[o] = matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12];
      V[o + 1] = matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13];
      V[o + 2] = matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14];
      const nx = geo.vertices[o + 3], ny = geo.vertices[o + 4], nz = geo.vertices[o + 5];
      let ax = nm[0] * nx + nm[3] * ny + nm[6] * nz;
      let ay = nm[1] * nx + nm[4] * ny + nm[7] * nz;
      let az = nm[2] * nx + nm[5] * ny + nm[8] * nz;
      const L = Math.hypot(ax, ay, az) || 1;
      V[o + 3] = ax / L; V[o + 4] = ay / L; V[o + 5] = az / L;
      V[o + 6] = geo.vertices[o + 6]; V[o + 7] = geo.vertices[o + 7];
      V[o + 8] = geo.vertices[o + 8]; V[o + 9] = geo.vertices[o + 9];
      V[o + 10] = geo.vertices[o + 10]; V[o + 11] = geo.vertices[o + 11];
    }
    return { vertices: V, indices: new Uint32Array(geo.indices), vertexCount: n, triCount: geo.indices.length / 3 };
  }

  /** 便捷：把沿 Y 的几何转到沿 X */
  const toX = (g) => transform(g, M4.fromTRS(M4.create(), [0, 0, 0], [0, 0, -90], [1, 1, 1]));

  global.GEO = {
    Builder, surface, plane, box, roundedBox, cylinder, sphere, disc, annulus,
    torus, lathe, arcShell, tubePath, hexPrism, knurledGrip, biconvex,
    lensGeneric, threadRing, merge, transform, toX, cross, dot, norm, beamRibbon,
  };
})(window);
