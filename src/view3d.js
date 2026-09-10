/*
 * view3d.js — 三维视图（three.js WebGL）
 * 显式曲面 z=f(x,y)：采样网格 + Lambert 光照；隐式曲面 f(x,y,z)=0：按列扫描 z 的高度场网格。
 * 支持线性（3×3）与非线性（x'/y'/z' 表达式）参考系变换：仅作用于坐标轴与网格（Follow Basis），
 * 编译结果缓存，逐帧仅求值（避免 mathflow 逐点重编译的性能问题）。
 */
(function (root) {
  'use strict';

  var FPlot = root.FPlot;
  var clamp = FPlot.clamp, fmt = FPlot.fmt, niceStep = FPlot.niceStep, linspace = FPlot.linspace;
  var state = FPlot.state, markers3d = FPlot.markers3d;
  var fnIsDrawable3d = FPlot.fnIsDrawable3d, scopeFn = FPlot.scopeFn;


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
  var list3d = state.functions.filter(fnIsDrawable3d);

  for (var fi = 0; fi < list3d.length; fi++) {
    var fn = list3d[fi];
    if (fn.kind === 'surface3dimplicit') { buildImplicit3dMesh(fn); continue; }
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
    addSurfaceMesh(fn, pos, idxOfGrid(n, valid), n);
  }

  // z 范围（自动，仅对显式曲面）
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
    } else if (!state.functions.some(function (f2) { return fnIsDrawable3d(f2) && f2.kind === 'surface3dimplicit'; })) {
      V.z = [-1, 1];
    }
    if (hooks.zRangeChanged) hooks.zRangeChanged();
  }

  buildAxes3d();
  renderMarkers3d();
  if (hooks.afterRebuild) hooks.afterRebuild();
}

function idxOfGrid(n, valid) {
  var idx = [];
  for (var iy = 0; iy < n; iy++) {
    for (var ix = 0; ix < n; ix++) {
      var a = iy * (n + 1) + ix;
      var b = a + 1;
      var c = a + (n + 1);
      var d = c + 1;
      if (valid[a] && valid[b] && valid[c]) idx.push(a, b, c);
      if (valid[b] && valid[c] && valid[d]) idx.push(b, d, c);
    }
  }
  return idx;
}

function addSurfaceMesh(fn, pos, idx, n) {
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

  if (state.view.wireframe) {
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
  void n;
}

/* 隐式曲面 f(x,y,z)=0：按列扫描 z 生成高度场网格（three.js 渲染） */
function buildImplicit3dMesh(fn) {
  var V = state.view;
  var n = clamp(Math.round(V.res) || 60, 10, 120);
  var zs = fn.core.vars;
  var scope = {};
  for (var k in fn.constants) scope[k] = fn.constants[k];
  var ev = fn.core.evaluate;
  function evalXYZ(x, y, z) {
    scope[zs[0]] = x; scope[zs[1]] = y; scope[zs[2]] = z;
    return ev(scope);
  }
  var mesh = window.FPlotMarching.implicit3dMesh(
    evalXYZ, V.x[0], V.x[1], V.y[0], V.y[1], V.z[0], V.z[1], Math.round(n / 1.5), 48);
  var pos32 = new Float32Array(mesh.positions.length);
  for (var i = 0; i < mesh.positions.length; i++) pos32[i] = mesh.positions[i];
  addSurfaceMesh(fn, pos32, mesh.indices, n);
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
    if (fnIsDrawable3d(state.functions[i])) return state.functions[i];
  }
  return null;
}

/* ---------- 参考系变换（M5）：linear 3×3 / nonlinear x',y',z'；编译缓存 ---------- */
var _tp3cache = { fx: null, fy: null, fz: null, cfx: null, cfy: null, cfz: null, scope: null };

function makeTp3d(T) {
  if (!T || T.mode === 'off') return null;
  if (T.mode === 'linear') {
    var m = T.m;
    return function (x, y, z) {
      return {
        x: m.a * x + m.b * y + m.c * z,
        y: m.d * x + m.e * y + m.f * z,
        z: m.g * x + m.h * y + m.i * z,
      };
    };
  }
  var F = root.FPlotCore, M = root.math;
  if (_tp3cache.fx !== T.fx) {
    _tp3cache.fx = T.fx; _tp3cache.cfx = null;
    try { _tp3cache.cfx = F.makeEvaluator(M.parse(T.fx)); } catch (e) { _tp3cache.cfx = null; }
  }
  if (_tp3cache.fy !== T.fy) {
    _tp3cache.fy = T.fy; _tp3cache.cfy = null;
    try { _tp3cache.cfy = F.makeEvaluator(M.parse(T.fy)); } catch (e2) { _tp3cache.cfy = null; }
  }
  if (_tp3cache.fz !== T.fz) {
    _tp3cache.fz = T.fz; _tp3cache.cfz = null;
    try { _tp3cache.cfz = F.makeEvaluator(M.parse(T.fz)); } catch (e3) { _tp3cache.cfz = null; }
  }
  if (!_tp3cache.cfx || !_tp3cache.cfy || !_tp3cache.cfz) return null;
  var scope = _tp3cache.scope || (_tp3cache.scope = {});
  return function (x, y, z) {
    scope.x = x; scope.y = y; scope.z = z; scope.t = T.t || 0;
    var nx = _tp3cache.cfx(scope), ny = _tp3cache.cfy(scope), nz = _tp3cache.cfz(scope);
    return {
      x: isFinite(nx) ? nx : x,
      y: isFinite(ny) ? ny : y,
      z: isFinite(nz) ? nz : z,
    };
  };
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
  var nameZ = fn0 ? (fn0.core.name || 'f') : 'z';

  var T3 = state.view.t3;
  var tp3 = makeTp3d(T3);
  var follow3 = !!(tp3 && T3.follow);
  function TV3(x, y, z) {
    if (!tp3 || !follow3) return new THREE.Vector3(x, y, z);
    var q = tp3(x, y, z);
    return new THREE.Vector3(q.x, q.y, q.z);
  }
  // 直线（世界两端点）→ 变换后折线（非线性时细分）
  function segPoints(xa, ya, za, xb, yb, zb, n) {
    var arr = [];
    for (var k = 0; k <= n; k++) {
      var u = k / n;
      var qx = xa + (xb - xa) * u, qy = ya + (yb - ya) * u, qz = za + (zb - za) * u;
      var v = TV3(qx, qy, qz);
      arr.push(v.x, v.y, v.z);
    }
    return arr;
  }

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
  // 变换后的锥体：沿切线方向摆放
  function addConeAlong(fromWorld, toWorld, color) {
    var p = TV3(toWorld[0], toWorld[1], toWorld[2]);
    var q = TV3(fromWorld[0], fromWorld[1], fromWorld[2]);
    var dir = new THREE.Vector3().subVectors(p, q);
    if (dir.lengthSq() < 1e-18) return;
    dir.normalize();
    var g = new THREE.ConeGeometry(diag * 0.012, diag * 0.04, 12);
    var m = new THREE.MeshBasicMaterial({ color: color });
    var mesh = new THREE.Mesh(g, m);
    mesh.position.copy(p);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    v3.groupAxes.add(mesh);
  }

  // 底面网格（follow 时为变换后的网格像）
  if (V.showGrid) {
    var sx = niceStep(spanX, 8), sy = niceStep(spanY, 8);
    var i, t;
    if (follow3) {
      var segN = (T3.mode === 'nonlinear') ? 12 : 1;
      var mats = [];
      i = Math.ceil((x0 - sx * 1e-6) / sx);
      for (; i * sx <= x1 + sx * 1e-6; i++) {
        t = i * sx;
        mats.push(segPoints(t, y0, z0, t, y1, z0, segN));
      }
      i = Math.ceil((y0 - sy * 1e-6) / sy);
      for (; i * sy <= y1 + sy * 1e-6; i++) {
        t = i * sy;
        mats.push(segPoints(x0, t, z0, x1, t, z0, segN));
      }
      for (var gi = 0; gi < mats.length; gi++) {
        addLine(new THREE.Vector3(mats[gi][0], mats[gi][1], mats[gi][2]),
          new THREE.Vector3(mats[gi][mats[gi].length - 3], mats[gi][mats[gi].length - 2], mats[gi][mats[gi].length - 1]),
          new THREE.Color(colGrid), 0.55);
      }
    } else {
      var pts = [];
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
  }

  // 三条轴线 + 箭头（follow 时为变换后的基向量像）
  if (follow3) {
    var segA = (T3.mode === 'nonlinear') ? 12 : 1;
    var xl = segPoints(x0, oy, oz, x1, oy, oz, segA);
    var yl = segPoints(ox, y0, oz, ox, y1, oz, segA);
    var zl = segPoints(ox, oy, z0, ox, oy, z1, segA);
    addLine(new THREE.Vector3(xl[0], xl[1], xl[2]),
      new THREE.Vector3(xl[xl.length - 3], xl[xl.length - 2], xl[xl.length - 1]), colAx, 1);
    addLine(new THREE.Vector3(yl[0], yl[1], yl[2]),
      new THREE.Vector3(yl[yl.length - 3], yl[yl.length - 2], yl[yl.length - 1]), colAy, 1);
    addLine(new THREE.Vector3(zl[0], zl[1], zl[2]),
      new THREE.Vector3(zl[zl.length - 3], zl[zl.length - 2], zl[zl.length - 1]), colAz, 1);
    addConeAlong([x1 - (x1 - x0) * 0.02, oy, oz], [x1, oy, oz], colAx);
    addConeAlong([ox, y1 - (y1 - y0) * 0.02, oz], [ox, y1, oz], colAy);
    addConeAlong([ox, oy, z1 - (z1 - z0) * 0.02], [ox, oy, z1], colAz);
  } else {
    addLine(new THREE.Vector3(x0, oy, oz), new THREE.Vector3(x1, oy, oz), colAx, 1);
    addLine(new THREE.Vector3(ox, y0, oz), new THREE.Vector3(ox, y1, oz), colAy, 1);
    addLine(new THREE.Vector3(ox, oy, z0), new THREE.Vector3(ox, oy, z1), colAz, 1);
    addCone(new THREE.Vector3(x1, oy, oz), 'x', colAx);
    addCone(new THREE.Vector3(ox, y1, oz), 'y', colAy);
    addCone(new THREE.Vector3(ox, oy, z1), 'z', colAz);
  }

  if (V.showTicks) {
    var i0, i1, tt;
    // 刻度短线与数字（follow 时贴着变换后的轴像）
    function tickMark(center, color) {
      var c = TV3(center[0], center[1], center[2]);
      var g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(c.x - tickLen, c.y, c.z),
        new THREE.Vector3(c.x + tickLen, c.y, c.z),
      ]);
      var m = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.9 });
      v3.groupAxes.add(new THREE.Line(g, m));
    }
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
      var P1 = (follow3 || tp3) ? TV3(tt, oy - tickLen * 4.2, oz) : new THREE.Vector3(tt, oy - tickLen * 4.2, oz);
      spr1.position.copy(P1);
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
      var P2 = (follow3 || tp3) ? TV3(ox - tickLen * 4.2, tt, oz) : new THREE.Vector3(ox - tickLen * 4.2, tt, oz);
      spr2.position.copy(P2);
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
      var P3 = (follow3 || tp3) ? TV3(ox - tickLen * 4.2, oy, tt) : new THREE.Vector3(ox - tickLen * 4.2, oy, tt);
      spr3.position.copy(P3);
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
  if (fn && fn.core) {
    nx = fn.core.vars[0]; ny = fn.core.vars[1];
    nz = fn.core.name || (fn.kind === 'surface3dimplicit' ? 'f' : 'z');
  }
  showTooltip(v3.pointerPx.x, v3.pointerPx.y,
    nx + ' = ' + fmt(p.x) + '   ' + ny + ' = ' + fmt(p.y) + '   ' + nz + ' = ' + fmt(p.z));
}

  var tooltips = { show: null, hide: null };
  var hooks = { afterRebuild: null, zRangeChanged: null };

  var api = {
    bindTooltipFns: function (show, hide) { tooltips.show = show; tooltips.hide = hide; },
    hooks: hooks,
    init: init3d,
    rebuild: rebuild3d,
    frame: frame3d,
    resize: resize3d,
    renderMarkers: renderMarkers3d,
    tick: tick3d,
    render: function () { if (v3.ready) v3.renderer.render(v3.scene, v3.camera); },
    getRenderer: function () { return v3.renderer; },
    isReady: function () { return v3.ready; },
  };

  root.FPlotView3d = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
