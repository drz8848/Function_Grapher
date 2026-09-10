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

t('解析: z(x,y)=x^2+y^2', () => {
  const d = core.parseFunctionDef('z(x,y)=x^2+y^2');
  assert.equal(d.name, 'z');
  assert.deepEqual(d.vars, ['x', 'y']);
});
t('解析: 宽松空白 y ( t ) = sin(t)+t/5', () => {
  const d = core.parseFunctionDef(' y ( t ) = sin(t)+t/5 ');
  assert.equal(d.name, 'y');
  assert.deepEqual(d.vars, ['t']);
});
t('解析: 缺少签名应报错', () => {
  assert.throws(() => core.parseFunctionDef('x^2+1'), /格式应为/);
});
t('解析: 三变量应报错', () => {
  assert.throws(() => core.parseFunctionDef('f(x,y,z)=x+y+z'), /仅支持/);
});
t('解析: 变量重复应报错', () => {
  assert.throws(() => core.parseFunctionDef('f(x,x)=x+x'), /重复/);
});
t('自由符号: a*x^2+b → [a,b]', () => {
  const c = core.compileFunction(math, 'f(x)=a*x^2+b');
  assert.deepEqual(c.freeSymbols.slice().sort(), ['a', 'b']);
});
t('自由符号: 排除内置 pi/e 与函数名 sin', () => {
  const c = core.compileFunction(math, 'f(x)=pi*x+sin(x)+e^x');
  assert.deepEqual(c.freeSymbols, []);
});
t('求值: sin(x)*cos(y) 数值正确', () => {
  const c = core.compileFunction(math, 'z(x,y)=sin(x)*cos(y)');
  const v = c.evaluate({ x: 0.5, y: 1.5 });
  assert.ok(Math.abs(v - Math.sin(0.5) * Math.cos(1.5)) < 1e-12);
});
t('求值: sqrt(-1) → NaN（拒绝复数）', () => {
  const c = core.compileFunction(math, 'f(x)=sqrt(x)');
  assert.ok(Number.isNaN(c.evaluate({ x: -1 })));
});
t('求值: 1/0 → NaN（拒绝无穷）', () => {
  const c = core.compileFunction(math, 'f(x)=1/x');
  assert.ok(Number.isNaN(c.evaluate({ x: 0 })));
});
t('求值: 常数字母参与运算', () => {
  const c = core.compileFunction(math, 'f(x)=a*x+b');
  assert.equal(c.evaluate({ x: 2, a: 3, b: 1 }), 7);
});
t('求值: 变量名 e 覆盖内置常数', () => {
  const c = core.compileFunction(math, 'f(e)=e^2');
  assert.equal(c.evaluate({ e: 3 }), 9);
});
t('求值: 隐式乘法 2x', () => {
  const c = core.compileFunction(math, 'f(x)=2x+1');
  assert.equal(c.evaluate({ x: 2 }), 5);
});
t('求值: 未定义函数名 foo(x) → NaN', () => {
  const c = core.compileFunction(math, 'f(x)=foo(x)');
  assert.ok(Number.isNaN(c.evaluate({ x: 1 })));
});
t('求值: 负数平方 x^2', () => {
  const c = core.compileFunction(math, 'f(x)=x^2');
  assert.equal(c.evaluate({ x: -3 }), 9);
});

let fail = 0;
for (const [s, name] of results) {
  if (s !== 'ok') fail++;
  console.log((s === 'ok' ? '  ✓ ' : '  ✗ ') + name);
}
console.log('\n' + (results.length - fail) + '/' + results.length + ' 项通过');
process.exit(fail ? 1 : 0);
