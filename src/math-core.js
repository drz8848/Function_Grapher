/*
 * math-core.js — 表达式解析核心（浏览器 / Node 通用）
 * 依赖：调用方传入 mathjs 实例（浏览器中由 lib/math.min.js 提供全局 math）。
 * 职责：
 *   1. 解析 "名称(变量表)=表达式" 的函数定义；
 *   2. 解析二维方程（y=f(x) / x=g(y) / 隐函数 f(x,y)=0）与曲面定义（z=f(x,y) / 隐式曲面 f(x,y,z)=0）；
 *   3. 找出表达式中的自由符号（常数字母，供用户调节）；
 *   4. 生成安全求值器：只接受有限实数，复数/无穷/矩阵/错误一律返回 NaN。
 */
(function (root) {
  'use strict';

  var BUILTIN_SYMBOLS = {
    pi: 1, PI: 1, e: 1, E: 1, tau: 1, phi: 1,
    i: 1, 'true': 1, 'false': 1, 'null': 1, 'undefined': 1,
    NaN: 1, Infinity: 1,
  };

  var IDENT_SRC = '[A-Za-z_][A-Za-z0-9_]*';
  var VARLIST_SRC = IDENT_SRC + '(?:\\s*,\\s*' + IDENT_SRC + ')*';
  var CALL_RE = new RegExp('^\\s*(' + IDENT_SRC + ')\\s*\\(\\s*(' + VARLIST_SRC + ')\\s*\\)\\s*$');

  /*
   * 解析函数定义源码，如 "z(x,y)=x^2+y^2"（1–2 个变量，老接口，保持兼容）。
   * 返回 { name, vars, expr }；格式错误时抛出带说明的 Error。
   */
  function parseFunctionDef(src) {
    var def = parseDefGeneric(src);
    if (def.name === null) {
      throw new Error('格式应为：名称(变量,变量)=表达式，如 z(x,y)=x^2+y^2 或 y(t)=sin(t)');
    }
    var seen = {};
    for (var i = 0; i < def.vars.length; i++) {
      if (seen[def.vars[i]]) throw new Error('变量 ' + def.vars[i] + ' 重复声明');
      seen[def.vars[i]] = 1;
    }
    if (def.vars.length < 1 || def.vars.length > 2) {
      throw new Error('仅支持一元函数（1 个变量 → 二维曲线）或二元函数（2 个变量 → 三维曲面）');
    }
    return def;
  }

  /*
   * 通用定义解析：名称(变量表)=表达式，变量 1–3 个，不做业务限制。
   * 也接受无名称形式（返回 name=null）。
   */
  function parseDefGeneric(src) {
    if (typeof src !== 'string' || !src.trim()) throw new Error('表达式不能为空');
    var eq = src.indexOf('=');
    if (eq < 0) return { name: null, vars: [], expr: src.trim() };
    var lhs = src.slice(0, eq);
    var m = lhs.match(CALL_RE);
    if (!m) return { name: null, vars: [], expr: src.slice(eq + 1).trim() };
    var vars = m[2].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (vars.length < 1 || vars.length > 3) {
      throw new Error('变量个数须为 1–3 个（分别对应二维曲线 / 三维曲面 / 隐式曲面）');
    }
    return { name: m[1], vars: vars, expr: src.slice(eq + 1).trim() };
  }

  /*
   * 遍历 AST，找出自由符号（既非声明变量、又非内置常量的字母）。
   * 返回数组，顺序为表达式中出现的先后。
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
      kind: 'function',
      name: def.name,
      vars: def.vars,
      expr: def.expr,
      node: node,
      freeSymbols: findFreeSymbols(node, def.vars),
      evaluate: makeEvaluator(node),
    };
  }

  /* ==================== 二维方程（y=f(x) / x=g(y) / 隐函数） ==================== */

  function exprError(err) {
    throw new Error('表达式语法错误：' + (err && err.message ? err.message : String(err)));
  }

  function lhsOf(src) {
    var eq = src.indexOf('=');
    return eq < 0 ? src.trim() : src.slice(0, eq).trim();
  }

  /*
   * 把二维输入粗分类：
   *   call     — 名称(变量)=表达式（y(x)=… / x(y)=… / f(t)=…）
   *   symbol   — 左侧是单个符号（y=… / x=… / u=…）
   *   implicit — 两侧都是一般表达式（x^2+y^2=1）
   *   bare     — 没有等号
   * 具体模式判定由 compileEquation2D 结合 mathjs 完成。
   */
  function parseEquation2D(src) {
    if (typeof src !== 'string' || !src.trim()) throw new Error('表达式不能为空');
    var eq = src.indexOf('=');
    if (eq < 0) return { mode: 'bare', name: null, vars: [], expr: src.trim() };
    var lhs = src.slice(0, eq).trim();
    var rhs = src.slice(eq + 1).trim();
    if (!lhs || !rhs) throw new Error('等号两侧都不能为空');
    var call = lhs.match(CALL_RE);
    if (call) {
      var vars = call[2].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (vars.length !== 1) throw new Error('二维曲线只能声明 1 个自变量，如 y(x)=sin(x)');
      return { mode: 'call', name: call[1], vars: vars, expr: rhs };
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(lhs)) {
      return { mode: 'symbol', name: lhs, vars: [], expr: rhs };
    }
    return { mode: 'implicit', name: null, vars: [], expr: '(' + lhs + ')-(' + rhs + ')', lhs: lhs, rhs: rhs };
  }

  /*
   * 编译二维方程输入 → 与 compileFunction 同构的结果 + kind/mode 信息。
   * kind 恒为 'curve2d'；mode ∈ {y_of_x, x_of_y, implicit}。
   * 约定：mode=y_of_x 时 vars=[自变量]；implicit 时 vars=[两个自变量名]。
   */
  function compileEquation2D(math, src) {
    var p = parseEquation2D(src);

    if (p.mode === 'implicit') {
      // 两侧均为一般表达式：f = lhs - rhs = 0（允许缺一个变量）
      return implicitFromParts(math, p.lhs, p.rhs);
    }

    var node;
    try { node = math.parse(p.expr); } catch (err) { exprError(err); }
    var free = findFreeSymbols(node, []);

    if (p.mode === 'call') {
      return {
        kind: 'curve2d',
        mode: (p.name === 'x') ? 'x_of_y' : 'y_of_x',
        name: p.name, vars: p.vars, expr: p.expr,
        node: node, freeSymbols: free, evaluate: makeEvaluator(node),
      };
    }

    if (p.mode === 'bare') {
      // 裸表达式：恰 1 个自由符号 → 曲线；否则交给曲面路径处理（2→z_of_xy、3→隐式曲面）
      if (free.length === 1) {
        var v0 = free[0];
        return {
          kind: 'curve2d',
          mode: (v0 === 'y') ? 'x_of_y' : 'y_of_x',
          name: (v0 === 'y') ? 'x' : 'y', vars: [v0], expr: p.expr,
          node: node, freeSymbols: [], evaluate: makeEvaluator(node),
        };
      }
      throw new Error('裸表达式含 ' + free.length + ' 个自由符号：2 个请写成 z(x,y)=…，隐函数请写成 a=b 形式');
    }

    // p.mode === 'symbol'：左侧单个符号（y=… / x=… / u=…）
    var lhsInRhs = free.indexOf(p.name) >= 0;
    if (!lhsInRhs) {
      // 显函数：自变量按偏好挑选，其余自由符号视为常数字母
      // y=sin(t) → t；y=a*x+b → x（a、b 为常数）；x=sin(y) → y；y=2 → 常数线
      var pref = (p.name === 'x') ? ['y', 't', 'u', 's', 'v'] : ['x', 't', 'u', 's', 'v'];
      var v = null, pi;
      for (pi = 0; pi < pref.length; pi++) {
        if (free.indexOf(pref[pi]) >= 0) { v = pref[pi]; break; }
      }
      if (!v && free.length === 1) v = free[0];
      if (!v && free.length === 0) v = (p.name === 'x') ? 'y' : 'x';
      if (!v) v = free[0];
      var consts = [];
      for (pi = 0; pi < free.length; pi++) {
        if (free[pi] !== v) consts.push(free[pi]);
      }
      return {
        kind: 'curve2d',
        mode: (p.name === 'x') ? 'x_of_y' : 'y_of_x',
        name: p.name, vars: [v], expr: p.expr,
        node: node, freeSymbols: consts, evaluate: makeEvaluator(node),
      };
    }
    // 左侧符号也出现在右侧 → 隐函数（允许缺一个变量，如 y=y^2/4-1 的竖直线束）
    return implicitFromParts(math, lhsOf(src), p.expr);
  }

  /*
   * 由 lhs、rhs 构建二维隐函数：f = lhs - rhs = 0。
   * 自由符号 1–2 个均可（缺的按 x/y 优先补齐为绘图 scope 变量），>2 报错。
   */
  function implicitFromParts(math, lhs, rhs) {
    var full = '(' + lhs + ')-(' + rhs + ')';
    var n2;
    try { n2 = math.parse(full); } catch (err) { exprError(err); }
    var f2 = findFreeSymbols(n2, []);
    if (f2.length > 2) {
      throw new Error('隐函数最多 2 个自变量（如 x^2+y^2=1），当前识别到 ' + f2.length + ' 个');
    }
    if (f2.length === 0) {
      throw new Error('等式不含任何变量，无法绘制曲线');
    }
    var CANON = ['x', 'y', 'u', 'v', 'w', 's', 't'];
    function canonRank(s) {
      for (var i = 0; i < CANON.length; i++) if (CANON[i] === s) return i;
      return 100 + s.charCodeAt(0);
    }
    var vars = f2.slice();
    for (var ci = 0; ci < CANON.length && vars.length < 2; ci++) {
      if (vars.indexOf(CANON[ci]) < 0) vars.push(CANON[ci]);
    }
    vars.sort(function (a, b) { return canonRank(a) - canonRank(b); });
    return {
      kind: 'curve2d', mode: 'implicit', name: null, vars: vars, expr: full,
      node: n2, freeSymbols: [], evaluate: makeEvaluator(n2),
    };
  }

  /* ==================== 曲面（z=f(x,y) / 隐式曲面 f(x,y,z)=0） ==================== */

  /*
   * 解析曲面定义源码。
   */
  function parseSurface(src) {
    if (typeof src !== 'string' || !src.trim()) throw new Error('表达式不能为空');
    var eq = src.indexOf('=');
    if (eq < 0) return { mode: 'bare', name: null, vars: [], expr: src.trim() };
    var lhs = src.slice(0, eq).trim();
    var rhs = src.slice(eq + 1).trim();
    if (!lhs || !rhs) throw new Error('等号两侧都不能为空');
    var call = lhs.match(CALL_RE);
    if (call) {
      var vars = call[2].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var seen = {};
      for (var i = 0; i < vars.length; i++) {
        if (seen[vars[i]]) throw new Error('变量 ' + vars[i] + ' 重复声明');
        seen[vars[i]] = 1;
      }
      if (vars.length === 2) return { mode: 'call2', name: call[1], vars: vars, expr: rhs };
      if (vars.length === 3) return { mode: 'call3', name: call[1], vars: vars, expr: rhs };
      throw new Error('曲面需要 2 个变量（z(x,y)=…）或 3 个变量（f(x,y,z)=… 隐式曲面）');
    }
    return { mode: 'equation', name: null, vars: [], expr: src.trim(), lhs: lhs, rhs: rhs };
  }

  /*
   * 编译曲面定义 → { kind, mode, name, vars, expr, node, freeSymbols, evaluate }
   * kind='surface'（z=f(x,y)）或 'surface3dimplicit'（f(x,y,z)=0）。
   */
  function compileSurface(math, src) {
    var p = parseSurface(src);

    if (p.mode === 'call2' || p.mode === 'call3') {
      var node0;
      try { node0 = math.parse(p.expr); } catch (err) { exprError(err); }
      return {
        kind: p.mode === 'call2' ? 'surface' : 'surface3dimplicit',
        mode: p.mode === 'call2' ? 'z_of_xy' : 'implicit3d',
        name: p.name, vars: p.vars, expr: p.expr,
        node: node0, freeSymbols: findFreeSymbols(node0, p.vars), evaluate: makeEvaluator(node0),
      };
    }

    if (p.mode === 'equation') {
      // 先解析 RHS，看自由符号
      var nodeR;
      try { nodeR = math.parse(p.rhs); } catch (err) { exprError(err); }
      var freeR = findFreeSymbols(nodeR, []);
      var lhsSym = /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.lhs);
      if (lhsSym && freeR.length === 2 && freeR.indexOf(p.lhs) < 0) {
        // z = x^2+y^2 之类的显式曲面
        return {
          kind: 'surface', mode: 'z_of_xy', name: p.lhs, vars: freeR.slice(), expr: p.rhs,
          node: nodeR, freeSymbols: [], evaluate: makeEvaluator(nodeR),
        };
      }
      // 一般等式 → 隐式曲面 f = lhs - rhs = 0
      var full = '(' + p.lhs + ')-(' + p.rhs + ')';
      var n2;
      try { n2 = math.parse(full); } catch (err) { exprError(err); }
      var f2 = findFreeSymbols(n2, []);
      if (f2.length !== 3) {
        throw new Error('隐式曲面需要恰好 3 个变量（如 x^2+y^2+z^2=1），当前识别到 ' + f2.length + ' 个');
      }
      return {
        kind: 'surface3dimplicit', mode: 'implicit3d', name: null, vars: f2.slice(), expr: full,
        node: n2, freeSymbols: f2.slice(), evaluate: makeEvaluator(n2),
      };
    }

    // bare：按自由符号个数判断
    var node;
    try { node = math.parse(p.expr); } catch (err) { exprError(err); }
    var free = findFreeSymbols(node, []);
    if (free.length === 2) {
      return {
        kind: 'surface', mode: 'z_of_xy', name: 'z', vars: free.slice(), expr: p.expr,
        node: node, freeSymbols: [], evaluate: makeEvaluator(node),
      };
    }
    if (free.length === 3) {
      return {
        kind: 'surface3dimplicit', mode: 'implicit3d', name: null, vars: free.slice(), expr: p.expr,
        node: node, freeSymbols: free.slice(), evaluate: makeEvaluator(node),
      };
    }
    throw new Error('曲面表达式需要 2 个（z=f(x,y)）或 3 个（f(x,y,z)=0）自变量，当前识别到 ' + free.length + ' 个');
  }

  var api = {
    parseFunctionDef: parseFunctionDef,
    parseDefGeneric: parseDefGeneric,
    findFreeSymbols: findFreeSymbols,
    makeEvaluator: makeEvaluator,
    compileFunction: compileFunction,
    parseEquation2D: parseEquation2D,
    compileEquation2D: compileEquation2D,
    parseSurface: parseSurface,
    compileSurface: compileSurface,
    BUILTIN_SYMBOLS: BUILTIN_SYMBOLS,
  };

  root.FPlotCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
