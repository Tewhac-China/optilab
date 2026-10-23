/* ═══════════════════════════════════════════════════════════
   textures.js · 程序化铭牌 / 刻度 / 警示标签
   全部用 Canvas2D 生成，透明底 → 以 decal 材质贴到器件表面
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function cv(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  const SANS = '"Inter","Segoe UI","Microsoft YaHei",sans-serif';
  const MONO = '"JetBrains Mono",Consolas,monospace';

  /* 激光器铭牌：黄底黑字警示 + 型号 */
  function laserDanger() {
    const c = cv(512, 256), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 256);
    // 黄色警示块
    x.fillStyle = '#e8b31a';
    rrect(x, 4, 4, 504, 248, 10); x.fill();
    // 黑边
    x.strokeStyle = '#12100c'; x.lineWidth = 8;
    rrect(x, 12, 12, 488, 232, 6); x.stroke();
    // 激光符号
    x.save();
    x.translate(92, 104);
    x.strokeStyle = '#12100c'; x.lineWidth = 7;
    x.beginPath(); x.arc(0, 0, 44, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.moveTo(-62, 0); x.lineTo(-24, 0); x.moveTo(24, 0); x.lineTo(62, 0); x.stroke();
    x.beginPath(); x.arc(0, 0, 14, 0, Math.PI * 2); x.fillStyle = '#12100c'; x.fill();
    x.restore();
    x.fillStyle = '#12100c';
    x.font = '700 46px ' + SANS;
    x.fillText('DANGER', 176, 74);
    x.font = '700 26px ' + SANS;
    x.fillText('LASER RADIATION', 176, 110);
    x.font = '500 20px ' + SANS;
    x.fillText('AVOID DIRECT EYE EXPOSURE', 176, 140);
    x.font = '700 22px ' + MONO;
    x.fillText('CLASS 3B  ·  632.8 nm  ·  2.0 mW', 176, 176);
    x.font = '500 18px ' + SANS;
    x.fillText('OPTILAB  HENE-20  ·  SN 2026-0417', 176, 208);
    return c;
  }

  /* 激光器尾部铭牌（深色金属 + 蚀刻字） */
  function laserPlate() {
    const c = cv(512, 192), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 192);
    x.fillStyle = 'rgba(18,20,24,0.92)';
    rrect(x, 2, 2, 508, 188, 8); x.fill();
    x.strokeStyle = 'rgba(180,196,214,.35)'; x.lineWidth = 2;
    rrect(x, 8, 8, 496, 176, 5); x.stroke();
    x.fillStyle = '#cfdae8';
    x.font = '600 34px ' + MONO;
    x.fillText('HeNe 632.8 nm', 26, 56);
    x.fillStyle = '#8fa3ba';
    x.font = '400 22px ' + MONO;
    x.fillText('OUTPUT  2.0 mW  TEM00', 26, 92);
    x.fillText('SER. 2026-0417   AC 3.2 kV', 26, 122);
    x.fillStyle = '#e8b31a';
    x.font = '600 18px ' + SANS;
    x.fillText('DO NOT OPEN — HIGH VOLTAGE', 26, 158);
    return c;
  }

  /* 镜筒焦距环：环形排列的刻度 + 焦距 */
  function lensRing(text) {
    const c = cv(512, 128), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 128);
    x.fillStyle = 'rgba(232,238,246,.94)';
    x.font = '600 54px ' + MONO;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, 256, 66);
    // 两侧细刻度
    x.strokeStyle = 'rgba(232,238,246,.75)'; x.lineWidth = 3;
    for (let i = 0; i < 7; i++) {
      const px = 40 + i * 9;
      x.beginPath(); x.moveTo(px, 40); x.lineTo(px, i % 2 ? 58 : 66); x.stroke();
      const qx = 472 - i * 9;
      x.beginPath(); x.moveTo(qx, 40); x.lineTo(qx, i % 2 ? 58 : 66); x.stroke();
    }
    return c;
  }

  /* 调整架侧沿的激光刻字（透明底，只有字） */
  function mountLabel(main, sub) {
    const c = cv(512, 96), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 96);
    x.textBaseline = 'middle';
    x.fillStyle = 'rgba(214,222,232,.92)';
    x.font = '600 40px ' + MONO;
    x.fillText(main || 'KM100', 14, 50);
    x.fillStyle = 'rgba(150,166,186,.85)';
    x.font = '400 30px ' + MONO;
    x.textAlign = 'right';
    x.fillText(sub || 'f = 150 mm', 498, 50);
    // 中间的小菱形标记（装配基准）
    x.fillStyle = 'rgba(120,200,230,.55)';
    x.beginPath();
    x.moveTo(256, 34); x.lineTo(266, 50); x.lineTo(256, 66); x.lineTo(246, 50);
    x.closePath(); x.fill();
    return c;
  }

  /* 光阑孔径刻度环（0…12 mm） */
  function irisScale() {
    const c = cv(512, 128), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 128);
    x.strokeStyle = 'rgba(226,234,244,.9)';
    x.fillStyle = 'rgba(226,234,244,.9)';
    x.lineWidth = 3;
    x.textAlign = 'center';
    x.font = '600 26px ' + MONO;
    for (let i = 0; i <= 24; i++) {
      const px = 26 + i * (460 / 24);
      const long = i % 4 === 0;
      x.beginPath(); x.moveTo(px, 96); x.lineTo(px, long ? 54 : 74); x.stroke();
      if (long) x.fillText(String(i), px, 40);
    }
    return c;
  }

  /* 偏振片旋转刻度环（0…180°，每 15° 长刻线） */
  function polScale() {
    const c = cv(512, 128), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 128);
    x.strokeStyle = 'rgba(226,234,244,.86)';
    x.fillStyle = 'rgba(226,234,244,.86)';
    x.lineWidth = 3; x.textAlign = 'center';
    x.font = '600 24px ' + MONO;
    for (let i = 0; i <= 36; i++) {
      const px = 22 + i * (468 / 36);
      const long = i % 6 === 0;
      x.beginPath(); x.moveTo(px, 96); x.lineTo(px, long ? 52 : 72); x.stroke();
      if (long) x.fillText(String(i * 5), px, 38);
    }
    // 红色零位指标
    x.fillStyle = '#e04a3c';
    x.fillRect(20, 100, 4, 24);
    return c;
  }

  /* 光学平台前缘标尺 */
  function boardRuler() {
    const c = cv(2048, 96), x = c.getContext('2d');
    x.clearRect(0, 0, 2048, 96);
    x.fillStyle = 'rgba(214,224,236,.85)';
    x.strokeStyle = 'rgba(214,224,236,.85)';
    x.textAlign = 'center'; x.textBaseline = 'top';
    x.font = '500 26px ' + MONO;
    for (let i = 0; i <= 180; i++) {
      const px = 20 + i * (2008 / 180);
      const long = i % 10 === 0, mid = i % 5 === 0;
      x.lineWidth = long ? 3 : 2;
      x.beginPath(); x.moveTo(px, 6); x.lineTo(px, long ? 48 : mid ? 34 : 24); x.stroke();
      if (long) x.fillText(String(i * 10), px, 52);
    }
    return c;
  }

  /* CMOS 相机铭牌 */

  function cameraPlate() {
    const c = cv(512, 256), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 256);
    x.fillStyle = 'rgba(20,23,28,.95)';
    rrect(x, 2, 2, 508, 252, 10); x.fill();
    x.strokeStyle = 'rgba(120,200,230,.35)'; x.lineWidth = 2;
    rrect(x, 10, 10, 492, 236, 6); x.stroke();
    x.fillStyle = '#dbe6f2';
    x.font = '700 40px ' + SANS;
    x.fillText('OPTILAB', 26, 62);
    x.fillStyle = '#7fd6ea';
    x.font = '500 24px ' + MONO;
    x.fillText('CMOS  CAMERA', 26, 96);
    x.fillStyle = '#93a3b8';
    x.font = '400 20px ' + MONO;
    x.fillText('1024 × 1024  ·  5.86 µm', 26, 132);
    x.fillText('USB 3.0  ·  60 fps', 26, 160);
    x.fillText('SN 26A-0912', 26, 188);
    // 小圆点指示灯
    x.fillStyle = '#34d399';
    x.beginPath(); x.arc(462, 46, 7, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#5d6b7e';
    x.font = '400 14px ' + MONO;
    x.fillText('PWR', 440, 78);
    return c;
  }

  /* SLM 铭牌 */
  function slmPlate() {
    const c = cv(512, 160), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 160);
    x.fillStyle = 'rgba(16,19,24,.94)';
    rrect(x, 2, 2, 508, 156, 8); x.fill();
    x.fillStyle = '#cfdae8';
    x.font = '600 30px ' + MONO;
    x.fillText('LCOS-SLM', 22, 52);
    x.fillStyle = '#7fd6ea';
    x.font = '400 20px ' + MONO;
    x.fillText('1024 × 768  ·  8.0 µm pitch', 22, 88);
    x.fillStyle = '#93a3b8';
    x.font = '400 18px ' + MONO;
    x.fillText('λ 400–700 nm  ·  HDMI', 22, 120);
    return c;
  }

  /* 电源 / 控制器铭牌 */
  function powerPlate() {
    const c = cv(512, 200), x = c.getContext('2d');
    x.clearRect(0, 0, 512, 200);
    x.fillStyle = 'rgba(22,25,30,.95)';
    rrect(x, 2, 2, 508, 196, 8); x.fill();
    x.fillStyle = '#dbe6f2';
    x.font = '600 32px ' + SANS;
    x.fillText('LASER  POWER  SUPPLY', 22, 54);
    x.fillStyle = '#93a3b8';
    x.font = '400 20px ' + MONO;
    x.fillText('MODEL LPS-3.2kV', 22, 90);
    x.fillText('IN 220 V~ 50 Hz', 22, 120);
    x.fillText('OUT 3.2 kV  /  6 mA', 22, 150);
    return c;
  }

  /* 黄黑警示条（光束终止器 / 边缘） */
  function hazardStripes() {
    const c = cv(256, 64), x = c.getContext('2d');
    x.fillStyle = '#e8b31a'; x.fillRect(0, 0, 256, 64);
    x.fillStyle = '#15130f';
    for (let i = -64; i < 320; i += 44) {
      x.beginPath();
      x.moveTo(i, 0); x.lineTo(i + 22, 0); x.lineTo(i + 22 - 64, 64); x.lineTo(i - 64, 64);
      x.closePath(); x.fill();
    }
    return c;
  }

  /* 螺钉/旋钮顶面的滚花细纹（可作 albedo 调制） */
  function brushed(w, h, base) {
    const c = cv(w, h), x = c.getContext('2d');
    const img = x.createImageData(w, h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const n = 0.5 + 0.5 * Math.sin(j * 0.7 + Math.sin(i * 0.05) * 2.0);
        const v = base * (0.92 + 0.08 * n);
        const o = (j * w + i) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    return c;
  }

  global.TEX = {
    laserDanger, laserPlate, lensRing, irisScale, polScale, boardRuler,
    cameraPlate, slmPlate, powerPlate, hazardStripes, brushed, mountLabel,
  };
})(window);
