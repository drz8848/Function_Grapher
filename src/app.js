/*
 * app.js — 应用主逻辑：三维视图、UI 编排、模板面板、参数动画、计算求值、历史、导出
 * 依赖全局：math、THREE、THREE.OrbitControls、FPlotCore、FPlotMarching、FPlot(state)、FPlotView2d、FPlotTemplates
 * 二维视图见 view2d.js；共享状态见 state.js。
 */
(function () {
  'use strict';

  var FPlot = window.FPlot;
  var V2 = window.FPlotView2d;
  var V3 = window.FPlotView3d;
  var TPL = window.FPlotTemplates;

  function syncZInputs() {
    var V = state.view;
    var a = $('#zmin3'), b = $('#zmax3');
    if (document.activeElement !== a) a.value = fmt(V.z[0]);
    if (document.activeElement !== b) b.value = fmt(V.z[1]);
  }

  /* 共享工具/状态的本地别名 */
  var $ = FPlot.$, fmt = FPlot.fmt, clamp = FPlot.clamp, linspace = FPlot.linspace,
      niceStep = FPlot.niceStep, escapeHtml = FPlot.escapeHtml, uid = FPlot.uid,
      stamp = FPlot.stamp, downloadDataURL = FPlot.downloadDataURL;
  var state = FPlot.state, markers2d = FPlot.markers2d, markers3d = FPlot.markers3d;
  var mkFn = FPlot.mkFn, recompile = FPlot.recompile, fnLabel = FPlot.fnLabel;
  var fnIsDrawable2d = FPlot.fnIsDrawable2d, fnIsDrawable3d = FPlot.fnIsDrawable3d;
  var evalFn = FPlot.evalFn, scopeFn = FPlot.scopeFn;

  /* ===================== 几何构造 ===================== */

  var G = window.FPlotGeometry;
  var geoState = { selected: null, draggingPoint: null, pending: null, lastWorld: null };

  function geoSet() { return state.geometry || (state.geometry = G.create()); }

  function geoColor() {
    return FPlot.PALETTE[geoSet().order.length % FPlot.PALETTE.length];
  }

  function afterGeoChange() {
    FPlot.persist();
    renderObjList();
    renderInspector();
    V2.draw();
  }

  function geoTol() {
    var m = V2.getMap();
    if (!m) return 0.2;
    return 8 * (m.b - m.a) / Math.max(1, m.pw);
  }

  function geoSelect(id) {
    geoState.selected = id;
    renderObjList();
    renderInspector();
    V2.draw();
  }

  var GEO_HOOKS = {
    pointerDown: function (e, world) {
      var tool = state.view.tool || 'select';
      var set = geoSet();
      if (!world) {
        // 非线性变换无逆映射 → 几何工具暂停（平移仍可用）
        if (tool !== 'select') {
          $('#addMsg').textContent = '非线性变换下暂停几何工具（可先关闭变换）';
          return true;
        }
        return false;
      }
      if (tool === 'select') {
        var hit = G.hitTest(set, world.x, world.y, geoTol());
        if (hit) {
          geoSelect(hit.id);
          if (hit.type === 'point') geoState.draggingPoint = hit.id;
          return true;
        }
        geoSelect(null);
        return false; // 空白处交给平移
      }
      if (tool === 'point') {
        var p = G.addPoint(set, world.x, world.y, geoColor());
        geoState.pending = null;
        $('#addMsg').textContent = '';
        afterGeoChange();
        geoSelect(p.id);
        return true;
      }
      if (tool === 'line' || tool === 'circle') {
        var hitP = G.hitTest(set, world.x, world.y, geoTol());
        if (!hitP || hitP.type !== 'point') {
          $('#addMsg').textContent = tool === 'line' ? '画线：请点击两个已有的点' : '画圆：请依次点击圆心与圆周点';
          return true;
        }
        if (!geoState.pending || geoState.pending.type !== tool) {
          geoState.pending = { type: tool, first: hitP.id };
          $('#addMsg').textContent = tool === 'line' ? '已选起点，再点一个点完成线段' : '已选圆心，再点一个点完成圆';
          V2.draw();
          return true;
        }
        if (geoState.pending.first === hitP.id) {
          $('#addMsg').textContent = '两个点不能相同';
          return true;
        }
        var obj;
        if (tool === 'line') obj = G.addLine(set, geoState.pending.first, hitP.id, geoColor());
        else obj = G.addCircle(set, geoState.pending.first, hitP.id, geoColor());
        geoState.pending = null;
        $('#addMsg').textContent = '';
        afterGeoChange();
        geoSelect(obj.id);
        return true;
      }
      return false;
    },
    pointerMove: function (e, world, hookDragging) {
      geoState.lastWorld = world;
      if (world && hookDragging && geoState.draggingPoint) {
        var o = G.getObject(geoSet(), geoState.draggingPoint);
        if (o && o.type === 'point') { o.x = world.x; o.y = world.y; }
      }
    },
    pointerUp: function () {
      if (geoState.draggingPoint) {
        geoState.draggingPoint = null;
        afterGeoChange();
      }
    },
  };

  function geoLabel(ctx, text, x, y, color) {
    ctx.fillStyle = color;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, x, y);
  }

  function drawGeo(ctx, w2s) {
    var set = geoSet();
    for (var i = 0; i < set.order.length; i++) {
      var o = G.getObject(set, set.order[i]);
      if (!o) continue;
      var sel = o.id === geoState.selected;
      if (o.type === 'point') {
        drawGeoPoint(ctx, o.x, o.y, o.color, w2s, sel);
        var L1 = w2s(o.x, o.y);
        geoLabel(ctx, o.label, L1.x + 7, L1.y - 7, o.color);
      } else if (o.type === 'line') {
        var lp = G.lineProps(set, o);
        if (!lp) continue;
        ctx.strokeStyle = o.color;
        ctx.lineWidth = sel ? 3 : 2;
        ctx.beginPath();
        var A = w2s(lp.p1.x, lp.p1.y), B = w2s(lp.p2.x, lp.p2.y);
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
        drawGeoPoint(ctx, lp.p1.x, lp.p1.y, o.color, w2s, false);
        drawGeoPoint(ctx, lp.p2.x, lp.p2.y, o.color, w2s, false);
        var M1 = w2s(lp.mid.x, lp.mid.y);
        geoLabel(ctx, o.label, M1.x + 7, M1.y - 7, o.color);
      } else if (o.type === 'circle') {
        var cp = G.circleProps(set, o);
        if (!cp) continue;
        ctx.strokeStyle = o.color;
        ctx.lineWidth = sel ? 3 : 2;
        // 非线性变换下圆像可能变形——采样折线；线性/无变换时直接画圆
        var tp = V2.getTp();
        if (!tp || state.view.t2.mode === 'linear') {
          var C0 = w2s(cp.center.x, cp.center.y);
          var CR = w2s(cp.center.x + cp.radius, cp.center.y);
          ctx.beginPath();
          ctx.arc(C0.x, C0.y, Math.abs(CR.x - C0.x), 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.beginPath();
          for (var ai = 0; ai <= 48; ai++) {
            var th = ai / 48 * Math.PI * 2;
            var PX = w2s(cp.center.x + cp.radius * Math.cos(th), cp.center.y + cp.radius * Math.sin(th));
            if (ai === 0) ctx.moveTo(PX.x, PX.y);
            else ctx.lineTo(PX.x, PX.y);
          }
          ctx.stroke();
        }
        drawGeoPoint(ctx, cp.center.x, cp.center.y, o.color, w2s, false);
        drawGeoPoint(ctx, cp.rim.x, cp.rim.y, o.color, w2s, false);
        var L3 = w2s(cp.center.x, cp.center.y);
        geoLabel(ctx, o.label, L3.x + 7, L3.y - 7, o.color);
      }
    }
    // 两点拾取的虚线预览
    if (geoState.pending && geoState.lastWorld) {
      var first = G.getObject(set, geoState.pending.first);
      if (first && first.type === 'point') {
        ctx.strokeStyle = 'rgba(148,163,184,0.9)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        var FP = w2s(first.x, first.y);
        var LP = w2s(geoState.lastWorld.x, geoState.lastWorld.y);
        ctx.moveTo(FP.x, FP.y);
        ctx.lineTo(LP.x, LP.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function drawGeoPoint(ctx, wx, wy, color, w2s, selected) {
    var P = w2s(wx, wy);
    ctx.beginPath();
    ctx.arc(P.x, P.y, selected ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  function renderObjList() {
    var box = $('#objList');
    if (!box) return;
    var set = geoSet();
    if (!set.order.length) {
      box.innerHTML = '<span class="mini">暂无几何对象（用顶部工具添加）</span>';
      return;
    }
    var names = { point: '点', line: '线段', circle: '圆' };
    var html = '';
    for (var i = 0; i < set.order.length; i++) {
      var o = G.getObject(set, set.order[i]);
      if (!o) continue;
      html += '<div class="obj-row' + (o.id === geoState.selected ? ' sel' : '') + '" data-id="' + o.id + '">'
        + '<i style="background:' + o.color + '"></i>'
        + '<span class="obj-label">' + escapeHtml(o.label) + '</span>'
        + '<span class="obj-type">' + names[o.type] + '</span>'
        + '<button class="icon-btn obj-del" title="删除（级联）">×</button>'
        + '</div>';
    }
    box.innerHTML = html;
    var rows = box.querySelectorAll('.obj-row');
    for (var j = 0; j < rows.length; j++) {
      (function (row) {
        row.addEventListener('click', function (ev) {
          if (ev.target.classList.contains('obj-del')) return;
          geoSelect(row.getAttribute('data-id'));
        });
      })(rows[j]);
      (function (row) {
        row.querySelector('.obj-del').addEventListener('click', function () {
          G.deleteCascade(geoSet(), row.getAttribute('data-id'));
          geoState.selected = null;
          afterGeoChange();
        });
      })(rows[j]);
    }
  }

  function renderInspector() {
    var box = $('#inspector');
    if (!box) return;
    var set = geoSet();
    var o = G.getObject(set, geoState.selected);
    if (!o) {
      box.innerHTML = '<span class="mini">未选中对象（选择工具点击图形）</span>';
      return;
    }
    var typeNames = { point: '点', line: '线段', circle: '圆' };
    var html = '<div class="insp-title">' + escapeHtml(o.label) + ' · ' + typeNames[o.type] + '</div>';
    if (o.type === 'point') {
      html += '<div class="grid2">'
        + '<label>x <input type="number" step="any" id="inspX" value="' + o.x + '"></label>'
        + '<label>y <input type="number" step="any" id="inspY" value="' + o.y + '"></label>'
        + '</div>';
    } else if (o.type === 'line') {
      var lp = G.lineProps(set, o);
      html += '<div class="insp-props">'
        + '<div>长度 <b>' + fmt(lp.length) + '</b></div>'
        + '<div>斜率 <b>' + (lp.slope === null ? '∞（垂直）' : fmt(lp.slope)) + '</b></div>'
        + '<div>中点 <b>(' + fmt(lp.mid.x) + ', ' + fmt(lp.mid.y) + ')</b></div>'
        + '</div>';
    } else {
      var cp = G.circleProps(set, o);
      html += '<div class="insp-props">'
        + '<div>半径 <b>' + fmt(cp.radius) + '</b></div>'
        + '<div>周长 <b>' + fmt(cp.circumference) + '</b></div>'
        + '<div>面积 <b>' + fmt(cp.area) + '</b></div>'
        + '</div>';
    }
    html += '<div class="btn-row"><button id="inspDel" class="btn danger small">删除' + (o.type !== 'point' ? '（含依赖）' : '') + '</button></div>';
    box.innerHTML = html;
    if (o.type === 'point') {
      $('#inspX').addEventListener('change', function (e) {
        var v = parseFloat(e.target.value);
        if (isFinite(v)) { o.x = v; afterGeoChange(); }
      });
      $('#inspY').addEventListener('change', function (e) {
        var v = parseFloat(e.target.value);
        if (isFinite(v)) { o.y = v; afterGeoChange(); }
      });
    }
    $('#inspDel').addEventListener('click', function () {
      G.deleteCascade(set, o.id);
      geoState.selected = null;
      afterGeoChange();
    });
  }

  function setGeoTool(tool) {
    V2.setTool(tool);
    geoState.pending = null; // 切换工具取消未完成的拾取
    var btns = document.querySelectorAll('#geoTools .tool');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-tool') === tool);
    }
  }

  function bindGeoTools() {
    var btns = document.querySelectorAll('#geoTools .tool');
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          setGeoTool(btn.getAttribute('data-tool'));
        });
      })(btns[i]);
    }
    window.addEventListener('keydown', function (e) {
      var tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'v' || e.key === 'V') setGeoTool('select');
      else if (e.key === 'h' || e.key === 'H') setGeoTool('pan');
      else if (e.key === 'Escape') {
        geoState.pending = null;
        geoSelect(null);
        $('#addMsg').textContent = '';
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (geoState.selected && state.view.mode === '2d') {
          G.deleteCascade(geoSet(), geoState.selected);
          geoState.selected = null;
          afterGeoChange();
          e.preventDefault();
        }
      }
    });
  }

  /* ===================== 提示 / 图例 / 空态 ===================== */

  function showTooltip(px, py, text) {
    var el = $('#tooltip');
    el.textContent = text;
    el.style.display = 'block';
    el.style.left = (px + 14) + 'px';
    el.style.top = (py + 14) + 'px';
  }

  function hideTooltip() {
    $('#tooltip').style.display = 'none';
  }

  function updateLegend() {
    var box = $('#legend');
    var is3d = state.view.mode === '3d';
    var fns = state.functions.filter(is3d ? fnIsDrawable3d : fnIsDrawable2d);
    var html = '';
    for (var i = 0; i < fns.length; i++) {
      html += '<span class="lg-item" data-id="' + fns[i].id + '" title="点击隐藏">'
        + '<i style="background:' + fns[i].color + '"></i>'
        + escapeHtml(fnLabel(fns[i]))
        + '</span>';
    }
    box.innerHTML = html;
    box.style.display = fns.length ? 'flex' : 'none';
    var items = box.querySelectorAll('.lg-item');
    for (var j = 0; j < items.length; j++) {
      (function (el) {
        el.addEventListener('click', function () {
          for (var k = 0; k < state.functions.length; k++) {
            if (state.functions[k].id === el.getAttribute('data-id')) {
              state.functions[k].visible = false;
              break;
            }
          }
          FPlot.persist();
          renderFnList();
          V3.rebuild();
          V2.draw();
        });
      })(items[j]);
    }
  }

  function updateEmptyHint() {
    var mode = state.view.mode;
    var any = state.functions.some(mode === '3d' ? fnIsDrawable3d : fnIsDrawable2d);
    var el = $('#emptyHint');
    el.style.display = any ? 'none' : 'flex';
    el.textContent = mode === '3d'
      ? '三维视图暂无函数：添加如 z(x,y)=x^2+y^2 或 x^2+y^2+z^2=1'
      : '二维视图暂无函数：添加如 y(x)=sin(x) 或 x^2+y^2=1';
  }

  /* ===================== UI：函数列表 ===================== */

  function kindBadge(fn) {
    if (fn.error) return '<span class="badge berr">错误</span>';
    switch (fn.kind) {
      case 'surface': return '<span class="badge b3d">三维曲面</span>';
      case 'surface3dimplicit': return '<span class="badge b3d">隐式曲面</span>';
      case 'curve2d':
        return fn.core.mode === 'implicit'
          ? '<span class="badge b2d">隐函数</span>'
          : '<span class="badge b2d">二维曲线</span>';
      default: return '<span class="badge boff">无法解析</span>';
    }
  }

  function renderFnList() {
    var box = $('#fnList');
    box.innerHTML = '';
    for (var i = 0; i < state.functions.length; i++) {
      box.appendChild(buildFnCard(state.functions[i]));
    }
    renderCalcSelect();
    renderCalculusSelect();
    updateLegend();
    updateEmptyHint();
  }

  function buildFnCard(fn) {
    var card = document.createElement('div');
    card.className = 'fn-card';
    card.setAttribute('data-fn', fn.id);

    var html = ''
      + '<div class="fn-row1">'
      + '<input type="checkbox" class="fn-vis" title="显示/隐藏"' + (fn.visible ? ' checked' : '') + '>'
      + '<input type="text" class="fn-src" value="' + escapeHtml(fn.src) + '" spellcheck="false">'
      + '<button class="icon-btn fn-del" title="删除">×</button>'
      + '</div>'
      + '<div class="fn-row2">'
      + kindBadge(fn)
      + '<input type="color" class="fn-color" value="' + fn.color + '" title="图像颜色（面/线）">'
      + '<span class="mini">不透明度</span>'
      + '<input type="range" class="fn-op" min="0.1" max="1" step="0.05" value="' + fn.opacity + '">'
      + (fn.kind === 'surface' ? '<button class="mini-btn fn-wire">线框</button>' : '')
      + '</div>';

    if (fn.core && fn.core.freeSymbols.length) {
      html += '<div class="fn-consts">';
      for (var i = 0; i < fn.core.freeSymbols.length; i++) {
        var s = fn.core.freeSymbols[i];
        var v = fn.constants[s];
        html += '<label class="const-item"><span>' + escapeHtml(s) + '</span>'
          + '<input type="number" step="any" class="fn-const" data-sym="' + escapeHtml(s) + '" value="' + v + '">'
          + '<input type="range" class="fn-const-range" data-sym="' + escapeHtml(s) + '" min="-5" max="5" step="0.01" value="' + v + '" title="拖动调节（-5 ~ 5）">'
          + '<button type="button" class="mini-btn fn-anim' + (FPlot.animIsOn(fn.id, s) ? ' on' : '') + '" data-sym="' + escapeHtml(s) + '" title="参数动画（-5 ~ 5 往复）">' + (FPlot.animIsOn(fn.id, s) ? '⏸' : '▶') + '</button>'
          + '</label>';
      }
      html += '</div>';
    }
    if (fn.error) html += '<div class="fn-error">' + escapeHtml(fn.error) + '</div>';
    card.innerHTML = html;

    card.querySelector('.fn-vis').addEventListener('change', function (e) {
      fn.visible = e.target.checked;
      FPlot.persist();
      V3.rebuild();
      V2.draw();
    });
    card.querySelector('.fn-src').addEventListener('change', function (e) {
      fn.src = e.target.value.trim();
      recompile(fn);
      FPlot.persist();
      renderFnList();
      if (!fn.error) {
        if (fn.kind === 'surface' || fn.kind === 'surface3dimplicit') switchMode('3d');
        else if (fn.kind === 'curve2d') switchMode('2d');
      }
      V3.rebuild();
      V2.draw();
    });
    card.querySelector('.fn-del').addEventListener('click', function () {
      state.functions = state.functions.filter(function (f) { return f.id !== fn.id; });
      var j;
      for (j = markers3d.length - 1; j >= 0; j--) if (markers3d[j].fnId === fn.id) markers3d.splice(j, 1);
      for (j = markers2d.length - 1; j >= 0; j--) if (markers2d[j].fnId === fn.id) markers2d.splice(j, 1);
      FPlot.persist();
      renderFnList();
      V3.rebuild();
      V2.draw();
    });
    card.querySelector('.fn-color').addEventListener('input', function (e) {
      fn.color = e.target.value;
      FPlot.persist();
      V3.rebuild();
      V2.draw();
    });
    card.querySelector('.fn-op').addEventListener('input', function (e) {
      fn.opacity = parseFloat(e.target.value);
      FPlot.persist();
      V3.rebuild();
      V2.draw();
    });
    var wire = card.querySelector('.fn-wire');
    if (wire) {
      wire.addEventListener('click', function () {
        state.view.wireframe = !state.view.wireframe;
        $('#wireframeChk').checked = state.view.wireframe;
        FPlot.persist();
        V3.rebuild();
      });
    }

    // 常数字母：数字框 + 滑杆 + 动画开关
    var rebuildTimer = null;
    function afterConstChange() {
      V3.rebuild();
      V2.draw();
    }
    var consts = card.querySelectorAll('.fn-const');
    for (var k = 0; k < consts.length; k++) {
      (function (inp) {
        var sym = inp.getAttribute('data-sym');
        inp.addEventListener('change', function () {
          var v = parseFloat(inp.value);
          fn.constants[sym] = isFinite(v) ? v : 1;
          var range = card.querySelector('.fn-const-range[data-sym="' + sym + '"]');
          if (range) range.value = String(clamp(fn.constants[sym], -5, 5));
          FPlot.persist();
          afterConstChange();
        });
      })(consts[k]);
    }
    var ranges = card.querySelectorAll('.fn-const-range');
    for (var r = 0; r < ranges.length; r++) {
      (function (inp) {
        var sym = inp.getAttribute('data-sym');
        inp.addEventListener('input', function () {
          var v = parseFloat(inp.value);
          if (!isFinite(v)) return;
          fn.constants[sym] = v;
          var num = card.querySelector('.fn-const[data-sym="' + sym + '"]');
          if (num && document.activeElement !== num) num.value = String(v);
          clearTimeout(rebuildTimer);
          rebuildTimer = setTimeout(afterConstChange, 60);
        });
        inp.addEventListener('change', function () { FPlot.persist(); });
      })(ranges[r]);
    }
    var animBtns = card.querySelectorAll('.fn-anim');
    for (var ai = 0; ai < animBtns.length; ai++) {
      (function (btn) {
        var sym = btn.getAttribute('data-sym');
        btn.addEventListener('click', function () {
          var on = FPlot.animToggle(fn.id, sym);
          btn.classList.toggle('on', on);
          btn.textContent = on ? '⏸' : '▶';
        });
      })(animBtns[ai]);
    }
    return card;
  }

  /* 动画推进时，仅更新受影响的滑杆/数字框（避免整表重绘） */
  function syncAnimInputs() {
    for (var key in FPlot.anim.active) {
      var parts = key.split('|');
      var card = document.querySelector('.fn-card[data-fn="' + parts[0] + '"]');
      if (!card) continue;
      var fn = null;
      for (var i = 0; i < state.functions.length; i++) {
        if (state.functions[i].id === parts[0]) { fn = state.functions[i]; break; }
      }
      if (!fn) continue;
      var v = fn.constants[parts[1]];
      var range = card.querySelector('.fn-const-range[data-sym="' + parts[1] + '"]');
      var num = card.querySelector('.fn-const[data-sym="' + parts[1] + '"]');
      if (range && document.activeElement !== range) range.value = String(v);
      if (num && document.activeElement !== num) num.value = fmt(v);
    }
  }

  /* ---------- 添加函数 / 模板 ---------- */

  function addFunctionCore(src, color) {
    var fn = mkFn(src, color);
    if (fn.error) return { error: fn.error };
    fn.color = color || fn.color;
    state.functions.push(fn);
    FPlot.persist();
    renderFnList();
    if (fn.kind === 'surface' || fn.kind === 'surface3dimplicit') switchMode('3d');
    else switchMode('2d');
    V3.rebuild();
    V2.draw();
    return { fn: fn };
  }

  function addFunction() {
    var inp = $('#addFnInput');
    var msg = $('#addMsg');
    var src = inp.value.trim();
    msg.textContent = '';
    if (!src) { msg.textContent = '请输入函数定义，如 z(x,y)=x^2+y^2 或 y(x)=sin(x)'; return; }
    var res = addFunctionCore(src);
    if (res.error) { msg.textContent = res.error; return; }
    inp.value = '';
  }

  function renderTemplates() {
    var box = $('#tplList');
    if (!box) return;
    var html = '';
    function group(title, cats) {
      html += '<div class="tpl-group"><div class="tpl-title">' + escapeHtml(title) + '</div>';
      for (var ci = 0; ci < cats.length; ci++) {
        var cat = cats[ci];
        html += '<div class="tpl-cat">' + escapeHtml(cat.category) + '</div><div class="tpl-chips">';
        for (var ti = 0; ti < cat.templates.length; ti++) {
          var tp = cat.templates[ti];
          html += '<button type="button" class="tpl-chip" data-src="' + escapeHtml(tp.src) + '" data-color="' + tp.color + '" title="' + escapeHtml(tp.src) + '">'
            + escapeHtml(tp.label) + '</button>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    group('函数模板', TPL.functionCategories());
    group('曲面与隐式曲面', TPL.surfaceCategories());
    box.innerHTML = html;
    var chips = box.querySelectorAll('.tpl-chip');
    for (var i = 0; i < chips.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var res = addFunctionCore(btn.getAttribute('data-src'), btn.getAttribute('data-color'));
          var msg = $('#addMsg');
          msg.textContent = res.error || '';
        });
      })(chips[i]);
    }
  }

  /* ===================== UI：模式 / 范围 / 颜色 ===================== */

  function switchMode(mode) {
    state.view.mode = mode;
    $('#tab3d').classList.toggle('active', mode === '3d');
    $('#tab2d').classList.toggle('active', mode === '2d');
    $('#view3d').classList.toggle('hidden', mode !== '3d');
    $('#view2d').classList.toggle('hidden', mode !== '2d');
    var gt = $('#geoTools');
    if (gt) gt.classList.toggle('hidden', mode !== '2d');
    $('#resetViewBtn').textContent = mode === '3d' ? '重置视角' : '重置范围';
    hideTooltip();
    if (mode === '3d') V3.resize();
    V2.draw();
    updateLegend();
    updateEmptyHint();
    FPlot.persist();
  }

  function rebuildAll() {
    switchMode(state.view.mode);
    V3.rebuild();
    V2.draw();
  }

  function bindPair(idA, idB, apply) {
    var ea = $(idA), eb = $(idB);
    function handler() {
      var va = parseFloat(ea.value), vb = parseFloat(eb.value);
      if (!isFinite(va) || !isFinite(vb) || !(vb > va)) { syncUIFromState(); return; }
      apply([va, vb]);
      FPlot.persist();
      V3.rebuild();
      V2.draw();
    }
    ea.addEventListener('change', handler);
    eb.addEventListener('change', handler);
  }

  function bindUI() {
    // 添加函数
    $('#addFnBtn').addEventListener('click', addFunction);
    $('#addFnInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addFunction();
    });

    // 视图模式
    $('#tab3d').addEventListener('click', function () { switchMode('3d'); });
    $('#tab2d').addEventListener('click', function () { switchMode('2d'); });
    $('#resetViewBtn').addEventListener('click', function () {
      if (state.view.mode === '3d') V3.frame();
      else V2.resetView();
    });
    $('#exportBtn').addEventListener('click', exportPNG);

    // 三维范围
    bindPair('#xmin3', '#xmax3', function (v) { state.view.x = v; });
    bindPair('#ymin3', '#ymax3', function (v) { state.view.y = v; });
    bindPair('#zmin3', '#zmax3', function (v) {
      state.view.z = v;
      state.view.zAuto = false;
      $('#zAutoChk').checked = false;
      $('#zmin3').disabled = false;
      $('#zmax3').disabled = false;
    });
    $('#zAutoChk').addEventListener('change', function (e) {
      state.view.zAuto = e.target.checked;
      $('#zmin3').disabled = e.target.checked;
      $('#zmax3').disabled = e.target.checked;
      FPlot.persist();
      V3.rebuild();
    });

    // 二维范围
    bindPair('#xmin2', '#xmax2', function (v) { state.view.x2 = v; });
    bindPair('#ymin2', '#ymax2', function (v) {
      state.view.y2 = v;
      state.view.y2Auto = false;
      $('#yAutoChk').checked = false;
      $('#ymin2').disabled = false;
      $('#ymax2').disabled = false;
    });
    $('#yAutoChk').addEventListener('change', function (e) {
      state.view.y2Auto = e.target.checked;
      $('#ymin2').disabled = e.target.checked;
      $('#ymax2').disabled = e.target.checked;
      FPlot.persist();
      V2.draw();
      V2.syncRangeInputs();
    });

    // 采样密度（防抖）
    var resTimer = null;
    $('#resRange').addEventListener('input', function (e) {
      state.view.res = parseInt(e.target.value, 10);
      $('#resVal').textContent = String(state.view.res);
      clearTimeout(resTimer);
      resTimer = setTimeout(function () { V3.rebuild(); FPlot.persist(); }, 150);
    });

    // 二维隐函数网格密度（防抖）
    var impTimer = null;
    $('#impRange').addEventListener('input', function (e) {
      state.view.impGrid = parseInt(e.target.value, 10);
      $('#impVal').textContent = String(state.view.impGrid);
      clearTimeout(impTimer);
      impTimer = setTimeout(function () { V2.draw(); }, 120);
    });
    $('#impRange').addEventListener('change', function () { FPlot.persist(); });

    // 三维开关
    $('#wireframeChk').addEventListener('change', function (e) {
      state.view.wireframe = e.target.checked;
      FPlot.persist();
      V3.rebuild();
    });
    $('#gridChk').addEventListener('change', function (e) {
      state.view.showGrid = e.target.checked;
      FPlot.persist();
      V3.rebuild();
    });
    $('#ticksChk').addEventListener('change', function (e) {
      state.view.showTicks = e.target.checked;
      FPlot.persist();
      V3.rebuild();
    });

    // 颜色
    var colorBindings = [
      ['#c3bg', 'c3', 'bg'], ['#c3ax', 'c3', 'ax'], ['#c3ay', 'c3', 'ay'],
      ['#c3az', 'c3', 'az'], ['#c3grid', 'c3', 'grid'], ['#c3text', 'c3', 'text'],
      ['#c2bg', 'c2', 'bg'], ['#c2ax', 'c2', 'ax'], ['#c2ay', 'c2', 'ay'],
      ['#c2grid', 'c2', 'grid'], ['#c2text', 'c2', 'text'],
    ];
    for (var i = 0; i < colorBindings.length; i++) {
      (function (id, grp, key) {
        $(id).addEventListener('input', function (e) {
          state.view[grp][key] = e.target.value;
          FPlot.persist();
          if (grp === 'c3') V3.rebuild();
          else V2.draw();
        });
      })(colorBindings[i][0], colorBindings[i][1], colorBindings[i][2]);
    }

    // 计算
    $('#calcBtn').addEventListener('click', doCalc);
    $('#calcMark').addEventListener('click', markCalc);
    $('#calcClear').addEventListener('click', function () {
      markers3d.length = 0;
      markers2d.length = 0;
      V3.renderMarkers();
      V2.draw();
    });
    $('#calcFn').addEventListener('change', renderCalcInputs);

    // 几何工具
    bindGeoTools();

    // 线性代数
    bindLa();

    // 微积分
    $('#derivBtn').addEventListener('click', doDerivative);
    $('#intValBtn').addEventListener('click', doIntegralValue);
    $('#intFnBtn').addEventListener('click', doIntegralFn);

    // 历史
    $('#histSaveBtn').addEventListener('click', function () {
      saveSnapshot($('#histLabel').value);
      $('#histLabel').value = '';
    });
    $('#histLabel').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        saveSnapshot($('#histLabel').value);
        $('#histLabel').value = '';
      }
    });
    $('#histClearBtn').addEventListener('click', function () {
      FPlot.writeHistoryList([]);
      renderHistory();
    });
  }

  function syncUIFromState() {
    var V = state.view;
    $('#resRange').value = String(V.res);
    $('#resVal').textContent = String(V.res);
    $('#impRange').value = String(V.impGrid);
    $('#impVal').textContent = String(V.impGrid);
    $('#wireframeChk').checked = V.wireframe;
    $('#gridChk').checked = V.showGrid;
    $('#ticksChk').checked = V.showTicks;
    $('#xmin3').value = fmt(V.x[0]);
    $('#xmax3').value = fmt(V.x[1]);
    $('#ymin3').value = fmt(V.y[0]);
    $('#ymax3').value = fmt(V.y[1]);
    $('#zAutoChk').checked = V.zAuto;
    $('#zmin3').disabled = V.zAuto;
    $('#zmax3').disabled = V.zAuto;
    $('#zmin3').value = fmt(V.z[0]);
    $('#zmax3').value = fmt(V.z[1]);
    $('#yAutoChk').checked = V.y2Auto;
    $('#ymin2').disabled = V.y2Auto;
    $('#ymax2').disabled = V.y2Auto;
    $('#xmin2').value = fmt(V.x2[0]);
    $('#xmax2').value = fmt(V.x2[1]);
    $('#ymin2').value = fmt(V.y2[0]);
    $('#ymax2').value = fmt(V.y2[1]);
    $('#c3bg').value = V.c3.bg;
    $('#c3ax').value = V.c3.ax;
    $('#c3ay').value = V.c3.ay;
    $('#c3az').value = V.c3.az;
    $('#c3grid').value = V.c3.grid;
    $('#c3text').value = V.c3.text;
    $('#c2bg').value = V.c2.bg;
    $('#c2ax').value = V.c2.ax;
    $('#c2ay').value = V.c2.ay;
    $('#c2grid').value = V.c2.grid;
    $('#c2text').value = V.c2.text;
    renderFnList();
    renderHistory();
    renderObjList();
    renderInspector();
    renderLa();
  }

  /* ===================== 快照 ===================== */

  function saveSnapshot(label) {
    var snap = JSON.parse(JSON.stringify({ functions: state.functions, view: state.view, geometry: G.serialize(geoSet()) }, FPlot.stateReplacer));
    var list = FPlot.loadHistoryList();
    list.unshift({ id: uid(), time: Date.now(), label: (label || '').trim() || '未命名快照', snap: snap });
    if (list.length > 50) list.length = 50;
    FPlot.writeHistoryList(list);
    renderHistory();
  }

  function restoreSnapshot(id) {
    var item = null;
    var list = FPlot.loadHistoryList();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { item = list[i]; break; }
    if (!item) return;
    state.functions = item.snap.functions.map(FPlot.reviveFn);
    state.view = FPlot.mergeView(FPlot.defaultView(), item.snap.view || {});
    state.geometry = G.deserialize(item.snap.geometry || []);
    markers3d.length = 0;
    markers2d.length = 0;
    syncUIFromState();
    rebuildAll();
    V3.frame();
    FPlot.persist();
  }

  /* ===================== 计算求值 ===================== */

  function currentCalcFn() {
    var id = $('#calcFn').value;
    for (var i = 0; i < state.functions.length; i++) {
      if (state.functions[i].id === id) return state.functions[i];
    }
    return null;
  }

  function renderCalcSelect() {
    var sel = $('#calcFn');
    var prev = sel.value;
    sel.innerHTML = '';
    for (var i = 0; i < state.functions.length; i++) {
      var fn = state.functions[i];
      if (!fn.core || fn.error) continue;
      var opt = document.createElement('option');
      opt.value = fn.id;
      var exprShort = fn.core.expr.length > 26 ? fn.core.expr.slice(0, 26) + '…' : fn.core.expr;
      opt.textContent = fnLabel(fn) + ' = ' + exprShort;
      sel.appendChild(opt);
    }
    var exists = false;
    for (var j = 0; j < sel.options.length; j++) if (sel.options[j].value === prev) { exists = true; break; }
    sel.value = exists ? prev : (sel.options.length ? sel.options[0].value : '');
    renderCalcInputs();
  }

  function renderCalcInputs() {
    var box = $('#calcInputs');
    box.innerHTML = '';
    var fn = currentCalcFn();
    if (!fn) {
      box.innerHTML = '<span class="mini">暂无可用函数（先添加并确保无语法错误）</span>';
      return;
    }
    for (var i = 0; i < fn.core.vars.length; i++) {
      var v = fn.core.vars[i];
      var label = document.createElement('label');
      label.innerHTML = '<span>' + escapeHtml(v) + '</span>'
        + '<input type="text" data-var="' + escapeHtml(v) + '" placeholder="如 1 或 pi/2">';
      box.appendChild(label);
    }
    $('#calcOut').textContent = '';
    $('#calcOut').className = '';
  }

  function readCalcVals(fn) {
    var vals = [];
    for (var i = 0; i < fn.core.vars.length; i++) {
      var v = fn.core.vars[i];
      var inp = $('#calcInputs input[data-var="' + v + '"]');
      var src = inp ? inp.value.trim() : '';
      if (!src) { $('#calcOut').textContent = '请输入 ' + v + ' 的值'; $('#calcOut').className = 'bad'; return null; }
      var x;
      try { x = math.evaluate(src); }
      catch (err) { $('#calcOut').textContent = '无法解析 ' + v + ' = ' + src; $('#calcOut').className = 'bad'; return null; }
      if (typeof x !== 'number' || !isFinite(x)) {
        $('#calcOut').textContent = v + ' = ' + src + ' 不是有限实数';
        $('#calcOut').className = 'bad';
        return null;
      }
      vals.push(x);
    }
    return vals;
  }

  function doCalc() {
    var fn = currentCalcFn();
    if (!fn) { $('#calcOut').textContent = '暂无可用函数'; $('#calcOut').className = 'bad'; return; }
    var vals = readCalcVals(fn);
    if (!vals) return;
    var y = evalFn(fn, vals);
    var out = $('#calcOut');
    if (isFinite(y)) {
      out.textContent = (fn.core.name || 'f') + ' = ' + fmt(y);
      out.className = 'ok';
    } else {
      out.textContent = '该点无定义（结果不是有限实数）';
      out.className = 'bad';
    }
  }

  function markCalc() {
    var fn = currentCalcFn();
    if (!fn) return;
    var vals = readCalcVals(fn);
    if (!vals) return;
    if (fn.kind === 'surface' || fn.kind === 'surface3dimplicit') {
      var z = evalFn(fn, vals);
      if (!isFinite(z)) { $('#calcOut').textContent = '该点无定义，未标注'; $('#calcOut').className = 'bad'; return; }
      var pos = fn.kind === 'surface3dimplicit' ? vals : [vals[0], vals[1], z];
      markers3d.push({ fnId: fn.id, pos: pos, color: fn.color });
      switchMode('3d');
      V3.renderMarkers();
    } else {
      var y = evalFn(fn, vals);
      if (!isFinite(y)) { $('#calcOut').textContent = '该点无定义，未标注'; $('#calcOut').className = 'bad'; return; }
      markers2d.push({ fnId: fn.id, x: vals[0], y: y, color: fn.color });
      switchMode('2d');
      V2.draw();
    }
    $('#calcOut').textContent = '已在图中标注';
    $('#calcOut').className = 'ok';
  }

  /* ===================== 微积分面板 ===================== */

  function setCalcOut(text, cls) {
    var el = $('#calculusOut');
    el.textContent = text;
    el.className = cls || '';
  }

  function currentCalc2Fn() {
    var id = $('#calculusFn').value;
    for (var i = 0; i < state.functions.length; i++) {
      if (state.functions[i].id === id) return state.functions[i];
    }
    return null;
  }

  function renderCalculusSelect() {
    var sel = $('#calculusFn');
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '';
    for (var i = 0; i < state.functions.length; i++) {
      var fn = state.functions[i];
      if (fn.kind !== 'curve2d' || !fn.core || fn.error) continue;
      var opt = document.createElement('option');
      opt.value = fn.id;
      var short = fn.core.expr.length > 30 ? fn.core.expr.slice(0, 30) + '…' : fn.core.expr;
      opt.textContent = fnLabel(fn) + ' = ' + short;
      sel.appendChild(opt);
    }
    var exists = false;
    for (var j = 0; j < sel.options.length; j++) if (sel.options[j].value === prev) { exists = true; break; }
    sel.value = exists ? prev : (sel.options.length ? sel.options[0].value : '');
  }

  function doDerivative() {
    var fn = currentCalc2Fn();
    if (!fn) { setCalcOut('暂无可用函数', 'bad'); return; }
    var v = fn.core.vars[0];
    var diffed;
    try {
      diffed = math.derivative(fn.core.expr, v).toString();
    } catch (err) {
      setCalcOut('无法求导：' + (err && err.message ? err.message : err), 'bad');
      return;
    }
    var name = (fn.core.mode === 'x_of_y') ? 'x' : (fn.core.name || 'y');
    var src = 'dcalculus(' + fn.core.expr + ', ' + v + ')';
    var res = addFunctionCore(src, '#7cf29c');
    if (res.error) { setCalcOut(res.error, 'bad'); return; }
    setCalcOut('已添加导函数 d/d' + v + ' (' + fn.core.expr + ') = ' + diffed, 'ok');
  }

  function doIntegralValue() {
    var fn = currentCalc2Fn();
    if (!fn) { setCalcOut('暂无可用函数', 'bad'); return; }
    var lo = $('#intLo').value.trim();
    var hi = $('#intHi').value.trim();
    if (!lo || !hi) { setCalcOut('请输入上下限（支持表达式与 inf/-inf）', 'bad'); return; }
    var spec;
    try {
      spec = FPlotCalculus.buildIntegral(math, fn.core.expr, fn.core.vars[0], lo, hi);
    } catch (err) {
      setCalcOut('积分参数错误：' + (err && err.message ? err.message : err), 'bad');
      return;
    }
    if (spec.isVariableBound) {
      setCalcOut('上下限含变量，属变限积分——请点「绘成函数」查看图像', '');
      return;
    }
    var val = spec.evalAt(0);
    if (!isFinite(val)) {
      setCalcOut('积分发散或被积函数在该区间无定义', 'bad');
      return;
    }
    setCalcOut('∫(' + fn.core.expr + ')d' + fn.core.vars[0] + ' [' + lo + ', ' + hi + '] = ' + fmt(val), 'ok');
  }

  function doIntegralFn() {
    var fn = currentCalc2Fn();
    if (!fn) { setCalcOut('暂无可用函数', 'bad'); return; }
    var lo = $('#intLo').value.trim();
    var hi = $('#intHi').value.trim();
    if (!lo || !hi) { setCalcOut('请输入上下限（变上限写变量名，如 x）', 'bad'); return; }
    var spec;
    try {
      spec = FPlotCalculus.buildIntegral(math, fn.core.expr, fn.core.vars[0], lo, hi);
    } catch (err) {
      setCalcOut('积分参数错误：' + (err && err.message ? err.message : err), 'bad');
      return;
    }
    if (!spec.isVariableBound) {
      setCalcOut('上下限均为常数，请用「求积分值」获取数值', 'bad');
      return;
    }
    var src = 'calculus(' + fn.core.expr + ', ' + fn.core.vars[0] + ', ' + lo + ', ' + hi + ')';
    var res = addFunctionCore(src, '#f5c542');
    if (res.error) { setCalcOut(res.error, 'bad'); return; }
    setCalcOut('已添加变限积分 F(' + spec.outputVar + ') = ∫(' + fn.core.expr + ')d' + fn.core.vars[0], 'ok');
  }

  /* ===================== 线性代数 / 参考系变换 ===================== */

  var LA = window.FPlotLinalg;

  function laM2(m) { return { a: m.a, b: m.b, c: m.c, d: m.d }; }
  function laM3(m) { return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f, g: m.g, h: m.h, i: m.i }; }

  function la2Out() {
    var T = state.view.t2;
    var m = laM2(T.m);
    var det = LA.m2Det(m), tr = LA.m2Trace(m), ev = LA.m2Eigenvalues(m);
    var lines = ['行列式 = ' + fmt(det), '迹 = ' + fmt(tr),
      '特征值 = ' + ev.map(function (e) { return fmt(e); }).join(', '),
      '类型 = ' + LA.m2TypeName(m)];
    $('#la2dOut').innerHTML = lines.map(function (t) { return '<div>' + escapeHtml(t) + '</div>'; }).join('');
  }

  function la3Out() {
    var T = state.view.t3;
    var m = laM3(T.m);
    var lines = ['行列式 = ' + fmt(LA.m3Det(m)), '迹 = ' + fmt(LA.m3Trace(m))];
    $('#la3dOut').innerHTML = lines.map(function (t) { return '<div>' + escapeHtml(t) + '</div>'; }).join('');
  }

  function renderLa() {
    var T2 = state.view.t2, T3 = state.view.t3;
    // 2D
    $('#la2dMode').value = T2.mode;
    $('#la2dLinear').classList.toggle('hidden', T2.mode !== 'linear');
    $('#la2dNonlinear').classList.toggle('hidden', T2.mode !== 'nonlinear');
    var cells2 = { la2a: 'a', la2b: 'b', la2c: 'c', la2d: 'd' };
    for (var id in cells2) { var el = $('#' + id); if (document.activeElement !== el) el.value = fmt(T2.m[cells2[id]]); }
    $('#la2fx').value = T2.fx;
    $('#la2fy').value = T2.fy;
    $('#la2Follow').checked = T2.follow;
    $('#la2Anim').textContent = T2.animate ? '⏸ 动画' : '▶ 动画';
    $('#la2Anim').classList.toggle('on', !!T2.animate);
    la2Out();
    // 3D
    $('#la3dMode').value = T3.mode;
    $('#la3dLinear').classList.toggle('hidden', T3.mode !== 'linear');
    $('#la3dNonlinear').classList.toggle('hidden', T3.mode !== 'nonlinear');
    var cells3 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    for (var k = 0; k < cells3.length; k++) {
      var el3 = $('#la3' + cells3[k]);
      if (document.activeElement !== el3) el3.value = fmt(T3.m[cells3[k]]);
    }
    $('#la3fx').value = T3.fx;
    $('#la3fy').value = T3.fy;
    $('#la3fz').value = T3.fz;
    $('#la3Follow').checked = T3.follow;
    $('#la3Anim').textContent = T3.animate ? '⏸ 动画' : '▶ 动画';
    $('#la3Anim').classList.toggle('on', !!T3.animate);
    la3Out();
  }

  function laRedraw2() { FPlot.persist(); renderLa(); V2.draw(); }
  function laRedraw3() { FPlot.persist(); renderLa(); if (state.view.mode === '3d') V3.rebuild(); }

  function la2ApplyPoints() {
    var T = state.view.t2;
    if (T.mode !== 'linear') { $('#la2dOut').innerHTML = '<div class="bad">仅线性变换可应用到点</div>'; return; }
    var set = geoSet();
    var n = 0;
    for (var i = 0; i < set.order.length; i++) {
      var o = G.getObject(set, set.order[i]);
      if (o && o.type === 'point') {
        var q = LA.m2Apply(laM2(T.m), o.x, o.y);
        o.x = q.x; o.y = q.y;
        n++;
      }
    }
    T.mode = 'off';
    $('#addMsg').textContent = '已把变换应用到 ' + n + ' 个点，变换已关闭';
    afterGeoChange();
    renderLa();
  }

  function bindLa() {
    // 面板内部 2D/3D 页签
    $('#laTab2d').addEventListener('click', function () {
      $('#laTab2d').classList.add('active');
      $('#laTab3d').classList.remove('active');
      $('#la2dBlock').classList.remove('hidden');
      $('#la3dBlock').classList.add('hidden');
    });
    $('#laTab3d').addEventListener('click', function () {
      $('#laTab3d').classList.add('active');
      $('#laTab2d').classList.remove('active');
      $('#la3dBlock').classList.remove('hidden');
      $('#la2dBlock').classList.add('hidden');
    });

    // 2D
    $('#la2dMode').addEventListener('change', function (e) {
      state.view.t2.mode = e.target.value;
      laRedraw2();
    });
    var cells2 = ['a', 'b', 'c', 'd'];
    for (var i = 0; i < cells2.length; i++) {
      (function (key) {
        $('#la2' + key).addEventListener('change', function (e) {
          var v = parseFloat(e.target.value);
          if (isFinite(v)) { state.view.t2.m[key] = v; laRedraw2(); }
        });
      })(cells2[i]);
    }
    var chips2 = document.querySelectorAll('#la2dLinear .tpl-chip');
    for (var c1 = 0; c1 < chips2.length; c1++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var p = LA.M2_PRESETS.filter(function (x) { return x.id === btn.getAttribute('data-m'); })[0];
          if (p) { state.view.t2.m = laM2(p.matrix); laRedraw2(); }
        });
      })(chips2[c1]);
    }
    $('#la2fx').addEventListener('change', function (e) { state.view.t2.fx = e.target.value.trim() || 'x'; laRedraw2(); });
    $('#la2fy').addEventListener('change', function (e) { state.view.t2.fy = e.target.value.trim() || 'y'; laRedraw2(); });
    $('#la2Follow').addEventListener('change', function (e) { state.view.t2.follow = e.target.checked; laRedraw2(); });
    $('#la2Anim').addEventListener('click', function () { state.view.t2.animate = !state.view.t2.animate; renderLa(); });
    $('#la2ApplyBtn').addEventListener('click', la2ApplyPoints);
    // 3D
    $('#la3dMode').addEventListener('change', function (e) {
      state.view.t3.mode = e.target.value;
      laRedraw3();
    });
    var cells3 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    for (var k = 0; k < cells3.length; k++) {
      (function (key) {
        $('#la3' + key).addEventListener('change', function (e) {
          var v = parseFloat(e.target.value);
          if (isFinite(v)) { state.view.t3.m[key] = v; laRedraw3(); }
        });
      })(cells3[k]);
    }
    var chips3 = document.querySelectorAll('#la3dLinear .tpl-chip');
    for (var c2 = 0; c2 < chips3.length; c2++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var p = LA.M3_PRESETS.filter(function (x) { return x.id === btn.getAttribute('data-m'); })[0];
          if (p) { state.view.t3.m = laM3(p.matrix); laRedraw3(); }
        });
      })(chips3[c2]);
    }
    $('#la3fx').addEventListener('change', function (e) { state.view.t3.fx = e.target.value.trim() || 'x'; laRedraw3(); });
    $('#la3fy').addEventListener('change', function (e) { state.view.t3.fy = e.target.value.trim() || 'y'; laRedraw3(); });
    $('#la3fz').addEventListener('change', function (e) { state.view.t3.fz = e.target.value.trim() || 'z'; laRedraw3(); });
    $('#la3Follow').addEventListener('change', function (e) { state.view.t3.follow = e.target.checked; laRedraw3(); });
    $('#la3Anim').addEventListener('click', function () { state.view.t3.animate = !state.view.t3.animate; renderLa(); });
  }

  /* t 参数动画：三角波 yoyo（-1 → 1 → -1），速度 0.9/s */
  function laAnimStep(dt) {
    var any = false;
    var T2 = state.view.t2, T3 = state.view.t3;
    if (T2.animate) {
      T2.phase = (T2.phase + dt * 0.9) % 2;
      T2.t = T2.phase < 1 ? -1 + 2 * T2.phase : 3 - 2 * T2.phase;
      any = true;
    }
    if (T3.animate) {
      T3.phase = (T3.phase + dt * 0.9) % 2;
      T3.t = T3.phase < 1 ? -1 + 2 * T3.phase : 3 - 2 * T3.phase;
      any = true;
    }
    return any;
  }

  /* ===================== 历史记录 UI ===================== */

  function renderHistory() {
    var box = $('#histList');
    var list = FPlot.loadHistoryList();
    box.innerHTML = list.length ? '' : '<span class="mini">暂无快照</span>';
    for (var i = 0; i < list.length; i++) {
      (function (h) {
        var row = document.createElement('div');
        row.className = 'hist-row';
        var t = new Date(h.time);
        function p(n) { return String(n).length < 2 ? '0' + n : String(n); }
        var ts = (t.getMonth() + 1) + '/' + t.getDate() + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
        row.innerHTML = '<div class="hist-info">'
          + '<div class="hist-label">' + escapeHtml(h.label) + '</div>'
          + '<div class="hist-meta">' + ts + ' · ' + h.snap.functions.length + ' 个函数</div>'
          + '</div>'
          + '<div class="hist-ops">'
          + '<button class="mini-btn h-load">载入</button>'
          + '<button class="mini-btn h-del">删除</button>'
          + '</div>';
        row.querySelector('.h-load').addEventListener('click', function () { restoreSnapshot(h.id); });
        row.querySelector('.h-del').addEventListener('click', function () {
          FPlot.writeHistoryList(FPlot.loadHistoryList().filter(function (x) { return x.id !== h.id; }));
          renderHistory();
        });
        box.appendChild(row);
      })(list[i]);
    }
  }

  /* ===================== 导出 ===================== */

  function exportPNG() {
    if (state.view.mode === '3d') {
      V3.render();
      var url = V3.getRenderer().domElement.toDataURL('image/png');
      downloadDataURL(url, '函数图像_三维_' + stamp() + '.png');
    } else {
      V2.draw();
      var url2 = $('#view2d').toDataURL('image/png');
      downloadDataURL(url2, '函数图像_二维_' + stamp() + '.png');
    }
  }

  /* ===================== 主循环 / 启动 ===================== */

  var lastT = 0;
  var animAccum = 0;

  function loop(t) {
    requestAnimationFrame(loop);
    var dt = Math.min(0.1, (t - lastT) / 1000 || 0);
    lastT = t;

    // 参考系 t 动画
    if (laAnimStep(dt)) {
      if (state.view.mode === '2d') V2.draw();
      else {
        animAccum += dt;
        if (animAccum >= 0.12) { animAccum = 0; V3.rebuild(); }
      }
    }

    // 参数动画推进（常数变化 → 重绘当前视图）
    if (FPlot.anim.count) {
      if (FPlot.animStep(dt)) {
        syncAnimInputs();
        animAccum += dt;
        if (state.view.mode === '3d') {
          if (animAccum >= 0.05) { animAccum = 0; V3.rebuild(); }
        } else {
          V2.draw();
        }
      }
    }

    if (state.view.mode !== '3d') return;
    V3.tick();
  }

  function init() {
    if (typeof THREE === 'undefined' || typeof math === 'undefined' || typeof FPlotCore === 'undefined' || !FPlot || !V2 || !V3) {
      document.body.innerHTML = '<p style="color:#e5484d;padding:20px">依赖库加载失败：请确认 lib/ 与 src/ 目录和 index.html 在一起。</p>';
      return;
    }
    // 视图回调
    V2.bindTooltipFns(showTooltip, hideTooltip);
    V3.bindTooltipFns(showTooltip, hideTooltip);
    V3.hooks.afterRebuild = function () { updateLegend(); updateEmptyHint(); };
    V3.hooks.zRangeChanged = syncZInputs;
    V2.hooks.pointerDown = GEO_HOOKS.pointerDown;
    V2.hooks.pointerMove = GEO_HOOKS.pointerMove;
    V2.hooks.pointerUp = GEO_HOOKS.pointerUp;
    V2.hooks.afterMarkers = function (ctx, w2s) { drawGeo(ctx, w2s); };
    FPlot.on2dDrawn = function () { updateLegend(); updateEmptyHint(); };

    if (!state.geometry && G) state.geometry = G.create();
    if (!FPlot.loadPersisted()) {
      state.functions = [
        mkFn('z(x,y)=sin(x)*cos(y)', '#ef5350'),
        mkFn('y(t)=sin(t)+t/5', '#4f8ef7'),
      ];
      state.geometry = G.create();
    }
    if (!state.geometry) state.geometry = G.create();
    V3.init();
    V2.init();
    bindUI();
    renderTemplates();
    syncUIFromState();
    V3.rebuild();
    V3.frame();
    V2.draw();
    switchMode(state.view.mode);
    requestAnimationFrame(function (t) { lastT = t; requestAnimationFrame(loop); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
