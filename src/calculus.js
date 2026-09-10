/*
 * calculus.js — 数值积分（浏览器 / Node 通用，无 DOM 依赖）
 * 移植自 mathflow 的积分引擎，语义一致：
 *   - 定积分：Simpson 复合法则，默认 80 子区间；
 *   - 反常积分：无穷边界经变量代换 u∈[0,1-eps] 映射（t = a + u/(1-u)，雅可比 1/(1-u)²）；
 *   - 变上限/变下限积分：上下限可含输出变量，生成可绘制的 F(x) 求值器。
 * 依赖：mathjs 实例与 FPlotCore（用于解析上下限中的自由符号）。
 */
(function (root) {
  'use strict';

  var EPS = 0.004;   // 代换区间右端截断
  var N = 80;        // Simpson 子区间数（须为偶数）

  function normalizeInf(s) {
    var t = String(s == null ? '' : s).trim();
    if (t === 'inf' || t === '+inf' || t === 'Infinity' || t === '+Infinity') return 'Infinity';
    if (t === '-inf' || t === '-Infinity') return '-Infinity';
    return t;
  }

  /*
   * Simpson 积分：f 在 [a,b] 上取 n（偶数）等分。
   * 任一采样点非有限 → 返回 null。
   */
  function simpson(f, a, b, n) {
    n = Math.max(4, Math.round(n || N));
    if (n % 2) n += 1;
    var h = (b - a) / n;
    if (!isFinite(h)) return null;
    var y0 = f(a);
    if (!isFinite(y0)) return null;
    var yn = f(b);
    if (!isFinite(yn)) return null;
    var sum = y0 + yn;
    for (var i = 1; i < n; i++) {
      var y = f(a + i * h);
      if (!isFinite(y)) return null;
      sum += (i % 2 === 0) ? 2 * y : 4 * y;
    }
    return (h / 3) * sum;
  }

  /* ∫[a, +∞) f：代换 t = a + u/(1-u)，u∈[0, 1-eps] */
  function integralUpToInf(f, a, n) {
    function g(u) {
      var t = a + u / (1 - u);
      var w = 1 / ((1 - u) * (1 - u));
      return f(t) * w;
    }
    return simpson(g, 0, 1 - EPS, n || N);
  }

  /* ∫(-∞, b] f：代换 t = b - u/(1-u) */
  function integralDownFromInf(f, b, n) {
    function g(u) {
      var t = b - u / (1 - u);
      var w = 1 / ((1 - u) * (1 - u));
      return f(t) * w;
    }
    return simpson(g, 0, 1 - EPS, n || N);
  }

  /* ∫(-∞, +∞) f：以 0 为界拆成两段 */
  function integralBothInf(f, n) {
    var left = integralDownFromInf(f, 0, n);
    if (left === null) return null;
    var right = integralUpToInf(f, 0, n);
    if (right === null) return null;
    return left + right;
  }

  /*
   * 构建积分求值器。
   * 参数：math（mathjs 实例）、innerExpr（被积表达式，含积分变量 calcVar）、
   *       calcVar（积分变量名）、loExpr / hiExpr（下/上限表达式，可含 inf 或输出变量）。
   * 返回：
   *   {
   *     calcVar, outputVar,          // outputVar：上限表达式中的变量（变上限积分的自变量）
   *     isVariableBound,             // 上下限是否依赖 outputVar（true → 可作为 F(x) 绘制）
   *     hasInfinite, definiteValue,  // definiteValue：定积分结果（固定上下限时填充）
   *     evalAt(x, extraScope)        // → 数值或 NaN；extraScope 为常数字母表
   *   }
   */
  function buildIntegral(math, innerExpr, calcVar, loExpr, hiExpr) {
    var core = root.FPlotCore;
    var loN = normalizeInf(loExpr);
    var hiN = normalizeInf(hiExpr);

    var loNode = math.parse(loN);
    var hiNode = math.parse(hiN);
    var innerNode = math.parse(innerExpr);
    var loFn = core.makeEvaluator(loNode);
    var hiFn = core.makeEvaluator(hiNode);
    var innerFn = core.makeEvaluator(innerNode);

    // 上下限中的自由符号 → 输出变量判定
    var bound = {};
    var loFree = core.findFreeSymbols(loNode, []);
    var hiFree = core.findFreeSymbols(hiNode, []);
    var i;
    for (i = 0; i < loFree.length; i++) bound[loFree[i]] = 1;
    for (i = 0; i < hiFree.length; i++) bound[hiFree[i]] = 1;
    var boundList = Object.keys(bound);

    var outputVar = calcVar;
    if (boundList.indexOf('x') >= 0) outputVar = 'x';
    else if (boundList.indexOf('y') >= 0) outputVar = 'y';
    else if (boundList.indexOf('z') >= 0) outputVar = 'z';
    else if (boundList.length) outputVar = boundList[0];

    var isVariableBound = boundList.indexOf(outputVar) >= 0;
    var loIsPosInf = loN === 'Infinity';
    var loIsNegInf = loN === '-Infinity';
    var hiIsPosInf = hiN === 'Infinity';
    var hiIsNegInf = hiN === '-Infinity';
    var hasInfinite = loIsPosInf || loIsNegInf || hiIsPosInf || hiIsNegInf;

    function innerAt(t, scope) {
      scope[calcVar] = t;
      return innerFn(scope);
    }

    var spec = {
      calcVar: calcVar,
      outputVar: outputVar,
      isVariableBound: isVariableBound,
      hasInfinite: hasInfinite,
      definiteValue: null,
      evalAt: function (x, extraScope) {
        var scope = {};
        if (extraScope) for (var k in extraScope) scope[k] = extraScope[k];
        scope[outputVar] = x;
        try {
          if (hasInfinite) {
            return improperAt(scope);
          }
          var loVal = loFn(scope);
          var hiVal = hiFn(scope);
          if (!isFinite(loVal) || !isFinite(hiVal)) return NaN;
          var dist = hiVal - loVal;
          if (Math.abs(dist) < 1e-12) { if (!isVariableBound) spec.definiteValue = 0; return 0; }
          var val = simpson(function (t) { return innerAt(t, scope); }, loVal, hiVal, N);
          if (val === null) return NaN;
          if (!isVariableBound) spec.definiteValue = val;
          return val;
        } catch (err) {
          return NaN;
        }
      },
    };

    function improperAt(scope) {
      var result = null;
      if (loIsNegInf && hiIsPosInf) {
        result = integralBothInf(function (t) { return innerAt(t, scope); });
      } else if (hiIsPosInf) {
        var loVal = loFn(scope);
        if (!isFinite(loVal)) return NaN;
        result = integralUpToInf(function (t) { return innerAt(t, scope); }, loVal);
      } else if (loIsNegInf) {
        var hiVal = hiFn(scope);
        if (!isFinite(hiVal)) return NaN;
        result = integralDownFromInf(function (t) { return innerAt(t, scope); }, hiVal);
      } else if (loIsPosInf) {
        var hiVal2 = hiFn(scope);
        if (!isFinite(hiVal2)) return NaN;
        var raw = integralUpToInf(function (t) { return innerAt(t, scope); }, hiVal2);
        result = raw === null ? null : -raw;
      } else if (hiIsNegInf) {
        var loVal2 = loFn(scope);
        if (!isFinite(loVal2)) return NaN;
        var raw2 = integralDownFromInf(function (t) { return innerAt(t, scope); }, loVal2);
        result = raw2 === null ? null : -raw2;
      }
      if (result === null) return NaN;
      if (!isVariableBound) spec.definiteValue = result;
      return result;
    }

    return spec;
  }

  /* ---------- 特殊函数源码：calculus(...) / dcalculus(...) ---------- */

  /* 按顶层逗号拆分（忽略括号内的逗号） */
  function splitTopLevel(s) {
    var parts = [];
    var depth = 0, cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim() || parts.length) parts.push(cur);
    return parts.map(function (x) { return x.trim(); });
  }

  /*
   * 编译 "calculus(被积表达式, 积分变量, 下限, 上限)"。
   * 上下限含输出变量（变上下限积分）→ 返回可绘制曲线（kind 'curve2d'）；
   * 上下限均为常数 → 抛错并提示改用数值求值。
   */
  function compileIntegralCall(math, src) {
    var m = /^\s*calculus\s*\((.*)\)\s*$/.exec(src);
    if (!m) throw new Error('格式应为 calculus(表达式, 变量, 下限, 上限)');
    var args = splitTopLevel(m[1]);
    if (args.length !== 4) throw new Error('calculus 需要 4 个参数：calculus(表达式, 变量, 下限, 上限)');
    var innerExpr = args[0], calcVar = args[1], lo = args[2], hi = args[3];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(calcVar)) throw new Error('积分变量名不合法：' + calcVar);
    var spec = buildIntegral(math, innerExpr, calcVar, lo, hi);
    if (!spec.isVariableBound) {
      throw new Error('上下限均为常数（值 = ' + (function () {
        var v = spec.evalAt(0);
        return isFinite(v) ? String(v) : '发散/无定义';
      })() + '），请用「求积分值」；要绘制 F(x) 请让上限含变量，如 calculus(sin(t), t, 0, x)');
    }
    var outVar = spec.outputVar;
    var mode = (outVar === 'y') ? 'x_of_y' : 'y_of_x';
    var nm = (mode === 'y_of_x') ? 'y' : 'x';
    // 内层自由符号（除积分变量）作为常数滑杆
    var innerNode = math.parse(innerExpr);
    var consts = root.FPlotCore.findFreeSymbols(innerNode, [calcVar]);
    return {
      kind: 'curve2d', mode: mode, name: nm, vars: [outVar],
      expr: src.replace(/\s+/g, ' '), node: null,
      freeSymbols: consts,
      isIntegral: true,
      evaluate: function (scope) {
        return spec.evalAt(scope[outVar], scope);
      },
      spec: spec,
    };
  }

  /*
   * 编译 "dcalculus(表达式, 变量)" → 符号求导曲线（mathjs derivative）。
   */
  function compileDerivativeCall(math, src) {
    var m = /^\s*dcalculus\s*\((.*)\)\s*$/.exec(src);
    if (!m) throw new Error('格式应为 dcalculus(表达式, 变量)');
    var args = splitTopLevel(m[1]);
    if (args.length !== 2) throw new Error('dcalculus 需要 2 个参数：dcalculus(表达式, 变量)');
    var expr = args[0], v = args[1];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error('变量名不合法：' + v);
    var diffed;
    try {
      diffed = math.derivative(expr, v).toString();
    } catch (err) {
      throw new Error('无法对 ' + expr + ' 关于 ' + v + ' 求导：' + (err && err.message ? err.message : err));
    }
    var inner = root.FPlotCore.compileEquation2D(math, 'y(' + v + ')=' + diffed);
    inner.expr = src.replace(/\s+/g, ' ');
    inner.isDerivative = true;
    return inner;
  }

  var api = {
    simpson: simpson,
    integralUpToInf: integralUpToInf,
    integralDownFromInf: integralDownFromInf,
    integralBothInf: integralBothInf,
    buildIntegral: buildIntegral,
    splitTopLevel: splitTopLevel,
    compileIntegralCall: compileIntegralCall,
    compileDerivativeCall: compileDerivativeCall,
    normalizeInf: normalizeInf,
    EPS: EPS,
    N: N,
  };

  root.FPlotCalculus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
