/*
 * app.js — 应用主逻辑：三维视图、UI 编排、模板面板、参数动画、计算求值、历史、导出
 * 依赖全局：math、THREE、THREE.OrbitControls、FPlotCore、FPlotMarching、FPlot(state)、FPlotView2d、FPlotTemplates
 * 二维视图见 view2d.js；共享状态见 state.js。
 */
(function () {
  'use strict';

  var FPlot = window.FPlot;
  var V2 = window.FPlotView2d;
  var TPL = window.FPlotTemplates;

  /* 共享工具/状态的本地别名 */
  var $ = FPlot.$, fmt = FPlot.fmt, clamp = FPlot.clamp, linspace = FPlot.linspace,
      niceStep = FPlot.niceStep, escapeHtml = FPlot.escapeHtml, uid = FPlot.uid,
      stamp = FPlot.stamp, downloadDataURL = FPlot.downloadDataURL;
  var state = FPlot.state, markers2d = FPlot.markers2d, markers3d = FPlot.markers3d;
  var mkFn = FPlot.mkFn, recompile = FPlot.recompile, fnLabel = FPlot.fnLabel;
  var fnIsDrawable2d = FPlot.fnIsDrawable2d, fnIsDrawable3d = FPlot.fnIsDrawable3d;
  var evalFn = FPlot.evalFn, scopeFn = FPlot.scopeFn;

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

  function syncZInputs() {
    var V = state.view;
    var a = $('#zmin3'), b = $('#zmax3');
    if (document.activeElement !== a) a.value = fmt(V.z[0]);
    if (document.activeElement !== b) b.value = fmt(V.z[1]);
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
      syncZInputs();
    }

    buildAxes3d();
    renderMarkers3d();
    updateLegend();
    updateEmptyHint();
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
    if (fn && fn.core) {
      nx = fn.core.vars[0]; ny = fn.core.vars[1];
      nz = fn.core.name || (fn.kind === 'surface3dimplicit' ? 'f' : 'z');
    }
    showTooltip(v3.pointerPx.x, v3.pointerPx.y,
      nx + ' = ' + fmt(p.x) + '   ' + ny + ' = ' + fmt(p.y) + '   ' + nz + ' = ' + fmt(p.z));
  }

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
      if (hookDragging && geoState.draggingPoint) {
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

  function drawGeoPoint(ctx, wx, wy, color, x2px, y2px, selected) {
    var X = x2px(wx), Y = y2px(wy);
    ctx.beginPath();
    ctx.arc(X, Y, selected ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  function geoLabel(ctx, text, x, y, color) {
    ctx.fillStyle = color;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, x, y);
  }

  function drawGeo(ctx, x2px, y2px) {
    var set = geoSet();
    for (var i = 0; i < set.order.length; i++) {
      var o = G.getObject(set, set.order[i]);
      if (!o) continue;
      var sel = o.id === geoState.selected;
      if (o.type === 'point') {
        drawGeoPoint(ctx, o.x, o.y, o.color, x2px, y2px, sel);
        geoLabel(ctx, o.label, x2px(o.x) + 7, y2px(o.y) - 7, o.color);
      } else if (o.type === 'line') {
        var lp = G.lineProps(set, o);
        if (!lp) continue;
        ctx.strokeStyle = o.color;
        ctx.lineWidth = sel ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(x2px(lp.p1.x), y2px(lp.p1.y));
        ctx.lineTo(x2px(lp.p2.x), y2px(lp.p2.y));
        ctx.stroke();
        drawGeoPoint(ctx, lp.p1.x, lp.p1.y, o.color, x2px, y2px, false);
        drawGeoPoint(ctx, lp.p2.x, lp.p2.y, o.color, x2px, y2px, false);
        geoLabel(ctx, o.label, x2px(lp.mid.x) + 7, y2px(lp.mid.y) - 7, o.color);
      } else if (o.type === 'circle') {
        var cp = G.circleProps(set, o);
        if (!cp) continue;
        ctx.strokeStyle = o.color;
        ctx.lineWidth = sel ? 3 : 2;
        ctx.beginPath();
        ctx.arc(x2px(cp.center.x), y2px(cp.center.y),
          Math.abs(x2px(cp.center.x + cp.radius) - x2px(cp.center.x)), 0, Math.PI * 2);
        ctx.stroke();
        drawGeoPoint(ctx, cp.center.x, cp.center.y, o.color, x2px, y2px, false);
        drawGeoPoint(ctx, cp.rim.x, cp.rim.y, o.color, x2px, y2px, false);
        geoLabel(ctx, o.label, x2px(cp.center.x) + 7, y2px(cp.center.y) - 7, o.color);
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
        ctx.moveTo(x2px(first.x), y2px(first.y));
        ctx.lineTo(x2px(geoState.lastWorld.x), y2px(geoState.lastWorld.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
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
          rebuild3d();
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
      rebuild3d();
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
      rebuild3d();
      V2.draw();
    });
    card.querySelector('.fn-del').addEventListener('click', function () {
      state.functions = state.functions.filter(function (f) { return f.id !== fn.id; });
      var j;
      for (j = markers3d.length - 1; j >= 0; j--) if (markers3d[j].fnId === fn.id) markers3d.splice(j, 1);
      for (j = markers2d.length - 1; j >= 0; j--) if (markers2d[j].fnId === fn.id) markers2d.splice(j, 1);
      FPlot.persist();
      renderFnList();
      rebuild3d();
      V2.draw();
    });
    card.querySelector('.fn-color').addEventListener('input', function (e) {
      fn.color = e.target.value;
      FPlot.persist();
      rebuild3d();
      V2.draw();
    });
    card.querySelector('.fn-op').addEventListener('input', function (e) {
      fn.opacity = parseFloat(e.target.value);
      FPlot.persist();
      rebuild3d();
      V2.draw();
    });
    var wire = card.querySelector('.fn-wire');
    if (wire) {
      wire.addEventListener('click', function () {
        state.view.wireframe = !state.view.wireframe;
        $('#wireframeChk').checked = state.view.wireframe;
        FPlot.persist();
        rebuild3d();
      });
    }

    // 常数字母：数字框 + 滑杆 + 动画开关
    var rebuildTimer = null;
    function afterConstChange() {
      rebuild3d();
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
    rebuild3d();
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
    if (mode === '3d') resize3d();
    V2.draw();
    updateLegend();
    updateEmptyHint();
    FPlot.persist();
  }

  function rebuildAll() {
    switchMode(state.view.mode);
    rebuild3d();
    V2.draw();
  }

  function bindPair(idA, idB, apply) {
    var ea = $(idA), eb = $(idB);
    function handler() {
      var va = parseFloat(ea.value), vb = parseFloat(eb.value);
      if (!isFinite(va) || !isFinite(vb) || !(vb > va)) { syncUIFromState(); return; }
      apply([va, vb]);
      FPlot.persist();
      rebuild3d();
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
      if (state.view.mode === '3d') frame3d();
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
      resTimer = setTimeout(function () { rebuild3d(); FPlot.persist(); }, 150);
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
      rebuild3d();
    });
    $('#gridChk').addEventListener('change', function (e) {
      state.view.showGrid = e.target.checked;
      FPlot.persist();
      rebuild3d();
    });
    $('#ticksChk').addEventListener('change', function (e) {
      state.view.showTicks = e.target.checked;
      FPlot.persist();
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
          FPlot.persist();
          if (grp === 'c3') rebuild3d();
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
      renderMarkers3d();
      V2.draw();
    });
    $('#calcFn').addEventListener('change', renderCalcInputs);

    // 几何工具
    bindGeoTools();

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
    frame3d();
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
      renderMarkers3d();
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
      v3.renderer.render(v3.scene, v3.camera);
      var url = v3.renderer.domElement.toDataURL('image/png');
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

    // 参数动画推进（常数变化 → 重绘当前视图）
    if (FPlot.anim.count) {
      if (FPlot.animStep(dt)) {
        syncAnimInputs();
        animAccum += dt;
        if (state.view.mode === '3d') {
          if (animAccum >= 0.05) { animAccum = 0; rebuild3d(); }
        } else {
          V2.draw();
        }
      }
    }

    if (state.view.mode !== '3d' || !v3.ready) return;
    v3.controls.update();
    if (v3.hoverDirty) {
      v3.hoverDirty = false;
      hover3d();
    }
    v3.renderer.render(v3.scene, v3.camera);
  }

  function init() {
    if (typeof THREE === 'undefined' || typeof math === 'undefined' || typeof FPlotCore === 'undefined' || !FPlot || !V2) {
      document.body.innerHTML = '<p style="color:#e5484d;padding:20px">依赖库加载失败：请确认 lib/ 与 src/ 目录和 index.html 在一起。</p>';
      return;
    }
    // 二维视图回调
    V2.bindTooltipFns(showTooltip, hideTooltip);
    V2.hooks.pointerDown = GEO_HOOKS.pointerDown;
    V2.hooks.pointerMove = GEO_HOOKS.pointerMove;
    V2.hooks.pointerUp = GEO_HOOKS.pointerUp;
    V2.hooks.afterMarkers = function (ctx, x2px, y2px) { drawGeo(ctx, x2px, y2px); };
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
    init3d();
    V2.init();
    bindUI();
    renderTemplates();
    syncUIFromState();
    rebuild3d();
    frame3d();
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
