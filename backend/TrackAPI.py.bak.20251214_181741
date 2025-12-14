import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv
import websocket

# ----------------------------
# Paths / storage
# ----------------------------
BASE_DIR = Path(__file__).resolve().parent

DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

TRACK_DIR = DATA_DIR / "tracks"
TRACK_DIR.mkdir(parents=True, exist_ok=True)

STATE_FILE = BASE_DIR / "last_seen.json"          # last seen snapshot for API
REGISTRY_FILE = DATA_DIR / "mmsi_registry.json"   # MMSI -> {name,line} learned from ShipStaticData

# ----------------------------
# Config
# ----------------------------

load_dotenv()

API_KEY = os.getenv("AISSTREAM_API_KEY")

if not API_KEY:
    raise RuntimeError("AISSTREAM_API_KEY not set. Put it in .env or environment variables.")

NEW_TRIP_GAP_HOURS = 6
NEW_TRIP_JUMP_KM = 150
MIN_POINT_DISTANCE_M = 200   # write a point if moved >= 200m
MIN_POINT_TIME_SEC = 60      # or at least every 60 seconds
MAX_REASONABLE_SOG = 80      # knots

OFFLINE_AFTER_MINUTES = 15

# ----------------------------
# Fleets (exact AIS names, uppercased)
# NOTE: You can keep expanding these, or later replace with dynamic lookup.
# ----------------------------
LINE_FLEETS = {
    "royal": {
        "ICON OF THE SEAS",
        "STAR OF THE SEAS",
        "UTOPIA OF THE SEAS",
        "WONDER OF THE SEAS",
        "SYMPHONY OF THE SEAS",
        "HARMONY OF THE SEAS",
        "OASIS OF THE SEAS",
        "ALLURE OF THE SEAS",
        "ODYSSEY OF THE SEAS",
        "SPECTRUM OF THE SEAS",
        "QUANTUM OF THE SEAS",
        "OVATION OF THE SEAS",
        "ANTHEM OF THE SEAS",
        "FREEDOM OF THE SEAS",
        "LIBERTY OF THE SEAS",
        "INDEPENDENCE OF THE SEAS",
        "VOYAGER OF THE SEAS",
        "EXPLORER OF THE SEAS",
        "ADVENTURE OF THE SEAS",
        "NAVIGATOR OF THE SEAS",
        "MARINER OF THE SEAS",
        "RADIANCE OF THE SEAS",
        "BRILLIANCE OF THE SEAS",
        "JEWEL OF THE SEAS",
        "SERENADE OF THE SEAS",
        "VISION OF THE SEAS",
        "GRANDEUR OF THE SEAS",
        "RHAPSODY OF THE SEAS",
        "ENCHANTMENT OF THE SEAS",
    },

    "carnival": {
        "CARNIVAL BREEZE",
        "CARNIVAL CELEBRATION",
        "CARNIVAL DREAM",
        "CARNIVAL FANTASY",
        "CARNIVAL HORIZON",
        "CARNIVAL LEGEND",
        "CARNIVAL MAGIC",
        "CARNIVAL MIRACLE",
        "CARNIVAL PRIDE",
        "CARNIVAL SPIRIT",
        "CARNIVAL SUNSHINE",
        "CARNIVAL TRIUMPH",
        "CARNIVAL VISTA",
        "CARNIVAL JUBILEE",
        "MARDI GRAS",
        "CARNIVAL PANORAMA",
        "CARNIVAL CONQUEST",
        "CARNIVAL GLORY",
        "CARNIVAL VALOR",
        "CARNIVAL ELATION",
        "CARNIVAL PARADISE",
        "CARNIVAL RADIANCE",
        "CARNIVAL FREEDOM",
        "CARNIVAL SPLENDOR",
        "CARNIVAL LUMINOSA",
        "CARNIVAL FIRENZE",
    },

    "ncl": {
        "NORWEGIAN BLISS",
        "NORWEGIAN BREAKAWAY",
        "NORWEGIAN DAWN",
        "NORWEGIAN ENCORE",
        "NORWEGIAN ESCAPE",
        "NORWEGIAN GEM",
        "NORWEGIAN GETAWAY",
        "NORWEGIAN JADE",
        "NORWEGIAN JOY",
        "NORWEGIAN PEARL",
        "NORWEGIAN PRIMA",
        "NORWEGIAN SUN",
        "NORWEGIAN SPIRIT",
        "NORWEGIAN STAR",
        "NORWEGIAN VIVA",
        "PRIDE OF AMERICA",
        "NORWEGIAN EPIC",
    },

    "msc": {
        # keep MSC names uppercase consistently
        "MSC FANTASIA",
        "MSC SPLENDIDA",
        "MSC DIVINA",
        "MSC PREZIOSA",
        "MSC SEASIDE",
        "MSC SEAVIEW",
        "MSC SEASHORE",
        "MSC SEASCAPE",
        "MSC GRANDIOSA",
        "MSC EURIBIA",
        "MSC VIRTUOSA",
        "MSC WORLD EUROPA",
        "MSC WORLD AMERICA",
        "MSC ORCHESTRA",
        "MSC POESIA",
        "MSC MAGNIFICA",
        "MSC LIRICA",
        "MSC MUSICA",
        "MSC OPERA",
        "MSC ARMONIA",
        "MSC MERAVIGLIA",
        "MSC BELLISSIMA",
    },

    "virgin": {
        "SCARLET LADY",
        "VALIANT LADY",
        "RESILIENT LADY",
        "BRILLIANT LADY",
    },

    "disney": {
        "DISNEY MAGIC",
        "DISNEY WONDER",
        "DISNEY DREAM",
        "DISNEY FANTASY",
        "DISNEY WISH",
        "DISNEY TREASURE",
        "DISNEY DESTINY",
        "DISNEY ADVENTURE",
    },
}

# ----------------------------
# Runtime state
# ----------------------------
trip_state = {}     # mmsi(str) -> {"trip_id": int, "last_ts": str, "last_lat": float, "last_lon": float}
last_seen = {}      # mmsi(str) -> {name,line,lat,lon,speed,course,last_seen}
mmsi_registry = {}  # mmsi(str) -> {name,line} learned from static data (persisted)

# ----------------------------
# Helpers
# ----------------------------
def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def normalize_name(name: str) -> str:
    safe = (name or "").replace("\x00", " ")
    return " ".join(safe.strip().upper().split())

def parse_iso(ts: str):
    try:
        return datetime.fromisoformat(ts)
    except Exception:
        return None

def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def save_json_atomic(path: Path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

def should_record_point(prev, lat, lon, ts_iso):
    if not prev:
        return True

    try:
        prev_t = datetime.fromisoformat(prev["last_ts"])
        cur_t = datetime.fromisoformat(ts_iso)
        dt = (cur_t - prev_t).total_seconds()
    except Exception:
        dt = MIN_POINT_TIME_SEC

    dist_km = haversine_km(prev["last_lat"], prev["last_lon"], lat, lon)
    return (dt >= MIN_POINT_TIME_SEC) or (dist_km * 1000 >= MIN_POINT_DISTANCE_M)

def maybe_new_trip(prev, lat, lon, ts_iso):
    if not prev:
        return True

    try:
        prev_t = datetime.fromisoformat(prev["last_ts"])
        cur_t = datetime.fromisoformat(ts_iso)
        gap_hours = (cur_t - prev_t).total_seconds() / 3600
    except Exception:
        gap_hours = 0

    jump_km = haversine_km(prev["last_lat"], prev["last_lon"], lat, lon)
    return (gap_hours >= NEW_TRIP_GAP_HOURS) or (jump_km >= NEW_TRIP_JUMP_KM)

def append_track_point(mmsi_str, trip_id, ts, lat, lon, sog, cog):
    fp = TRACK_DIR / f"{mmsi_str}.jsonl"
    rec = {"mmsi": mmsi_str, "trip_id": trip_id, "ts": ts, "lat": lat, "lon": lon, "sog": sog, "cog": cog}
    with fp.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")

def find_line_for_ship(ship_name: str):
    # returns "royal"/"carnival"/... or None
    for line, fleet in LINE_FLEETS.items():
        if ship_name in fleet:
            return line
    return None

def startup_summary():
    if not last_seen:
        print("No saved last-seen state yet (first run).")
        return

    print(f"Loaded {len(last_seen)} last-seen entries from {STATE_FILE}")
    now = datetime.now(timezone.utc)

    def sort_key(item):
        _, rec = item
        dt = parse_iso(rec.get("last_seen") or "")
        return dt or datetime.min.replace(tzinfo=timezone.utc)

    recent = sorted(last_seen.items(), key=sort_key, reverse=True)[:10]
    for mmsi, rec in recent:
        ship = rec.get("name", "UNKNOWN")
        line = rec.get("line", "unknown")
        dt = parse_iso(rec.get("last_seen") or "")
        mins = (now - dt).total_seconds() / 60.0 if dt else None
        status = "OFFLINE" if mins is None or mins > OFFLINE_AFTER_MINUTES else "LIVE-ish"
        print(f"  {ship} [{line}] (MMSI {mmsi}) last_seen={rec.get('last_seen')} status={status}")

# ----------------------------
# WebSocket callbacks
# ----------------------------
def on_open(ws):
    print("Connected to AISStream")
    subscribe_message = {
        "APIKey": API_KEY,
        "BoundingBoxes": [[[-90, -180], [90, 180]]],  # global
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }
    ws.send(json.dumps(subscribe_message))

def on_message(ws, message):
    global last_seen, mmsi_registry

    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        return

    mtype = data.get("MessageType")
    msg = data.get("Message", {})

    # 1) ShipStaticData -> discover MMSI -> name (+ classify line)
    if mtype == "ShipStaticData":
        s = msg.get("ShipStaticData", {})
        mmsi = s.get("UserID")
        raw_name = s.get("Name")
        if not mmsi or not raw_name:
            return

        ship_name = normalize_name(raw_name)
        line = find_line_for_ship(ship_name)
        if not line:
            return  # ignore ships not in our tracked lines

        mmsi_str = str(mmsi)

        # persist registry
        prev_reg = mmsi_registry.get(mmsi_str)
        if not prev_reg or prev_reg.get("name") != ship_name or prev_reg.get("line") != line:
            mmsi_registry[mmsi_str] = {"name": ship_name, "line": line}
            save_json_atomic(REGISTRY_FILE, mmsi_registry)

        # ensure last_seen record exists early (before we get PositionReport)
        existing = last_seen.get(mmsi_str)
        if not existing:
            last_seen[mmsi_str] = {
                "name": ship_name,
                "line": line,
                "lat": None,
                "lon": None,
                "speed": None,
                "course": None,
                "last_seen": None,
            }
            save_json_atomic(STATE_FILE, last_seen)
        else:
            # update name/line only (don’t overwrite coords)
            last_seen[mmsi_str] = {**existing, "name": ship_name, "line": line}
            save_json_atomic(STATE_FILE, last_seen)

        # print once per MMSI discovery
        if prev_reg is None:
            print(f"[DISCOVERED] line={line}  MMSI={mmsi_str}  Name='{ship_name}'")

        return

    # 2) PositionReport -> update last_seen + write track points
    if mtype == "PositionReport":
        p = msg.get("PositionReport", {})
        mmsi = p.get("UserID")
        if not mmsi:
            return

        mmsi_str = str(mmsi)

        # Only track MMSIs that we've classified (from registry / static)
        reg = mmsi_registry.get(mmsi_str)
        if not reg:
            return

        lat = p.get("Latitude")
        lon = p.get("Longitude")
        sog = p.get("Sog")
        cog = p.get("Cog")

        if lat is None or lon is None:
            return
        if isinstance(sog, (int, float)) and sog > MAX_REASONABLE_SOG:
            return

        ts = utc_now_iso()
        name = reg["name"]
        line = reg["line"]

        # persist last seen snapshot
        last_seen[mmsi_str] = {
            "name": name,
            "line": line,
            "lat": lat,
            "lon": lon,
            "speed": sog,
            "course": cog,
            "last_seen": ts,
        }
        save_json_atomic(STATE_FILE, last_seen)

        prev = trip_state.get(mmsi_str)

        # assign trip id
        if maybe_new_trip(prev, lat, lon, ts):
            new_id = (prev["trip_id"] + 1) if prev else 1
        else:
            new_id = prev["trip_id"]

        # write track point
        if should_record_point(prev, lat, lon, ts):
            append_track_point(mmsi_str, new_id, ts, lat, lon, sog, cog)

        # update in-memory trip state
        trip_state[mmsi_str] = {"trip_id": new_id, "last_ts": ts, "last_lat": lat, "last_lon": lon}

        print(f"[{ts}] {name} [{line}] | MMSI: {mmsi_str} | Lat: {lat:.6f} | Lon: {lon:.6f} | Speed: {sog} | Course: {cog}")

def on_error(ws, error):
    print("Error:", error)

def on_close(ws, close_status_code, close_msg):
    print("Connection closed:", close_status_code, close_msg)

# ----------------------------
# Main
# ----------------------------
if __name__ == "__main__":
    if not API_KEY or "PASTE_YOUR_AISSTREAM_API_KEY_HERE" in API_KEY:
        raise SystemExit("Set AISSTREAM_API_KEY (env var) or edit API_KEY in the file.")

    # Load persisted state
    last_seen = load_json(STATE_FILE, {})
    mmsi_registry = load_json(REGISTRY_FILE, {})
    startup_summary()

    # reconnect loop
    backoff = 2
    while True:
        try:
            ws = websocket.WebSocketApp(
                "wss://stream.aisstream.io/v0/stream",
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            ws.run_forever()
        except KeyboardInterrupt:
            print("\nExiting.")
            break
        except Exception as e:
            print("Run loop exception:", e)

        print(f"Disconnected. Reconnecting in {backoff}s...")
        time.sleep(backoff)
        backoff = min(backoff * 2, 30)
