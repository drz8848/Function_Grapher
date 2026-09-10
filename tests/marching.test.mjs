import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const math = require('../lib/math.min.js');
const core = require('../src/math-core.js');
const m = require('../src/marching.js');

const results = [];
function t(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' → ' + e.message]); }
}

function circleEval(x, y) { return x * x + y * y - 1; }

t('等值线: 单位圆产生线段', () => {
  const segs = m.marchingSquares(circleEval, -2, 2, -2, 2, 64);
  assert.ok(segs.length > 50, '线段数 ' + segs.length);
});
t('等值线: 线段端点均落在圆周附近', () => {
  const segs = m.marchingSquares(circleEval, -2, 2, -2, 2, 64);
  const h = 4 / 64;
  for (const s of segs) {
    const r1 = Math.hypot(s.x1, s.y1), r2 = Math.hypot(s.x2, s.y2);
    assert.ok(Math.abs(r1 - 1) < h * 1.5, 'r1=' + r1);
    assert.ok(Math.abs(r2 - 1) < h * 1.5, 'r2=' + r2);
  }
});
t('等值线: 远离零值的区域无线段', () => {
  const segs = m.marchingSquares((x, y) => x * x + y * y + 10, -2, 2, -2, 2, 32);
  assert.equal(segs.length, 0);
});
t('等值线: NaN 区域被跳过', () => {
  const segs = m.marchingSquares((x, y) => (x > 0 ? NaN : x * x + y * y - 1), -2, 2, -2, 2, 32);
  for (const s of segs) {
    assert.ok(s.x1 <= 0.001 && s.x2 <= 0.001);
  }
});
t('隐式3D: implicitZAt 找到球面下半 z=-1', () => {
  const f = (x, y, z) => x * x + y * y + z * z - 1;
  const z = m.implicitZAt(f, 0, 0, -2, 2, 80);
  assert.ok(Math.abs(z + 1) < 0.05, 'z=' + z);
});
t('隐式3D: 无交点返回 null', () => {
  const f = (x, y, z) => x * x + y * y + z * z + 5;
  assert.equal(m.implicitZAt(f, 0, 0, -2, 2, 40), null);
});
t('隐式3D: 球面网格顶点在球面附近', () => {
  const f = (x, y, z) => x * x + y * y + z * z - 1;
  const mesh = m.implicit3dMesh(f, -1.2, 1.2, -1.2, 1.2, -1.2, 1.2, 30, 60);
  assert.ok(mesh.indices.length > 100, '三角形索引数 ' + mesh.indices.length);
  const n = mesh.indices.length;
  for (let i = 0; i < n; i += 3) {
    const a = mesh.indices[i];
    const x = mesh.positions[a * 3], y = mesh.positions[a * 3 + 1], z = mesh.positions[a * 3 + 2];
    const r = Math.hypot(x, y, z);
    assert.ok(Math.abs(r - 1) < 0.15, 'r=' + r);
  }
});
t('隐式3D: 抛物面 z=x²+y² 无符号变号返回稀疏网格', () => {
  // x^2+y^2-z = 0 在 z∈[-5,5] 上有解（碗面），验证能取到
  const f = (x, y, z) => x * x + y * y - z;
  const z = m.implicitZAt(f, 1, 1, -5, 5, 60);
  assert.ok(Math.abs(z - 2) < 0.2, 'z=' + z);
});

let fail = 0;
for (const [s, name] of results) {
  if (s !== 'ok') fail++;
  console.log((s === 'ok' ? '  ✓ ' : '  ✗ ') + name);
}
console.log('\n' + (results.length - fail) + '/' + results.length + ' 项通过');
process.exit(fail ? 1 : 0);
