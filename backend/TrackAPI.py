import asyncio
import json
import logging
import math
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import websocket
from dotenv import load_dotenv
from google.cloud import firestore

# ----------------------------
# Config / env
# ----------------------------
load_dotenv()

NEW_TRIP_GAP_HOURS = 6
NEW_TRIP_JUMP_KM = 150
MIN_POINT_DISTANCE_M = 200   # write a point if moved >= 200m
MIN_POINT_TIME_SEC = 60      # or at least every 60 seconds
MAX_REASONABLE_SOG = 80      # knots
OFFLINE_AFTER_MINUTES = 15

# ----------------------------
# Fleets (exact AIS names, uppercased)
# ----------------------------
LINE_FLEETS = {
    "royal": {
        "ICON OF THE SEAS","STAR OF THE SEAS","UTOPIA OF THE SEAS","WONDER OF THE SEAS","SYMPHONY OF THE SEAS",
        "HARMONY OF THE SEAS","OASIS OF THE SEAS","ALLURE OF THE SEAS","ODYSSEY OF THE SEAS","SPECTRUM OF THE SEAS",
        "QUANTUM OF THE SEAS","OVATION OF THE SEAS","ANTHEM OF THE SEAS","FREEDOM OF THE SEAS","LIBERTY OF THE SEAS",
        "INDEPENDENCE OF THE SEAS","VOYAGER OF THE SEAS","EXPLORER OF THE SEAS","ADVENTURE OF THE SEAS","NAVIGATOR OF THE SEAS",
        "MARINER OF THE SEAS","RADIANCE OF THE SEAS","BRILLIANCE OF THE SEAS","JEWEL OF THE SEAS","SERENADE OF THE SEAS",
        "VISION OF THE SEAS","GRANDEUR OF THE SEAS","RHAPSODY OF THE SEAS","ENCHANTMENT OF THE SEAS",
    },
    "carnival": {
        "CARNIVAL BREEZE","CARNIVAL CELEBRATION","CARNIVAL DREAM","CARNIVAL FANTASY","CARNIVAL HORIZON",
        "CARNIVAL LEGEND","CARNIVAL MAGIC","CARNIVAL MIRACLE","CARNIVAL PRIDE","CARNIVAL SPIRIT",
        "CARNIVAL SUNSHINE","CARNIVAL TRIUMPH","CARNIVAL VISTA","CARNIVAL JUBILEE","MARDI GRAS",
        "CARNIVAL PANORAMA","CARNIVAL CONQUEST","CARNIVAL GLORY","CARNIVAL VALOR","CARNIVAL ELATION",
        "CARNIVAL PARADISE","CARNIVAL RADIANCE","CARNIVAL FREEDOM","CARNIVAL SPLENDOR","CARNIVAL LUMINOSA",
        "CARNIVAL FIRENZE",
    },
    "ncl": {
        "NORWEGIAN BLISS","NORWEGIAN BREAKAWAY","NORWEGIAN DAWN","NORWEGIAN ENCORE","NORWEGIAN ESCAPE",
        "NORWEGIAN GEM","NORWEGIAN GETAWAY","NORWEGIAN JADE","NORWEGIAN JOY","NORWEGIAN PEARL",
        "NORWEGIAN PRIMA","NORWEGIAN SUN","NORWEGIAN SPIRIT","NORWEGIAN STAR","NORWEGIAN VIVA",
        "PRIDE OF AMERICA","NORWEGIAN EPIC",
    },
    "msc": {
        "MSC FANTASIA","MSC SPLENDIDA","MSC DIVINA","MSC PREZIOSA","MSC SEASIDE","MSC SEAVIEW","MSC SEASHORE",
        "MSC SEASCAPE","MSC GRANDIOSA","MSC EURIBIA","MSC VIRTUOSA","MSC WORLD EUROPA","MSC WORLD AMERICA",
        "MSC ORCHESTRA","MSC POESIA","MSC MAGNIFICA","MSC LIRICA","MSC MUSICA","MSC OPERA","MSC ARMONIA",
        "MSC MERAVIGLIA","MSC BELLISSIMA",
    },
    "virgin": {"SCARLET LADY","VALIANT LADY","RESILIENT LADY","BRILLIANT LADY"},
    "disney": {"DISNEY MAGIC","DISNEY WONDER","DISNEY DREAM","DISNEY FANTASY","DISNEY WISH","DISNEY TREASURE","DISNEY DESTINY","DISNEY ADVENTURE"},
}

# ----------------------------
# Runtime state (in-memory)
# ----------------------------
trip_state: Dict[str, Dict[str, Any]] = {}     # mmsi -> {"trip_id": int, "last_ts": str, "last_lat": float, "last_lon": float}
mmsi_registry: Dict[str, Dict[str, str]] = {}  # mmsi -> {"name": str, "line": str}

# ----------------------------
# Helpers
# ----------------------------
def utc_now() -> datetime:
    return datetime.now(timezone.utc)

def utc_now_iso() -> str:
    return utc_now().isoformat(timespec="seconds")

def normalize_name(name: str) -> str:
    safe = (name or "").replace("\x00", " ")
    return " ".join(safe.strip().upper().split())

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

def should_record_point(prev: Optional[Dict[str, Any]], lat: float, lon: float, ts_iso: str) -> bool:
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

def maybe_new_trip(prev: Optional[Dict[str, Any]], lat: float, lon: float, ts_iso: str) -> bool:
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

def find_line_for_ship(ship_name: str) -> Optional[str]:
    for line, fleet in LINE_FLEETS.items():
        if ship_name in fleet:
            return line
    return None

def firestore_client() -> firestore.Client:
    # Cloud Run uses Application Default Credentials automatically
    project = os.getenv("GOOGLE_CLOUD_PROJECT")
    return firestore.Client(project=project)

def fs_upsert_ship(db: firestore.Client, mmsi: str, fields: Dict[str, Any]) -> None:
    # ships/{mmsi}
    db.collection("ships").document(mmsi).set(fields, merge=True)

def fs_append_track_point(
    db: firestore.Client,
    mmsi: str,
    point: Dict[str, Any],
) -> None:
    # ships/{mmsi}/tracks/{autoId}
    db.collection("ships").document(mmsi).collection("tracks").add(point)

# ----------------------------
# Core worker (sync websocket loop)
# ----------------------------
def run_sync_worker() -> None:
    """
    Blocking loop:
    - connect to AISStream websocket
    - filter fleet ships
    - write last-seen + track points to Firestore
    - reconnect with backoff
    """
    logging.basicConfig(level=logging.INFO)

    api_key = os.getenv("AISSTREAM_API_KEY")
    if not api_key:
        # Don't crash the container instantly; log and retry in outer loop
        raise RuntimeError("AISSTREAM_API_KEY not set in environment (secret not mounted?)")

    db = firestore_client()

    backoff = 2

    def on_open(ws):
        logging.info("Connected to AISStream")
        subscribe_message = {
            "APIKey": api_key,
            "BoundingBoxes": [[[-90, -180], [90, 180]]],  # global
            "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
        }
        ws.send(json.dumps(subscribe_message))

    def on_message(ws, message):
        global mmsi_registry, trip_state

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

            prev = mmsi_registry.get(mmsi_str)
            if not prev or prev.get("name") != ship_name or prev.get("line") != line:
                mmsi_registry[mmsi_str] = {"name": ship_name, "line": line}
                fs_upsert_ship(db, mmsi_str, {
                    "mmsi": mmsi_str,
                    "name": ship_name,
                    "line": line,
                    "discovered_at": utc_now(),
                    "updated_at": utc_now(),
                })

            if prev is None:
                logging.info(f"[DISCOVERED] line={line}  MMSI={mmsi_str}  Name='{ship_name}'")

            return

        # 2) PositionReport -> update last_seen + write track points
        if mtype == "PositionReport":
            p = msg.get("PositionReport", {})
            mmsi = p.get("UserID")
            if not mmsi:
                return

            mmsi_str = str(mmsi)

            # Only track MMSIs we classified via static registry
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

            # Update last seen in Firestore
            fs_upsert_ship(db, mmsi_str, {
                "mmsi": mmsi_str,
                "name": name,
                "line": line,
                "lat": float(lat),
                "lon": float(lon),
                "speed": sog,
                "course": cog,
                "last_seen": ts,
                "last_seen_dt": utc_now(),
                "updated_at": utc_now(),
            })

            prev_state = trip_state.get(mmsi_str)

            # assign trip id
            if maybe_new_trip(prev_state, float(lat), float(lon), ts):
                trip_id = (prev_state["trip_id"] + 1) if prev_state else 1
            else:
                trip_id = prev_state["trip_id"]

            # write track point (sparser)
            if should_record_point(prev_state, float(lat), float(lon), ts):
                fs_append_track_point(db, mmsi_str, {
                    "mmsi": mmsi_str,
                    "trip_id": trip_id,
                    "ts": ts,
                    "ts_dt": utc_now(),
                    "lat": float(lat),
                    "lon": float(lon),
                    "sog": sog,
                    "cog": cog,
                })

            trip_state[mmsi_str] = {
                "trip_id": trip_id,
                "last_ts": ts,
                "last_lat": float(lat),
                "last_lon": float(lon),
            }

            logging.info(f"[{ts}] {name} [{line}] MMSI={mmsi_str} lat={lat:.6f} lon={lon:.6f} sog={sog} cog={cog}")

    def on_error(ws, error):
        logging.exception(f"WebSocket error: {error}")

    def on_close(ws, close_status_code, close_msg):
        logging.warning(f"Connection closed: code={close_status_code} msg={close_msg}")

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
            logging.info("Exiting (KeyboardInterrupt).")
            return
        except Exception as e:
            logging.exception(f"Run loop exception: {e}")

        logging.warning(f"Disconnected. Reconnecting in {backoff}s...")
        time.sleep(backoff)
        backoff = min(backoff * 2, 30)

# ----------------------------
# Async wrapper for FastAPI startup task
# ----------------------------
async def run_worker_forever():
    """
    Async wrapper used by worker_server.py startup event.
    Runs the blocking worker in a thread; auto-retries if it crashes.
    """
    while True:
        try:
            await asyncio.to_thread(run_sync_worker)
        except Exception as e:
            logging.exception(f"Worker crashed, retrying in 5s: {e}")
            await asyncio.sleep(5)

# ----------------------------
# Local run
# ----------------------------
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_worker_forever())
