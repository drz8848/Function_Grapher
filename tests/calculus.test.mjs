import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const math = require('../lib/math.min.js');
const core = require('../src/math-core.js');
const calc = require('../src/calculus.js');

const results = [];
function t(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' → ' + e.message]); }
}

t('Simpson: ∫₀¹x²dx = 1/3', () => {
  const v = calc.simpson((x) => x * x, 0, 1, 80);
  assert.ok(Math.abs(v - 1 / 3) < 1e-10, 'v=' + v);
});
t('Simpson: 奇数区间数自动转偶数', () => {
  const v = calc.simpson((x) => x * x, 0, 1, 81);
  assert.ok(Math.abs(v - 1 / 3) < 1e-10, 'v=' + v);
});
t('Simpson: 非有限采样返回 null', () => {
  assert.equal(calc.simpson((x) => (x === 0.5 ? NaN : x), 0, 1, 20), null);
});
t('定积分: buildIntegral ∫₀¹x²dx', () => {
  const spec = calc.buildIntegral(math, 'x^2', 'x', '0', '1');
  assert.equal(spec.isVariableBound, false);
  assert.ok(Math.abs(spec.evalAt(0) - 1 / 3) < 1e-10);
  assert.ok(Math.abs(spec.definiteValue - 1 / 3) < 1e-10);
});
t('反常积分: ∫₁^∞ 1/x²dx ≈ 1（含 eps=0.004 截断误差，尾部 ≈ 1/249）', () => {
  const spec = calc.buildIntegral(math, '1/x^2', 'x', '1', 'inf');
  assert.equal(spec.hasInfinite, true);
  const v = spec.evalAt(0);
  assert.ok(Math.abs(v - 1) < 6e-3, 'v=' + v);
});
t('反常积分: ∫₋∞^∞ e^(-x²)dx = √π', () => {
  const spec = calc.buildIntegral(math, 'exp(-x^2)', 'x', '-inf', 'inf');
  const v = spec.evalAt(0);
  assert.ok(Math.abs(v - Math.sqrt(Math.PI)) < 1e-3, 'v=' + v + ' 目标 ' + Math.sqrt(Math.PI));
});
t('反常积分: ∫₋∞⁰ eˣdx = 1', () => {
  const spec = calc.buildIntegral(math, 'exp(x)', 'x', '-inf', '0');
  const v = spec.evalAt(0);
  assert.ok(Math.abs(v - 1) < 1e-3, 'v=' + v);
});
t('变上限积分: F(x)=∫₀ˣ sin(t)dt = 1-cos(x)', () => {
  const spec = calc.buildIntegral(math, 'sin(t)', 't', '0', 'x');
  assert.equal(spec.isVariableBound, true);
  assert.equal(spec.outputVar, 'x');
  const F = (x) => spec.evalAt(x);
  assert.ok(Math.abs(F(1.234) - (1 - Math.cos(1.234))) < 1e-6, 'F(1.234)=' + F(1.234));
  assert.ok(Math.abs(F(-2) - (1 - Math.cos(-2))) < 1e-6);
});
t('变下限积分: F(x)=∫ₓ¹ t dt', () => {
  const spec = calc.buildIntegral(math, 't', 't', 'x', '1');
  assert.equal(spec.isVariableBound, true);
  const F = (x) => spec.evalAt(x);
  assert.ok(Math.abs(F(0.5) - (0.5 - 0.125)) < 1e-9, 'F(0.5)=' + F(0.5));
});
t('inf 别名: +inf / Infinity / -inf 均识别', () => {
  assert.equal(calc.normalizeInf('+inf'), 'Infinity');
  assert.equal(calc.normalizeInf('Infinity'), 'Infinity');
  assert.equal(calc.normalizeInf('-inf'), '-Infinity');
  assert.equal(calc.normalizeInf('2*pi'), '2*pi');
});
t('常数字母进入积分: ∫₀¹ a*x dx', () => {
  const spec = calc.buildIntegral(math, 'a*x', 'x', '0', '1');
  const v = spec.evalAt(0, { a: 3 });
  assert.ok(Math.abs(v - 1.5) < 1e-10, 'v=' + v);
});
t('交换上下限: ∫₁⁰x²dx = -1/3', () => {
  const spec = calc.buildIntegral(math, 'x^2', 'x', '1', '0');
  assert.ok(Math.abs(spec.evalAt(0) + 1 / 3) < 1e-10);
});

let fail = 0;
for (const [s, name] of results) {
  if (s !== 'ok') fail++;
  console.log((s === 'ok' ? '  ✓ ' : '  ✗ ') + name);
}
console.log('\n' + (results.length - fail) + '/' + results.length + ' 项通过');
process.exit(fail ? 1 : 0);
