/* ═══════════════════════════════════════════════════════════
   embed.js · 宿主页面内嵌模式
   用法：iframe.src = 'index.html?embed=1'（可选 &step=3 指定初始步骤）

   与宿主的最小协议（同源或跨源都可用，消息里带 source 标识）：
     宿主 → 本页  { type:'optilab:cmd', cmd:'set-step'|'set-mode'|'set-view'|'solve'|'reset-view', value }
     本页 → 宿主  { type:'optilab:ready', version, steps:[{index,title,brief}] }
                  { type:'optilab:step', index, title, done }
                  { type:'optilab:state', index, mode, done }
                  { type:'optilab:error', message }
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var params = new URLSearchParams(location.search);
  var mode = params.get('embed');
  if (!mode || mode === '0') return;      // 不是内嵌：一行都不执行

  var doc = document.documentElement;
  doc.classList.add('optilab-embed');
  if (mode === 'compact') doc.classList.add('optilab-embed-compact');

  function emit(msg) {
    if (window.parent === window) return;
    try {
      window.parent.postMessage(Object.assign({ source: 'optilab', version: VERSION }, msg), '*');
    } catch (e) { /* 宿主已卸载 */ }
  }

  /* ── 等待 App 启动完成（GPU 上下文 / FFT 编译 / 首次求解）── */
  function whenReady(cb) {
    var tries = 0;
    var timer = setInterval(function () {
      var app = window.APP;
      var appEl = document.getElementById('app');
      var booted = app && app.rnd && app.jtc && app.lab && appEl && appEl.classList.contains('ready');
      if (booted) { clearInterval(timer); cb(app); return; }
      if (++tries > 300) {                     // 15 s 仍未就绪
        clearInterval(timer);
        emit({ type: 'optilab:error', message: '初始化超时：请确认浏览器支持 WebGL2' });
      }
    }, 50);
  }

  var last = { index: -1, mode: '', done: -1 };
  function reportStep(app) {
    var done = app.doneSteps ? app.doneSteps.size : 0;
    if (app.stepIndex === last.index && app.mode === last.mode && done === last.done) return;
    last = { index: app.stepIndex, mode: app.mode, done: done };
    var st = app.steps && app.steps[app.stepIndex];
    emit({
      type: 'optilab:step',
      index: app.stepIndex,
      title: st ? st.title : '',
      count: app.steps ? app.steps.length : 0,
      done: app.doneSteps ? Array.from(app.doneSteps) : [],
      mode: app.mode,
    });
  }

  function applyCmd(app, cmd, value) {
    switch (cmd) {
      case 'set-step':
        if (typeof value === 'number' && app.steps) {
          if (app.mode !== 'guide') app.setMode('guide');
          app.gotoStep(value);
        }
        break;
      case 'set-mode':
        if (value === 'guide' || value === 'free') app.setMode(value);
        break;
      case 'set-view':
        if (['bench', 'beam', 'screen'].indexOf(value) >= 0) app.setView(value);
        break;
      case 'solve':
        if (app.solve) app.solve(true);
        break;
      case 'reset-view':
        if (app.viewAction) app.viewAction('reset');
        break;
      default:
        break;
    }
    reportStep(app);
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source === 'optilab' || data.type !== 'optilab:cmd') return;
    var app = window.APP;
    if (!app || !app.steps) return;
    applyCmd(app, data.cmd, data.value);
  });

  whenReady(function (app) {
    emit({
      type: 'optilab:ready',
      version: VERSION,
      steps: (app.steps || []).map(function (s, i) {
        return { index: i, title: s.title, brief: s.brief };
      }),
    });

    // 初始步骤：?step=N —— 宿主打开时直接落到对应实验环节
    var initial = parseInt(params.get('step'), 10);
    if (!isNaN(initial)) applyCmd(app, 'set-step', initial);

    // 步骤 / 模式变化回传（低频轮询，避免改 app.js 内部逻辑）
    setInterval(function () { reportStep(app); }, 400);

    // 键盘落到 iframe 内部时，宿主仍可用 Esc 退出（把 Esc 冒泡上去）
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') emit({ type: 'optilab:key', key: 'Escape' });
    });
  });
})();
