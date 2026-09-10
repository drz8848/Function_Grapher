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

  var api = {
    simpson: simpson,
    integralUpToInf: integralUpToInf,
    integralDownFromInf: integralDownFromInf,
    integralBothInf: integralBothInf,
    buildIntegral: buildIntegral,
    normalizeInf: normalizeInf,
    EPS: EPS,
    N: N,
  };

  root.FPlotCalculus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
