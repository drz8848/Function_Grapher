import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const math = require('../lib/math.min.js');
const core = require('../src/math-core.js');

const results = [];
function t(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' → ' + e.message]); }
}

t('方程: y(x)=sin(x) → y_of_x', () => {
  const c = core.compileEquation2D(math, 'y(x)=sin(x)');
  assert.equal(c.mode, 'y_of_x');
  assert.deepEqual(c.vars, ['x']);
});
t('方程: x(y)=y^2 → x_of_y', () => {
  const c = core.compileEquation2D(math, 'x(y)=y^2');
  assert.equal(c.mode, 'x_of_y');
  const s = { y: 3 };
  assert.equal(c.evaluate(s), 9);
});
t('方程: y=sin(t) 自变量取 t', () => {
  const c = core.compileEquation2D(math, 'y=sin(t)');
  assert.equal(c.mode, 'y_of_x');
  assert.deepEqual(c.vars, ['t']);
});
t('方程: x=sin(y) → x_of_y', () => {
  const c = core.compileEquation2D(math, 'x=sin(y)');
  assert.equal(c.mode, 'x_of_y');
  assert.deepEqual(c.vars, ['y']);
});
t('方程: 裸表达式 sin(x) → y_of_x', () => {
  const c = core.compileEquation2D(math, 'sin(x)');
  assert.equal(c.mode, 'y_of_x');
  assert.ok(Math.abs(c.evaluate({ x: Math.PI / 2 }) - 1) < 1e-12);
});
t('方程: 裸 sin(y) → x_of_y', () => {
  const c = core.compileEquation2D(math, 'sin(y)');
  assert.equal(c.mode, 'x_of_y');
});
t('方程: x^2+y^2=1 → 隐函数', () => {
  const c = core.compileEquation2D(math, 'x^2+y^2=1');
  assert.equal(c.mode, 'implicit');
  assert.deepEqual(c.vars, ['x', 'y']);
  assert.ok(Math.abs(c.evaluate({ x: 1, y: 0 })) < 1e-12);
  assert.ok(c.evaluate({ x: 2, y: 0 }) > 0);
});
t('方程: y=2y（左符号在右侧）→ 隐函数', () => {
  const c = core.compileEquation2D(math, 'y=2y');
  assert.equal(c.mode, 'implicit');
  assert.deepEqual(c.vars, ['x', 'y']);
  assert.ok(Math.abs(c.evaluate({ x: 5, y: 0 })) < 1e-12);
  assert.ok(c.evaluate({ x: 5, y: 1 }) < 0);
});
t('方程: y^2=4 → 隐函数竖直线', () => {
  const c = core.compileEquation2D(math, 'y^2=4');
  assert.equal(c.mode, 'implicit');
  assert.ok(Math.abs(c.evaluate({ x: 0, y: 2 })) < 1e-12);
  assert.ok(c.evaluate({ x: 3, y: 0 }) < 0);
  assert.ok(c.evaluate({ x: 3, y: 3 }) > 0);
});
t('方程: 三变量裸表达式应报错', () => {
  assert.throws(() => core.compileEquation2D(math, 'x+y+z=0'), /2 个自变量/);
});
t('曲面: z(x,y)=x^2+y^2 → surface', () => {
  const s = core.compileSurface(math, 'z(x,y)=x^2+y^2');
  assert.equal(s.kind, 'surface');
  assert.equal(s.mode, 'z_of_xy');
  assert.equal(s.evaluate({ x: 2, y: 3 }), 13);
});
t('曲面: z=x^2+y^2（等式形式）→ surface', () => {
  const s = core.compileSurface(math, 'z=x^2+y^2');
  assert.equal(s.kind, 'surface');
  assert.equal(s.evaluate({ x: 1, y: 1 }), 2);
});
t('曲面: f(x,y,z)=x^2+y^2+z^2-1 → 隐式曲面', () => {
  const s = core.compileSurface(math, 'f(x,y,z)=x^2+y^2+z^2-1');
  assert.equal(s.mode, 'implicit3d');
  assert.deepEqual(s.vars, ['x', 'y', 'z']);
  assert.ok(Math.abs(s.evaluate({ x: 1, y: 0, z: 0 })) < 1e-12);
});
t('曲面: x^2+y^2+z^2=1（等式形式）→ 隐式曲面', () => {
  const s = core.compileSurface(math, 'x^2+y^2+z^2=1');
  assert.equal(s.mode, 'implicit3d');
});
t('曲面: 裸表达式 x^2+y^2 → z_of_xy', () => {
  const s = core.compileSurface(math, 'x^2+y^2');
  assert.equal(s.mode, 'z_of_xy');
});
t('曲面: 两变量等式应报错（隐式曲面需 3 变量）', () => {
  assert.throws(() => core.compileSurface(math, 'x^2+y^2=1'), /3 个变量/);
});
t('兼容: 老 compileFunction 行为不变', () => {
  const c = core.compileFunction(math, 'f(x)=a*x^2+b');
  assert.deepEqual(c.freeSymbols.slice().sort(), ['a', 'b']);
  assert.equal(c.evaluate({ x: 2, a: 3, b: 1 }), 13);
});
t('兼容: parseFunctionDef 三变量应报错', () => {
  assert.throws(() => core.parseFunctionDef('f(x,y,z)=x+y+z'), /仅支持/);
});
t('常数字母: y=a*x+b 自由符号 [a,b]', () => {
  const c = core.compileEquation2D(math, 'y=a*x+b');
  assert.deepEqual(c.freeSymbols.slice().sort(), ['a', 'b']);
  assert.equal(c.evaluate({ x: 1, a: 2, b: 3 }), 5);
});

t('回归: y(x)=a*x+b 自由符号不含声明变量 x', () => {
  const c = core.compileEquation2D(math, 'y(x)=a*x+b');
  assert.deepEqual(c.freeSymbols.slice().sort(), ['a', 'b']);
});
t('回归: x(y)=a*sin(y)+b 自由符号不含 y', () => {
  const c = core.compileEquation2D(math, 'x(y)=a*sin(y)+b');
  assert.deepEqual(c.freeSymbols.slice().sort(), ['a', 'b']);
});

let fail = 0;
for (const [s, name] of results) {
  if (s !== 'ok') fail++;
  console.log((s === 'ok' ? '  ✓ ' : '  ✗ ') + name);
}
console.log('\n' + (results.length - fail) + '/' + results.length + ' 项通过');
process.exit(fail ? 1 : 0);
// 追加到运行器之前不方便——这里用独立检查文件
