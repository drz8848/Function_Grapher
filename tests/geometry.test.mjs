import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const G = require('../src/geometry.js');

const results = [];
function t(name, fn) {
  try { fn(); results.push(['ok', name]); }
  catch (e) { results.push(['FAIL', name + ' → ' + e.message]); }
}

t('标签: P1/L1/C1 依次生成', () => {
  const s = G.create();
  const p = G.addPoint(s, 0, 0);
  const p2 = G.addPoint(s, 1, 1);
  const l = G.addLine(s, p.id, p2.id);
  const c = G.addCircle(s, p.id, p2.id);
  assert.equal(p.label, 'P1');
  assert.equal(p2.label, 'P2');
  assert.equal(l.label, 'L1');
  assert.equal(c.label, 'C1');
});
t('线段属性: 长度/斜率/中点', () => {
  const s = G.create();
  const a = G.addPoint(s, 0, 0), b = G.addPoint(s, 3, 4);
  const l = G.addLine(s, a.id, b.id);
  const pr = G.lineProps(s, l);
  assert.equal(pr.length, 5);
  assert.equal(pr.slope, 4 / 3);
  assert.deepEqual(pr.mid, { x: 1.5, y: 2 });
});
t('线段属性: 垂直线斜率为 null', () => {
  const s = G.create();
  const a = G.addPoint(s, 1, 0), b = G.addPoint(s, 1, 5);
  const l = G.addLine(s, a.id, b.id);
  assert.equal(G.lineProps(s, l).slope, null);
});
t('圆属性: 半径/周长/面积', () => {
  const s = G.create();
  const c0 = G.addPoint(s, 0, 0), rim = G.addPoint(s, 2, 0);
  const c = G.addCircle(s, c0.id, rim.id);
  const pr = G.circleProps(s, c);
  assert.equal(pr.radius, 2);
  assert.ok(Math.abs(pr.circumference - 4 * Math.PI) < 1e-12);
  assert.ok(Math.abs(pr.area - 4 * Math.PI) < 1e-12);
});
t('命中: 点优先于线', () => {
  const s = G.create();
  const a = G.addPoint(s, 0, 0), b = G.addPoint(s, 4, 0);
  G.addLine(s, a.id, b.id);
  const hit = G.hitTest(s, 0, 0, 0.1);
  assert.equal(hit.type, 'point');
  assert.equal(hit.label, 'P1');
});
t('命中: 线段中部', () => {
  const s = G.create();
  const a = G.addPoint(s, 0, 0), b = G.addPoint(s, 4, 0);
  const l = G.addLine(s, a.id, b.id);
  const hit = G.hitTest(s, 2, 0.05, 0.1);
  assert.equal(hit.id, l.id);
});
t('命中: 圆周命中但内部不命中', () => {
  const s = G.create();
  const c0 = G.addPoint(s, 0, 0), rim = G.addPoint(s, 2, 0);
  const c = G.addCircle(s, c0.id, rim.id);
  // (0,2) 在圆周上且不与任何点重合
  assert.equal(G.hitTest(s, 0, 2, 0.05).id, c.id);
  // 圆内部非圆周处不命中
  assert.equal(G.hitTest(s, 1, 0, 0.05), null);
});
t('级联删除: 删点连带删线/圆', () => {
  const s = G.create();
  const a = G.addPoint(s, 0, 0), b = G.addPoint(s, 3, 0), rim = G.addPoint(s, 0, 2);
  const l = G.addLine(s, a.id, b.id);
  const c = G.addCircle(s, a.id, rim.id);
  const removed = G.deleteCascade(s, a.id);
  assert.ok(removed.includes(l.id) && removed.includes(c.id) && removed.includes(a.id));
  assert.equal(removed.length, 3);
  assert.equal(s.order.length, 2); // 只剩 P2 与 P3
  assert.equal(G.getObject(s, l.id), null);
});
t('级联删除: 删独立点不影响线', () => {
  const s = G.create();
  const a = G.addPoint(s, 0, 0), b = G.addPoint(s, 3, 0), solo = G.addPoint(s, 9, 9);
  G.addLine(s, a.id, b.id);
  G.deleteCascade(s, solo.id);
  assert.equal(s.order.length, 3);
});
t('序列化往返', () => {
  const s = G.create();
  const a = G.addPoint(s, 1.5, -2);
  const b = G.addPoint(s, 3, 4);
  G.addLine(s, a.id, b.id);
  const s2 = G.deserialize(G.serialize(s));
  assert.equal(s2.order.length, 3);
  const l2 = s2.byId.get(s2.order[2]);
  assert.equal(l2.type, 'line');
  assert.ok(G.lineProps(s2, l2).length > 0);
});
t('反序列化后标签计数续接', () => {
  const s = G.create();
  G.addPoint(s, 0, 0);
  G.addPoint(s, 1, 1);
  const s2 = G.deserialize(G.serialize(s));
  const p3 = G.addPoint(s2, 2, 2);
  assert.equal(p3.label, 'P3');
});

let fail = 0;
for (const [st, name] of results) {
  if (st !== 'ok') fail++;
  console.log((st === 'ok' ? '  ✓ ' : '  ✗ ') + name);
}
console.log('\n' + (results.length - fail) + '/' + results.length + ' 项通过');
process.exit(fail ? 1 : 0);
