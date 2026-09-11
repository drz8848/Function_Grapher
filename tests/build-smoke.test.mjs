/*
 * build-smoke.test.mjs — 构建产物冒烟测试
 * 把 函数作图器.html 里的内联脚本按原顺序在 VM 中执行（带浏览器桩），
 * 断言 app.js 依赖守卫所需的全部全局就绪。防止"模块加载期 ReferenceError
 * 导致整页依赖守卫报错"这类 node --check 查不出来的回归。
 */
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

function makeStubCanvas() {
  return {
    width: 300, height: 150, style: {},
    getContext: () => new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}) }),
    addEventListener: () => {}, removeEventListener: () => {},
    appendChild: () => {}, setAttribute: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150 }),
    clientWidth: 300, clientHeight: 150,
  };
}

function universalEl() {
  const target = { style: {}, children: [] };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'getContext') return () => new Proxy({}, { get: (tt, kk) => (kk === 'measureText' ? () => ({ width: 10 }) : () => {}) });
      if (k === 'querySelectorAll') return () => [];
      if (k === 'querySelector') return () => universalEl();
      if (k === 'addEventListener' || k === 'removeEventListener' || k === 'setAttribute' || k === 'appendChild' || k === 'observe') return () => {};
      if (k === 'getBoundingClientRect') return () => ({ left: 0, top: 0, width: 300, height: 150 });
      if (k === 'classList') return { add: () => {}, remove: () => {}, toggle: () => {} };
      if (k === 'clientWidth' || k === 'clientHeight') return 300;
      return (t[k] = universalEl());
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const html = fs.readFileSync(new URL('../函数作图器.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

const storage = {};
const domListeners = {};
const sandbox = {
  console, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
  navigator: { userAgent: 'node', devicePixelRatio: 1 },
  document: {
    // 'loading' → app.js 走 DOMContentLoaded 延迟初始化路径（不触达 WebGL）
    readyState: 'loading', documentElement: { style: {} },
    body: universalEl(),
    createElement: (tag) => (tag === 'canvas' ? makeStubCanvas() : universalEl()),
    createElementNS: () => makeStubCanvas(),
    getElementById: () => universalEl(),
    querySelector: () => universalEl(),
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (domListeners[type] = domListeners[type] || []).push(fn); },
  },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
  performance: { now: () => Date.now() },
  URL: { createObjectURL: () => '' },
  Blob: function () {},
  ResizeObserver: function () { this.observe = () => {}; },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const names = ['math.min.js', 'three.min.js', 'OrbitControls.js', 'math-core.js', 'marching.js',
  'calculus.js', 'linalg.js', 'templates.js', 'geometry.js', 'state.js', 'view2d.js', 'view3d.js', 'app.js'];

assert.equal(scripts.length, 13, '构建产物应内联 13 个脚本（实际 ' + scripts.length + '）');

const errors = [];
scripts.forEach((code, i) => {
  try {
    vm.runInContext(code, sandbox, { filename: names[i] || ('script#' + i), timeout: 30000 });
  } catch (e) {
    errors.push((names[i] || i) + ': ' + e.message);
  }
});
assert.deepEqual(errors, [], '内联脚本应全部无错执行: ' + errors.join(' | '));

const guard = ['THREE', 'math', 'FPlotCore', 'FPlotMarching', 'FPlotCalculus', 'FPlotLinalg',
  'FPlotTemplates', 'FPlotGeometry', 'FPlot', 'FPlotView2d', 'FPlotView3d'];
const missing = guard.filter(g => typeof sandbox[g] === 'undefined');
assert.deepEqual(missing, [], '依赖守卫所需全局缺失: ' + missing.join(', '));

assert.ok((domListeners['DOMContentLoaded'] || []).length >= 1,
  'app.js 应已注册 DOMContentLoaded（延迟初始化路径生效）');

console.log('13/13 内联脚本执行 OK，' + guard.length + ' 个全局就绪（构建冒烟通过）');
