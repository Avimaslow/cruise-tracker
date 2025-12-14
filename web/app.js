// web/app.js

const API_URL = "http://127.0.0.1:8000/api/last-seen";
const REFRESH_MS = 5000;
const OFFLINE_AFTER_MIN = 15;

const statusEl = document.getElementById("status");
const lastUpdateEl = document.getElementById("lastUpdate");
const shipListEl = document.getElementById("shipList");
const searchInput = document.getElementById("searchInput");
const lineChipsEl = document.getElementById("lineChips"); // must exist in index.html

let map;
let markers = new Map(); // mmsi -> Leaflet marker
let shipsCache = {};     // latest data from API (mmsi -> rec)
let currentFilter = "";
let currentLine = "all"; // all | royal | carnival | ncl | msc | virgin | disney

// route state
let activeRouteLine = null;
let activeRouteMmsi = null;
let activeRouteMode = "current";

function minutesSince(isoString) {
  if (!isoString) return Infinity;
  const t = Date.parse(isoString);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

/**
 * Eastern Time display (DST-safe)
 */
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
// Details button: open ship page in a new tab
document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-details][data-mmsi]");
  if (!btn) return;
  const mmsi = btn.getAttribute("data-mmsi");
  if (!mmsi) return;

  window.open(`ship.html?mmsi=${encodeURIComponent(mmsi)}`, "_blank", "noopener,noreferrer");
});

/**
 * Ship "local" time approximation using longitude:
 * offsetHours ≈ round(lon / 15)
 * (nautical time, not political timezones)
 */
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

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([25.7617, -80.1918], 4);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }).addTo(map);
}

function markerIcon(isLive) {
  const color = isLive ? "#2ee59d" : "#ffcc66";
  return L.divIcon({
    className: "",
    html: `<div style="
      width:14px;height:14px;border-radius:50%;
      background:${color};
      box-shadow:0 0 0 6px rgba(0,0,0,0.20), 0 0 24px rgba(0,0,0,0.35);
      border:1px solid rgba(255,255,255,0.35);
    "></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function getFilteredShips(shipsObj) {
  const out = {};
  for (const [mmsi, rec] of Object.entries(shipsObj || {})) {
    const nameOk = (rec.name || "").toLowerCase().includes(currentFilter);

    const line = (rec.line || "unknown").toLowerCase();
    const lineOk = currentLine === "all" ? true : line === currentLine;

    if (nameOk && lineOk) out[mmsi] = rec;
  }
  return out;
}

// Backend should support: GET /api/track/{mmsi}?mode=current|all
async function drawRoute(mmsi, mode = "current") {
  try {
    const url = `http://127.0.0.1:8000/api/track/${encodeURIComponent(mmsi)}?mode=${encodeURIComponent(mode)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;

    const data = await res.json();
    const latlngs = (data.points || [])
      .map((p) => [p[0], p[1]]) // [lat,lon,...]
      .filter(([lat, lon]) => lat != null && lon != null);

    // remove previous route
    if (activeRouteLine) {
      map.removeLayer(activeRouteLine);
      activeRouteLine = null;
    }

    activeRouteMmsi = mmsi;
    activeRouteMode = mode;

    if (latlngs.length < 2) return;

    activeRouteLine = L.polyline(latlngs, { weight: 4, opacity: 0.9 }).addTo(map);
    map.fitBounds(activeRouteLine.getBounds(), { padding: [40, 40] });
  } catch (_) {
    // keep UI usable even if route fails
  }
}

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

    const card = document.createElement("div");
    card.className = "card";
    card.addEventListener("click", async () => {
      if (s.lat != null && s.lon != null) {
        map.flyTo([s.lat, s.lon], 7, { duration: 0.8 });
        const marker = markers.get(String(s.mmsi));
        if (marker) marker.openPopup();
        await drawRoute(String(s.mmsi), "current");
      }
    });

    const lineLabel = (s.line || "unknown").toUpperCase();

    card.innerHTML = `
      <div class="card-top">
        <div>
          <div class="ship-name">${s.name || "UNKNOWN"}</div>
          <div class="mmsi">MMSI ${s.mmsi} • ${lineLabel}</div>
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

    // don’t place marker until we have coords
    if (lat == null || lon == null) continue;

    const mins = minutesSince(rec.last_seen);
    const isLive = mins <= OFFLINE_AFTER_MIN;

    const lineLabel = (rec.line || "unknown").toUpperCase();

    const popupHtml = `
      <div style="min-width:240px">
        <div style="font-weight:700">${rec.name || "UNKNOWN"}</div>
        <div style="opacity:.75;font-size:12px;margin-top:2px">MMSI ${mmsi} • ${lineLabel}</div>

        <div style="margin-top:10px; font-size:12px; opacity:.9">
          Last seen (ET): ${formatEasternTime(rec.last_seen)}<br/>
          Ship local: ${formatShipLocalTime(rec.last_seen, rec.lon)}<br/>
          Speed: ${rec.speed ?? "—"} kn<br/>
          Course: ${rec.course ?? "—"}
        </div>

        <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap">
  <button data-route="current" data-mmsi="${mmsi}" style="padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:white;cursor:pointer;">
    Current route
  </button>
  <button data-route="all" data-mmsi="${mmsi}" style="padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:white;cursor:pointer;">
    All history
  </button>
  <button data-details="1" data-mmsi="${mmsi}" style="padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.25);color:white;cursor:pointer;">
    View ship
  </button>
</div>

      </div>
    `;

    const key = String(mmsi);

    if (!markers.has(key)) {
      const marker = L.marker([lat, lon], { icon: markerIcon(isLive) })
        .addTo(map)
        .bindPopup(popupHtml);

      marker.on("click", async () => {
        await drawRoute(key, "current");
      });

      markers.set(key, marker);
    } else {
      const marker = markers.get(key);
      if (!map.hasLayer(marker)) marker.addTo(map);
      marker.setLatLng([lat, lon]);
      marker.setIcon(markerIcon(isLive));
      marker.setPopupContent(popupHtml);
    }
  }
}

async function fetchAndRender() {
  try {
    statusEl.textContent = "Loading";

    const res = await fetch(API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("API error");

    const data = await res.json();
    shipsCache = data.ships || {};

    // show ET for the "Last update" too
    lastUpdateEl.textContent = formatEasternTime(new Date().toISOString());

    statusEl.textContent = "OK";
    statusEl.style.borderColor = "rgba(46,229,157,0.35)";
    statusEl.style.color = "var(--ok)";

    upsertMarkers(shipsCache);
    renderList(shipsCache);
  } catch (e) {
    statusEl.textContent = "Error";
    statusEl.style.borderColor = "rgba(255,92,122,0.35)";
    statusEl.style.color = "var(--bad)";
  }
}

function wireEvents() {
  // Search filter
  searchInput.addEventListener("input", () => {
    currentFilter = (searchInput.value || "").trim().toLowerCase();
    upsertMarkers(shipsCache);
    renderList(shipsCache);
  });

  // Line chip filter
  if (lineChipsEl) {
    lineChipsEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip[data-line]");
      if (!btn) return;

      currentLine = btn.getAttribute("data-line") || "all";

      for (const b of lineChipsEl.querySelectorAll(".chip")) b.classList.remove("active");
      btn.classList.add("active");

      upsertMarkers(shipsCache);
      renderList(shipsCache);
    });
  }

  // Popup buttons: current/all route
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-route][data-mmsi]");
    if (!btn) return;

    const mode = btn.getAttribute("data-route") || "current";
    const mmsi = btn.getAttribute("data-mmsi");
    if (!mmsi) return;

    await drawRoute(String(mmsi), mode);
  });
}
// --- Ports overlay (viewport loaded) ---
const API_PORTS = "http://127.0.0.1:8000/api/ports";

let portsLayer = null;
let portsEnabled = true;     // toggle later if you want
let portsMoveTimer = null;

function portIcon() {
  // small, minimal
  return L.divIcon({
    className: "",
    html: `<div style="font-size:12px; line-height:12px; transform: translate(-2px,-6px);">⚓</div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

async function fetchPortsForViewport() {
  if (!portsEnabled) return [];

  // Only show ports once zoomed in enough (prevents clutter)
  if (map.getZoom() < 6) return [];

  const b = map.getBounds();
  const url =
    `${API_PORTS}` +
    `?min_lat=${encodeURIComponent(b.getSouth())}` +
    `&min_lon=${encodeURIComponent(b.getWest())}` +
    `&max_lat=${encodeURIComponent(b.getNorth())}` +
    `&max_lon=${encodeURIComponent(b.getEast())}` +
    `&limit=1200`;

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

  // Re-render on moveend (debounced)
  map.on("moveend", () => {
    clearTimeout(portsMoveTimer);
    portsMoveTimer = setTimeout(renderPorts, 250);
  });

  // Also re-render on zoomend
  map.on("zoomend", () => {
    clearTimeout(portsMoveTimer);
    portsMoveTimer = setTimeout(renderPorts, 150);
  });

  renderPorts();
}

// small HTML escape helper (prevents weird names from breaking popup)
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Boot
initMap();
setupPortsOverlay();
wireEvents();
fetchAndRender();
setInterval(fetchAndRender, REFRESH_MS);
