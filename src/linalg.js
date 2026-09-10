/*
 * linalg.js — 线性代数（浏览器 / Node 通用，无 DOM 依赖）
 * 移植自 mathflow：2×2 / 3×3 矩阵、预设、行列式 / 迹 / 实特征值、类型判断。
 * 矩阵采用行主序：2×2 = {a,b,c,d} → [a b; c d]；3×3 = {a..i} → [a b c; d e f; g h i]。
 */
(function (root) {
  'use strict';

  /* ---------- 2×2 ---------- */

  var M2_IDENTITY = { a: 1, b: 0, c: 0, d: 1 };

  function m2Rotation(angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return { a: c, b: -s, c: s, d: c };
  }

  var M2_PRESETS = [
    { id: 'identity', label: '恒等', matrix: M2_IDENTITY },
    { id: 'rotate', label: '旋转 30°', matrix: m2Rotation(Math.PI / 6) },
    { id: 'shear', label: '剪切 X', matrix: { a: 1, b: 0.85, c: 0, d: 1 } },
    { id: 'scale', label: '缩放', matrix: { a: 1.45, b: 0, c: 0, d: 0.72 } },
    { id: 'reflect', label: '反射 Y', matrix: { a: -1, b: 0, c: 0, d: 1 } },
    { id: 'project', label: '投影', matrix: { a: 1, b: 0.35, c: 0.35, d: 0.12 } },
  ];

  function m2Apply(m, x, y) {
    return { x: m.a * x + m.b * y, y: m.c * x + m.d * y };
  }

  function m2Det(m) { return m.a * m.d - m.b * m.c; }
  function m2Trace(m) { return m.a + m.d; }

  /* 实特征值；判别式 < 0 时返回 null（一对共轭复根） */
  function m2Eigenvalues(m) {
    var tr = m2Trace(m), det = m2Det(m);
    var disc = tr * tr - 4 * det;
    if (disc < 0) return null;
    var r = Math.sqrt(disc);
    return [(tr + r) / 2, (tr - r) / 2];
  }

  function m2IsOrthogonal(m) {
    // 列向量单位正交：a²+c²=1, b²+d²=1, ab+cd=0
    return Math.abs(m.a * m.a + m.c * m.c - 1) < 1e-9
      && Math.abs(m.b * m.b + m.d * m.d - 1) < 1e-9
      && Math.abs(m.a * m.b + m.c * m.d) < 1e-9;
  }

  function m2TypeName(m) {
    if (m2IsIdentity(m)) return '恒等';
    var det = m2Det(m);
    // Frobenius 范数平方做参照：|det| 相对面积尺度极小 → 近似秩 1（投影）
    var fro2 = m.a * m.a + m.b * m.b + m.c * m.c + m.d * m.d;
    if (Math.abs(det) < 0.01 * fro2) return '退化（投影）';
    if (m2IsOrthogonal(m)) return det > 0 ? '旋转' : '反射';
    return '一般线性';
  }

  function m2IsIdentity(m) {
    return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1;
  }

  /* 可逆矩阵求逆；|det| 过小返回 null */
  function m2Inverse(m) {
    var det = m2Det(m);
    if (Math.abs(det) < 1e-12) return null;
    return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
  }

  /* ---------- 3×3 ---------- */

  var M3_IDENTITY = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, g: 0, h: 0, i: 1 };

  function m3RotationZ(angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return { a: c, b: -s, c: 0, d: s, e: c, f: 0, g: 0, h: 0, i: 1 };
  }
  function m3RotationX(angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return { a: 1, b: 0, c: 0, d: 0, e: c, f: -s, g: 0, h: s, i: c };
  }
  function m3RotationY(angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return { a: c, b: 0, c: s, d: 0, e: 1, f: 0, g: -s, h: 0, i: c };
  }

  var M3_PRESETS = [
    { id: 'identity', label: '恒等', matrix: M3_IDENTITY },
    { id: 'rotz', label: '绕 Z 旋 30°', matrix: m3RotationZ(Math.PI / 6) },
    { id: 'rotx', label: '绕 X 旋 30°', matrix: m3RotationX(Math.PI / 6) },
    { id: 'roty', label: '绕 Y 旋 30°', matrix: m3RotationY(Math.PI / 6) },
    { id: 'shear', label: '剪切 XY', matrix: { a: 1, b: 0.5, c: 0, d: 0, e: 1, f: 0, g: 0, h: 0, i: 1 } },
    { id: 'scale', label: '缩放', matrix: { a: 1.4, b: 0, c: 0, d: 0, e: 0.7, f: 0, g: 0, h: 0, i: 1 } },
    { id: 'reflectx', label: '反射 X', matrix: { a: -1, b: 0, c: 0, d: 0, e: 1, f: 0, g: 0, h: 0, i: 1 } },
  ];

  function m3Apply(m, x, y, z) {
    return {
      x: m.a * x + m.b * y + m.c * z,
      y: m.d * x + m.e * y + m.f * z,
      z: m.g * x + m.h * y + m.i * z,
    };
  }

  function m3Det(m) {
    return m.a * (m.e * m.i - m.f * m.h)
      - m.b * (m.d * m.i - m.f * m.g)
      + m.c * (m.d * m.h - m.e * m.g);
  }

  function m3Trace(m) { return m.a + m.e + m.i; }

  function m3IsIdentity(m) {
    return m.a === 1 && m.b === 0 && m.c === 0
      && m.d === 0 && m.e === 1 && m.f === 0
      && m.g === 0 && m.h === 0 && m.i === 1;
  }

  /* ---------- 通用 ---------- */

  function formatNum(v, digits) {
    var r = Number(Number(v).toFixed(digits == null ? 3 : digits));
    return Object.is(r, -0) ? '0' : String(r);
  }

  var api = {
    M2_IDENTITY: M2_IDENTITY, M2_PRESETS: M2_PRESETS,
    m2Rotation: m2Rotation, m2Apply: m2Apply, m2Det: m2Det, m2Trace: m2Trace,
    m2Eigenvalues: m2Eigenvalues, m2IsIdentity: m2IsIdentity, m2IsOrthogonal: m2IsOrthogonal,
    m2Inverse: m2Inverse,
    m2TypeName: m2TypeName,
    M3_IDENTITY: M3_IDENTITY, M3_PRESETS: M3_PRESETS,
    m3RotationZ: m3RotationZ, m3RotationX: m3RotationX, m3RotationY: m3RotationY,
    m3Apply: m3Apply, m3Det: m3Det, m3Trace: m3Trace, m3IsIdentity: m3IsIdentity,
    formatNum: formatNum,
  };

  root.FPlotLinalg = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
