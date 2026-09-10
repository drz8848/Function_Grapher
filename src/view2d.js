/*
 * view2d.js — 二维视图（Canvas 2D）
 * 支持三种曲线形态：
 *   y_of_x  — y = f(x)，逐像素采样
 *   x_of_y  — x = g(y)，横向曲线，按可见 y 窗口采样
 *   implicit— f(x,y)=0，Marching Squares 等值线（拖拽交互时自动降密度）
 * 另提供几何对象的绘制与命中接口（M3 扩展点）。
 */
(function (root) {
  'use strict';

  var FPlot = root.FPlot;
  var clamp = FPlot.clamp, fmt = FPlot.fmt, niceStep = FPlot.niceStep;
  var state = FPlot.state, markers2d = FPlot.markers2d;
  var fnIsDrawable2d = FPlot.fnIsDrawable2d, scopeFn = FPlot.scopeFn, fnLabel = FPlot.fnLabel;

  var v2 = {
    canvas: null, ctx: null, cssW: 0, cssH: 0,
    hover: null, pointerDown: false, dragStart: null,
    dragging: false, // 拖拽中（隐函数降采样标志）
    hookDragging: false, // 几何层占用了本次指针交互（点拖拽等）
    map: null,           // 最近一次绘制的坐标映射（世界⇄屏幕）
  };

  /* 几何层挂钩（M3 几何模块注入）：{ beforeFns(ctx), afterFns(ctx), hitTest(wx,wy), ... } */
  var hooks = { beforeFns: null, afterMarkers: null, drawOverlay: null };

  function init2d() {
    v2.canvas = FPlot.$('#view2d');
    v2.ctx = v2.canvas.getContext('2d');
    window.addEventListener('resize', draw2d);

    function screenToWorld(cssX, cssY) {
      if (!v2.map) return { x: 0, y: 0 };
      var wx = v2.map.px2x(cssX), wy = v2.map.py2y(cssY);
      var TT = state.view.t2;
      if (TT && TT.mode === 'linear') {
        var inv = root.FPlotLinalg.m2Inverse(TT.m);
        if (inv) {
          var q = root.FPlotLinalg.m2Apply(inv, wx, wy);
          return { x: q.x, y: q.y };
        }
      }
      if (TT && TT.mode === 'nonlinear') return null; // 无逆变换 → 几何交互暂停
      return { x: wx, y: wy };
    }

    v2.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    v2.canvas.addEventListener('pointerdown', function (e) {
      var r = v2.canvas.getBoundingClientRect();
      var world = screenToWorld(e.clientX - r.left, e.clientY - r.top);
      var isPan = (e.button === 2) || state.view.tool === 'pan';
      var consumed = false;
      if (!isPan && hooks.pointerDown) consumed = !!hooks.pointerDown(e, world);
      v2.pointerDown = true;
      v2.dragging = !consumed;
      v2.hookDragging = consumed;
      if (!consumed) {
        v2.dragStart = { x: e.clientX, y: e.clientY, x2: state.view.x2.slice(), y2: state.view.y2.slice() };
      }
      try { v2.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });

    v2.canvas.addEventListener('pointermove', function (e) {
      var r = v2.canvas.getBoundingClientRect();
      v2.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      var world = screenToWorld(v2.hover.x, v2.hover.y);
      if (hooks.pointerMove) hooks.pointerMove(e, world, v2.hookDragging);
      if (v2.pointerDown && v2.dragStart) {
        var dx = e.clientX - v2.dragStart.x;
        var dy = e.clientY - v2.dragStart.y;
        var a0 = v2.dragStart.x2[0], b0 = v2.dragStart.x2[1];
        var px2x = (b0 - a0) / Math.max(1, v2.cssW);
        state.view.x2 = [a0 - dx * px2x, b0 - dx * px2x];
        if (!state.view.y2Auto) {
          var c0 = v2.dragStart.y2[0], d0 = v2.dragStart.y2[1];
          var px2y = (d0 - c0) / Math.max(1, v2.cssH);
          state.view.y2 = [c0 + dy * px2y, d0 + dy * px2y];
        }
        syncRangeInputs2d();
      }
      draw2d();
    });

    function endDrag(e) {
      var wasHook = v2.hookDragging;
      if (v2.pointerDown && !wasHook) { v2.pointerDown = false; v2.dragStart = null; v2.dragging = false; FPlot.persist(); }
      if (v2.pointerDown && wasHook) {
        v2.pointerDown = false;
        v2.dragStart = null;
        v2.dragging = false;
        v2.hookDragging = false;
      }
      var r = v2.canvas.getBoundingClientRect();
      var world = screenToWorld(e && e.clientX !== undefined ? e.clientX - r.left : -1, e && e.clientY !== undefined ? e.clientY - r.top : -1);
      if (hooks.pointerUp && (wasHook || e && e.type === 'pointercancel')) hooks.pointerUp(e, world);
    }
    v2.canvas.addEventListener('pointerup', endDrag);
    v2.canvas.addEventListener('pointercancel', endDrag);
    v2.canvas.addEventListener('pointerleave', function () {
      v2.hover = null;
      endDrag();
      draw2d();
    });

    v2.canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = v2.canvas.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var a = state.view.x2[0], b = state.view.x2[1];
      var k = e.deltaY < 0 ? 1 / 1.15 : 1.15;
      var xm = a + (mx / Math.max(1, v2.cssW)) * (b - a);
      state.view.x2 = [xm - (xm - a) * k, xm + (b - xm) * k];
      if (!state.view.y2Auto) {
        var c = state.view.y2[0], d = state.view.y2[1];
        var ym = c + (my / Math.max(1, v2.cssH)) * (d - c);
        state.view.y2 = [ym - (ym - c) * k, ym + (d - ym) * k];
      }
      syncRangeInputs2d();
      draw2d();
      FPlot.persist();
    }, { passive: false });

    v2.canvas.addEventListener('dblclick', reset2dView);
  }

  function reset2dView() {
    state.view.x2 = [-10, 10];
    state.view.y2Auto = true;
    state.view.y2 = [-6, 6];
    syncRangeInputs2d();
    draw2d();
    FPlot.persist();
  }

  function y2RangeAuto() {
    var fns = state.functions.filter(fnIsDrawable2d);
    var a = state.view.x2[0], b = state.view.x2[1];
    var mn = Infinity, mx = -Infinity;
    function push(v) { if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    for (var i = 0; i < fns.length; i++) {
      var fn = fns[i];
      var f = scopeFn(fn);
      var mode = fn.core.mode;
      if (mode === 'x_of_y') {
        // 横向曲线：纵坐标即参数 t，取可见 x 窗口
        for (var ti = 0; ti <= 120; ti++) {
          var t = a + (b - a) * ti / 120;
          push(t);
          push(f(t));
        }
      } else if (mode === 'implicit') {
        continue; // 隐函数不参与 y 自适应
      } else {
        for (var j = 0; j <= 240; j++) {
          var x = a + (b - a) * j / 240;
          push(f(x));
        }
      }
    }
    if (!isFinite(mn) || !isFinite(mx)) return [-1, 1];
    if (mx - mn < 1e-9) { mn -= 1; mx += 1; }
    var pad = (mx - mn) * 0.08;
    return [mn - pad, mx + pad];
  }

  /* ---------- 参考系变换（M5）----------
   * linear: 2×2 矩阵作用于世界坐标；nonlinear: x'=fx(x,y,t)、y'=fy(x,y,t)。
   * 编译结果按源码缓存——逐帧只做求值，绝不逐点重新编译。 */
  var _tp2cache = { fx: null, fy: null, cfx: null, cfy: null, scope: null };

  function makeTp2d(T) {
    if (!T || T.mode === 'off') return null;
    if (T.mode === 'linear') {
      var m = T.m;
      return function (x, y) {
        return { x: m.a * x + m.b * y, y: m.c * x + m.d * y };
      };
    }
    if (_tp2cache.fx !== T.fx) {
      _tp2cache.fx = T.fx;
      _tp2cache.cfx = null;
      try { _tp2cache.cfx = root.FPlotCore.makeEvaluator(root.math.parse(T.fx)); }
      catch (e) { _tp2cache.cfx = null; }
    }
    if (_tp2cache.fy !== T.fy) {
      _tp2cache.fy = T.fy;
      _tp2cache.cfy = null;
      try { _tp2cache.cfy = root.FPlotCore.makeEvaluator(root.math.parse(T.fy)); }
      catch (e2) { _tp2cache.cfy = null; }
    }
    if (!_tp2cache.cfx || !_tp2cache.cfy) return null;
    var scope = _tp2cache.scope || (_tp2cache.scope = {});
    return function (x, y) {
      scope.x = x; scope.y = y; scope.t = T.t || 0;
      var nx = _tp2cache.cfx(scope), ny = _tp2cache.cfy(scope);
      return { x: isFinite(nx) ? nx : x, y: isFinite(ny) ? ny : y };
    };
  }

  function draw2d() {
    if (!v2.ctx) return;
    var cv = v2.canvas;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (w === 0 || h === 0) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    v2.cssW = w;
    v2.cssH = h;
    var ctx = v2.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var C = state.view.c2;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    var a = state.view.x2[0], b = state.view.x2[1];
    var c, d;
    if (state.view.y2Auto) {
      var rng = y2RangeAuto();
      c = rng[0]; d = rng[1];
      state.view.y2 = [c, d];
    } else {
      c = state.view.y2[0]; d = state.view.y2[1];
    }
    if (!(b > a) || !(d > c)) return;

    var L = 46, R = 14, T = 12, B = 26;
    var px0 = L, py0 = T, pw = Math.max(10, w - L - R), ph = Math.max(10, h - T - B);

    function x2px(x) { return px0 + (x - a) / (b - a) * pw; }
    function y2px(y) { return py0 + ph - (y - c) / (d - c) * ph; }
    function px2x(p) { return a + (p - px0) / pw * (b - a); }
    function py2y(p) { return d - (p - py0) / ph * (d - c); }
    v2.map = { a: a, b: b, c: c, d: d, px0: px0, py0: py0, pw: pw, ph: ph,
      x2px: x2px, y2px: y2px, px2x: px2x, py2y: py2y };

    var T = state.view.t2;
    var tp = makeTp2d(T);
    var follow = !!(tp && T.follow);
    function TX(wx, wy) {
      if (!tp) return { x: x2px(wx), y: y2px(wy) };
      var q = tp(wx, wy);
      return { x: x2px(q.x), y: y2px(q.y) };
    }
    var w2s = TX;

    // 轴名随第一张可绘曲线
    var fns = state.functions.filter(fnIsDrawable2d);
    var nameX = 'x', nameY = 'y';
    for (var ni = 0; ni < fns.length; ni++) {
      var f0 = fns[ni];
      if (f0.core.mode === 'x_of_y') { nameX = f0.core.name || 'x'; nameY = f0.core.vars[0]; break; }
      if (f0.core.mode === 'implicit') { nameX = f0.core.vars[0]; nameY = f0.core.vars[1]; break; }
      nameX = f0.core.vars[0]; nameY = f0.core.name || 'y';
      break;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(px0, py0, pw, ph);
    ctx.clip();

    // 网格（follow 时画变换后的弯/斜网格）
    var sx = niceStep(b - a, 8), sy = niceStep(d - c, 6);
    var i, t;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (follow) {
      var segN = (T.mode === 'nonlinear') ? 24 : 1;
      i = Math.ceil((a - sx * 1e-6) / sx);
      for (; i * sx <= b + sx * 1e-6; i++) {
        t = i * sx;
        for (var g1 = 0; g1 <= segN; g1++) {
          var yy1 = c + (d - c) * g1 / segN;
          var P1 = TX(t, yy1);
          if (g1 === 0) ctx.moveTo(P1.x, P1.y);
          else ctx.lineTo(P1.x, P1.y);
        }
      }
      i = Math.ceil((c - sy * 1e-6) / sy);
      for (; i * sy <= d + sy * 1e-6; i++) {
        t = i * sy;
        for (var g2 = 0; g2 <= segN; g2++) {
          var xx2 = a + (b - a) * g2 / segN;
          var P2 = TX(xx2, t);
          if (g2 === 0) ctx.moveTo(P2.x, P2.y);
          else ctx.lineTo(P2.x, P2.y);
        }
      }
    } else {
      i = Math.ceil((a - sx * 1e-6) / sx);
      for (; i * sx <= b + sx * 1e-6; i++) {
        t = i * sx;
        ctx.moveTo(x2px(t), py0);
        ctx.lineTo(x2px(t), py0 + ph);
      }
      i = Math.ceil((c - sy * 1e-6) / sy);
      for (; i * sy <= d + sy * 1e-6; i++) {
        t = i * sy;
        ctx.moveTo(px0, y2px(t));
        ctx.lineTo(px0 + pw, y2px(t));
      }
    }
    ctx.stroke();

    // 坐标轴（follow 时为变换后的 x 轴 / y 轴像）
    var axY = y2px(clamp(0, c, d));
    var axX = x2px(clamp(0, a, b));
    ctx.lineWidth = 1.5;
    if (follow) {
      var segA = (T.mode === 'nonlinear') ? 24 : 1;
      ctx.strokeStyle = C.ax;
      ctx.beginPath();
      for (var ax1 = 0; ax1 <= segA; ax1++) {
        var qx = a + (b - a) * ax1 / segA;
        var Q1 = TX(qx, 0);
        if (ax1 === 0) ctx.moveTo(Q1.x, Q1.y);
        else ctx.lineTo(Q1.x, Q1.y);
      }
      ctx.stroke();
      ctx.strokeStyle = C.ay;
      ctx.beginPath();
      for (var ay1 = 0; ay1 <= segA; ay1++) {
        var qy = c + (d - c) * ay1 / segA;
        var Q2 = TX(0, qy);
        if (ay1 === 0) ctx.moveTo(Q2.x, Q2.y);
        else ctx.lineTo(Q2.x, Q2.y);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = C.ax;
      ctx.beginPath();
      ctx.moveTo(px0, axY);
      ctx.lineTo(px0 + pw, axY);
      ctx.stroke();
      ctx.strokeStyle = C.ay;
      ctx.beginPath();
      ctx.moveTo(axX, py0);
      ctx.lineTo(axX, py0 + ph);
      ctx.stroke();
    }

    // 刻度短线（落在变换后轴像上的对应点）
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C.ax;
    ctx.beginPath();
    i = Math.ceil((a - sx * 1e-6) / sx);
    for (; i * sx <= b + sx * 1e-6; i++) {
      t = i * sx;
      var Q3 = (follow || tp) ? TX(t, 0) : { x: x2px(t), y: axY };
      ctx.moveTo(Q3.x - 4, Q3.y - 4);
      ctx.lineTo(Q3.x + 4, Q3.y + 4);
    }
    ctx.stroke();
    ctx.strokeStyle = C.ay;
    ctx.beginPath();
    i = Math.ceil((c - sy * 1e-6) / sy);
    for (; i * sy <= d + sy * 1e-6; i++) {
      t = i * sy;
      var Q4 = (follow || tp) ? TX(0, t) : { x: axX, y: y2px(t) };
      ctx.moveTo(Q4.x - 4, Q4.y - 4);
      ctx.lineTo(Q4.x + 4, Q4.y + 4);
    }
    ctx.stroke();

    // 几何层挂钩（曲线下层）
    if (hooks.beforeFns) hooks.beforeFns(ctx, w2s);

    // 曲线（多条叠加，三种形态）
    var best = null;
    for (var fi = 0; fi < fns.length; fi++) {
      var fn = fns[fi];
      var f = scopeFn(fn);
      ctx.globalAlpha = fn.opacity;
      ctx.lineWidth = 2;
      ctx.strokeStyle = fn.color;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (fn.core.mode === 'implicit') {
        drawImplicit(ctx, fn, a, b, c, d, w2s);
      } else if (fn.core.mode === 'x_of_y') {
        ctx.beginPath();
        var pen = false;
        var steps = Math.max(120, Math.round(ph));
        for (var si = 0; si <= steps; si++) {
          var tv = c + (d - c) * si / steps;
          var xv = f(tv);
          if (!isFinite(xv)) { pen = false; continue; }
          var W1 = TX(xv, tv);
          var X = W1.x, Y = W1.y;
          if (!pen) { ctx.moveTo(X, Y); pen = true; }
          else ctx.lineTo(X, Y);
        }
        ctx.stroke();
        // 悬停吸附（横向）
        if (v2.hover && !v2.pointerDown) {
          var hyd = py2y(v2.hover.y);
          var hxv = f(hyd);
          if (isFinite(hxv)) {
            var HP = TX(hxv, hyd);
            var distX = Math.abs(HP.x - v2.hover.x);
            if (distX < 40 && (!best || distX < best.dist)) {
              best = { dist: distX, x: hxv, y: hyd, xPx: HP.x, yPx: HP.y, fn: fn, horizontal: true };
            }
          }
        }
      } else {
        ctx.beginPath();
        var pen2 = false;
        var ySpan = d - c;
        for (var px = 0; px <= pw; px++) {
          var x = a + (px / pw) * (b - a);
          var y = f(x);
          if (!isFinite(y) || y < c - ySpan * 2 || y > d + ySpan * 2) { pen2 = false; continue; }
          var W2 = (tp && T.follow) ? TX(x, y) : { x: px0 + px, y: y2px(y) };
          var X2 = W2.x;
          var Y2 = W2.y;
          if (!pen2) { ctx.moveTo(X2, Y2); pen2 = true; }
          else ctx.lineTo(X2, Y2);
        }
        ctx.stroke();
        // 悬停吸附（纵向）
        if (v2.hover && !v2.pointerDown) {
          var hx = v2.hover.x, hy = v2.hover.y;
          if (hx >= px0 && hx <= px0 + pw) {
            var xd = px2x(hx);
            var by = f(xd);
            if (isFinite(by)) {
              var VP = (tp && T.follow) ? TX(xd, by) : { x: hx, y: y2px(by) };
              var dist = Math.abs(VP.y - hy);
              if (dist < 40 && (!best || dist < best.dist)) {
                best = { dist: dist, x: xd, y: by, xPx: VP.x, yPx: VP.y, fn: fn, horizontal: false };
              }
            }
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // 计算标注点
    for (var mi = 0; mi < markers2d.length; mi++) {
      var mk = markers2d[mi];
      var MP = TX(mk.x, mk.y);
      var MX = MP.x, MY = MP.y;
      ctx.beginPath();
      ctx.arc(MX, MY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = mk.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    // 几何层挂钩（标注上层）
    if (hooks.afterMarkers) hooks.afterMarkers(ctx, w2s);

    ctx.restore();

    // 刻度数字（画在裁剪区外）
    ctx.fillStyle = C.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    i = Math.ceil((a - sx * 1e-6) / sx);
    for (; i * sx <= b + sx * 1e-6; i++) {
      t = i * sx;
      var LX = (follow || tp) ? TX(t, 0) : { x: x2px(t), y: axY };
      var ly = Math.min(LX.y + 6, h - 16);
      ctx.fillText(fmt(t), LX.x, ly);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    i = Math.ceil((c - sy * 1e-6) / sy);
    for (; i * sy <= d + sy * 1e-6; i++) {
      t = i * sy;
      var LY = (follow || tp) ? TX(0, t) : { x: axX, y: y2px(t) };
      ctx.fillText(fmt(t), Math.max(LY.x - 7, 38), LY.y);
    }
    // 轴名
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = C.ax;
    ctx.fillText(nameX, px0 + pw - 2, Math.max(axY - 4, 14));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = C.ay;
    ctx.fillText(nameY, Math.min(axX + 6, w - 14), py0 + 2);

    // 悬停十字线与提示
    if (v2.hover && !v2.pointerDown && best) {
      ctx.strokeStyle = 'rgba(128,138,155,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (best.horizontal) {
        ctx.moveTo(px0, best.yPx);
        ctx.lineTo(px0 + pw, best.yPx);
      } else {
        ctx.moveTo(best.xPx, py0);
        ctx.lineTo(best.xPx, py0 + ph);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(best.xPx, best.yPx, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = best.fn.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      var vx, vy, vt;
      if (best.horizontal) {
        vx = best.fn.core.name; vy = best.fn.core.vars[0];
        vt = vy + ' = ' + fmt(best.y) + '   ' + vx + ' = ' + fmt(best.x);
      } else {
        vx = best.fn.core.vars[0]; vy = best.fn.core.name;
        vt = vx + ' = ' + fmt(best.x) + '   ' + vy + ' = ' + fmt(best.y);
      }
      var rect = cv.getBoundingClientRect();
      showTooltip(v2.hover.x + rect.left, v2.hover.y + rect.top, vt);
    } else if (!best) {
      hideTooltip();
    }

    if (hooks.drawOverlay) hooks.drawOverlay(ctx, w2s);
    FPlot.on2dDrawn();
  }

  /* 隐函数：marching squares；交互中降采样；线段端点经 w2s（支持变换） */
  function drawImplicit(ctx, fn, a, b, c, d, w2s) {
    var segs;
    var f = scopeFn(fn); // f(x, y)
    try {
      segs = root.FPlotMarching.marchingSquares(f, a, b, c, d, v2.dragging ? Math.max(24, Math.round(state.view.impGrid / 2)) : state.view.impGrid);
    } catch (err) {
      return;
    }
    ctx.beginPath();
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      var P1 = w2s(sg.x1, sg.y1);
      var P2 = w2s(sg.x2, sg.y2);
      ctx.moveTo(P1.x, P1.y);
      ctx.lineTo(P2.x, P2.y);
    }
    ctx.stroke();
  }

  function syncRangeInputs2d() {
    var V = state.view;
    var exa = FPlot.$('#xmin2'), exb = FPlot.$('#xmax2'), eya = FPlot.$('#ymin2'), eyb = FPlot.$('#ymax2');
    if (document.activeElement !== exa) exa.value = fmt(V.x2[0]);
    if (document.activeElement !== exb) exb.value = fmt(V.x2[1]);
    if (document.activeElement !== eya) eya.value = fmt(V.y2[0]);
    if (document.activeElement !== eyb) eyb.value = fmt(V.y2[1]);
  }

  /* 提示条由 app.js 提供（DOM 共享层） */
  var showTooltip = function () {};
  var hideTooltip = function () {};
  function bindTooltipFns(st, hd) { showTooltip = st; hideTooltip = hd; }

  function setTool(tool) {
    state.view.tool = tool; // 会话级，不持久化
    if (v2.canvas) {
      v2.canvas.style.cursor = tool === 'pan' ? 'grab'
        : (tool === 'select' ? 'default' : 'crosshair');
    }
  }

  var api = {
    init: init2d,
    draw: draw2d,
    resetView: reset2dView,
    syncRangeInputs: syncRangeInputs2d,
    y2RangeAuto: y2RangeAuto,
    hooks: hooks,
    bindTooltipFns: bindTooltipFns,
    setTool: setTool,
    getMap: function () { return v2.map; },
    getTp: function () { return makeTp2d(state.view.t2); },
    screenToWorld: screenToWorld,
    isDragging: function () { return v2.dragging; },
  };

  root.FPlotView2d = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
