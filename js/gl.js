/* ═══════════════════════════════════════════════════════════
   gl.js · WebGL2 薄封装
   —— program / VAO / texture / FBO / 状态块，均在单一 context 内，
      使 GPU-FFT 的计算纹理可被 3D 场景直接采样（零拷贝）
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ───────── 着色器编译 ───────── */
  function compile(gl, type, src, tag) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '';
      const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join('\n');
      console.error(`[shader:${tag}] ${log}\n${lines}`);
      gl.deleteShader(sh);
      throw new Error(`着色器编译失败 (${tag})：\n${log}`);
    }
    return sh;
  }

  const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

  class Program {
    constructor(gl, vsSrc, fsSrc, tag) {
      this.gl = gl; this.tag = tag || 'prog';
      const vs = compile(gl, gl.VERTEX_SHADER, HEADER + vsSrc, tag + '.vs');
      const fs = compile(gl, gl.FRAGMENT_SHADER, HEADER + fsSrc, tag + '.fs');
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        throw new Error(`着色器链接失败 (${tag})：\n${log}`);
      }
      gl.deleteShader(vs); gl.deleteShader(fs);
      this.p = p;
      this.loc = new Map();
      // 反射 uniform 类型，便于自动设置
      this.utype = new Map();
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        const name = info.name.replace(/\[0\]$/, '');
        this.utype.set(name, info.type);
      }
    }
    use() { this.gl.useProgram(this.p); return this; }
    u(name) {
      let l = this.loc.get(name);
      if (l === undefined) { l = this.gl.getUniformLocation(this.p, name); this.loc.set(name, l); }
      return l;
    }
    /** 自动按类型派发 */
    set(name, v) {
      const gl = this.gl, l = this.u(name);
      if (l === null || l === undefined) return this;
      const t = this.utype.get(name);
      if (t === undefined) return this;
      switch (t) {
        case gl.FLOAT: gl.uniform1f(l, v); break;
        case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: case gl.SAMPLER_CUBE:
          gl.uniform1i(l, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(l, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(l, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(l, v); break;
        case gl.INT_VEC2: gl.uniform2iv(l, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(l, false, v); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(l, false, v); break;
        default: break;
      }
      return this;
    }
    setAll(obj) { for (const k in obj) this.set(k, obj[k]); return this; }
    /** 绑定纹理到指定 unit 并设置 sampler uniform */
    tex(name, texture, unit) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      this.set(name, unit);
      return this;
    }
    dispose() { this.gl.deleteProgram(this.p); }
  }

  /* ───────── 纹理 ───────── */
  // internalFormat, format, type 三元组
  const FMT = {
    rgba8: { ifmt: 'RGBA8', fmt: 'RGBA', type: 'UNSIGNED_BYTE', bytes: 4 },
    rgba16f: { ifmt: 'RGBA16F', fmt: 'RGBA', type: 'HALF_FLOAT', bytes: 8 },
    rgba32f: { ifmt: 'RGBA32F', fmt: 'RGBA', type: 'FLOAT', bytes: 16 },
    rg32f: { ifmt: 'RG32F', fmt: 'RG', type: 'FLOAT', bytes: 8 },
    r32f: { ifmt: 'R32F', fmt: 'RED', type: 'FLOAT', bytes: 4 },
    r8: { ifmt: 'R8', fmt: 'RED', type: 'UNSIGNED_BYTE', bytes: 1 },
  };

  function tex2D(gl, o) {
    const f = FMT[o.format || 'rgba8'];
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const isCanvas = o.data && (o.data instanceof HTMLCanvasElement || o.data instanceof ImageData ||
      (typeof ImageBitmap !== 'undefined' && o.data instanceof ImageBitmap));
    if (isCanvas && o.flipY !== false) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0,
      gl[f.ifmt], o.width, o.height, 0,
      gl[f.fmt], gl[f.type], o.data || null);
    if (isCanvas && o.flipY !== false) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const filter = o.filter || 'linear';
    const wrap = o.wrap || 'clamp';
    const glFilter = filter === 'nearest' ? gl.NEAREST : (filter === 'mipmap' ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter === 'mipmap' ? glFilter : glFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === 'nearest' ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    if (filter === 'mipmap') gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    t._w = o.width; t._h = o.height; t._fmt = f;
    return t;
  }

  /** 渲染目标：颜色纹理 + 可选深度（renderbuffer 或可采样深度纹理） */
  function makeFBO(gl, o) {
    const tex = tex2D(gl, o);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let depth = null, depthTex = null;
    if (o.depth && o.depthTexture) {
      depthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, o.width, o.height, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } else if (o.depth) {
      depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, o.width, o.height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    }
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('[gl] FBO 不完整 0x' + st.toString(16), o);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, depth, depthTex, width: o.width, height: o.height };
  }

  /* ───────── 全屏三角 ───────── */
  // 用单个覆盖屏幕的三角形（比 quad 少一次插值边界）
  function fullscreenVAO(gl) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, buf };
  }

  /* ───────── 顶点布局 ───────── */
  // 0: position(3)  1: normal(3)  2: uv(2)  3: extra(4) = (ao, matId, instanceSeed, unused)
  const STRIDE = 12 * 4;

  function uploadMesh(gl, geo, dynamic) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, geo.vertices, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STRIDE, 32);
    let ibo = null, count = 0;
    const hasIdx = geo.indices && geo.indices.length > 0;
    if (hasIdx) {
      ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.indices, gl.STATIC_DRAW);
      count = geo.indices.length;
    } else {
      count = geo.vertices.length / 12;
    }
    gl.bindVertexArray(null);
    return { vao, vbo, ibo, count, indexed: hasIdx };
  }

  /* ───────── 上下文 ───────── */
  function createContext(canvas, opts) {
    const gl = canvas.getContext('webgl2', Object.assign({
      alpha: false, antialias: false, depth: true, stencil: false,
      premultipliedAlpha: false,
      // 截图在同一帧的 rAF 回调里 toDataURL，不需要 preserveDrawingBuffer；
      // 打开它会强制浏览器每帧复制一次后备缓冲，是明显的额外带宽开销。
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance', desynchronized: true,
    }, opts || {}));
    if (!gl) throw new Error('当前浏览器/设备不支持 WebGL2，请使用较新版本的 Chrome / Edge。');

    const caps = {
      colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
      colorBufferHalf: !!gl.getExtension('EXT_color_buffer_half_float'),
      floatLinear: !!gl.getExtension('OES_texture_float_linear'),
      aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
      deriv: !!gl.getExtension('OES_standard_derivatives'),
      debugRenderer: gl.getExtension('WEBGL_debug_renderer_info'),
    };
    caps.rendererName = caps.debugRenderer
      ? gl.getParameter(caps.debugRenderer.UNMASKED_RENDERER_WEBGL) : 'unknown';
    caps.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    caps.maxVaryings = gl.getParameter(gl.MAX_VARYING_VECTORS);
    caps.floatRT = caps.colorBufferFloat ? FMT.rgba32f : (caps.colorBufferHalf ? FMT.rgba16f : null);
    caps.lowPrecision = !caps.colorBufferFloat;

    gl.getExtension('EXT_float_blend');   // 浮点色混合（Bloom 累加）

    return { gl, caps };
  }

  function resize(canvas, gl, dpr) {
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      return true;
    }
    return false;
  }

  global.GLX = {
    Program, FMT, tex2D, makeFBO, fullscreenVAO, uploadMesh,
    createContext, resize, STRIDE,
  };
})(window);
