/*
 * math-core.js — 表达式解析核心（浏览器 / Node 通用）
 * 依赖：调用方传入 mathjs 实例（浏览器中由 lib/math.min.js 提供全局 math）。
 * 职责：
 *   1. 解析 "名称(变量表)=表达式" 的函数定义；
 *   2. 找出表达式中的自由符号（常数字母，供用户调节）；
 *   3. 生成安全求值器：只接受有限实数，复数/无穷/矩阵/错误一律返回 NaN。
 */
(function (root) {
  'use strict';

  var BUILTIN_SYMBOLS = {
    pi: 1, PI: 1, e: 1, E: 1, tau: 1, phi: 1,
    i: 1, 'true': 1, 'false': 1, 'null': 1, 'undefined': 1,
    NaN: 1, Infinity: 1,
  };

  /*
   * 解析函数定义源码，如 "z(x,y)=x^2+y^2"。
   * 返回 { name, vars, expr }；格式错误时抛出带说明的 Error。
   */
  function parseFunctionDef(src) {
    if (typeof src !== 'string' || !src.trim()) throw new Error('表达式不能为空');
    var m = src.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\)\s*=\s*(.+)$/
    );
    if (!m) {
      throw new Error('格式应为：名称(变量,变量)=表达式，如 z(x,y)=x^2+y^2 或 y(t)=sin(t)');
    }
    var name = m[1];
    var vars = m[2].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var expr = m[3].trim();
    var seen = {};
    for (var i = 0; i < vars.length; i++) {
      if (seen[vars[i]]) throw new Error('变量 ' + vars[i] + ' 重复声明');
      seen[vars[i]] = 1;
    }
    if (vars.length < 1 || vars.length > 2) {
      throw new Error('仅支持一元函数（1 个变量 → 二维曲线）或二元函数（2 个变量 → 三维曲面）');
    }
    return { name: name, vars: vars, expr: expr };
  }

  /*
   * 遍历 AST，找出自由符号（既非声明变量、又非内置常量的字母）。
   */
  function findFreeSymbols(node, vars) {
    var free = {};
    var varSet = {};
    for (var i = 0; i < vars.length; i++) varSet[vars[i]] = 1;
    node.traverse(function (n, path, parent) {
      if (n.isSymbolNode) {
        if (parent && parent.isFunctionNode && path === 'fn') return; // 函数调用名
        if (varSet[n.name]) return;                                   // 已声明变量
        if (Object.prototype.hasOwnProperty.call(BUILTIN_SYMBOLS, n.name)) return; // 内置常量
        free[n.name] = 1;
      }
    });
    return Object.keys(free);
  }

  /*
   * 生成求值器：输入 scope 对象，输出有限实数或 NaN。
   */
  function makeEvaluator(node) {
    var compiled = node.compile();
    return function (scope) {
      var r;
      try {
        r = compiled.evaluate(scope);
      } catch (err) {
        return NaN; // 未定义的函数名、求值错误等
      }
      if (typeof r === 'number') return isFinite(r) ? r : NaN;
      if (r && typeof r === 'object') {
        if (r.isComplex) {
          // 纯实数的复数（虚部为 0）可视为实数
          if (r.im === 0 && typeof r.re === 'number' && isFinite(r.re)) return r.re;
          return NaN;
        }
        if (r.isMatrix || r.isUnit || r.isFraction || r.isBigNumber) return NaN;
      }
      return NaN;
    };
  }

  /*
   * 完整流水线：源码 → { name, vars, expr, node, freeSymbols, evaluate }
   * 解析失败时抛出带中文说明的错误。
   */
  function compileFunction(math, src) {
    var def = parseFunctionDef(src);
    var node;
    try {
      node = math.parse(def.expr);
    } catch (err) {
      throw new Error('表达式语法错误：' + (err && err.message ? err.message : String(err)));
    }
    return {
      name: def.name,
      vars: def.vars,
      expr: def.expr,
      node: node,
      freeSymbols: findFreeSymbols(node, def.vars),
      evaluate: makeEvaluator(node),
    };
  }

  var api = { parseFunctionDef: parseFunctionDef, findFreeSymbols: findFreeSymbols, makeEvaluator: makeEvaluator, compileFunction: compileFunction, BUILTIN_SYMBOLS: BUILTIN_SYMBOLS };

  root.FPlotCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
