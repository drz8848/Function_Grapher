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
  };

  /* 几何层挂钩（M3 几何模块注入）：{ beforeFns(ctx), afterFns(ctx), hitTest(wx,wy), ... } */
  var hooks = { beforeFns: null, afterMarkers: null, drawOverlay: null };

  function init2d() {
    v2.canvas = FPlot.$('#view2d');
    v2.ctx = v2.canvas.getContext('2d');
    window.addEventListener('resize', draw2d);

    v2.canvas.addEventListener('pointerdown', function (e) {
      v2.pointerDown = true;
      v2.dragging = true;
      v2.dragStart = { x: e.clientX, y: e.clientY, x2: state.view.x2.slice(), y2: state.view.y2.slice() };
      try { v2.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (hooks.pointerDown) hooks.pointerDown(e);
    });

    v2.canvas.addEventListener('pointermove', function (e) {
      var r = v2.canvas.getBoundingClientRect();
      v2.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
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
      if (hooks.pointerMove) hooks.pointerMove(e);
      draw2d();
    });

    function endDrag(e) {
      var wasDragging = v2.dragging;
      if (v2.pointerDown) { v2.pointerDown = false; v2.dragStart = null; v2.dragging = false; FPlot.persist(); }
      if (hooks.pointerUp && wasDragging) hooks.pointerUp(e);
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

    // 网格
    var sx = niceStep(b - a, 8), sy = niceStep(d - c, 6);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var i, t;
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
    ctx.stroke();

    // 坐标轴
    var axY = y2px(clamp(0, c, d));
    var axX = x2px(clamp(0, a, b));
    ctx.lineWidth = 1.5;
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

    // 刻度短线
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = C.ax;
    ctx.beginPath();
    i = Math.ceil((a - sx * 1e-6) / sx);
    for (; i * sx <= b + sx * 1e-6; i++) {
      t = i * sx;
      ctx.moveTo(x2px(t), axY - 4);
      ctx.lineTo(x2px(t), axY + 4);
    }
    ctx.stroke();
    ctx.strokeStyle = C.ay;
    ctx.beginPath();
    i = Math.ceil((c - sy * 1e-6) / sy);
    for (; i * sy <= d + sy * 1e-6; i++) {
      t = i * sy;
      ctx.moveTo(axX - 4, y2px(t));
      ctx.lineTo(axX + 4, y2px(t));
    }
    ctx.stroke();

    // 几何层挂钩（曲线下层）
    if (hooks.beforeFns) hooks.beforeFns(ctx, x2px, y2px, px2x, py2y);

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
        drawImplicit(ctx, fn, a, b, c, d, x2px, y2px);
      } else if (fn.core.mode === 'x_of_y') {
        ctx.beginPath();
        var pen = false;
        var steps = Math.max(120, Math.round(ph));
        for (var si = 0; si <= steps; si++) {
          var tv = c + (d - c) * si / steps;
          var xv = f(tv);
          if (!isFinite(xv)) { pen = false; continue; }
          var X = x2px(xv), Y = y2px(tv);
          if (!pen) { ctx.moveTo(X, Y); pen = true; }
          else ctx.lineTo(X, Y);
        }
        ctx.stroke();
        // 悬停吸附（横向）
        if (v2.hover && !v2.pointerDown) {
          var hyd = py2y(v2.hover.y);
          var hxv = f(hyd);
          if (isFinite(hxv)) {
            var distX = Math.abs(x2px(hxv) - v2.hover.x);
            if (distX < 40 && (!best || distX < best.dist)) {
              best = { dist: distX, x: hxv, y: hyd, xPx: x2px(hxv), yPx: y2px(hyd), fn: fn, horizontal: true };
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
          var X2 = px0 + px;
          var Y2 = y2px(y);
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
              var byPx = y2px(by);
              var dist = Math.abs(byPx - hy);
              if (dist < 40 && (!best || dist < best.dist)) {
                best = { dist: dist, x: xd, y: by, xPx: hx, yPx: byPx, fn: fn, horizontal: false };
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
      var MX = x2px(mk.x), MY = y2px(mk.y);
      ctx.beginPath();
      ctx.arc(MX, MY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = mk.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    // 几何层挂钩（标注上层）
    if (hooks.afterMarkers) hooks.afterMarkers(ctx, x2px, y2px, px2x, py2y);

    ctx.restore();

    // 刻度数字（画在裁剪区外）
    ctx.fillStyle = C.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    i = Math.ceil((a - sx * 1e-6) / sx);
    for (; i * sx <= b + sx * 1e-6; i++) {
      t = i * sx;
      var lx = x2px(t);
      var ly = Math.min(axY + 6, h - 16);
      ctx.fillText(fmt(t), lx, ly);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    i = Math.ceil((c - sy * 1e-6) / sy);
    for (; i * sy <= d + sy * 1e-6; i++) {
      t = i * sy;
      var yy = y2px(t);
      ctx.fillText(fmt(t), Math.max(axX - 7, 38), yy);
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

    if (hooks.drawOverlay) hooks.drawOverlay(ctx, x2px, y2px, px2x, py2y);
    FPlot.on2dDrawn();
  }

  /* 隐函数：marching squares；交互中降采样 */
  function drawImplicit(ctx, fn, a, b, c, d, x2px, y2px) {
    var segs;
    var f = scopeFn(fn); // f(x, y)
    try {
      segs = root.FPlotMarching.marchingSquares(f, a, b, c, d, v2.dragging ? Math.max(24, Math.round(state.view.impGrid / 2)) : state.view.impGrid);
    } catch (err) {
      return;
    }
    ctx.beginPath();
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      ctx.moveTo(x2px(s.x1), y2px(s.y1));
      ctx.lineTo(x2px(s.x2), y2px(s.y2));
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

  var api = {
    init: init2d,
    draw: draw2d,
    resetView: reset2dView,
    syncRangeInputs: syncRangeInputs2d,
    y2RangeAuto: y2RangeAuto,
    hooks: hooks,
    bindTooltipFns: bindTooltipFns,
    isDragging: function () { return v2.dragging; },
  };

  root.FPlotView2d = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
