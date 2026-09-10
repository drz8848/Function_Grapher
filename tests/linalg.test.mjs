import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const la = require('../src/linalg.js');

const results = [];
function t(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' → ' + e.message]); }
}

t('m2 行列式 / 迹', () => {
  assert.equal(la.m2Det({ a: 2, b: 1, c: 3, d: 4 }), 5);
  assert.equal(la.m2Trace({ a: 2, b: 1, c: 3, d: 4 }), 6);
});
t('m2 实特征值', () => {
  const eig = la.m2Eigenvalues({ a: 3, b: 1, c: 0, d: 2 });
  assert.deepEqual(eig.map((v) => Math.round(v * 1e10) / 1e10).sort(), [2, 3]);
});
t('m2 复根返回 null', () => {
  assert.equal(la.m2Eigenvalues({ a: 0, b: -1, c: 1, d: 0 }), null);
});
t('m2 旋转矩阵作用于向量', () => {
  const r = la.m2Rotation(Math.PI / 2);
  const p = la.m2Apply(r, 1, 0);
  assert.ok(Math.abs(p.x) < 1e-12 && Math.abs(p.y - 1) < 1e-12);
});
t('m2 预设齐全且类型判断正确', () => {
  assert.ok(la.M2_PRESETS.length >= 6);
  assert.equal(la.m2TypeName(la.M2_IDENTITY), '恒等');
  assert.equal(la.m2TypeName(la.m2Rotation(Math.PI / 6)), '旋转');
  assert.equal(la.m2TypeName({ a: -1, b: 0, c: 0, d: 1 }), '反射');
  assert.equal(la.m2TypeName({ a: 1, b: 0.35, c: 0.35, d: 0.12 }), '退化（投影）');
});
t('m3 行列式 / 迹 / 作用', () => {
  const m = { a: 1, b: 2, c: 3, d: 0, e: 1, f: 4, g: 5, h: 6, i: 0 };
  assert.equal(la.m3Det(m), 1 * (1 * 0 - 4 * 6) - 2 * (0 * 0 - 4 * 5) + 3 * (0 * 6 - 1 * 5));
  assert.equal(la.m3Trace(m), 2);
  const p = la.m3Apply(la.M3_IDENTITY, 1, 2, 3);
  assert.deepEqual([p.x, p.y, p.z], [1, 2, 3]);
});
t('m3 绕 Z 旋转 90°：x 轴转到 y 轴', () => {
  const r = la.m3RotationZ(Math.PI / 2);
  const p = la.m3Apply(r, 1, 0, 0);
  assert.ok(Math.abs(p.x) < 1e-12 && Math.abs(p.y - 1) < 1e-12 && Math.abs(p.z) < 1e-12);
});
t('m3 预设齐全', () => {
  assert.ok(la.M3_PRESETS.length >= 6);
  for (const pr of la.M3_PRESETS) {
    assert.equal(typeof la.m3Det(pr.matrix), 'number');
  }
});
t('formatNum 处理 -0 与位数', () => {
  assert.equal(la.formatNum(-0.0001), '0');
  assert.equal(la.formatNum(1 / 3, 2), '0.33');
});

let fail = 0;
for (const [s, name] of results) {
  if (s !== 'ok') fail++;
  console.log((s === 'ok' ? '  ✓ ' : '  ✗ ') + name);
}
console.log('\n' + (results.length - fail) + '/' + results.length + ' 项通过');
process.exit(fail ? 1 : 0);
