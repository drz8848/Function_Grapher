import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const math = require('../lib/math.min.js');
require('../src/math-core.js'); // 注册全局 FPlotCore（浏览器由脚本顺序保证）
const calc = require('../src/calculus.js');

const results = [];
function t(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' → ' + e.message]); }
}

t('splitTopLevel: 忽略括号内逗号', () => {
  assert.deepEqual(calc.splitTopLevel('min(a,b), x, 0, 1'), ['min(a,b)', 'x', '0', '1']);
  assert.deepEqual(calc.splitTopLevel('sin(t) , t , 0 , x'), ['sin(t)', 't', '0', 'x']);
});

t('变上限积分: calculus(sin(t),t,0,x) → F(x)=1-cos(x)', () => {
  const c = calc.compileIntegralCall(math, 'calculus(sin(t), t, 0, x)');
  assert.equal(c.kind, 'curve2d');
  assert.equal(c.mode, 'y_of_x');
  assert.deepEqual(c.vars, ['x']);
  assert.ok(Math.abs(c.evaluate({ x: 1.234 }) - (1 - Math.cos(1.234))) < 1e-6);
});

t('变上限积分: 输出变量 y → x_of_y', () => {
  const c = calc.compileIntegralCall(math, 'calculus(sin(t), t, 0, y)');
  assert.equal(c.mode, 'x_of_y');
  assert.deepEqual(c.vars, ['y']);
});

t('变上限积分: 内层常数成为滑杆', () => {
  const c = calc.compileIntegralCall(math, 'calculus(a*t^2, t, 0, x)');
  assert.deepEqual(c.freeSymbols, ['a']);
  // ∫₀ˣ a·t² dt = a·x³/3
  assert.ok(Math.abs(c.evaluate({ x: 2, a: 3 }) - 8) < 1e-6);
});

t('反常积分特型: calculus(exp(-t^2),t,-inf,inf)', () => {
  assert.throws(() => calc.compileIntegralCall(math, 'calculus(exp(-t^2), t, -inf, inf)'), /常数/);
});

t('定积分特型应报错并给出数值', () => {
  const err = (() => {
    try { calc.compileIntegralCall(math, 'calculus(t^2, t, 0, 1)'); return null; }
    catch (e) { return e; }
  })();
  assert.ok(err && /求积分值/.test(err.message));
  assert.ok(err.message.includes('0.333'), '消息含数值: ' + err.message);
});

t('符号求导: dcalculus(a*x^3+b*x,x)', () => {
  const c = calc.compileDerivativeCall(math, 'dcalculus(a*x^3+b*x, x)');
  assert.equal(c.kind, 'curve2d');
  assert.equal(c.mode, 'y_of_x');
  // d/dx = 3a x² + b
  assert.ok(Math.abs(c.evaluate({ x: 2, a: 1, b: 0 }) - 12) < 1e-12);
  assert.deepEqual(c.freeSymbols.slice().sort(), ['a', 'b']);
});

t('符号求导: 不可导应报错', () => {
  assert.throws(() => calc.compileDerivativeCall(math, 'dcalculus(floor(x), x)'), /无法/);
});

t('参数个数错误应报错', () => {
  assert.throws(() => calc.compileIntegralCall(math, 'calculus(sin(t), t, 0)'), /4 个参数/);
  assert.throws(() => calc.compileDerivativeCall(math, 'dcalculus(x^2)'), /2 个参数/);
});

let fail = 0;
for (const [s, name] of results) {
  if (s !== 'ok') fail++;
  console.log((s === 'ok' ? '  ✓ ' : '  ✗ ') + name);
}
console.log('\n' + (results.length - fail) + '/' + results.length + ' 项通过');
process.exit(fail ? 1 : 0);
