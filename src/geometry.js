/*
 * geometry.js — 几何构造模型（浏览器 / Node 通用，无 DOM 依赖）
 * 移植自 mathflow：点（可拖拽）、线段（两点）、圆（圆心+圆周点），
 * 依赖关系（线/圆依赖其定义点）、级联删除、命中测试、属性计算。
 * 几何集合结构：
 *   { byId: Map, order: [id,...], seq: {P:0,L:0,C:0} }
 * 对象结构：
 *   point  { id, type:'point',  label, x, y, color }
 *   line   { id, type:'line',   label, a, b, color, deps:[a,b] }
 *   circle { id, type:'circle', label, c, r, color, deps:[c,r] }  // c=圆心点id, r=圆周点id
 */
(function (root) {
  'use strict';

  function create() {
    return { byId: new Map(), order: [], seq: { P: 0, L: 0, C: 0 } };
  }

  function nextLabel(set, prefix) {
    set.seq[prefix] = (set.seq[prefix] || 0) + 1;
    return prefix + set.seq[prefix];
  }

  function renumber(set) {
    // 反序列化后重排计数器，保证新对象标签不冲突
    var seq = { P: 0, L: 0, C: 0 };
    set.order.forEach(function (id) {
      var o = set.byId.get(id);
      if (!o) return;
      var m = /^(P|L|C)(\d+)$/.exec(o.label);
      if (m) seq[m[1]] = Math.max(seq[m[1]], parseInt(m[2], 10));
    });
    set.seq = seq;
  }

  function addObject(set, obj) {
    set.byId.set(obj.id, obj);
    set.order.push(obj.id);
    return obj;
  }

  function addPoint(set, x, y, color) {
    return addObject(set, {
      id: 'g' + Math.random().toString(36).slice(2, 10),
      type: 'point', label: nextLabel(set, 'P'),
      x: x, y: y, color: color || '#22b8cf', deps: [],
    });
  }

  function addLine(set, aId, bId, color) {
    return addObject(set, {
      id: 'g' + Math.random().toString(36).slice(2, 10),
      type: 'line', label: nextLabel(set, 'L'),
      a: aId, b: bId, color: color || '#845ef7', deps: [aId, bId],
    });
  }

  function addCircle(set, centerId, rimId, color) {
    return addObject(set, {
      id: 'g' + Math.random().toString(36).slice(2, 10),
      type: 'circle', label: nextLabel(set, 'C'),
      c: centerId, r: rimId, color: color || '#ff922b', deps: [centerId, rimId],
    });
  }

  function getObject(set, id) { return id ? set.byId.get(id) || null : null; }

  function deleteCascade(set, id) {
    if (!set.byId.has(id)) return [];
    var deleted = [id];
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < set.order.length; i++) {
        var oid = set.order[i];
        if (deleted.indexOf(oid) >= 0) continue;
        var o = set.byId.get(oid);
        if (o && o.deps && o.deps.some(function (d) { return deleted.indexOf(d) >= 0; })) {
          deleted.push(oid);
          changed = true;
        }
      }
    }
    for (var j = 0; j < deleted.length; j++) {
      set.byId.delete(deleted[j]);
      var k = set.order.indexOf(deleted[j]);
      if (k >= 0) set.order.splice(k, 1);
    }
    return deleted;
  }

  /* 点坐标读取（线/圆跟随依赖点 → 渲染时实时取坐标即可） */
  function pointPos(set, id) {
    var p = getObject(set, id);
    return p && p.type === 'point' ? { x: p.x, y: p.y } : null;
  }

  /* 线段属性：长度、斜率（垂直线斜率为 null）、中点 */
  function lineProps(set, line) {
    var p1 = pointPos(set, line.a), p2 = pointPos(set, line.b);
    if (!p1 || !p2) return null;
    var dx = p2.x - p1.x, dy = p2.y - p1.y;
    var len = Math.hypot(dx, dy);
    return {
      length: len,
      slope: Math.abs(dx) < 1e-12 ? null : dy / dx,
      mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      p1: p1, p2: p2,
    };
  }

  /* 圆属性：半径、周长、面积 */
  function circleProps(set, circle) {
    var c = pointPos(set, circle.c), r = pointPos(set, circle.r);
    if (!c || !r) return null;
    var radius = Math.hypot(r.x - c.x, r.y - c.y);
    return { radius: radius, circumference: 2 * Math.PI * radius, area: Math.PI * radius * radius, center: c, rim: r };
  }

  /* ---------- 命中测试（世界坐标 + 容差） ---------- */

  function distToSegment(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /* 返回命中的对象；点优先，其次圆周，再次线段 */
  function hitTest(set, wx, wy, tol) {
    var out = null;
    for (var i = set.order.length - 1; i >= 0; i--) {
      var o = set.byId.get(set.order[i]);
      if (!o) continue;
      if (o.type === 'point') {
        if (Math.hypot(wx - o.x, wy - o.y) <= tol) return o;
      } else if (o.type === 'circle') {
        var cp = circleProps(set, o);
        if (cp && Math.abs(Math.hypot(wx - cp.center.x, wy - cp.center.y) - cp.radius) <= tol) out = out || o;
      } else if (o.type === 'line') {
        var lp = lineProps(set, o);
        if (lp && distToSegment(wx, wy, lp.p1.x, lp.p1.y, lp.p2.x, lp.p2.y) <= tol) out = out || o;
      }
    }
    return out;
  }

  /* ---------- 序列化 ---------- */

  function serialize(set) {
    return set.order.map(function (id) {
      var o = set.byId.get(id);
      return {
        id: o.id, type: o.type, label: o.label, color: o.color,
        x: o.x, y: o.y, a: o.a, b: o.b, c: o.c, r: o.r, deps: o.deps,
      };
    });
  }

  function deserialize(list) {
    var set = create();
    if (!Array.isArray(list)) return set;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || !o.type) continue;
      set.byId.set(o.id, {
        id: o.id, type: o.type, label: o.label, color: o.color,
        x: (typeof o.x === 'number') ? o.x : 0,
        y: (typeof o.y === 'number') ? o.y : 0,
        a: o.a, b: o.b, c: o.c, r: o.r, deps: o.deps || [],
      });
      set.order.push(o.id);
    }
    renumber(set);
    return set;
  }

  var api = {
    create: create,
    addPoint: addPoint,
    addLine: addLine,
    addCircle: addCircle,
    getObject: getObject,
    deleteCascade: deleteCascade,
    pointPos: pointPos,
    lineProps: lineProps,
    circleProps: circleProps,
    hitTest: hitTest,
    serialize: serialize,
    deserialize: deserialize,
  };

  root.FPlotGeometry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
