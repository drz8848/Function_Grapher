/*
 * state.js — 共享状态与函数模型（浏览器全局命名空间 FPlot）
 * 职责：工具函数、应用状态、函数对象（解析/求值/常数字母）、持久化、参数动画引擎。
 * 约束：不直接操作视图；DOM 相关的 UI 编排留在 app.js。
 */
(function (root) {
  'use strict';

  /* ===================== 小工具 ===================== */

  function $(sel) { return document.querySelector(sel); }

  function uid() {
    return 'f' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function fmt(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(3);
    return String(parseFloat(v.toPrecision(6)));
  }

  function niceStep(span, target) {
    if (!(span > 0) || !isFinite(span)) return 1;
    var rough = span / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var n = rough / mag;
    var step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return step * mag;
  }

  function linspace(a, b, n) {
    var out = new Array(n);
    if (n === 1) { out[0] = a; return out; }
    var d = (b - a) / (n - 1);
    for (var i = 0; i < n; i++) out[i] = a + d * i;
    out[n - 1] = b;
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function stamp() {
    var d = new Date();
    function q(n) { return String(n).length < 2 ? '0' + n : String(n); }
    return '' + d.getFullYear() + q(d.getMonth() + 1) + q(d.getDate()) + '_' + q(d.getHours()) + q(d.getMinutes()) + q(d.getSeconds());
  }

  function downloadDataURL(dataURL, filename) {
    var a = document.createElement('a');
    a.href = dataURL;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ===================== 状态 ===================== */

  var LS_STATE = 'fplot.v2.state';
  var LS_STATE_V1 = 'fplot.v1.state';
  var LS_HISTORY = 'fplot.v2.history';
  var LS_HISTORY_V1 = 'fplot.v1.history';
  var PALETTE = ['#ef5350', '#4f8ef7', '#51cf66', '#fcc419', '#cc5de8', '#22b8cf', '#ff922b', '#845ef7'];

  function defaultView() {
    return {
      mode: '3d',
      res: 60, wireframe: false, showGrid: true, showTicks: true,
      x: [-5, 5], y: [-5, 5], zAuto: true, z: [-2, 2],
      x2: [-10, 10], y2Auto: true, y2: [-6, 6],
      impGrid: 96, // 二维隐函数网格密度
      t2: { // 二维参考系变换
        mode: 'off', // 'off' | 'linear' | 'nonlinear'
        m: { a: 1, b: 0, c: 0, d: 1 },
        fx: 'x', fy: 'y',
        follow: true,
        t: 0, phase: 0, animate: false,
      },
      t3: { // 三维参考系变换
        mode: 'off',
        m: { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, g: 0, h: 0, i: 1 },
        fx: 'x', fy: 'y', fz: 'z',
        follow: true,
        t: 0, phase: 0, animate: false,
      },
      c3: { bg: '#12151c', ax: '#ff6b6b', ay: '#51cf66', az: '#5c9ded', grid: '#2a3140', text: '#aab3c5' },
      c2: { bg: '#ffffff', ax: '#d9480f', ay: '#1864ab', grid: '#e9ecf3', text: '#343a40' },
    };
  }

  var state = { functions: [], view: defaultView(), geometry: null }; // geometry 由 geometry.js 反序列化后填充
  var markers2d = []; // { fnId, x, y, color }
  var markers3d = []; // { fnId, pos:[x,y,z], color }

  /* ---------- 函数对象 ---------- */

  var CALL23_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*(,\s*[A-Za-z_][A-Za-z0-9_]*\s*)+\)\s*=/;

  /*
   * 重编译函数定义，自动识别四种形态：
   *   曲线     y(x)=f(x) / x(y)=g(y) / y=… / 裸一元表达式        → kind 'curve2d'
   *   隐函数   f(x,y)=0 形式（x^2+y^2=1 等）                      → kind 'curve2d' + mode 'implicit'
   *   曲面     z(x,y)=f(x,y) / z=… / 裸二元表达式                 → kind 'surface'
   *   隐式曲面 f(x,y,z)=0 / x^2+y^2+z^2=1 / 裸三元表达式         → kind 'surface3dimplicit'
   */
  function recompile(fn) {
    fn.core = null;
    fn.error = null;
    fn.kind = null;
    var c = null;
    try {
      if (/^\s*dcalculus\s*\(/.test(fn.src)) {
        c = compileWithKind(fn, function () { return root.FPlotCalculus.compileDerivativeCall(math, fn.src); });
        fn.kind = 'curve2d';
      } else if (/^\s*calculus\s*\(/.test(fn.src)) {
        c = compileWithKind(fn, function () { return root.FPlotCalculus.compileIntegralCall(math, fn.src); });
        fn.kind = 'curve2d';
      } else if (CALL23_RE.test(fn.src)) {
        // 明确的多变量签名：只走曲面路径
        c = compileWithKind(fn, function () { return root.FPlotCore.compileSurface(math, fn.src); });
        fn.kind = (c.kind === 'surface') ? 'surface' : 'surface3dimplicit';
      } else {
        try {
          c = compileWithKind(fn, function () { return root.FPlotCore.compileEquation2D(math, fn.src); });
          fn.kind = 'curve2d';
        } catch (curveErr) {
          // 曲线失败：若像曲面（含 '=' 且非 2 变量隐函数 / 或裸表达式多变量）再试曲面
          c = compileWithKind(fn, function () { return root.FPlotCore.compileSurface(math, fn.src); });
          fn.kind = (c.kind === 'surface') ? 'surface' : 'surface3dimplicit';
          void curveErr;
        }
      }
    } catch (err) {
      fn.error = err && err.message ? err.message : String(err);
      return;
    }
    // 试算：尽早暴露致命错误（如未定义的函数名）
    var scope = {};
    for (var j = 0; j < c.vars.length; j++) scope[c.vars[j]] = 1;
    for (var k in fn.constants) scope[k] = fn.constants[k];
    if (c.node) {
      try { c.node.compile().evaluate(scope); }
      catch (err2) { fn.error = '求值失败：' + (err2 && err2.message ? err2.message : String(err2)); fn.core = null; }
    }
  }

  function compileWithKind(fn, compileFn) {
    var c = compileFn();
    // 常数字母：保留已有值，补默认 1，删除不再存在的
    var keep = {};
    for (var i = 0; i < c.freeSymbols.length; i++) {
      var s = c.freeSymbols[i];
      var old = fn.constants[s];
      keep[s] = (typeof old === 'number' && isFinite(old)) ? old : 1;
    }
    fn.constants = keep;
    fn.core = c;
    return c;
  }

  function mkFn(src, color) {
    var fn = {
      id: uid(),
      src: src || 'z(x,y)=x^2+y^2',
      color: color || PALETTE[0],
      opacity: 1,
      visible: true,
      constants: {},
      core: null,
      error: null,
      kind: null,
    };
    recompile(fn);
    return fn;
  }

  function fnKind(fn) { return fn.kind || null; }

  function fnLabel(fn) {
    if (fn.core && fn.core.name) return fn.core.name + '(' + fn.core.vars.join(',') + ')';
    if (fn.core && fn.core.mode === 'implicit') {
      return fn.src.length > 30 ? fn.src.slice(0, 30) + '…' : fn.src;
    }
    return fn.src;
  }

  function fnIsDrawable2d(fn) {
    return !!(fn.visible && fn.core && !fn.error && fn.kind === 'curve2d');
  }
  function fnIsDrawable3d(fn) {
    return !!(fn.visible && fn.core && !fn.error && (fn.kind === 'surface' || fn.kind === 'surface3dimplicit'));
  }

  // 安全求值（每次新 scope，用于低频调用）
  function evalFn(fn, vals) {
    if (!fn.core) return NaN;
    var scope = {};
    for (var k in fn.constants) scope[k] = fn.constants[k];
    for (var i = 0; i < fn.core.vars.length; i++) scope[fn.core.vars[i]] = vals[i];
    return fn.core.evaluate(scope);
  }

  // 高频求值：复用 scope 对象，f(a) 或 f(a,b)
  function scopeFn(fn) {
    var scope = {};
    for (var k in fn.constants) scope[k] = fn.constants[k];
    var vs = fn.core.vars;
    return function (a, b) {
      scope[vs[0]] = a;
      if (vs.length > 1) scope[vs[1]] = b;
      return fn.core.evaluate(scope);
    };
  }

  /* ---------- 参数动画引擎 ---------- */

  var anim = {
    active: {},   // key: fnId+'|'+sym → { dir: ±1 }
    speed: 2.5,   // 单位/秒
    count: 0,
  };

  function animToggle(fnId, sym) {
    var key = fnId + '|' + sym;
    if (anim.active[key]) { delete anim.active[key]; anim.count--; return false; }
    anim.active[key] = { dir: 1 };
    anim.count++;
    return true;
  }

  function animIsOn(fnId, sym) { return !!anim.active[fnId + '|' + sym]; }

  /* 推进所有动画常数；有变化返回 true（yoyo 往复于 [-5,5]） */
  function animStep(dt) {
    if (!anim.count) return false;
    var changed = false;
    var fns = state.functions;
    for (var key in anim.active) {
      var parts = key.split('|');
      var fn = null;
      for (var i = 0; i < fns.length; i++) if (fns[i].id === parts[0]) { fn = fns[i]; break; }
      if (!fn) { delete anim.active[key]; anim.count--; continue; }
      var sym = parts[1];
      var a = anim.active[key];
      var v = (typeof fn.constants[sym] === 'number') ? fn.constants[sym] : 0;
      var nv = v + a.dir * anim.speed * dt;
      if (nv >= 5) { nv = 5; a.dir = -1; }
      else if (nv <= -5) { nv = -5; a.dir = 1; }
      else if (v === 5 && a.dir === 1) a.dir = -1;
      fn.constants[sym] = nv;
      changed = true;
    }
    return changed;
  }

  /* ---------- 持久化 ---------- */

  function stateReplacer(k, v) { return (k === 'core' || k === 'error' || k === 'kind') ? undefined : v; }

  function persist() {
    try {
      var geo = (root.FPlotGeometry && state.geometry) ? root.FPlotGeometry.serialize(state.geometry) : [];
      localStorage.setItem(LS_STATE, JSON.stringify({ functions: state.functions, view: state.view, geometry: geo }, stateReplacer));
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  function reviveFn(f) {
    var fn = {
      id: f.id || uid(),
      src: f.src,
      color: f.color || PALETTE[0],
      opacity: (typeof f.opacity === 'number') ? f.opacity : 1,
      visible: f.visible !== false,
      constants: f.constants || {},
      core: null,
      error: null,
      kind: null,
    };
    recompile(fn);
    return fn;
  }

  function mergeView(v, sv) {
    for (var k in sv) {
      if (k === 'c3' && sv.c3) { for (var a in sv.c3) v.c3[a] = sv.c3[a]; }
      else if (k === 'c2' && sv.c2) { for (var b in sv.c2) v.c2[b] = sv.c2[b]; }
      else v[k] = sv[k];
    }
    return v;
  }

  function loadPersisted() {
    var data = null;
    try { data = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) { data = null; }
    if (!data && (function () {
      // v1 → v2 迁移（结构兼容）
      try { data = JSON.parse(localStorage.getItem(LS_STATE_V1) || 'null'); } catch (e2) { data = null; }
      return !!data;
    })()) { /* v1 数据已取到 */ }
    if (!data || !Array.isArray(data.functions)) return false;
    state.functions = data.functions.map(reviveFn);
    state.view = mergeView(defaultView(), data.view || {});
    state.geometry = (root.FPlotGeometry && root.FPlotGeometry.deserialize(data.geometry)) || null;
    return true;
  }

  /* ---------- 历史记录（存储层） ---------- */

  function loadHistoryList() {
    var raw = null;
    try { raw = localStorage.getItem(LS_HISTORY); } catch (e) { raw = null; }
    if (raw === null) {
      try { raw = localStorage.getItem(LS_HISTORY_V1); } catch (e2) { raw = null; }
    }
    try {
      var l = JSON.parse(raw || '[]');
      return Array.isArray(l) ? l : [];
    } catch (e) { return []; }
  }

  function writeHistoryList(l) {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(l)); } catch (e) { /* ignore */ }
  }

  /* ===================== 导出 ===================== */

  var api = {
    $: $, uid: uid, clamp: clamp, fmt: fmt, niceStep: niceStep, linspace: linspace,
    escapeHtml: escapeHtml, stamp: stamp, downloadDataURL: downloadDataURL,
    PALETTE: PALETTE,
    defaultView: defaultView,
    state: state, markers2d: markers2d, markers3d: markers3d,
    mkFn: mkFn, recompile: recompile,
    fnKind: fnKind, fnLabel: fnLabel, fnIsDrawable2d: fnIsDrawable2d, fnIsDrawable3d: fnIsDrawable3d,
    evalFn: evalFn, scopeFn: scopeFn,
    anim: anim, animToggle: animToggle, animIsOn: animIsOn, animStep: animStep,
    persist: persist, reviveFn: reviveFn, loadPersisted: loadPersisted,
    loadHistoryList: loadHistoryList, writeHistoryList: writeHistoryList,
    stateReplacer: stateReplacer, mergeView: mergeView,
  };

  root.FPlot = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
