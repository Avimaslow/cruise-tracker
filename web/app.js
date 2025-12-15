// web/app.js

// ----------------------------
// Config
// ----------------------------
const API_BASE = "https://cruise-backend-320129656576.us-east1.run.app";
const API_URL = `${API_BASE}/api/last-seen`;
const API_PORTS = `${API_BASE}/api/ports`;

const REFRESH_MS = 5000;
const OFFLINE_AFTER_MIN = 15;

// Ports behavior (tune these)
const PORTS_MIN_ZOOM = 7;     // show ports only when zoomed in
const PORTS_LIMIT = 300;      // reduce clutter

// Default view (used when clearing selection)
const DEFAULT_VIEW = { center: [25.7617, -80.1918], zoom: 4 };

// ----------------------------
// DOM
// ----------------------------
const statusEl = document.getElementById("status");
const lastUpdateEl = document.getElementById("lastUpdate");
const shipListEl = document.getElementById("shipList");
const searchInput = document.getElementById("searchInput");
const lineChipsEl = document.getElementById("lineChips"); // must exist
const legendEl = document.getElementById("legend");       // optional

// Right rail (analytics + selected ship) — safe if not present
const fleetTotalEl = document.getElementById("fleetTotal");
const fleetLiveEl = document.getElementById("fleetLive");
const fleetAvgSpeedEl = document.getElementById("fleetAvgSpeed");
const fleetFastestEl = document.getElementById("fleetFastest");
const lineBreakdownEl = document.getElementById("lineBreakdown");

const selShipNameEl = document.getElementById("selShipName");
const selShipSpeedEl = document.getElementById("selShipSpeed");
const selShipCourseEl = document.getElementById("selShipCourse");
const selShipLastEl = document.getElementById("selShipLast");

// ----------------------------
// Line themes
// ----------------------------
const LINE_THEME = {
  royal:    { color: "#2E7CF6", label: "Royal Caribbean" },
  carnival: { color: "#E64B3C", label: "Carnival" },
  ncl:      { color: "#22C55E", label: "Norwegian" },
  msc:      { color: "#8B5CF6", label: "MSC" },
  virgin:   { color: "#F43F5E", label: "Virgin" },
  disney:   { color: "#F59E0B", label: "Disney" },
  unknown:  { color: "#94A3B8", label: "Unknown" },
};

function getLineKey(line) {
  const k = (line || "unknown").toLowerCase();
  return LINE_THEME[k] ? k : "unknown";
}

// ----------------------------
// State
// ----------------------------
let map;
let markers = new Map(); // mmsi -> Leaflet marker
let shipsCache = {};     // mmsi -> rec
let currentFilter = "";
let currentLine = "all"; // all | royal | carnival | ncl | msc | virgin | disney
let activeMmsi = null;   // selected ship

// route state
let activeRouteLine = null;      // core neon line
let activeRouteGlowLine = null;  // glow line
let activeRouteMmsi = null;
let activeRouteMode = "current";

// ports state
let portsLayer = null;
let portsEnabled = true;
let portsMoveTimer = null;

// ----------------------------
// Utils
// ----------------------------
function minutesSince(isoString) {
  if (!isoString) return Infinity;
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function formatEasternTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatShipLocalTime(iso, lon) {
  if (!iso || lon == null) return "—";

  const d = new Date(iso);
  const offsetHours = Math.round(Number(lon) / 15);

  const localMs = d.getTime() + offsetHours * 60 * 60 * 1000;
  const local = new Date(localMs);

  const sign = offsetHours >= 0 ? "+" : "−";
  return `${local.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })} (UTC${sign}${Math.abs(offsetHours)})`;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function numSpeed(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// ----------------------------
// Filtering
// ----------------------------
function getFilteredShips(shipsObj) {
  const out = {};
  for (const [mmsi, rec] of Object.entries(shipsObj || {})) {
    const nameOk = (rec.name || "").toLowerCase().includes(currentFilter);
    const lineKey = getLineKey(rec.line);
    const lineOk = currentLine === "all" ? true : lineKey === currentLine;
    if (nameOk && lineOk) out[mmsi] = rec;
  }
  return out;
}

// ----------------------------
// Right rail: selected ship panel
// ----------------------------
function updateSelectedShipPanel() {
  if (!selShipNameEl) return;

  if (!activeMmsi || !shipsCache[String(activeMmsi)]) {
    selShipNameEl.textContent = "None";
    if (selShipSpeedEl) selShipSpeedEl.textContent = "—";
    if (selShipCourseEl) selShipCourseEl.textContent = "—";
    if (selShipLastEl) selShipLastEl.textContent = "—";
    return;
  }

  const r = shipsCache[String(activeMmsi)];
  selShipNameEl.textContent = r.name || "UNKNOWN";
  if (selShipSpeedEl) selShipSpeedEl.textContent = r.speed != null ? `${r.speed} kn` : "—";
  if (selShipCourseEl) selShipCourseEl.textContent = r.course ?? "—";
  if (selShipLastEl) selShipLastEl.textContent = formatEasternTime(r.last_seen);
}

// ----------------------------
// Right rail: fleet analytics
// ----------------------------
function updateFleetAnalytics(shipsObj) {
  if (!fleetTotalEl && !fleetLiveEl && !fleetAvgSpeedEl && !fleetFastestEl && !lineBreakdownEl) return;

  const filtered = getFilteredShips(shipsObj);
  const recs = Object.values(filtered);

  const live = [];
  for (const r of recs) {
    const mins = minutesSince(r.last_seen);
    const sp = numSpeed(r.speed);
    if (mins <= OFFLINE_AFTER_MIN && sp != null) live.push({ ...r, speedNum: sp });
  }

  if (fleetTotalEl) fleetTotalEl.textContent = String(recs.length);
  if (fleetLiveEl) fleetLiveEl.textContent = String(live.length);

  if (live.length) {
    const avg = live.reduce((s, r) => s + r.speedNum, 0) / live.length;
    if (fleetAvgSpeedEl) fleetAvgSpeedEl.textContent = `${avg.toFixed(1)} kn`;

    const fastest = live.reduce((a, b) => (b.speedNum > a.speedNum ? b : a));
    if (fleetFastestEl) fleetFastestEl.textContent = `${fastest.name || "UNKNOWN"} • ${fastest.speedNum.toFixed(1)} kn`;
  } else {
    if (fleetAvgSpeedEl) fleetAvgSpeedEl.textContent = "—";
    if (fleetFastestEl) fleetFastestEl.textContent = "—";
  }

  if (lineBreakdownEl) {
    const totalBy = {};
    const liveBy = {};

    for (const r of recs) {
      const k = getLineKey(r.line);
      totalBy[k] = (totalBy[k] || 0) + 1;

      const mins = minutesSince(r.last_seen);
      if (mins <= OFFLINE_AFTER_MIN) liveBy[k] = (liveBy[k] || 0) + 1;
    }

    const keys = Object.keys(totalBy).sort((a, b) => (totalBy[b] || 0) - (totalBy[a] || 0));

    lineBreakdownEl.innerHTML = keys.map((k) => {
      const theme = LINE_THEME[k] || LINE_THEME.unknown;
      const t = totalBy[k] || 0;
      const l = liveBy[k] || 0;

      return `
        <div style="display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:12px;
                    background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08);">
          <span style="width:10px; height:10px; border-radius:50%; background:${theme.color};"></span>
          <span style="flex:1; font-size:13px; opacity:.9;">${theme.label}</span>
          <span style="font-size:12px; opacity:.75;">${l}/${t}</span>
        </div>
      `;
    }).join("");
  }
}

// ----------------------------
// Selection + zoom helpers
// ----------------------------
function clearRoute() {
  if (activeRouteLine) {
    map.removeLayer(activeRouteLine);
    activeRouteLine = null;
  }
  if (activeRouteGlowLine) {
    map.removeLayer(activeRouteGlowLine);
    activeRouteGlowLine = null;
  }
  activeRouteMmsi = null;
  activeRouteMode = "current";
}

function clearSelectionUI() {
  activeMmsi = null;
  for (const el of shipListEl.querySelectorAll(".card")) el.classList.remove("selected");
  updateSelectedShipPanel();
}

function fitToAllVisibleShips() {
  const filtered = getFilteredShips(shipsCache);
  const pts = [];

  for (const rec of Object.values(filtered)) {
    if (rec.lat != null && rec.lon != null) pts.push([rec.lat, rec.lon]);
  }

  if (pts.length >= 2) {
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  } else if (pts.length === 1) {
    map.flyTo(pts[0], 6, { duration: 0.6 });
  } else {
    map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  }
}

function toggleShipSelection(mmsi) {
  const key = String(mmsi);

  if (activeMmsi === key) {
    clearRoute();
    clearSelectionUI();
    fitToAllVisibleShips();
    return false;
  }

  activeMmsi = key;
  updateSelectedShipPanel();
  return true;
}

// ----------------------------
// Map
// ----------------------------
function initMap() {
  const worldBounds = L.latLngBounds(
    L.latLng(-85, -180),
    L.latLng(85, 180)
  );

  map = L.map("map", {
    zoomControl: true,
    worldCopyJump: false,
    maxBounds: worldBounds,
    maxBoundsViscosity: 1.0,
    minZoom: 2,
  }).setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);

  // Dark neon base
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
    {
      maxZoom: 19,
      minZoom: 2,
      noWrap: true,
      bounds: worldBounds,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    }
  ).addTo(map);
}

// Colored ship marker icon by line
function shipMarkerIcon(lineKey, isLive) {
  const theme = LINE_THEME[lineKey] || LINE_THEME.unknown;
  const fill = theme.color;
  const opacity = isLive ? 1.0 : 0.55;

  const svg = `
  <svg width="34" height="34" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="rgba(0,0,0,0.45)"/>
      </filter>
    </defs>

    <g filter="url(#shadow)" opacity="${opacity}">
      <circle cx="22" cy="22" r="18" fill="rgba(0,0,0,0.35)" />
      <circle cx="22" cy="22" r="16" fill="${fill}" fill-opacity="0.20" stroke="${fill}" stroke-opacity="0.65"/>
      <path d="M16 23h12l2 4c-3 2-13 2-16 0l2-4z" fill="${fill}" fill-opacity="0.95"/>
      <path d="M18 16h8v6h-8z" fill="${fill}" fill-opacity="0.80"/>
      <path d="M20 14h2v2h-2zM23 14h2v2h-2z" fill="${fill}" fill-opacity="0.80"/>
      <path d="M14 30c2 1 4 1 6 0s4-1 6 0 4 1 6 0" stroke="${fill}" stroke-opacity="0.75" stroke-width="2" fill="none" stroke-linecap="round"/>
    </g>
  </svg>`;

  return L.divIcon({
    className: `ship-marker ${isLive ? "is-live" : "is-offline"}`,
    html: svg,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -16],
  });
}

// ----------------------------
// Route drawing (neon glow)
// ----------------------------
async function drawRoute(mmsi, mode = "current") {
  try {
    const url = `${API_BASE}/api/track/${encodeURIComponent(mmsi)}?mode=${encodeURIComponent(mode)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;

    const data = await res.json();
    const latlngs = (data.points || [])
      .map((p) => [p[0], p[1]])
      .filter(([lat, lon]) => lat != null && lon != null);

    // remove existing lines
    if (activeRouteLine) { map.removeLayer(activeRouteLine); activeRouteLine = null; }
    if (activeRouteGlowLine) { map.removeLayer(activeRouteGlowLine); activeRouteGlowLine = null; }

    activeRouteMmsi = String(mmsi);
    activeRouteMode = mode;

    if (latlngs.length < 2) return;

    const rec = shipsCache[String(mmsi)] || {};
    const lineKey = getLineKey(rec.line);
    const color = (LINE_THEME[lineKey] || LINE_THEME.unknown).color;

    // glow layer (under)
    activeRouteGlowLine = L.polyline(latlngs, {
      weight: 12,
      opacity: 0.25,
      color,
    }).addTo(map);

    // core neon line (over)
    activeRouteLine = L.polyline(latlngs, {
      weight: 4,
      opacity: 1,
      color,
    }).addTo(map);

    map.fitBounds(activeRouteLine.getBounds(), { padding: [40, 40] });
  } catch (_) {
    // keep UI usable even if route fails
  }
}

// ----------------------------
// List render (sidebar)
// ----------------------------
function renderList(shipsObj) {
  const filteredShips = getFilteredShips(shipsObj);

  const entries = Object.entries(filteredShips)
    .map(([mmsi, rec]) => ({ mmsi, ...rec }))
    .sort((a, b) => (Date.parse(b.last_seen || "") || 0) - (Date.parse(a.last_seen || "") || 0));

  shipListEl.innerHTML = "";
  if (entries.length === 0) {
    shipListEl.innerHTML = `<div class="card"><div class="ship-name">No ships match your filter.</div></div>`;
    return;
  }

  for (const s of entries) {
    const mins = minutesSince(s.last_seen);
    const isLive = mins <= OFFLINE_AFTER_MIN;

    const lineKey = getLineKey(s.line);
    const lineLabel = (s.line || "unknown").toUpperCase();
    const color = (LINE_THEME[lineKey] || LINE_THEME.unknown).color;

    const card = document.createElement("div");
    card.className = "card";
    if (String(s.mmsi) === String(activeMmsi)) card.classList.add("selected");

    card.addEventListener("click", async () => {
      const turnedOn = toggleShipSelection(s.mmsi);
      if (!turnedOn) return;

      for (const el of shipListEl.querySelectorAll(".card")) el.classList.remove("selected");
      card.classList.add("selected");

      if (s.lat != null && s.lon != null) {
        map.flyTo([s.lat, s.lon], 7, { duration: 0.8 });
        const marker = markers.get(String(s.mmsi));
        if (marker) marker.openPopup();
        await drawRoute(String(s.mmsi), "current");
      }
    });

    card.innerHTML = `
      <div class="accent" style="background:${color}"></div>

      <div class="card-top">
        <div>
          <div class="ship-name">${escapeHtml(s.name || "UNKNOWN")}</div>
          <div class="mmsi">MMSI ${escapeHtml(s.mmsi)} • ${escapeHtml(lineLabel)}</div>
        </div>
        <div class="badge ${isLive ? "live" : "offline"}">${isLive ? "Live" : "Last seen"}</div>
      </div>

      <div class="card-grid">
        <div class="kv">
          <div class="k">Last seen (ET)</div>
          <div class="v">${formatEasternTime(s.last_seen)}</div>
        </div>

        <div class="kv">
          <div class="k">Ship local time</div>
          <div class="v">${formatShipLocalTime(s.last_seen, s.lon)}</div>
        </div>

        <div class="kv"><div class="k">Speed</div><div class="v">${s.speed ?? "—"} kn</div></div>
        <div class="kv"><div class="k">Lat</div><div class="v">${s.lat?.toFixed?.(5) ?? "—"}</div></div>
        <div class="kv"><div class="k">Lon</div><div class="v">${s.lon?.toFixed?.(5) ?? "—"}</div></div>
      </div>
    `;
    shipListEl.appendChild(card);
  }
}

// ----------------------------
// Markers
// ----------------------------
function upsertMarkers(shipsObj) {
  const filtered = getFilteredShips(shipsObj);

  // Hide markers not in filter
  for (const [mmsi, marker] of markers.entries()) {
    if (!filtered[mmsi]) {
      if (map.hasLayer(marker)) map.removeLayer(marker);
    }
  }

  for (const [mmsi, rec] of Object.entries(filtered)) {
    const lat = rec.lat;
    const lon = rec.lon;
    if (lat == null || lon == null) continue;

    const mins = minutesSince(rec.last_seen);
    const isLive = mins <= OFFLINE_AFTER_MIN;

    const lineKey = getLineKey(rec.line);
    const lineLabel = (rec.line || "unknown").toUpperCase();

    const popupHtml = `
      <div style="min-width:240px">
        <div style="font-weight:700">${escapeHtml(rec.name || "UNKNOWN")}</div>
        <div style="opacity:.75;font-size:12px;margin-top:2px">MMSI ${escapeHtml(mmsi)} • ${escapeHtml(lineLabel)}</div>

        <div style="margin-top:10px; font-size:12px; opacity:.9">
          Last seen (ET): ${formatEasternTime(rec.last_seen)}<br/>
          Ship local: ${formatShipLocalTime(rec.last_seen, rec.lon)}<br/>
          Speed: ${rec.speed ?? "—"} kn<br/>
          Course: ${rec.course ?? "—"}
        </div>

        <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap">
          <button data-route="current" data-mmsi="${escapeHtml(mmsi)}"
            style="padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:white;cursor:pointer;">
            Current route
          </button>
          <button data-route="all" data-mmsi="${escapeHtml(mmsi)}"
            style="padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:white;cursor:pointer;">
            All history
          </button>
          <button data-details="1" data-mmsi="${escapeHtml(mmsi)}"
            style="padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:white;cursor:pointer;">
            View ship
          </button>
        </div>
      </div>
    `;

    const key = String(mmsi);
    const icon = shipMarkerIcon(lineKey, isLive);

    if (!markers.has(key)) {
      const marker = L.marker([lat, lon], { icon })
        .addTo(map)
        .bindPopup(popupHtml);

      marker.on("click", async () => {
        const turnedOn = toggleShipSelection(key);
        if (!turnedOn) return;
        await drawRoute(key, "current");
      });

      markers.set(key, marker);
    } else {
      const marker = markers.get(key);
      if (!map.hasLayer(marker)) marker.addTo(map);
      marker.setLatLng([lat, lon]);
      marker.setIcon(icon);
      marker.setPopupContent(popupHtml);
    }
  }
}

// ----------------------------
// Legend
// ----------------------------
function renderLegend(shipsObj) {
  if (!legendEl) return;

  const counts = {};
  const liveCounts = {};

  for (const rec of Object.values(shipsObj || {})) {
    const k = getLineKey(rec.line);
    counts[k] = (counts[k] || 0) + 1;

    const mins = minutesSince(rec.last_seen);
    const isLive = mins <= OFFLINE_AFTER_MIN;
    if (isLive) liveCounts[k] = (liveCounts[k] || 0) + 1;
  }

  const items = Object.keys(LINE_THEME)
    .filter((k) => k !== "unknown")
    .map((k) => {
      const c = counts[k] || 0;
      const l = liveCounts[k] || 0;
      const color = LINE_THEME[k].color;
      return `
        <div class="legend-item">
          <span class="dot" style="background:${color}"></span>
          <span class="name">${LINE_THEME[k].label}</span>
          <span class="count">${l}/${c}</span>
        </div>`;
    })
    .join("");

  legendEl.innerHTML = `
    <div class="legend-title">Fleet overview</div>
    <div class="legend-sub">Live/Total by line</div>
    <div class="legend-grid">${items}</div>
  `;
}

// ----------------------------
// Ports overlay
// ----------------------------
function portIcon() {
  return L.divIcon({
    className: "",
    html: `
      <div style="
        color:#facc15;
        text-shadow: 0 0 12px rgba(250,204,21,0.8),
                     0 0 24px rgba(250,204,21,0.4);
        font-size:14px;">
        ⚓
      </div>
    `,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

async function fetchPortsForViewport() {
  if (!portsEnabled) return [];
  if (map.getZoom() < PORTS_MIN_ZOOM) return [];

  const b = map.getBounds();
  const url =
    `${API_PORTS}` +
    `?min_lat=${encodeURIComponent(b.getSouth())}` +
    `&min_lon=${encodeURIComponent(b.getWest())}` +
    `&max_lat=${encodeURIComponent(b.getNorth())}` +
    `&max_lon=${encodeURIComponent(b.getEast())}` +
    `&limit=${encodeURIComponent(PORTS_LIMIT)}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.ports || [];
}

async function renderPorts() {
  if (!portsLayer) return;

  portsLayer.clearLayers();

  const ports = await fetchPortsForViewport();
  if (!ports.length) return;

  for (const p of ports) {
    const m = L.marker([p.lat, p.lon], { icon: portIcon(), interactive: true });
    m.bindPopup(`<b>${escapeHtml(p.name)}</b><br/>${escapeHtml(p.country || "")}`);
    portsLayer.addLayer(m);
  }
}

function setupPortsOverlay() {
  portsLayer = L.layerGroup().addTo(map);

  map.on("moveend", () => {
    clearTimeout(portsMoveTimer);
    portsMoveTimer = setTimeout(renderPorts, 250);
  });

  map.on("zoomend", () => {
    clearTimeout(portsMoveTimer);
    portsMoveTimer = setTimeout(renderPorts, 150);
  });

  renderPorts();
}

// ----------------------------
// Ship details button
// ----------------------------
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-details][data-mmsi]");
  if (!btn) return;
  const mmsi = btn.getAttribute("data-mmsi");
  if (!mmsi) return;

  window.open(`ship.html?mmsi=${encodeURIComponent(mmsi)}`, "_blank", "noopener,noreferrer");
});

// Popup buttons: current/all route
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-route][data-mmsi]");
  if (!btn) return;

  const mode = btn.getAttribute("data-route") || "current";
  const mmsi = String(btn.getAttribute("data-mmsi") || "");
  if (!mmsi) return;

  if (activeRouteMmsi === mmsi && activeRouteMode === mode) {
    clearRoute();
    clearSelectionUI();
    fitToAllVisibleShips();
    return;
  }

  activeMmsi = mmsi;
  updateSelectedShipPanel();
  await drawRoute(mmsi, mode);
});

// ----------------------------
// Fetch + render
// ----------------------------
async function fetchAndRender() {
  try {
    statusEl.textContent = "Loading";

    const res = await fetch(API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("API error");

    const data = await res.json();
    shipsCache = data.ships || {};

    lastUpdateEl.textContent = formatEasternTime(new Date().toISOString());

    statusEl.textContent = "OK";
    statusEl.style.borderColor = "rgba(46,229,157,0.35)";
    statusEl.style.color = "var(--ok)";

    upsertMarkers(shipsCache);
    renderList(shipsCache);
    renderLegend(shipsCache);

    updateFleetAnalytics(shipsCache);
    updateSelectedShipPanel();

    renderPorts();
  } catch (e) {
    statusEl.textContent = "Error";
    statusEl.style.borderColor = "rgba(255,92,122,0.35)";
    statusEl.style.color = "var(--bad)";
  }
}

// ----------------------------
// Events
// ----------------------------
function wireMapTools() {
  const btnFit = document.getElementById("btnFitFleet");
  const btnClear = document.getElementById("btnClearRoute");
  const btnPorts = document.getElementById("btnTogglePorts");

  if (btnFit) {
    btnFit.addEventListener("click", () => {
      clearRoute();
      clearSelectionUI();
      fitToAllVisibleShips();
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", () => {
      clearRoute();
      clearSelectionUI();
      fitToAllVisibleShips();
    });
  }

  if (btnPorts) {
    btnPorts.addEventListener("click", async () => {
      portsEnabled = !portsEnabled;
      btnPorts.textContent = portsEnabled ? "Ports: On" : "Ports: Off";

      const portsStatusText = document.getElementById("portsStatusText");
      if (portsStatusText) portsStatusText.textContent = portsEnabled ? "On" : "Off";

      if (!portsEnabled && portsLayer) portsLayer.clearLayers();
      if (portsEnabled) await renderPorts();
    });
  }
}

function wireEvents() {
  searchInput.addEventListener("input", () => {
    currentFilter = (searchInput.value || "").trim().toLowerCase();
    upsertMarkers(shipsCache);
    renderList(shipsCache);
    renderLegend(shipsCache);
    updateFleetAnalytics(shipsCache);

    const filtered = getFilteredShips(shipsCache);
    if (activeMmsi && !filtered[String(activeMmsi)]) {
      clearRoute();
      clearSelectionUI();
    }
  });

  if (lineChipsEl) {
    lineChipsEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip[data-line]");
      if (!btn) return;

      const nextLine = btn.getAttribute("data-line") || "all";

      if (currentLine === nextLine && nextLine !== "all") {
        currentLine = "all";

        for (const b of lineChipsEl.querySelectorAll(".chip")) b.classList.remove("active");
        const allBtn = lineChipsEl.querySelector('.chip[data-line="all"]');
        if (allBtn) allBtn.classList.add("active");

        clearRoute();
        clearSelectionUI();
        upsertMarkers(shipsCache);
        renderList(shipsCache);
        renderLegend(shipsCache);
        updateFleetAnalytics(shipsCache);
        fitToAllVisibleShips();
        return;
      }

      currentLine = nextLine;

      for (const b of lineChipsEl.querySelectorAll(".chip")) b.classList.remove("active");
      btn.classList.add("active");

      const filtered = getFilteredShips(shipsCache);
      if (activeMmsi && !filtered[String(activeMmsi)]) {
        clearRoute();
        clearSelectionUI();
      }

      upsertMarkers(shipsCache);
      renderList(shipsCache);
      renderLegend(shipsCache);
      updateFleetAnalytics(shipsCache);
    });
  }

  map.on("click", () => {
    clearRoute();
    clearSelectionUI();
  });
}

// ----------------------------
// Boot
// ----------------------------
initMap();
setupPortsOverlay();
wireEvents();
wireMapTools();
fetchAndRender();
setInterval(fetchAndRender, REFRESH_MS);
