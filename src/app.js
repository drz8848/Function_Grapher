/*
 * app.js — 函数作图器主逻辑
 * 依赖全局：math (mathjs)、THREE (three.js r147)、THREE.OrbitControls、FPlotCore (math-core.js)
 */
(function () {
  'use strict';

  /* ===================== 小工具 ===================== */

  function $(sel) { return document.querySelector(sel); }

  function uid() {
    return 'f' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function fmt(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(3);
    return String(parseFloat(v.toPrecision(6)));
  }

  function niceStep(span, target) {
    if (!(span > 0) || !isFinite(span)) return 1;
    var rough = span / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
    var n = rough / mag;
    var step = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return step * mag;
  }

  function linspace(a, b, n) {
    var out = new Array(n);
    if (n === 1) { out[0] = a; return out; }
    var d = (b - a) / (n - 1);
    for (var i = 0; i < n; i++) out[i] = a + d * i;
    out[n - 1] = b;
    return out;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).length < 2 ? '0' + n : String(n); }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function downloadDataURL(dataURL, filename) {
    var a = document.createElement('a');
    a.href = dataURL;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ===================== 状态 ===================== */

  var LS_STATE = 'fplot.v1.state';
  var LS_HISTORY = 'fplot.v1.history';
  var PALETTE = ['#ef5350', '#4f8ef7', '#51cf66', '#fcc419', '#cc5de8', '#22b8cf', '#ff922b', '#845ef7'];

  function defaultView() {
    return {
      mode: '3d',
      res: 60, wireframe: false, showGrid: true, showTicks: true,
      x: [-5, 5], y: [-5, 5], zAuto: true, z: [-2, 2],
      x2: [-10, 10], y2Auto: true, y2: [-6, 6],
      c3: { bg: '#12151c', ax: '#ff6b6b', ay: '#51cf66', az: '#5c9ded', grid: '#2a3140', text: '#aab3c5' },
      c2: { bg: '#ffffff', ax: '#d9480f', ay: '#1864ab', grid: '#e9ecf3', text: '#343a40' },
    };
  }

  var state = { functions: [], view: defaultView() };
  var markers3d = []; // { fnId, pos:[x,y,z], color }
  var markers2d = []; // { fnId, x, y, color }

  /* ---------- 函数对象 ---------- */

  function mkFn(src, color) {
    var fn = {
      id: uid(),
      src: src || 'z(x,y)=x^2+y^2',
      color: color || PALETTE[0],
      opacity: 1,
      visible: true,
      constants: {},
      core: null,
      error: null,
    };
    recompile(fn);
    return fn;
  }

  function recompile(fn) {
    fn.core = null;
    fn.error = null;
    try {
      var c = FPlotCore.compileFunction(math, fn.src);
      // 常数字母：保留已有值，补默认 1，删除不再存在的
      var keep = {};
      for (var i = 0; i < c.freeSymbols.length; i++) {
        var s = c.freeSymbols[i];
        var old = fn.constants[s];
        keep[s] = (typeof old === 'number' && isFinite(old)) ? old : 1;
      }
      fn.constants = keep;
      // 试算：尽早暴露致命错误（如未定义的函数名）
      var scope = {};
      for (var j = 0; j < c.vars.length; j++) scope[c.vars[j]] = 1;
      for (var k in fn.constants) scope[k] = fn.constants[k];
      try { c.node.compile().evaluate(scope); }
      catch (err) { throw new Error('求值失败：' + (err && err.message ? err.message : String(err))); }
      fn.core = c;
    } catch (err) {
      fn.error = err && err.message ? err.message : String(err);
    }
  }

  function fnArity(fn) { return fn.core ? fn.core.vars.length : 0; }
  function fnLabel(fn) { return fn.core ? fn.core.name + '(' + fn.core.vars.join(',') + ')' : fn.src; }
  function fnIsDrawable(fn, arity) { return fn.visible && fn.core && !fn.error && fn.core.vars.length === arity; }

  // 安全求值（每次新 scope，用于低频调用）
  function evalFn(fn, vals) {
    if (!fn.core) return NaN;
    var scope = {};
    for (var k in fn.constants) scope[k] = fn.constants[k];
    for (var i = 0; i < fn.core.vars.length; i++) scope[fn.core.vars[i]] = vals[i];
    return fn.core.evaluate(scope);
  }

  // 高频求值：复用 scope 对象，f(a) 或 f(a,b)
  function scopeFn(fn) {
    var scope = {};
    for (var k in fn.constants) scope[k] = fn.constants[k];
    var vs = fn.core.vars;
    return function (a, b) {
      scope[vs[0]] = a;
      if (vs.length > 1) scope[vs[1]] = b;
      return fn.core.evaluate(scope);
    };
  }

  /* ---------- 持久化 ---------- */

  function stateReplacer(k, v) { return (k === 'core' || k === 'error') ? undefined : v; }

  function persist() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({ functions: state.functions, view: state.view }, stateReplacer));
    } catch (e) { /* 存储不可用时忽略 */ }
  }

  function reviveFn(f) {
    var fn = {
      id: f.id || uid(),
      src: f.src,
      color: f.color || PALETTE[0],
      opacity: (typeof f.opacity === 'number') ? f.opacity : 1,
      visible: f.visible !== false,
      constants: f.constants || {},
      core: null,
      error: null,
    };
    recompile(fn);
    return fn;
  }

  function loadPersisted() {
    var data = null;
    try { data = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) { data = null; }
    if (!data || !Array.isArray(data.functions)) return false;
    state.functions = data.functions.map(reviveFn);
    var v = defaultView();
    if (data.view) {
      for (var k in data.view) {
        if (k === 'c3' && data.view.c3) { for (var a in data.view.c3) v.c3[a] = data.view.c3[a]; }
        else if (k === 'c2' && data.view.c2) { for (var b in data.view.c2) v.c2[b] = data.view.c2[b]; }
        else v[k] = data.view[k];
      }
    }
    state.view = v;
    return true;
  }

  /* ---------- 历史记录 ---------- */

  function loadHistoryList() {
    try {
      var l = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
      return Array.isArray(l) ? l : [];
    } catch (e) { return []; }
  }

  function writeHistoryList(l) {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(l)); } catch (e) { /* ignore */ }
  }

  function saveSnapshot(label) {
    var snap = JSON.parse(JSON.stringify({ functions: state.functions, view: state.view }, stateReplacer));
    var list = loadHistoryList();
    list.unshift({ id: uid(), time: Date.now(), label: (label || '').trim() || '未命名快照', snap: snap });
    if (list.length > 50) list.length = 50;
    writeHistoryList(list);
    renderHistory();
  }

  function restoreSnapshot(id) {
    var item = null;
    var list = loadHistoryList();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { item = list[i]; break; }
    if (!item) return;
    state.functions = item.snap.functions.map(reviveFn);
    var v = defaultView();
    var sv = item.snap.view || {};
    for (var k in sv) {
      if (k === 'c3' && sv.c3) { for (var a in sv.c3) v.c3[a] = sv.c3[a]; }
      else if (k === 'c2' && sv.c2) { for (var b in sv.c2) v.c2[b] = sv.c2[b]; }
      else v[k] = sv[k];
    }
    state.view = v;
    markers3d.length = 0;
    markers2d.length = 0;
    syncUIFromState();
    rebuildAll();
    frame3d();
    persist();
  }

  /* ===================== 三维视图 ===================== */

  var v3 = {
    ready: false,
    container: null, renderer: null, scene: null, camera: null, controls: null,
    groupFns: null, groupAxes: null, groupMarkers: null, hoverMarker: null,
    raycaster: null,
    pointerNDC: null, pointerPx: { x: 0, y: 0 },
    hoverDirty: false, pointerInside: false,
  };

  function init3d() {
    v3.container = $('#view3d');
    var renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    v3.container.appendChild(renderer.domElement);
    v3.renderer = renderer;

    v3.scene = new THREE.Scene();
    v3.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    v3.camera.up.set(0, 0, 1); // z 轴朝上（数据坐标即世界坐标）
    v3.camera.position.set(9, -10, 7);

    var controls = new THREE.OrbitControls(v3.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    v3.controls = controls;

    v3.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 0.95));
    var dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(5, -6, 8);
    v3.scene.add(dir);

    v3.groupFns = new THREE.Group();
    v3.groupAxes = new THREE.Group();
    v3.groupMarkers = new THREE.Group();
    v3.scene.add(v3.groupFns);
    v3.scene.add(v3.groupAxes);
    v3.scene.add(v3.groupMarkers);

    v3.hoverMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.95 })
    );
    v3.hoverMarker.visible = false;
    v3.hoverMarker.renderOrder = 20;
    v3.scene.add(v3.hoverMarker);

    v3.raycaster = new THREE.Raycaster();
    v3.pointerNDC = new THREE.Vector2();

    renderer.domElement.addEventListener('pointermove', function (e) {
      var r = renderer.domElement.getBoundingClientRect();
      v3.pointerNDC.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      v3.pointerNDC.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      v3.pointerPx.x = e.clientX;
      v3.pointerPx.y = e.clientY;
      v3.pointerInside = true;
      v3.hoverDirty = true;
    });
    renderer.domElement.addEventListener('pointerleave', function () {
      v3.pointerInside = false;
      v3.hoverDirty = true;
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(resize3d).observe(v3.container);
    } else {
      window.addEventListener('resize', resize3d);
    }
    resize3d();
    v3.ready = true;
  }

  function resize3d() {
    if (!v3.renderer) return;
    var w = v3.container.clientWidth, h = v3.container.clientHeight;
    if (w === 0 || h === 0) return;
    v3.renderer.setSize(w, h);
    v3.camera.aspect = w / h;
    v3.camera.updateProjectionMatrix();
  }

  function disposeGroup(g) {
    g.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < mats.length; i++) {
          if (mats[i].map) mats[i].map.dispose();
          mats[i].dispose();
        }
      }
    });
    while (g.children.length) g.remove(g.children[0]);
  }

  function boxDiag() {
    var V = state.view;
    var dx = V.x[1] - V.x[0], dy = V.y[1] - V.y[0], dz = V.z[1] - V.z[0];
    return Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  }

  function rebuild3d() {
    if (!v3.ready) return;
    var V = state.view;
    v3.scene.background = new THREE.Color(V.c3.bg);

    disposeGroup(v3.groupFns);
    disposeGroup(v3.groupAxes);
    disposeGroup(v3.groupMarkers);

    var x0 = V.x[0], x1 = V.x[1], y0 = V.y[0], y1 = V.y[1];
    var n = clamp(Math.round(V.res) || 60, 10, 200);
    var xs = linspace(x0, x1, n + 1);
    var ys = linspace(y0, y1, n + 1);

    var zsAll = [];
    var list3d = state.functions.filter(function (f) { return fnIsDrawable(f, 2); });

    for (var fi = 0; fi < list3d.length; fi++) {
      var fn = list3d[fi];
      var f = scopeFn(fn);
      var count = (n + 1) * (n + 1);
      var pos = new Float32Array(count * 3);
      var valid = new Uint8Array(count);
      var k = 0;
      for (var iy = 0; iy <= n; iy++) {
        for (var ix = 0; ix <= n; ix++, k++) {
          var x = xs[ix], y = ys[iy];
          var z = f(x, y);
          pos[k * 3] = x;
          pos[k * 3 + 1] = y;
          pos[k * 3 + 2] = isFinite(z) ? z : 0;
          if (isFinite(z)) { valid[k] = 1; zsAll.push(z); }
        }
      }
      var idx = [];
      for (iy = 0; iy < n; iy++) {
        for (ix = 0; ix < n; ix++) {
          var a = iy * (n + 1) + ix;
          var b = a + 1;
          var c = a + (n + 1);
          var d = c + 1;
          if (valid[a] && valid[b] && valid[c]) idx.push(a, b, c);
          if (valid[b] && valid[c] && valid[d]) idx.push(b, d, c);
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();

      var mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(fn.color),
        side: THREE.DoubleSide,
        transparent: fn.opacity < 1,
        opacity: fn.opacity,
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.userData.fnId = fn.id;
      v3.groupFns.add(mesh);

      if (V.wireframe) {
        var wgeo = new THREE.WireframeGeometry(geo);
        var wmat = new THREE.LineBasicMaterial({
          color: new THREE.Color(fn.color),
          transparent: true,
          opacity: Math.min(0.9, 0.25 + 0.5 * fn.opacity),
        });
        var lines = new THREE.LineSegments(wgeo, wmat);
        lines.userData.fnId = fn.id;
        v3.groupFns.add(lines);
      }
    }

    // z 范围（自动）
    if (V.zAuto) {
      if (zsAll.length) {
        var mn = Infinity, mx = -Infinity;
        for (var zi = 0; zi < zsAll.length; zi++) {
          var zv = zsAll[zi];
          if (zv < mn) mn = zv;
          if (zv > mx) mx = zv;
        }
        var pad = Math.max((mx - mn) * 0.08, Math.abs(mx) * 1e-3, 1e-6);
        V.z = [mn - pad, mx + pad];
      } else {
        V.z = [-1, 1];
      }
      syncZInputs();
    }

    buildAxes3d();
    renderMarkers3d();
    updateLegend();
    updateEmptyHint();
  }

  function makeTextSprite(text, color, worldH) {
    var pad = 10;
    var cv = document.createElement('canvas');
    var ctx = cv.getContext('2d');
    var font = '500 48px system-ui, sans-serif';
    ctx.font = font;
    var w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    var h = 64;
    cv.width = Math.max(w, 2);
    cv.height = h;
    ctx = cv.getContext('2d');
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, h / 2);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    var spr = new THREE.Sprite(mat);
    spr.scale.set(worldH * cv.width / h, worldH, 1);
    spr.renderOrder = 10;
    return spr;
  }

  function first3dFn() {
    for (var i = 0; i < state.functions.length; i++) {
      if (fnIsDrawable(state.functions[i], 2)) return state.functions[i];
    }
    return null;
  }

  function buildAxes3d() {
    var V = state.view;
    var x0 = V.x[0], x1 = V.x[1], y0 = V.y[0], y1 = V.y[1], z0 = V.z[0], z1 = V.z[1];
    var colAx = new THREE.Color(V.c3.ax);
    var colAy = new THREE.Color(V.c3.ay);
    var colAz = new THREE.Color(V.c3.az);
    var colGrid = V.c3.grid;
    var colText = V.c3.text;

    var ox = clamp(0, x0, x1), oy = clamp(0, y0, y1), oz = clamp(0, z0, z1);
    var spanX = x1 - x0, spanY = y1 - y0, spanZ = z1 - z0;
    var diag = boxDiag();
    var labelH = diag * 0.035;
    var tickLen = diag * 0.012;
    var fn0 = first3dFn();
    var nameX = fn0 ? fn0.core.vars[0] : 'x';
    var nameY = fn0 ? fn0.core.vars[1] : 'y';
    var nameZ = fn0 ? fn0.core.name : 'z';

    function addLine(a, b, color, opacity) {
      var g = new THREE.BufferGeometry().setFromPoints([a, b]);
      var m = new THREE.LineBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity });
      v3.groupAxes.add(new THREE.Line(g, m));
    }
    function addLines(points, color, opacity) {
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      var m = new THREE.LineBasicMaterial({ color: color, transparent: opacity < 1, opacity: opacity });
      v3.groupAxes.add(new THREE.LineSegments(g, m));
    }
    function addCone(p, dirName, color) {
      var g = new THREE.ConeGeometry(diag * 0.012, diag * 0.04, 12);
      var m = new THREE.MeshBasicMaterial({ color: color });
      var mesh = new THREE.Mesh(g, m);
      mesh.position.copy(p);
      if (dirName === 'x') mesh.rotation.z = -Math.PI / 2;
      else if (dirName === 'z') mesh.rotation.x = Math.PI / 2;
      v3.groupAxes.add(mesh);
    }

    // 底面网格
    if (V.showGrid) {
      var pts = [];
      var sx = niceStep(spanX, 8), sy = niceStep(spanY, 8);
      var i, t;
      i = Math.ceil((x0 - sx * 1e-6) / sx);
      for (; i * sx <= x1 + sx * 1e-6; i++) {
        t = i * sx;
        pts.push(t, y0, z0, t, y1, z0);
      }
      i = Math.ceil((y0 - sy * 1e-6) / sy);
      for (; i * sy <= y1 + sy * 1e-6; i++) {
        t = i * sy;
        pts.push(x0, t, z0, x1, t, z0);
      }
      addLines(pts, new THREE.Color(colGrid), 0.55);
    }

    // 三条轴线 + 箭头
    addLine(new THREE.Vector3(x0, oy, oz), new THREE.Vector3(x1, oy, oz), colAx, 1);
    addLine(new THREE.Vector3(ox, y0, oz), new THREE.Vector3(ox, y1, oz), colAy, 1);
    addLine(new THREE.Vector3(ox, oy, z0), new THREE.Vector3(ox, oy, z1), colAz, 1);
    addCone(new THREE.Vector3(x1, oy, oz), 'x', colAx);
    addCone(new THREE.Vector3(ox, y1, oz), 'y', colAy);
    addCone(new THREE.Vector3(ox, oy, z1), 'z', colAz);

    if (V.showTicks) {
      var i0, i1, tt;
      // X 刻度
      var s1 = niceStep(spanX, 8);
      var pts1 = [];
      i0 = Math.ceil((x0 - s1 * 1e-6) / s1);
      i1 = Math.floor((x1 + s1 * 1e-6) / s1);
      for (i = i0; i <= i1; i++) {
        tt = i * s1;
        pts1.push(tt, oy - tickLen, oz, tt, oy + tickLen, oz);
      }
      addLines(pts1, colAx, 0.9);
      for (i = i0; i <= i1; i++) {
        tt = i * s1;
        var spr1 = makeTextSprite(fmt(tt), colText, labelH);
        spr1.position.set(tt, oy - tickLen * 4.2, oz);
        v3.groupAxes.add(spr1);
      }
      // Y 刻度
      var s2 = niceStep(spanY, 8);
      var pts2 = [];
      i0 = Math.ceil((y0 - s2 * 1e-6) / s2);
      i1 = Math.floor((y1 + s2 * 1e-6) / s2);
      for (i = i0; i <= i1; i++) {
        tt = i * s2;
        pts2.push(ox - tickLen, tt, oz, ox + tickLen, tt, oz);
      }
      addLines(pts2, colAy, 0.9);
      for (i = i0; i <= i1; i++) {
        tt = i * s2;
        var spr2 = makeTextSprite(fmt(tt), colText, labelH);
        spr2.position.set(ox - tickLen * 4.2, tt, oz);
        v3.groupAxes.add(spr2);
      }
      // Z 刻度
      var s3 = niceStep(spanZ, 6);
      var pts3 = [];
      i0 = Math.ceil((z0 - s3 * 1e-6) / s3);
      i1 = Math.floor((z1 + s3 * 1e-6) / s3);
      for (i = i0; i <= i1; i++) {
        tt = i * s3;
        pts3.push(ox - tickLen, oy, tt, ox + tickLen, oy, tt);
      }
      addLines(pts3, colAz, 0.9);
      for (i = i0; i <= i1; i++) {
        tt = i * s3;
        var spr3 = makeTextSprite(fmt(tt), colText, labelH);
        spr3.position.set(ox - tickLen * 4.2, oy, tt);
        v3.groupAxes.add(spr3);
      }
    }

    // 轴名（随变量名）
    var spx = makeTextSprite(nameX, '#' + colAx.getHexString(), labelH * 1.25);
    spx.position.set(x1 + diag * 0.05, oy, oz);
    v3.groupAxes.add(spx);
    var spy = makeTextSprite(nameY, '#' + colAy.getHexString(), labelH * 1.25);
    spy.position.set(ox, y1 + diag * 0.05, oz);
    v3.groupAxes.add(spy);
    var spz = makeTextSprite(nameZ, '#' + colAz.getHexString(), labelH * 1.25);
    spz.position.set(ox, oy, z1 + diag * 0.05);
    v3.groupAxes.add(spz);
  }

  function renderMarkers3d() {
    if (!v3.ready) return;
    var r = boxDiag() * 0.01;
    for (var i = 0; i < markers3d.length; i++) {
      var mk = markers3d[i];
      var mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(mk.color), depthTest: false, transparent: true, opacity: 0.95 })
      );
      mesh.position.set(mk.pos[0], mk.pos[1], mk.pos[2]);
      mesh.renderOrder = 15;
      v3.groupMarkers.add(mesh);
    }
  }

  function frame3d() {
    if (!v3.ready) return;
    var V = state.view;
    var cx = (V.x[0] + V.x[1]) / 2, cy = (V.y[0] + V.y[1]) / 2, cz = (V.z[0] + V.z[1]) / 2;
    var span = Math.max(V.x[1] - V.x[0], V.y[1] - V.y[0], V.z[1] - V.z[0]) || 1;
    var d = span * 2.1;
    v3.camera.position.set(cx + d * 0.62, cy - d * 0.72, cz + d * 0.52);
    v3.controls.target.set(cx, cy, cz);
    v3.controls.update();
  }

  function hover3d() {
    if (!v3.pointerInside) {
      v3.hoverMarker.visible = false;
      hideTooltip();
      return;
    }
    v3.raycaster.setFromCamera(v3.pointerNDC, v3.camera);
    var meshes = [];
    v3.groupFns.traverse(function (o) { if (o.isMesh) meshes.push(o); });
    var hits = v3.raycaster.intersectObjects(meshes, false);
    if (!hits.length) {
      v3.hoverMarker.visible = false;
      hideTooltip();
      return;
    }
    var h = hits[0];
    var p = h.point;
    v3.hoverMarker.position.copy(p);
    var s = boxDiag() * 0.012;
    v3.hoverMarker.scale.set(s, s, s);
    v3.hoverMarker.visible = true;
    var fn = null;
    for (var i = 0; i < state.functions.length; i++) {
      if (state.functions[i].id === h.object.userData.fnId) { fn = state.functions[i]; break; }
    }
    var nx = 'x', ny = 'y', nz = 'z';
    if (fn && fn.core) { nx = fn.core.vars[0]; ny = fn.core.vars[1]; nz = fn.core.name; }
    showTooltip(v3.pointerPx.x, v3.pointerPx.y,
      nx + ' = ' + fmt(p.x) + '   ' + ny + ' = ' + fmt(p.y) + '   ' + nz + ' = ' + fmt(p.z));
  }

  /* ===================== 二维视图 ===================== */

  var v2 = { canvas: null, ctx: null, cssW: 0, cssH: 0, hover: null, pointerDown: false, dragStart: null };

  function init2d() {
    v2.canvas = $('#view2d');
    v2.ctx = v2.canvas.getContext('2d');
    window.addEventListener('resize', draw2d);

    v2.canvas.addEventListener('pointerdown', function (e) {
      v2.pointerDown = true;
      v2.dragStart = { x: e.clientX, y: e.clientY, x2: state.view.x2.slice(), y2: state.view.y2.slice() };
      try { v2.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
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
      draw2d();
    });

    function endDrag() {
      if (v2.pointerDown) { v2.pointerDown = false; v2.dragStart = null; persist(); }
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
      persist();
    }, { passive: false });

    v2.canvas.addEventListener('dblclick', reset2dView);
  }

  function reset2dView() {
    state.view.x2 = [-10, 10];
    state.view.y2Auto = true;
    state.view.y2 = [-6, 6];
    syncRangeInputs2d();
    draw2d();
    persist();
  }

  function y2RangeAuto() {
    var fns = state.functions.filter(function (f) { return fnIsDrawable(f, 1); });
    var a = state.view.x2[0], b = state.view.x2[1];
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < fns.length; i++) {
      var f = scopeFn(fns[i]);
      for (var j = 0; j <= 240; j++) {
        var x = a + (b - a) * j / 240;
        var y = f(x);
        if (isFinite(y)) { if (y < mn) mn = y; if (y > mx) mx = y; }
      }
    }
    if (!isFinite(mn) || !isFinite(mx)) return [-1, 1];
    if (mx - mn < 1e-9) { mn -= 1; mx += 1; }
    var pad = (mx - mn) * 0.08;
    return [mn - pad, mx + pad];
  }

  function first1dFn() {
    for (var i = 0; i < state.functions.length; i++) {
      if (fnIsDrawable(state.functions[i], 1)) return state.functions[i];
    }
    return null;
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

    var fn1 = first1dFn();
    var nameX = fn1 ? fn1.core.vars[0] : 'x';
    var nameY = fn1 ? fn1.core.name : 'y';

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

    // 曲线（多条叠加）
    var fns = state.functions.filter(function (f) { return fnIsDrawable(f, 1); });
    for (var fi = 0; fi < fns.length; fi++) {
      var fn = fns[fi];
      var f = scopeFn(fn);
      ctx.globalAlpha = fn.opacity;
      ctx.lineWidth = 2;
      ctx.strokeStyle = fn.color;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      var pen = false;
      var ySpan = d - c;
      for (var px = 0; px <= pw; px++) {
        var x = a + (px / pw) * (b - a);
        var y = f(x);
        if (!isFinite(y) || y < c - ySpan * 2 || y > d + ySpan * 2) { pen = false; continue; }
        var X = px0 + px;
        var Y = y2px(y);
        if (!pen) { ctx.moveTo(X, Y); pen = true; }
        else ctx.lineTo(X, Y);
      }
      ctx.stroke();
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

    // 悬停：最近曲线点
    if (v2.hover && !v2.pointerDown) {
      var hx = v2.hover.x, hy = v2.hover.y;
      if (hx >= px0 && hx <= px0 + pw) {
        var xd = px2x(hx);
        var best = null;
        for (var bi = 0; bi < fns.length; bi++) {
          var bf = scopeFn(fns[bi]);
          var by = bf(xd);
          if (!isFinite(by)) continue;
          var byPx = y2px(by);
          var dist = Math.abs(byPx - hy);
          if (dist < 40 && (!best || dist < best.dist)) {
            best = { dist: dist, y: by, yPx: byPx, fn: fns[bi] };
          }
        }
        if (best) {
          // 十字线
          ctx.strokeStyle = 'rgba(128,138,155,0.45)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(hx, py0);
          ctx.lineTo(hx, py0 + ph);
          ctx.stroke();
          // 吸附点
          ctx.beginPath();
          ctx.arc(hx, best.yPx, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = best.fn.color;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
          var vx = best.fn.core.vars[0], vy = best.fn.core.name;
          showTooltip(v2.hover.x + cv.getBoundingClientRect().left, v2.hover.y + cv.getBoundingClientRect().top,
            vx + ' = ' + fmt(xd) + '   ' + vy + ' = ' + fmt(best.y));
        }
      }
      if (!best) hideTooltip();
    } else if (v2.pointerDown) {
      hideTooltip();
    }

    updateEmptyHint();
  }

  function syncRangeInputs2d() {
    var V = state.view;
    var exa = $('#xmin2'), exb = $('#xmax2'), eya = $('#ymin2'), eyb = $('#ymax2');
    if (document.activeElement !== exa) exa.value = fmt(V.x2[0]);
    if (document.activeElement !== exb) exb.value = fmt(V.x2[1]);
    if (document.activeElement !== eya) eya.value = fmt(V.y2[0]);
    if (document.activeElement !== eyb) eyb.value = fmt(V.y2[1]);
  }

  function syncZInputs() {
    var V = state.view;
    var a = $('#zmin3'), b = $('#zmax3');
    if (document.activeElement !== a) a.value = fmt(V.z[0]);
    if (document.activeElement !== b) b.value = fmt(V.z[1]);
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
    var arity = state.view.mode === '3d' ? 2 : 1;
    var fns = state.functions.filter(function (f) { return fnIsDrawable(f, arity); });
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
          persist();
          renderFnList();
          rebuild3d();
          draw2d();
        });
      })(items[j]);
    }
  }

  function updateEmptyHint() {
    var mode = state.view.mode;
    var arity = mode === '3d' ? 2 : 1;
    var any = state.functions.some(function (f) { return fnIsDrawable(f, arity); });
    var el = $('#emptyHint');
    el.style.display = any ? 'none' : 'flex';
    el.textContent = mode === '3d'
      ? '三维视图暂无函数：添加如 z(x,y)=x^2+y^2'
      : '二维视图暂无函数：添加如 y(x)=sin(x)';
  }

  /* ===================== UI：函数列表 ===================== */

  function renderFnList() {
    var box = $('#fnList');
    box.innerHTML = '';
    for (var i = 0; i < state.functions.length; i++) {
      box.appendChild(buildFnCard(state.functions[i]));
    }
    renderCalcSelect();
    updateLegend();
    updateEmptyHint();
  }

  function buildFnCard(fn) {
    var card = document.createElement('div');
    card.className = 'fn-card';
    var arity = fnArity(fn);
    var badge;
    if (fn.error) badge = '<span class="badge berr">错误</span>';
    else if (arity === 2) badge = '<span class="badge b3d">三维曲面</span>';
    else if (arity === 1) badge = '<span class="badge b2d">二维曲线</span>';
    else badge = '<span class="badge boff">无法解析</span>';

    var html = ''
      + '<div class="fn-row1">'
      + '<input type="checkbox" class="fn-vis" title="显示/隐藏"' + (fn.visible ? ' checked' : '') + '>'
      + '<input type="text" class="fn-src" value="' + escapeHtml(fn.src) + '" spellcheck="false">'
      + '<button class="icon-btn fn-del" title="删除">×</button>'
      + '</div>'
      + '<div class="fn-row2">'
      + badge
      + '<input type="color" class="fn-color" value="' + fn.color + '" title="图像颜色（面/线）">'
      + '<span class="mini">不透明度</span>'
      + '<input type="range" class="fn-op" min="0.1" max="1" step="0.05" value="' + fn.opacity + '">'
      + (arity === 2 ? '<button class="mini-btn fn-wire">线框</button>' : '')
      + '</div>';

    if (fn.core && fn.core.freeSymbols.length) {
      html += '<div class="fn-consts">';
      for (var i = 0; i < fn.core.freeSymbols.length; i++) {
        var s = fn.core.freeSymbols[i];
        html += '<label class="const-item"><span>' + escapeHtml(s) + '</span>'
          + '<input type="number" step="any" class="fn-const" data-sym="' + escapeHtml(s) + '" value="' + fn.constants[s] + '"></label>';
      }
      html += '</div>';
    }
    if (fn.error) html += '<div class="fn-error">' + escapeHtml(fn.error) + '</div>';
    card.innerHTML = html;

    card.querySelector('.fn-vis').addEventListener('change', function (e) {
      fn.visible = e.target.checked;
      persist();
      rebuild3d();
      draw2d();
    });
    card.querySelector('.fn-src').addEventListener('change', function (e) {
      fn.src = e.target.value.trim();
      var oldArity = fnArity(fn);
      recompile(fn);
      persist();
      renderFnList();
      var na = fnArity(fn);
      if (!fn.error && (na === 1 || na === 2) && na !== oldArity) {
        switchMode(na === 2 ? '3d' : '2d');
      }
      rebuild3d();
      draw2d();
    });
    card.querySelector('.fn-del').addEventListener('click', function () {
      state.functions = state.functions.filter(function (f) { return f.id !== fn.id; });
      var j;
      for (j = markers3d.length - 1; j >= 0; j--) if (markers3d[j].fnId === fn.id) markers3d.splice(j, 1);
      for (j = markers2d.length - 1; j >= 0; j--) if (markers2d[j].fnId === fn.id) markers2d.splice(j, 1);
      persist();
      renderFnList();
      rebuild3d();
      draw2d();
    });
    card.querySelector('.fn-color').addEventListener('input', function (e) {
      fn.color = e.target.value;
      persist();
      rebuild3d();
      draw2d();
    });
    card.querySelector('.fn-op').addEventListener('input', function (e) {
      fn.opacity = parseFloat(e.target.value);
      persist();
      rebuild3d();
      draw2d();
    });
    var wire = card.querySelector('.fn-wire');
    if (wire) {
      wire.addEventListener('click', function () {
        state.view.wireframe = !state.view.wireframe;
        $('#wireframeChk').checked = state.view.wireframe;
        persist();
        rebuild3d();
      });
    }
    var consts = card.querySelectorAll('.fn-const');
    for (var k = 0; k < consts.length; k++) {
      (function (inp) {
        inp.addEventListener('change', function () {
          var v = parseFloat(inp.value);
          fn.constants[inp.getAttribute('data-sym')] = isFinite(v) ? v : 1;
          persist();
          rebuild3d();
          draw2d();
        });
      })(consts[k]);
    }
    return card;
  }

  function addFunction() {
    var inp = $('#addFnInput');
    var msg = $('#addMsg');
    var src = inp.value.trim();
    msg.textContent = '';
    if (!src) { msg.textContent = '请输入函数定义，如 z(x,y)=x^2+y^2'; return; }
    var fn = mkFn(src);
    if (fn.error) { msg.textContent = fn.error; return; }
    var arity = fnArity(fn);
    if (arity !== 1 && arity !== 2) { msg.textContent = '仅支持一元或二元函数'; return; }
    fn.color = PALETTE[state.functions.length % PALETTE.length];
    state.functions.push(fn);
    inp.value = '';
    persist();
    renderFnList();
    switchMode(arity === 2 ? '3d' : '2d');
    rebuild3d();
    draw2d();
  }

  /* ===================== UI：模式 / 范围 / 颜色 ===================== */

  function switchMode(mode) {
    state.view.mode = mode;
    $('#tab3d').classList.toggle('active', mode === '3d');
    $('#tab2d').classList.toggle('active', mode === '2d');
    $('#view3d').classList.toggle('hidden', mode !== '3d');
    $('#view2d').classList.toggle('hidden', mode !== '2d');
    $('#resetViewBtn').textContent = mode === '3d' ? '重置视角' : '重置范围';
    hideTooltip();
    if (mode === '3d') resize3d();
    draw2d();
    updateLegend();
    updateEmptyHint();
    persist();
  }

  function rebuildAll() {
    switchMode(state.view.mode);
    rebuild3d();
    draw2d();
  }

  function bindPair(idA, idB, apply) {
    var ea = $(idA), eb = $(idB);
    function handler() {
      var va = parseFloat(ea.value), vb = parseFloat(eb.value);
      if (!isFinite(va) || !isFinite(vb) || !(vb > va)) { syncUIFromState(); return; }
      apply([va, vb]);
      persist();
      rebuild3d();
      draw2d();
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
      if (state.view.mode === '3d') frame3d();
      else reset2dView();
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
      persist();
      rebuild3d();
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
      persist();
      draw2d();
      syncRangeInputs2d();
    });

    // 采样密度（防抖）
    var resTimer = null;
    $('#resRange').addEventListener('input', function (e) {
      state.view.res = parseInt(e.target.value, 10);
      $('#resVal').textContent = String(state.view.res);
      clearTimeout(resTimer);
      resTimer = setTimeout(function () { rebuild3d(); persist(); }, 150);
    });

    // 三维开关
    $('#wireframeChk').addEventListener('change', function (e) {
      state.view.wireframe = e.target.checked;
      persist();
      rebuild3d();
    });
    $('#gridChk').addEventListener('change', function (e) {
      state.view.showGrid = e.target.checked;
      persist();
      rebuild3d();
    });
    $('#ticksChk').addEventListener('change', function (e) {
      state.view.showTicks = e.target.checked;
      persist();
      rebuild3d();
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
          persist();
          if (grp === 'c3') rebuild3d();
          else draw2d();
        });
      })(colorBindings[i][0], colorBindings[i][1], colorBindings[i][2]);
    }

    // 计算
    $('#calcBtn').addEventListener('click', doCalc);
    $('#calcMark').addEventListener('click', markCalc);
    $('#calcClear').addEventListener('click', function () {
      markers3d.length = 0;
      markers2d.length = 0;
      renderMarkers3d();
      draw2d();
    });
    $('#calcFn').addEventListener('change', renderCalcInputs);

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
      writeHistoryList([]);
      renderHistory();
    });
  }

  function syncUIFromState() {
    var V = state.view;
    $('#resRange').value = String(V.res);
    $('#resVal').textContent = String(V.res);
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
      out.textContent = fn.core.name + ' = ' + fmt(y);
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
    var arity = fnArity(fn);
    if (arity === 2) {
      var z = evalFn(fn, vals);
      if (!isFinite(z)) { $('#calcOut').textContent = '该点无定义，未标注'; $('#calcOut').className = 'bad'; return; }
      markers3d.push({ fnId: fn.id, pos: [vals[0], vals[1], z], color: fn.color });
      switchMode('3d');
      renderMarkers3d();
    } else {
      var y = evalFn(fn, vals);
      if (!isFinite(y)) { $('#calcOut').textContent = '该点无定义，未标注'; $('#calcOut').className = 'bad'; return; }
      markers2d.push({ fnId: fn.id, x: vals[0], y: y, color: fn.color });
      switchMode('2d');
      draw2d();
    }
    $('#calcOut').textContent = '已在图中标注';
    $('#calcOut').className = 'ok';
  }

  /* ===================== 历史记录 UI ===================== */

  function renderHistory() {
    var box = $('#histList');
    var list = loadHistoryList();
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
          writeHistoryList(loadHistoryList().filter(function (x) { return x.id !== h.id; }));
          renderHistory();
        });
        box.appendChild(row);
      })(list[i]);
    }
  }

  /* ===================== 导出 ===================== */

  function exportPNG() {
    if (state.view.mode === '3d') {
      v3.renderer.render(v3.scene, v3.camera);
      var url = v3.renderer.domElement.toDataURL('image/png');
      downloadDataURL(url, '函数图像_三维_' + stamp() + '.png');
    } else {
      draw2d();
      var url2 = v2.canvas.toDataURL('image/png');
      downloadDataURL(url2, '函数图像_二维_' + stamp() + '.png');
    }
  }

  /* ===================== 主循环 / 启动 ===================== */

  function loop() {
    requestAnimationFrame(loop);
    if (state.view.mode !== '3d' || !v3.ready) return;
    v3.controls.update();
    if (v3.hoverDirty) {
      v3.hoverDirty = false;
      hover3d();
    }
    v3.renderer.render(v3.scene, v3.camera);
  }

  function init() {
    if (typeof THREE === 'undefined' || typeof math === 'undefined' || typeof FPlotCore === 'undefined') {
      document.body.innerHTML = '<p style="color:#e5484d;padding:20px">依赖库加载失败：请确认 lib/ 目录与 index.html 在一起。</p>';
      return;
    }
    if (!loadPersisted()) {
      state.functions = [
        mkFn('z(x,y)=sin(x)*cos(y)', '#ef5350'),
        mkFn('y(t)=sin(t)+t/5', '#4f8ef7'),
      ];
    }
    init3d();
    init2d();
    bindUI();
    syncUIFromState();
    rebuild3d();
    frame3d();
    draw2d();
    switchMode(state.view.mode);
    loop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
