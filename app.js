// 24-hour playback of recorded TfNSW vehicle positions from static files:
//   data/index.json            day bounds and the windows that have data
//   data/w/<start>.json.gz     one compact gzip file per 10-minute window
// Vehicles are interpolated between reports and drawn with deck.gl on a MapLibre map.
"use strict";

const $ = (id) => document.getElementById(id);
const GROUPS = [
  ["buses", "Buses", (f) => f === "buses", true],
  ["sydneytrains", "Trains", (f) => f === "sydneytrains", true],
  ["metro", "Metro", (f) => f === "metro", true],
  ["nswtrains", "TrainLink", (f) => f === "nswtrains", false],
  ["ferries", "Ferries", (f) => f.startsWith("ferries"), true],
  ["lightrail", "Light rail", (f) => f.startsWith("lightrail"), true],
  ["regionbuses", "Regional buses", (f) => f.startsWith("regionbuses"), false],
];
const MODE_COLOURS = { buses: [0, 112, 210], sydneytrains: [242, 133, 0], metro: [22, 128, 128], nswtrains: [217, 75, 35],
                       ferries: [0, 150, 70], lightrail: [196, 30, 58], regionbuses: [120, 80, 180] };
// HIDE_AFTER_S: a vehicle with no report for this long (trip ended) is no longer drawn.
// APPEAR_BEFORE_S: a vehicle is drawn from this long before its first report.
const HIDE_AFTER_S = 150, APPEAR_BEFORE_S = 30, MAX_GAP_S = 180, TRAIL_S = 90;
const KEEP_BEHIND_S = 1800, MAX_IN_FLIGHT = 3;

const groupOf = (feed) => (GROUPS.find(([, , match]) => match(feed)) || ["buses"])[0];
const shortRoute = (route) => route.includes("_") ? route.slice(route.lastIndexOf("_") + 1) : route;

// vehicles: "feed|vehicle|route" -> {feed, group, vid, route, label, reports: [[ts, lon, lat, bearing, speed]] sorted}
const play = { vehicles: new Map(), version: 0, windows: new Map(), t: 0, playing: false, base: 0 };
let day = null;  // data/index.json

function lowerBound(rs, t) {  // first index with ts >= t
  let lo = 0, hi = rs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rs[mid][0] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function addReport(feed, vid, route, rep) {
  const key = feed + "|" + vid + "|" + route;
  let v = play.vehicles.get(key);
  if (!v) play.vehicles.set(key, v = { feed, group: groupOf(feed), vid, route, label: shortRoute(route), reports: [] });
  const rs = v.reports;
  if (!rs.length || rep[0] > rs[rs.length - 1][0]) { rs.push(rep); return; }
  const i = lowerBound(rs, rep[0]);
  if (rs[i] && rs[i][0] === rep[0]) return;
  rs.splice(i, 0, rep);  // windows arrive in any order
}

// --- data files ------------------------------------------------------------------
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  // .gz files are served as application/gzip; decompress here unless a CDN already did.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
/** Add a compact window (see recorder/static_export.py) to the vehicle store; returns report count. */
function addWindow(w) {
  let i = 0;
  w.vehicles.forEach(([fi, vid, route], k) => {
    const feed = w.feeds[fi];
    let t = w.start, x = 0, y = 0;
    for (let j = 0; j < w.n[k]; j++, i++) {
      t += w.t[i]; x += w.x[i]; y += w.y[i];
      addReport(feed, vid, route, [t, x / 1e5, y / 1e5, w.b[i] < 0 ? null : w.b[i], w.s[i] < 0 ? null : w.s[i] / 10]);
    }
  });
  return i;
}

const WINDOW_S = 600;
const windowOf = (t) => Math.floor(t / WINDOW_S) * WINDOW_S;
const lookahead = () => Math.max(WINDOW_S, Number($("speed").value) * 45);
const hasData = (w) => day && Object.prototype.hasOwnProperty.call(day.windows, String(w));
let inFlight = 0;

function ensureWindows() {
  const first = Math.max(day.start, windowOf(play.t) - WINDOW_S);
  const last = Math.min(day.end - WINDOW_S, windowOf(play.t + lookahead()));
  const wanted = [];
  for (let w = first; w <= last; w += WINDOW_S) wanted.push(w);
  wanted.sort((a, b) => Math.abs(a - play.t) - Math.abs(b - play.t));  // nearest first
  for (const w of wanted) {
    const s = play.windows.get(w);
    if (s && (s.state !== "error" || Date.now() - s.at < 15000)) continue;
    if (!hasData(w)) { play.windows.set(w, { state: "empty" }); continue; }
    if (inFlight >= MAX_IN_FLIGHT) return;
    loadWindow(w);
  }
}
async function loadWindow(w) {
  play.windows.set(w, { state: "loading" });
  inFlight++;
  try {
    const data = await fetchJson(`data/w/${w}.json.gz`);
    if (!play.windows.has(w)) return;  // pruned meanwhile
    addWindow(data);
    play.windows.set(w, { state: "loaded" });
    play.version++;
  } catch (e) {
    play.windows.set(w, { state: "error", at: Date.now(), error: String(e) });
  } finally {
    inFlight--;
  }
}
function prune() {
  const lo = play.t - KEEP_BEHIND_S, hi = play.t + lookahead() + WINDOW_S * 2;
  for (const w of play.windows.keys()) if (w + WINDOW_S < lo || w > hi) play.windows.delete(w);
  for (const [k, v] of play.vehicles) {
    v.reports = v.reports.filter((r) => r[0] >= lo - 300 && r[0] <= hi + 300);
    if (!v.reports.length) play.vehicles.delete(k);
  }
  play.version++;
}
const ready = (w) => w < day.start || (play.windows.get(w) && play.windows.get(w).state !== "loading");

// --- colours ---------------------------------------------------------------
function hashColour(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360, sat = 0.7, light = 0.45;  // HSL -> RGB
  const k = (n) => (n + hue / 30) % 12, a = sat * Math.min(light, 1 - light);
  const f = (n) => Math.round(255 * (light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}
function speedColour(mps) {
  if (mps == null) return [140, 140, 140];
  const t = Math.min(1, mps / 15);  // 0 km/h red -> 54 km/h green
  return [Math.round(220 * (1 - t) + 30 * t), Math.round(50 * (1 - t) + 160 * t), 60];
}
const routeColours = new Map();
function colourFor(v, by, speed) {
  if (by === "speed") return speedColour(speed);
  if (by === "mode") return MODE_COLOURS[v.group];
  if (!routeColours.has(v.route)) routeColours.set(v.route, hashColour(v.route));
  return routeColours.get(v.route);
}

// --- interpolation -----------------------------------------------------------
const toRad = Math.PI / 180;
function headingDeg(lon0, lat0, lon1, lat1) {
  const y = Math.sin((lon1 - lon0) * toRad) * Math.cos(lat1 * toRad);
  const x = Math.cos(lat0 * toRad) * Math.sin(lat1 * toRad) - Math.sin(lat0 * toRad) * Math.cos(lat1 * toRad) * Math.cos((lon1 - lon0) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}
const metres = (lon0, lat0, lon1, lat1) =>
  Math.hypot((lon1 - lon0) * 111320 * Math.cos(lat0 * toRad), (lat1 - lat0) * 110540);

/** [lon, lat, heading, speed, lastReportTs] of vehicle *v* at time *t*, or null when it isn't on the road then. */
function positionAt(v, t) {
  const rs = v.reports;
  if (!rs.length || t < rs[0][0] - APPEAR_BEFORE_S) return null;
  const i = lowerBound(rs, t + 1e-6) - 1;  // last report at or before t
  if (i < 0) return [rs[0][1], rs[0][2], rs[0][3], rs[0][4], rs[0][0]];
  const a = rs[i], b = rs[i + 1];
  if (t - a[0] > HIDE_AFTER_S && (!b || b[0] - a[0] > MAX_GAP_S)) return null;
  if (!b || b[0] - a[0] > MAX_GAP_S) return [a[1], a[2], a[3], a[4], a[0]];
  const f = (t - a[0]) / (b[0] - a[0]);
  const moved = metres(a[1], a[2], b[1], b[2]) > 5;
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f,
          moved ? headingDeg(a[1], a[2], b[1], b[2]) : (b[3] ?? a[3]), b[4], a[0]];
}

// --- Sydney time -------------------------------------------------------------------
const SYD = "Australia/Sydney";
const clockFmt = new Intl.DateTimeFormat("en-AU", { timeZone: SYD, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("en-AU", { timeZone: SYD, weekday: "long", day: "numeric", month: "long", year: "numeric" });
const hhmm = (epoch) => clockFmt.format(new Date(epoch * 1000)).slice(0, 5);

// --- filters -----------------------------------------------------------------
$("feeds").innerHTML = GROUPS.map(([g, name, , on]) =>
  `<label><input type="checkbox" value="${g}" ${on ? "checked" : ""}> ${name}</label>`).join("");
let enabledGroups, routeFilter;
function readFilters() {
  enabledGroups = new Set([...document.querySelectorAll("#feeds input:checked")].map((i) => i.value));
  const routes = $("routes").value.split(/[\s,]+/).filter(Boolean).map((s) => s.toUpperCase());
  routeFilter = routes.length ? new Set(routes) : null;
  play.version++;
}
document.querySelectorAll("#feeds input, #routes").forEach((el) => el.addEventListener("input", readFilters));
readFilters();
const visible = (v) => enabledGroups.has(v.group) && (!routeFilter || routeFilter.has(v.label.toUpperCase()) || routeFilter.has(v.route.toUpperCase()));

// --- map ---------------------------------------------------------------------
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const map = new maplibregl.Map({
  container: "map",
  style: `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`,
  center: [151.05, -33.85], zoom: 10.3, maxZoom: 19, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
map.addControl(new maplibregl.ScaleControl(), "bottom-left");

const ARROW = {
  url: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
    '<path d="M32 4 L54 56 L32 44 L10 56 Z" fill="#fff"/></svg>'),
  width: 64, height: 64, anchorY: 32, mask: true,
};
const overlay = new deck.MapboxOverlay({
  interleaved: true,
  getTooltip: ({ object: d }) => d && {
    html: `<b>${d.v.group === "buses" ? "Route" : ""} ${d.v.label || "—"}</b> <span style="opacity:.7">${d.v.feed}</span><br>` +
          `${d.speed == null ? "" : `${Math.round(d.speed * 3.6)} km/h · `}report ${clockFmt.format(new Date(d.ts * 1000))}`,
    style: { fontSize: "12px", padding: "6px 8px" },
  },
});
map.addControl(overlay);

const trails = { version: -1, base: 0, data: [] };
function trailData(base) {
  if (trails.version !== play.version || trails.base !== base) {
    trails.data = [];
    for (const v of play.vehicles.values()) {
      if (v.reports.length < 2 || !visible(v)) continue;
      trails.data.push({ v, path: v.reports.map((r) => [r[1], r[2]]), times: v.reports.map((r) => r[0] - base) });
    }
    Object.assign(trails, { version: play.version, base });
  }
  return trails.data;
}

function render(t, base) {
  const by = $("colour").value, zoom = map.getZoom();
  const points = [];
  for (const v of play.vehicles.values()) {
    if (!visible(v)) continue;
    const p = positionAt(v, t);
    if (p) points.push({ v, position: [p[0], p[1]], angle: p[2] ?? 0, speed: p[3], ts: p[4], colour: colourFor(v, by, p[3]) });
  }
  const arrows = zoom >= 13.5;
  overlay.setProps({
    layers: [
      new deck.TripsLayer({
        id: "trails", data: trailData(base), visible: $("trails").checked,
        getPath: (d) => d.path, getTimestamps: (d) => d.times,
        getColor: (d) => colourFor(d.v, by === "speed" ? "route" : by),
        currentTime: t - base, trailLength: TRAIL_S, fadeTrail: true,
        widthUnits: "pixels", getWidth: 3, opacity: 0.45, capRounded: true, jointRounded: true,
        updateTriggers: { getColor: [by] },
      }),
      new deck.ScatterplotLayer({
        id: "dots", data: points, visible: !arrows, pickable: true,
        getPosition: (d) => d.position, getFillColor: (d) => d.colour,
        radiusUnits: "pixels", getRadius: zoom < 11 ? 2.5 : 4,
        stroked: true, getLineColor: [255, 255, 255, 200], lineWidthUnits: "pixels", getLineWidth: 0.75,
      }),
      new deck.IconLayer({
        id: "arrows", data: points, visible: arrows, pickable: true,
        getPosition: (d) => d.position, getIcon: () => ARROW, getColor: (d) => d.colour,
        getAngle: (d) => -d.angle, sizeUnits: "pixels", getSize: zoom >= 16 ? 26 : 18,
      }),
      new deck.TextLayer({
        id: "labels", data: points, visible: zoom >= 15,
        getPosition: (d) => d.position, getText: (d) => d.v.label, getSize: 11,
        getPixelOffset: [0, -18], getColor: dark ? [240, 240, 240] : [30, 30, 30],
        fontWeight: 600, outlineWidth: 3, outlineColor: dark ? [0, 0, 0, 200] : [255, 255, 255, 220],
        fontSettings: { sdf: true },
      }),
    ],
  });
  return points.length;
}

// --- controls ------------------------------------------------------------------
function seek(t) {
  const far = Math.abs(t - play.t) > KEEP_BEHIND_S;
  play.t = Math.max(day.start, Math.min(t, day.end - 1));
  if (far) { play.vehicles.clear(); play.windows.clear(); }
  play.base = windowOf(play.t) - 3600;  // keeps TripsLayer timestamps small (float32)
  syncInputs();
  ensureWindows();
  play.version++;
}
function syncInputs() {
  $("clock").textContent = clockFmt.format(new Date(play.t * 1000));
  if (document.activeElement !== $("slider")) $("slider").value = Math.round(play.t - day.start);
  const hm = hhmm(play.t);
  if (document.activeElement !== $("time") && $("time").value !== hm) $("time").value = hm;
}
function setPlaying(on) {
  play.playing = on;
  $("playBtn").textContent = on ? "⏸" : "▶";
}
$("playBtn").addEventListener("click", () => {
  if (!play.playing && play.t >= day.end - 1) seek(day.start);  // replay from the start
  setPlaying(!play.playing);
});
$("slider").addEventListener("input", () => seek(day.start + Number($("slider").value)));
$("time").addEventListener("change", () => {
  if (!$("time").value) return;
  const [h, m] = $("time").value.split(":").map(Number);
  seek(day.start + h * 3600 + m * 60);  // day.start is local midnight (an hour off after a DST change)
});
$("speed").addEventListener("change", ensureWindows);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !["INPUT", "SELECT", "BUTTON"].includes(document.activeElement.tagName)) {
    e.preventDefault(); $("playBtn").click();
  }
});

function drawCoverage() {
  // shaded where recorded data exists, as a gradient across the day
  const span = day.end - day.start, stops = [];
  for (let w = day.start; w < day.end; w += WINDOW_S) {
    const a = ((w - day.start) / span * 100).toFixed(3), b = ((w + WINDOW_S - day.start) / span * 100).toFixed(3);
    const c = hasData(w) ? "var(--data)" : "transparent";
    stops.push(`${c} ${a}%`, `${c} ${b}%`);
  }
  $("coverage").style.background = `linear-gradient(to right, ${stops.join(",")}), var(--line)`;
}

// --- frame loop ------------------------------------------------------------------
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);  // cap after a background tab
  lastFrame = now;
  ensureWindows();
  const w = windowOf(play.t);
  const buffering = !ready(w) || !ready(w - WINDOW_S);
  if (play.playing && !buffering) {
    play.t += dt * Number($("speed").value);
    if (windowOf(play.t) !== w) play.base = windowOf(play.t) - 3600;
    if (play.t >= day.end - 1) { play.t = day.end - 1; setPlaying(false); }
    syncInputs();
  }
  const n = render(play.t, play.base);
  const cur = play.windows.get(w);
  let msg;
  if (buffering) msg = `Loading ${hhmm(w)}…`;
  else if (cur && cur.state === "error") msg = `<span class="bad">Could not load ${hhmm(w)} (${cur.error})</span>`;
  else if (!hasData(w)) msg = "No data recorded at this time";
  else msg = `${n.toLocaleString()} vehicles`;
  $("state").innerHTML = msg;
  requestAnimationFrame(frame);
}

async function start() {
  try {
    day = await fetchJson("data/index.json");
  } catch (e) {
    $("day").innerHTML = `<span class="bad">Could not load data/index.json (${e})</span>`;
    return;
  }
  $("day").textContent = dayFmt.format(new Date((day.start + 43200) * 1000));
  $("slider").max = day.end - day.start - 1;
  drawCoverage();
  const starts = Object.keys(day.windows).map(Number).sort((a, b) => a - b);
  // #HH:MM in the URL jumps there; otherwise start at 08:00 if recorded, else at the first data
  const m = location.hash.match(/^#(\d{1,2}):(\d{2})$/);
  const eight = day.start + 8 * 3600;
  let t = m ? day.start + Number(m[1]) * 3600 + Number(m[2]) * 60 : (hasData(windowOf(eight)) ? eight : starts[0] ?? day.start);
  seek(t);
  setInterval(prune, 5000);
  setPlaying(true);
  requestAnimationFrame(frame);
}
map.on("load", start);
