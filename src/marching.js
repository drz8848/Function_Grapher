/*
 * marching.js — 等值线 / 隐式曲面网格算法（浏览器 / Node 通用，无 DOM 依赖）
 * 职责：
 *   1. marchingSquares：二维隐函数 f(x,y)=0 → 线段集合（等值线提取）；
 *   2. implicitZAt / implicit3dMesh：三维隐式曲面 f(x,y,z)=0 → 按列扫描 z 找符号变号，
 *      并把求得的 z(x,y) 高度场三角化成网格（顶点 + 索引）。
 * 所有 evaluate 回调约定：传入数值返回有限实数或 NaN。
 */
(function (root) {
  'use strict';

  /* 边编码：0=上边(y0) 1=右边(x1) 2=下边(y1) 3=左边(x0)
   * 角编码位：1=(x0,y0) 2=(x1,y0) 4=(x1,y1) 8=(x0,y1)
   * 查表与经典 Marching Squares 一致，歧义格（5/10）输出两段。 */
  var EDGE_TABLE = {
    1: [3, 0], 2: [0, 1], 3: [3, 1], 4: [1, 2],
    5: [3, 2, 0, 1], 6: [0, 2], 7: [3, 2], 8: [2, 3],
    9: [2, 0], 10: [0, 3, 1, 2], 11: [2, 1], 12: [1, 3],
    13: [1, 0], 14: [0, 3],
  };

  function lerp1d(a, b, va, vb) {
    if (Math.abs(vb - va) < 1e-12) return a;
    return a - va * (b - a) / (vb - va);
  }

  /*
   * 二维等值线提取。
   * evalXY(x, y) → f 值或 NaN；区域 [x0,x1]×[y0,y1]；grid 为每轴格数。
   * 返回 [{x1,y1,x2,y2}, ...]（世界坐标线段）。
   */
  function marchingSquares(evalXY, x0, x1, y0, y1, grid) {
    var segs = [];
    grid = Math.max(2, Math.round(grid || 64));
    var hx = (x1 - x0) / grid;
    var hy = (y1 - y0) / grid;
    if (!(hx > 0) || !(hy > 0)) return segs;

    // 逐行采样，缓存上一行避免重复求值
    var prevRow = null;
    var pts = [];
    for (var j = 0; j <= grid; j++) {
      var row = new Array(grid + 1);
      var y = y0 + j * hy;
      for (var i = 0; i <= grid; i++) {
        var v = evalXY(x0 + i * hx, y);
        row[i] = (typeof v === 'number' && isFinite(v)) ? v : NaN;
      }
      if (prevRow) {
        for (i = 0; i < grid; i++) {
          var v00 = prevRow[i], v10 = prevRow[i + 1];   // 上行（y = y - hy）
          var v01 = row[i], v11 = row[i + 1];           // 下行（y = y）
          if (isNaN(v00) || isNaN(v10) || isNaN(v01) || isNaN(v11)) continue;
          var ci = (v00 > 0 ? 1 : 0) | (v10 > 0 ? 2 : 0) | (v11 > 0 ? 4 : 0) | (v01 > 0 ? 8 : 0);
          if (ci === 0 || ci === 15) continue;
          var bx0 = x0 + i * hx, bx1 = bx0 + hx;
          var by0 = y - hy, by1 = y;
          // 角点对应：(x0,y0)=v00 上左, (x1,y0)=v10 上右, (x1,y1)=v11 下右, (x0,y1)=v01 下左
          var top = lerp1d(bx0, bx1, v00, v10);      // 边 0：上边交点 x
          var right = lerp1d(by0, by1, v10, v11);    // 边 1：右边交点 y
          var bottom = lerp1d(bx0, bx1, v01, v11);   // 边 2：下边交点 x
          var left = lerp1d(by0, by1, v00, v01);     // 边 3：左边交点 y
          var edges = EDGE_TABLE[ci] || [];
          for (var e = 0; e + 1 < edges.length; e += 2) {
            pts.push(edgePoint(edges[e], bx0, bx1, by0, by1, top, right, bottom, left),
              edgePoint(edges[e + 1], bx0, bx1, by0, by1, top, right, bottom, left));
          }
        }
      }
      prevRow = row;
    }
    // 两两配对成线段
    var out = [];
    for (var s = 0; s + 1 < pts.length; s += 2) {
      out.push({ x1: pts[s].x, y1: pts[s].y, x2: pts[s + 1].x, y2: pts[s + 1].y });
    }
    return out;
  }

  function edgePoint(edge, x0, x1, y0, y1, top, right, bottom, left) {
    switch (edge) {
      case 0: return { x: top, y: y0 };
      case 1: return { x: x1, y: right };
      case 2: return { x: bottom, y: y1 };
      case 3: return { x: x0, y: left };
      default: return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    }
  }

  /*
   * 在竖直线上扫描 z：找 f(x,y,z) 的第一个符号变号，线性插值返回 z。
   * evalXYZ(x, y, z) → f 值或 NaN。找不到返回 null。
   */
  function implicitZAt(evalXYZ, x, y, z0, z1, samples) {
    samples = Math.max(8, Math.round(samples || 60));
    var dz = (z1 - z0) / samples;
    if (!(dz > 0)) return null;
    var prev = null;
    for (var i = 0; i <= samples; i++) {
      var z = z0 + i * dz;
      var val = evalXYZ(x, y, z);
      if (typeof val !== 'number' || !isFinite(val)) continue;
      if (prev !== null && prev.val * val <= 0) {
        var t = Math.abs(prev.val) / (Math.abs(prev.val) + Math.abs(val) + 1e-15);
        return prev.z + t * dz;
      }
      prev = { val: val, z: z };
    }
    return null;
  }

  /*
   * 三维隐式曲面网格化：对每个 (x,y) 网格列扫描 z 得高度场，再将相邻四角
   * 均有值的格子三角化。返回 { cols, rows, positions:Float64Array, indices:[...] }。
   * positions 长度 = cols*rows*3（无效列 z 填 0，靠 indices 跳过无效格）。
   */
  function implicit3dMesh(evalXYZ, x0, x1, y0, y1, z0, z1, grid, zSamples) {
    grid = Math.max(2, Math.round(grid || 40));
    var cols = grid + 1, rows = grid + 1;
    var hx = (x1 - x0) / grid, hy = (y1 - y0) / grid;
    var positions = new Float64Array(cols * rows * 3);
    var valid = new Uint8Array(cols * rows);
    var k = 0;
    for (var j = 0; j <= grid; j++) {
      for (var i = 0; i <= grid; i++, k++) {
        var x = x0 + i * hx, y = y0 + j * hy;
        var z = implicitZAt(evalXYZ, x, y, z0, z1, zSamples);
        var zOk = (typeof z === 'number' && isFinite(z));
        positions[k * 3] = x;
        positions[k * 3 + 1] = y;
        positions[k * 3 + 2] = zOk ? z : 0;
        if (zOk) valid[k] = 1;
      }
    }
    var indices = [];
    for (j = 0; j < grid; j++) {
      for (i = 0; i < grid; i++) {
        var a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
        if (valid[a] && valid[b] && valid[c] && valid[d]) {
          indices.push(a, b, c, b, d, c);
        }
      }
    }
    return { cols: cols, rows: rows, positions: positions, indices: indices };
  }

  var api = {
    EDGE_TABLE: EDGE_TABLE,
    marchingSquares: marchingSquares,
    implicitZAt: implicitZAt,
    implicit3dMesh: implicit3dMesh,
  };

  root.FPlotMarching = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
