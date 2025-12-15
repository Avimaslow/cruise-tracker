// web/ship.js
//
// Ship Details page logic:
// - Reads ?mmsi= from querystring
// - Fetches live ship record from backend /api/last-seen
// - (Optional) Fetches voyage prediction from backend /api/voyage/{mmsi} (handles 404 gracefully)
// - Pulls Wikipedia summary + one image + "Infobox ship" specs
//
// IMPORTANT:
// - This file auto-picks backend URL:
//   1) if ?backend=... is provided, uses that
//   2) if running locally (localhost/127.0.0.1), defaults to http://127.0.0.1:8000
//   3) otherwise defaults to your Cloud Run backend URL below

/* -------------------------
   Backend base URL
------------------------- */
const DEFAULT_BACKEND_CLOUDRUN = "https://cruise-backend-320129656576.us-east1.run.app";

function getBackendBase() {
  // Allow override: ship.html?mmsi=...&backend=https://...
  const override = new URLSearchParams(window.location.search).get("backend");
  if (override) return override.replace(/\/+$/, "");

  const host = window.location.hostname || "";
  const isLocal = host === "localhost" || host === "127.0.0.1";

  if (isLocal) return "http://127.0.0.1:8000";
  return DEFAULT_BACKEND_CLOUDRUN;
}

const BACKEND_BASE = getBackendBase();
const API_LAST_SEEN = `${BACKEND_BASE}/api/last-seen`;

/* -------------------------
   Querystring helpers
------------------------- */
function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/* -------------------------
   Time formatting
------------------------- */
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

// simple "ship local time" approximation by longitude (15° per hour)
function formatShipLocalTime(iso, lon) {
  if (!iso || lon == null || Number.isNaN(Number(lon))) return "—";
  const d = new Date(iso);
  const offsetHours = Math.round(Number(lon) / 15);
  const local = new Date(d.getTime() + offsetHours * 3600 * 1000);
  const sign = offsetHours >= 0 ? "+" : "−";

  const stamp = local.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return `${stamp} (UTC${sign}${Math.abs(offsetHours)})`;
}

/* -------------------------
   Confidence UI helper
------------------------- */
function confidenceDots(conf) {
  const c = Number(conf);
  if (!Number.isFinite(c)) return "●○○○○";
  const filled = Math.max(0, Math.min(5, Math.round(c * 5)));
  return "●".repeat(filled) + "○".repeat(5 - filled);
}

/* -------------------------
   Backend fetch
------------------------- */
async function fetchLastSeenRecord(mmsi) {
  const res = await fetch(API_LAST_SEEN, { cache: "no-store" });
  if (!res.ok) throw new Error("API last-seen failed");
  const data = await res.json();
  const ships = data.ships || {};
  return ships[String(mmsi)] || null;
}

/* -------------------------
   Voyage prediction (optional endpoint)
------------------------- */
async function loadVoyage(mmsi) {
  // If you don’t have /api/voyage/{mmsi} implemented in server.py yet,
  // this will just no-op.
  const voyageUrl = `${BACKEND_BASE}/api/voyage/${encodeURIComponent(mmsi)}`;

  try {
    const res = await fetch(voyageUrl, { cache: "no-store" });

    // Missing endpoint -> don’t spam console, just leave placeholders.
    if (res.status === 404) return;
    if (!res.ok) return;

    const v = await res.json();

    // --- Last Port ---
    const lastPortEl = document.getElementById("vpLastPort");
    if (lastPortEl) {
      if (v?.last_port?.name) {
        const when = v.last_port.departed_at || v.last_port.arrived_at || null;
        lastPortEl.innerText = `${v.last_port.name}\n${formatEasternTime(when)}`;
      } else {
        lastPortEl.innerText = "—";
      }
    }

    // --- At Sea ---
    const atSeaEl = document.getElementById("vpAtSea");
    if (atSeaEl) {
      if (v?.at_sea) {
        const sp =
          v.at_sea.speed_kn != null ? `${Number(v.at_sea.speed_kn).toFixed(1)} kn` : "—";
        const crs =
          v.at_sea.course_deg != null ? `${Math.round(Number(v.at_sea.course_deg))}°` : "—";
        atSeaEl.innerText = `${sp} • Heading ${crs}`;
      } else {
        atSeaEl.innerText = "—";
      }
    }

    // --- Likely Next Port ---
    const nextEl = document.getElementById("vpNextPort");
    if (nextEl) {
      if (v?.likely_next_port?.name) {
        const eta =
          v.likely_next_port.eta_hours != null
            ? `${Number(v.likely_next_port.eta_hours).toFixed(1)} h`
            : "—";
        const dots = confidenceDots(v.confidence);
        const pct = v.confidence != null ? `${Math.round(Number(v.confidence) * 100)}%` : "—";
        nextEl.innerText = `${v.likely_next_port.name}\nETA ~ ${eta}\nConfidence ${dots} (${pct})`;
      } else {
        nextEl.innerText = "—";
      }
    }
  } catch (_) {
    // keep UI usable even if voyage fetch fails
  }
}

/* -------------------------
   Wikipedia: summary + infobox
------------------------- */
async function wikiSearchTitle(query) {
  const url =
    "https://en.wikipedia.org/w/api.php" +
    `?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    "&utf8=1&format=json&origin=*";

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;

  const data = await res.json();
  return data?.query?.search?.[0]?.title || null;
}

async function wikiSummary(title) {
  const url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;

  const data = await res.json();
  return {
    title: data.title,
    url: data.content_urls?.desktop?.page || null,
    summary: data.extract || "",
    image: data.originalimage?.source || data.thumbnail?.source || null,
  };
}

async function wikiWikitext(title) {
  const url =
    "https://en.wikipedia.org/w/api.php" +
    "?action=parse" +
    `&page=${encodeURIComponent(title)}` +
    "&prop=wikitext" +
    "&format=json" +
    "&origin=*";

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;

  const data = await res.json();
  return data?.parse?.wikitext?.["*"] || null;
}

function extractInfoboxShip(wikitext) {
  if (!wikitext) return null;
  const start = wikitext.indexOf("{{Infobox ship");
  if (start === -1) return null;

  // Brace matching for the infobox template
  let depth = 0;
  let i = start;

  for (; i < wikitext.length; i++) {
    if (wikitext[i] === "{" && wikitext[i + 1] === "{") depth++;
    if (wikitext[i] === "}" && wikitext[i + 1] === "}") depth--;

    if (depth === 0 && i > start) return wikitext.slice(start, i + 2);
  }

  return null;
}

function parseInfoboxFields(infoboxText) {
  if (!infoboxText) return {};

  const lines = infoboxText.split("\n");
  const out = {};

  for (const line of lines) {
    const m = line.match(/^\|\s*([^=]+?)\s*=\s*(.+)\s*$/);
    if (!m) continue;

    const key = m[1].trim().toLowerCase();
    let val = m[2].trim();

    // Strip some common wiki markup safely
    val = val
      .replace(/<ref[^>]*>.*?<\/ref>/g, "")
      .replace(/<ref[^\/]*\/>/g, "")
      .replace(/\[\[|\]\]/g, "")
      .replace(/\{\{.*?\}\}/g, "")
      .replace(/''+/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!val || val === "—") continue;
    out[key] = val;
  }

  return out;
}

function normalizeShipSpecs(fields) {
  const pick = (label, ...keys) => {
    for (const k of keys) {
      const kk = String(k).toLowerCase();
      if (fields[kk]) return [label, fields[kk]];
    }
    return null;
  };

  const specs = [
    pick("Class", "class", "ship class"),
    pick("Builder", "builder"),
    pick("Ordered", "ordered"),
    pick("Laid down", "laid down"),
    pick("Launched", "launched"),
    pick("Completed", "completed"),
    pick("In service", "in service"),
    pick("Home port", "home port"),
    pick("Operator", "operator"),
    pick("Owner", "owner"),

    pick("Tonnage", "tonnage", "gross tonnage", "gt"),
    pick("Length", "length"),
    pick("Beam", "beam"),
    pick("Height", "height"),
    pick("Decks", "decks"),
    pick("Speed", "speed"),

    pick("Capacity", "capacity"),
    pick("Passengers", "passengers"),
    pick("Crew", "crew"),
  ].filter(Boolean);

  // Deduplicate labels
  const seen = new Set();
  return specs.filter(([label]) => {
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

async function getWikipediaShipProfileWithSpecs(shipName) {
  // Try higher hit-rate queries first:
  const title =
    (await wikiSearchTitle(`${shipName} (ship)`)) ||
    (await wikiSearchTitle(`${shipName} cruise ship`)) ||
    (await wikiSearchTitle(shipName));

  if (!title) return null;

  const summary = await wikiSummary(title);
  if (!summary) return null;

  const wikitext = await wikiWikitext(title);
  const infobox = extractInfoboxShip(wikitext);
  const fields = parseInfoboxFields(infobox);
  const specs = normalizeShipSpecs(fields);

  return {
    title: summary.title,
    url: summary.url,
    summary: summary.summary,
    mainImage: summary.image, // one image only
    specs,
  };
}

/* -------------------------
   DOM helpers
------------------------- */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setHeroImage(url) {
  const hero = document.getElementById("heroImage");
  if (!hero) return;

  hero.classList.remove("skeleton");
  hero.innerHTML = url
    ? `<img src="${url}" alt="Ship photo" />`
    : `<div style="padding:12px;color:rgba(255,255,255,.6)">No image found.</div>`;
}

function renderSpecs(specs) {
  const grid = document.getElementById("specGrid");
  if (!grid) return;

  if (!specs || specs.length === 0) {
    grid.innerHTML = `<div class="muted">No extra specs found for this ship.</div>`;
    return;
  }

  grid.innerHTML = specs
    .slice(0, 18)
    .map(
      ([k, v]) => `
        <div class="spec-card">
          <div class="spec-k">${escapeHtml(k)}</div>
          <div class="spec-v">${escapeHtml(v)}</div>
        </div>
      `
    )
    .join("");
}

/* -------------------------
   Main
------------------------- */
(async function main() {
  const mmsi = qs("mmsi");
  if (!mmsi) {
    setText("shipName", "Missing MMSI");
    return;
  }

  // Always set MMSI immediately
  setText("factMmsi", String(mmsi));

  // Voyage card (optional endpoint; safe if missing)
  await loadVoyage(mmsi);

  // 1) Live data from backend
  let rec = null;
  try {
    rec = await fetchLastSeenRecord(mmsi);
  } catch (_) {
    // keep going; page still works with Wikipedia fallback
  }

  const name = rec?.name || `MMSI ${mmsi}`;
  const line = (rec?.line || "unknown").toUpperCase();

  setText("shipName", name);
  setText("shipMeta", `${line} • MMSI ${mmsi}`);

  setText("factLine", line);
  setText("factLastSeen", formatEasternTime(rec?.last_seen));
  setText("factShipLocal", formatShipLocalTime(rec?.last_seen, rec?.lon));
  setText("factSpeed", rec?.speed != null ? `${rec.speed} kn` : "—");
  setText(
    "factPos",
    rec?.lat != null && rec?.lon != null ? `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}` : "—"
  );

  // 2) Wikipedia profile + specs
  const summaryEl = document.getElementById("shipSummary");
  if (summaryEl) summaryEl.classList.remove("skeleton-lines");

  const wiki = await getWikipediaShipProfileWithSpecs(name);

  if (wiki) {
    setHtml("shipSummary", wiki.summary ? escapeHtml(wiki.summary) : "No description available.");
    setHeroImage(wiki.mainImage);

    const wikiLink = document.getElementById("wikiLink");
    if (wikiLink && wiki.url) wikiLink.href = wiki.url;

    renderSpecs(wiki.specs);
  } else {
    setHtml("shipSummary", "Couldn’t find a Wikipedia match for this ship name yet.");
    setHeroImage(null);
    renderSpecs([]);

    const wikiLink = document.getElementById("wikiLink");
    if (wikiLink) {
      wikiLink.href = `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(
        `${name} ship`
      )}`;
    }
  }
})();
