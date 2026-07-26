'use strict';
/* Tiderip web app: reads meta.json + forecast.bin(.gz), renders heat + wind arrows
   on Leaflet, with tap-to-inspect popup, per-location rip bar, threshold sliders. */

/* ---------------- state & persisted thresholds ---------------- */
const MPH2KT = 0.868976;
const state = {
  t: 0, playing: false, inspect: null,
  minWindMph: +(localStorage.getItem('tr_minWindMph') || 5),
  comfortMph: +(localStorage.getItem('tr_comfortMph') || 10),
  minCur: +(localStorage.getItem('tr_minCur') || 1.0),
  cone: +(localStorage.getItem('tr_cone') || 60),
  arrows: localStorage.getItem('tr_arrows') || 'wind',   // 'wind' | 'current' | 'off'
};
Object.defineProperty(state, 'minWind', {get() { return this.minWindMph * MPH2KT; }});   // kt
Object.defineProperty(state, 'comfortKt', {get() { return this.comfortMph * MPH2KT; }}); // kt
// the rip bar's home point when nothing is tapped
const HOME = {name: 'Boundary Pass', lat: 48.713, lon: -123.232};
let META = null, DATA = null;   // DATA: {mask:Uint8Array, hours:[{ws,wd,cu,cv}]}
let mapL, heatOverlay, arrowLayer, popup;

const PASSES = [
  ['Dodd Narrows', 49.137, -123.817], ['Gabriola Pass', 49.128, -123.700],
  ['Porlier Pass', 49.015, -123.585], ['Active Pass', 48.867, -123.290],
  ['Boundary Pass', 48.720, -123.060], ['Haro Strait', 48.560, -123.170],
  ['Sansum Narrows', 48.785, -123.555], ['San Juan Channel', 48.510, -122.950],
  ['Rosario Strait', 48.550, -122.750], ['Spieden Channel', 48.640, -123.150],
  ['Satellite Channel', 48.710, -123.490], ['Trincomali Channel', 48.930, -123.520],
];

/* ---------------- data loading ---------------- */
async function loadData() {
  const meta = await (await fetch('data/meta.json', {cache: 'no-cache'})).json();
  let buf;
  try {
    const r = await fetch('data/forecast.bin.gz', {cache: 'no-cache'});
    if (!r.ok) throw 0;
    if (typeof DecompressionStream !== 'undefined') {
      const ds = r.body.pipeThrough(new DecompressionStream('gzip'));
      buf = await new Response(ds).arrayBuffer();
    } else { throw 0; }
  } catch (_) {
    buf = await (await fetch('data/forecast.bin', {cache: 'no-cache'})).arrayBuffer();
  }
  const g = meta.grid, n = g.nx * g.ny, H = meta.hours.length;
  const bytes = new Uint8Array(buf);
  if (bytes.length < n * (1 + 4 * H)) throw new Error('forecast payload truncated');
  const mask = bytes.subarray(0, n);
  const hours = [];
  let off = n;
  for (let h = 0; h < H; h++) {
    hours.push({
      ws: bytes.subarray(off, off += n),
      wd: bytes.subarray(off, off += n),
      cu: new Int8Array(buf, off, n), cv: new Int8Array(buf, (off += n, off), n),
    });
    off += n;
  }
  META = meta; DATA = {mask, hours};
}

/* ---------------- sampling & score ---------------- */
function cellIdx(lat, lon) {
  const g = META.grid;
  const ix = Math.round((lon - g.lon0) / g.dlon), iy = Math.round((lat - g.lat0) / g.dlat);
  if (ix < 0 || ix >= g.nx || iy < 0 || iy >= g.ny) return -1;
  return iy * g.nx + ix;
}
function angDiff(a, b) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function sampleRaw(i, h) {
  const s = META.scales, d = DATA.hours[h];
  const wkt = d.ws[i] / s.wspd, wfrom = d.wd[i] * s.wdir;
  const u = d.cu[i] / s.cur, v = d.cv[i] / s.cur;
  const ckt = Math.hypot(u, v);
  const cdir = (90 - Math.atan2(v, u) * 180 / Math.PI + 360) % 360;
  return {wkt, wfrom, ckt, cdir};
}
function scoreAt(lat, lon, h) {
  const i = cellIdx(lat, lon);
  if (i < 0) return null;
  const r = sampleRaw(i, h);
  r.water = DATA.mask[i] === 1;
  r.align = angDiff(r.wfrom, r.cdir);
  r.raw = (r.water && r.align <= state.cone) ? r.wkt * r.ckt * Math.cos(r.align * Math.PI / 180) : 0;
  r.s = (r.raw > 0 && r.wkt >= state.minWind && r.ckt >= state.minCur) ? r.raw : 0;
  return r;
}
function scoreCell(i, h) {  // fast path for full-grid rendering
  if (DATA.mask[i] !== 1) return 0x7fffffff; // sentinel: land
  const r = sampleRaw(i, h);
  const align = angDiff(r.wfrom, r.cdir);
  if (align > state.cone) return 0;
  const raw = r.wkt * r.ckt * Math.cos(align * Math.PI / 180);
  return (r.wkt >= state.minWind && r.ckt >= state.minCur) ? raw : -raw; // negative = sub-threshold
}
function rampColor(s) {
  const lo = state.minWind * state.minCur, hi = Math.max(lo + 12, 30);
  const n = Math.max(0, Math.min(1, (s - lo) / (hi - lo)));
  const stops = [[242, 206, 78], [239, 154, 46], [222, 90, 30], [183, 30, 18]];
  const x = n * 3, i = Math.min(2, Math.floor(x)), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return [c[0], c[1], c[2], Math.round(255 * (0.55 + 0.38 * n))];
}
function windColor(wk) {   // wind above comfort threshold, no (gated) opposition
  const n = Math.max(0, Math.min(1, (wk - state.comfortKt) / Math.max(state.comfortKt, 1)));
  return [122, 60, 165, Math.round(255 * (0.28 + 0.42 * n))];
}
function subColor(raw) {
  const lo = Math.max(1, state.minWind * state.minCur);
  const n = Math.max(0, Math.min(1, raw / lo));
  return [30, 102, 116, Math.round(255 * (0.20 + 0.30 * n))];
}

/* ---------------- heat overlay (Mercator-correct, supersampled + bilinear) ---------------- */
const HEAT_ROWS = 1024, HEAT_XS = 3;   // render resolution >> grid resolution
let heatCanvas, rowMapF, fields;
function mercY(lat) { const r = lat * Math.PI / 180; return Math.log(Math.tan(Math.PI / 4 + r / 2)); }
function buildRowMap() {
  const g = META.grid;
  const latTop = g.lat0 + g.dlat * (g.ny - 1), latBot = g.lat0;
  const yT = mercY(latTop + g.dlat / 2), yB = mercY(latBot - g.dlat / 2);
  rowMapF = new Float32Array(HEAT_ROWS);
  for (let r = 0; r < HEAT_ROWS; r++) {
    const y = yT + (yB - yT) * (r + 0.5) / HEAT_ROWS;           // top row -> north
    const lat = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
    rowMapF[r] = (lat - g.lat0) / g.dlat;                        // fractional grid row
  }
}
function buildFields(h) {   // per-hour float fields for interpolation (NaN = land)
  const g = META.grid, n = g.nx * g.ny, s = META.scales, d = DATA.hours[h];
  if (!fields) fields = {w: new Float32Array(n), c: new Float32Array(n), r: new Float32Array(n)};
  for (let i = 0; i < n; i++) {
    if (DATA.mask[i] !== 1) { fields.r[i] = NaN; continue; }
    const wkt = d.ws[i] / s.wspd, u = d.cu[i] / s.cur, v = d.cv[i] / s.cur;
    const ckt = Math.hypot(u, v);
    const wfrom = d.wd[i] * s.wdir;
    const cdir = (90 - Math.atan2(v, u) * 180 / Math.PI + 360) % 360;
    const al = angDiff(wfrom, cdir);
    fields.w[i] = wkt; fields.c[i] = ckt;
    fields.r[i] = al <= state.cone ? wkt * ckt * Math.cos(al * Math.PI / 180) : 0;
  }
}
function renderHeat(h) {
  const g = META.grid, W = g.nx * HEAT_XS;
  if (!heatCanvas) {
    heatCanvas = document.createElement('canvas');
    heatCanvas.width = W; heatCanvas.height = HEAT_ROWS;
    buildRowMap();
  }
  buildFields(h);
  const Fw = fields.w, Fc = fields.c, Fr = fields.r, nx = g.nx, ny = g.ny;
  const ctx = heatCanvas.getContext('2d');
  const img = ctx.createImageData(W, HEAT_ROWS);
  const px = img.data;
  for (let r = 0; r < HEAT_ROWS; r++) {
    const gy = rowMapF[r];
    let iy0 = Math.floor(gy); const ty = gy - iy0;
    if (iy0 < 0) iy0 = 0; else if (iy0 > ny - 2) iy0 = ny - 2;
    const rowOff = r * W * 4, b0 = iy0 * nx, b1 = (iy0 + 1) * nx;
    for (let x = 0; x < W; x++) {
      const gx = (x + 0.5) / HEAT_XS - 0.5;
      let ix0 = Math.floor(gx); const tx = gx - ix0;
      if (ix0 < 0) ix0 = 0; else if (ix0 > nx - 2) ix0 = nx - 2;
      // bilinear over water corners only
      const i00 = b0 + ix0, i10 = i00 + 1, i01 = b1 + ix0, i11 = i01 + 1;
      let raw = 0, wk = 0, ck = 0, wsum = 0;
      let v0 = Fr[i00];
      if (v0 === v0) { const wgt = (1 - tx) * (1 - ty); raw += v0 * wgt; wk += Fw[i00] * wgt; ck += Fc[i00] * wgt; wsum += wgt; }
      v0 = Fr[i10];
      if (v0 === v0) { const wgt = tx * (1 - ty); raw += v0 * wgt; wk += Fw[i10] * wgt; ck += Fc[i10] * wgt; wsum += wgt; }
      v0 = Fr[i01];
      if (v0 === v0) { const wgt = (1 - tx) * ty; raw += v0 * wgt; wk += Fw[i01] * wgt; ck += Fc[i01] * wgt; wsum += wgt; }
      v0 = Fr[i11];
      if (v0 === v0) { const wgt = tx * ty; raw += v0 * wgt; wk += Fw[i11] * wgt; ck += Fc[i11] * wgt; wsum += wgt; }
      if (wsum < 0.05) continue;                     // all-land neighbourhood
      raw /= wsum; wk /= wsum; ck /= wsum;
      let c;
      if (raw >= 0.3 && wk >= state.minWind && ck >= state.minCur) c = rampColor(raw);
      else if (wk >= state.comfortKt) c = windColor(wk);           // rough even without opposition
      else if (raw >= 0.3) c = subColor(raw);
      else continue;
      const o = rowOff + x * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  const bounds = [[g.lat0 - g.dlat / 2, g.lon0 - g.dlon / 2],
                  [g.lat0 + g.dlat * (g.ny - 0.5), g.lon0 + g.dlon * (g.nx - 0.5)]];
  const url = heatCanvas.toDataURL();
  if (!heatOverlay) {
    heatOverlay = L.imageOverlay(url, bounds, {opacity: 1, interactive: false, className: 'heat'}).addTo(mapL);
    heatOverlay.getElement()?.style.setProperty('image-rendering', 'auto');
  } else heatOverlay.setUrl(url);
}

/* ---------------- wind arrow layer (screen-density constant) ---------------- */
const ArrowLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide');
    this._canvas.style.pointerEvents = 'none';
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on('moveend zoomend resize', this._redraw, this);
    this._redraw();
  },
  onRemove(map) {
    map.getPanes().overlayPane.removeChild(this._canvas);
    map.off('moveend zoomend resize', this._redraw, this);
  },
  _redraw() {
    if (!DATA) return;
    const map = this._map, size = map.getSize(), dpr = window.devicePixelRatio || 1;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.width = size.x * dpr; this._canvas.height = size.y * dpr;
    this._canvas.style.width = size.x + 'px'; this._canvas.style.height = size.y + 'px';
    const ctx = this._canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    if (state.arrows === 'off') return;
    const mode = state.arrows;
    const SP = 76;
    const arrow = (x, y, toDeg, len, stroke, lw) => {
      const t = (90 - toDeg) * Math.PI / 180;
      const dx = Math.cos(t), dy = -Math.sin(t);
      const x1 = x + dx * len, y1 = y + dy * len;
      ctx.strokeStyle = stroke; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x1, y1); ctx.stroke();
      const hA = t + 2.6, hB = t - 2.6, hl = Math.min(9, 3.5 + len / 5);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x1 + Math.cos(hA) * hl, y1 - Math.sin(hA) * hl);
      ctx.moveTo(x1, y1); ctx.lineTo(x1 + Math.cos(hB) * hl, y1 - Math.sin(hB) * hl);
      ctx.stroke();
    };
    for (let x = SP / 2; x < size.x; x += SP) {
      for (let y = SP / 2; y < size.y; y += SP) {
        const ll = map.containerPointToLatLng([x, y]);
        const i = cellIdx(ll.lat, ll.lng);
        if (i < 0) continue;
        const r = sampleRaw(i, state.t);
        const water = DATA.mask[i] === 1;
        const doWind = mode === 'wind' || mode === 'both';
        const doCur = (mode === 'current' || mode === 'both') && water && r.ckt >= 0.1;
        if (!doWind && !doCur) continue;
        if (doCur)
          arrow(x, y, r.cdir, Math.min(34, 4 + r.ckt * 5),
                `rgba(14,110,140,${0.5 + Math.min(0.4, r.ckt / 7)})`, 1.2 + Math.min(1.8, r.ckt / 3));
        if (doWind)
          arrow(x, y, r.wfrom + 180, Math.min(34, 4 + r.wkt * 1.3),
                `rgba(22,50,62,${0.35 + Math.min(0.4, r.wkt / 45)})`, 1 + Math.min(1.6, r.wkt / 14));
      }
    }
  },
  refresh() { this._redraw(); },
});

/* ---------------- popup ---------------- */
const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const compass = d => COMPASS[Math.round(d / 22.5) % 16];
function popupHtml(lat, lon) {
  const r = scoreAt(lat, lon, state.t);
  if (!r) return 'Outside forecast region';
  if (!r.water) return `<span class="mono">${lat.toFixed(3)}, ${lon.toFixed(3)}</span><br>No current data here (land or outside the ocean model).`;
  let cls = 'ok', txt = 'No opposition here';
  if (r.s > 0) { cls = 'bad'; txt = 'WIND AGAINST CURRENT'; }
  else if (r.raw > 0) { cls = 'sub'; txt = 'Opposed, below your thresholds'; }
  return `<span class="mono" style="color:var(--ink-soft)">${lat.toFixed(3)}, ${lon.toFixed(3)}</span>
    <table class="pop-table">
      <tr><td>Wind</td><td class="mono">${r.wkt.toFixed(1)} kt (${(r.wkt / MPH2KT).toFixed(0)} mph) from ${compass(r.wfrom)}</td></tr>
      <tr><td>Current</td><td class="mono">${r.ckt.toFixed(1)} kt toward ${compass(r.cdir)}</td></tr>
      <tr><td>Opposition angle</td><td class="mono">${r.align.toFixed(0)}°</td></tr>
      <tr><td><b>Opposition score</b></td><td class="mono"><b>${r.raw > 0 ? r.raw.toFixed(1) : '0'}</b></td></tr>
    </table>
    <div class="pop-flag ${cls}">${txt}</div>`;
}
function openInspect(lat, lon) {
  state.inspect = {lat, lon};
  popup = L.popup({maxWidth: 240, autoPan: true, closeOnClick: false})
    .setLatLng([lat, lon]).setContent(popupHtml(lat, lon)).openOn(mapL);
  document.getElementById('ripMode').textContent = `@ ${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  document.getElementById('ripReset').style.display = 'inline-block';
  drawRip();
}
function closeInspect() {
  state.inspect = null;
  if (popup) mapL.closePopup(popup);
  document.getElementById('ripMode').textContent = HOME.name;
  document.getElementById('ripReset').style.display = 'none';
  drawRip();
}

/* ---------------- rip bar ---------------- */
const rip = document.getElementById('ripbar'), rctx = rip.getContext('2d');
function drawRip() {
  const wrap = rip.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  rip.width = wrap.width * dpr; rip.height = wrap.height * dpr;
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = wrap.width, hgt = wrap.height, H = META.hours.length, seg = w / H;
  rctx.clearRect(0, 0, w, hgt);
  const loc = state.inspect || HOME;
  const bars = [];
  for (let h = 0; h < H; h++) {
    const q = scoreAt(loc.lat, loc.lon, h);
    bars.push(q && q.water ? {v: q.raw, g: q.s > 0} : {v: 0, g: false});
  }
  const top = Math.max(30, ...bars.map(b => b.v));
  for (let h = 0; h < H; h++) {
    const local = new Date(META.hours[h]);
    const hr = local.getHours();
    if (hr < 6 || hr >= 21) { rctx.fillStyle = 'rgba(22,50,62,.18)'; rctx.fillRect(h * seg, 0, seg, hgt); }
    if (bars[h].v > 0) {
      const bh = Math.max(3, bars[h].v / top * (hgt - 8));
      if (bars[h].g) { const c = rampColor(bars[h].v); rctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},.95)`; }
      else rctx.fillStyle = 'rgba(70,120,130,.55)';
      rctx.fillRect(h * seg + 1, hgt - bh - 2, Math.max(1, seg - 2), bh);
    }
  }
  rctx.fillStyle = '#B01E6E';
  rctx.fillRect(state.t * seg, 0, 2.5, hgt);
  // date labels at day boundaries (and at the start)
  rctx.font = '9px ui-monospace, Menlo, monospace';
  for (let h = 0; h < H; h++) {
    const d = new Date(META.hours[h]);
    if (h === 0 || d.getHours() === 0) {
      if (h > 0) { rctx.fillStyle = 'rgba(22,50,62,.5)'; rctx.fillRect(h * seg, 0, 1, hgt); }
      rctx.fillStyle = 'rgba(22,50,62,.85)';
      rctx.fillText(d.toLocaleDateString([], {weekday: 'short', day: 'numeric'}), h * seg + 4, 10);
    }
  }
}

/* ---------------- readouts ---------------- */
const fmtHour = iso => new Date(iso).toLocaleString([], {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
function updateReadouts() {
  document.getElementById('timeLabel').innerHTML =
    `<b class="mono">${fmtHour(META.hours[state.t])}</b> <span class="mono" style="color:var(--ink-soft)">(T+${state.t}h)</span>`;
  const list = PASSES.map(([name, la, lo]) => ({name, r: scoreAt(la, lo, state.t)}))
    .filter(x => x.r).sort((a, b) => b.r.s - a.r.s).slice(0, 6);
  document.getElementById('hotspots').innerHTML = list.map(x =>
    x.r.s <= 0
      ? `<div><span>${x.name}</span><span class="score calm mono">—</span></div>`
      : `<div><span>${x.name}</span><span class="score mono" style="color:${x.r.s >= 22 ? 'var(--warn4)' : x.r.s >= 14 ? 'var(--warn3)' : 'var(--warn2)'}">${x.r.s.toFixed(0)}</span></div>`
  ).join('');
  const lo = state.minWind * state.minCur;
  document.getElementById('lgMin').textContent = lo.toFixed(0);
  document.getElementById('lgMid').textContent = ((lo + Math.max(lo + 12, 30)) / 2).toFixed(0);
  document.getElementById('lgMax').textContent = Math.max(lo + 12, 30).toFixed(0) + '+';
  if (state.inspect && popup) popup.setContent(popupHtml(state.inspect.lat, state.inspect.lon));
}
function refreshAll() { renderHeat(state.t); arrowLayer.refresh(); drawRip(); updateReadouts(); }

/* ---------------- init ---------------- */
async function init() {
  try { await loadData(); }
  catch (e) {
    document.getElementById('loading').textContent =
      'Could not load the forecast. If this is a fresh deployment, run the build-forecast workflow once. (' + e.message + ')';
    return;
  }
  document.getElementById('loading').remove();

  // freshness banner
  const genMs = Date.parse(META.generated), ageH = (Date.now() - genMs) / 3.6e6;
  document.getElementById('genLabel').textContent = 'data ' + new Date(genMs).toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'});
  if (ageH > 12) {
    const b = document.getElementById('staleBanner');
    b.style.display = 'block';
    b.textContent = `⚠ Forecast data is ${ageH.toFixed(0)} h old — you may be offline or the build failed. Treat with caution.`;
  }
  // start at the current hour
  const nowIdx = META.hours.findIndex(hh => Date.parse(hh) >= Date.now() - 30 * 60e3);
  state.t = Math.max(0, nowIdx);

  const g = META.grid;
  mapL = L.map('leafmap', {zoomSnap: 0.5, minZoom: 8, maxZoom: 14})
    .fitBounds([[g.lat0, g.lon0], [g.lat0 + g.dlat * g.ny, g.lon0 + g.dlon * g.nx]]);
  const positron = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap · © CARTO · OpenSeaMap',
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(mapL);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap · OpenSeaMap',
  });
  mapL.attributionControl.setPrefix(false);
  // OpenSeaMap seamark overlay: buoys, beacons, lights. Crowd-sourced —
  // orientation aid only, not a navigation chart.
  const seamarks = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    {maxZoom: 18, opacity: 0.9});
  seamarks.addTo(mapL);
  L.control.layers(
    {'Simple (CARTO)': positron, 'Detailed (OSM)': osm},
    {'Seamarks (OpenSeaMap)': seamarks},
    {position: 'bottomright'}
  ).addTo(mapL);
  // mute only the busy OSM tiles; Positron needs no filter
  mapL.on('baselayerchange', e =>
    document.documentElement.classList.toggle('mute-tiles', /OSM/.test(e.name)));
  arrowLayer = new ArrowLayer(); mapL.addLayer(arrowLayer);

  // data-region outline + fade everything outside it
  const b0 = [g.lat0 - g.dlat / 2, g.lon0 - g.dlon / 2];
  const b1 = [g.lat0 + g.dlat * (g.ny - 0.5), g.lon0 + g.dlon * (g.nx - 0.5)];
  L.polygon([
    [[-85, -360], [85, -360], [85, 360], [-85, 360]],                 // world
    [[b0[0], b0[1]], [b0[0], b1[1]], [b1[0], b1[1]], [b1[0], b0[1]]], // hole = our region
  ], {stroke: false, fillColor: '#16323E', fillOpacity: 0.28, interactive: false}).addTo(mapL);
  L.rectangle([b0, b1], {color: '#B01E6E', weight: 1.5, dashArray: '6 4', fill: false, interactive: false}).addTo(mapL);

  mapL.on('click', e => openInspect(e.latlng.lat, e.latlng.lng));
  mapL.on('popupclose', () => { if (state.inspect) closeInspect(); });

  document.getElementById('sources').innerHTML =
    `${META.sources.currents}<br>${META.sources.wind}<br>Generated ${META.generated}`;

  // controls
  const bind = (id, out, key, fmt) => {
    const el = document.getElementById(id);
    el.value = state[key];
    document.getElementById(out).textContent = fmt(el.value);
    el.addEventListener('input', () => {
      state[key] = parseFloat(el.value);
      localStorage.setItem('tr_' + key, el.value);
      document.getElementById(out).textContent = fmt(el.value);
      refreshAll();
    });
  };
  bind('minWind', 'minWindOut', 'minWindMph', v => `${v} mph`);
  bind('comfort', 'comfortOut', 'comfortMph', v => `${v} mph`);
  bind('minCur', 'minCurOut', 'minCur', v => `${(+v).toFixed(1)} kt`);
  bind('cone', 'coneOut', 'cone', v => `±${v}°`);
  document.getElementById('panelHead').addEventListener('click', () => {
    const p = document.getElementById('panel');
    p.classList.toggle('collapsed');
    document.getElementById('panelHead').textContent =
      p.classList.contains('collapsed') ? '⚙' : '⚙ Settings';
  });
  document.getElementById('ripReset').addEventListener('click', closeInspect);

  // arrow overlay mode: wind / current / off
  const arrowBtns = document.querySelectorAll('#arrowCtl button');
  const setArrowMode = mode => {
    state.arrows = mode;
    localStorage.setItem('tr_arrows', mode);
    arrowBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    arrowLayer.refresh();
  };
  arrowBtns.forEach(b => b.addEventListener('click', () => setArrowMode(b.dataset.mode)));
  setArrowMode(state.arrows);

  const ripWrap = document.getElementById('ripbarWrap');
  const scrub = e => {
    const r = ripWrap.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    state.t = Math.max(0, Math.min(META.hours.length - 1, Math.round(x / r.width * META.hours.length)));
    refreshAll();
  };
  let scrubbing = false;
  ripWrap.addEventListener('pointerdown', e => { scrubbing = true; scrub(e); ripWrap.setPointerCapture(e.pointerId); });
  ripWrap.addEventListener('pointermove', e => { if (scrubbing) scrub(e); });
  ripWrap.addEventListener('pointerup', () => scrubbing = false);

  let timer = null;
  document.getElementById('playBtn').addEventListener('click', function () {
    state.playing = !state.playing;
    this.textContent = state.playing ? '⏸' : '▶';
    if (state.playing) timer = setInterval(() => { state.t = (state.t + 1) % META.hours.length; refreshAll(); }, 450);
    else clearInterval(timer);
  });
  window.addEventListener('resize', drawRip);

  refreshAll();
}
init();

/* offline shell + data caching */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
