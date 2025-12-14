import json
import math
import os
import time
from datetime import datetime, timezone

import websocket
from google.cloud import firestore

from firestore_db import get_client, upsert_ship_last_seen, append_track_point

API_KEY = os.getenv("AISSTREAM_API_KEY")
if not API_KEY:
    raise RuntimeError("AISSTREAM_API_KEY not set")

NEW_TRIP_GAP_HOURS = 6
NEW_TRIP_JUMP_KM = 150
MIN_POINT_DISTANCE_M = 200
MIN_POINT_TIME_SEC = 60
MAX_REASONABLE_SOG = 80
OFFLINE_AFTER_MINUTES = 15

LINE_FLEETS = {
    "royal": {"ICON OF THE SEAS","STAR OF THE SEAS","UTOPIA OF THE SEAS","WONDER OF THE SEAS","SYMPHONY OF THE SEAS","HARMONY OF THE SEAS","OASIS OF THE SEAS","ALLURE OF THE SEAS","ODYSSEY OF THE SEAS","SPECTRUM OF THE SEAS","QUANTUM OF THE SEAS","OVATION OF THE SEAS","ANTHEM OF THE SEAS","FREEDOM OF THE SEAS","LIBERTY OF THE SEAS","INDEPENDENCE OF THE SEAS","VOYAGER OF THE SEAS","EXPLORER OF THE SEAS","ADVENTURE OF THE SEAS","NAVIGATOR OF THE SEAS","MARINER OF THE SEAS","RADIANCE OF THE SEAS","BRILLIANCE OF THE SEAS","JEWEL OF THE SEAS","SERENADE OF THE SEAS","VISION OF THE SEAS","GRANDEUR OF THE SEAS","RHAPSODY OF THE SEAS","ENCHANTMENT OF THE SEAS"},
    "carnival": {"CARNIVAL BREEZE","CARNIVAL CELEBRATION","CARNIVAL DREAM","CARNIVAL FANTASY","CARNIVAL HORIZON","CARNIVAL LEGEND","CARNIVAL MAGIC","CARNIVAL MIRACLE","CARNIVAL PRIDE","CARNIVAL SPIRIT","CARNIVAL SUNSHINE","CARNIVAL TRIUMPH","CARNIVAL VISTA","CARNIVAL JUBILEE","MARDI GRAS","CARNIVAL PANORAMA","CARNIVAL CONQUEST","CARNIVAL GLORY","CARNIVAL VALOR","CARNIVAL ELATION","CARNIVAL PARADISE","CARNIVAL RADIANCE","CARNIVAL FREEDOM","CARNIVAL SPLENDOR","CARNIVAL LUMINOSA","CARNIVAL FIRENZE"},
    "ncl": {"NORWEGIAN BLISS","NORWEGIAN BREAKAWAY","NORWEGIAN DAWN","NORWEGIAN ENCORE","NORWEGIAN ESCAPE","NORWEGIAN GEM","NORWEGIAN GETAWAY","NORWEGIAN JADE","NORWEGIAN JOY","NORWEGIAN PEARL","NORWEGIAN PRIMA","NORWEGIAN SUN","NORWEGIAN SPIRIT","NORWEGIAN STAR","NORWEGIAN VIVA","PRIDE OF AMERICA","NORWEGIAN EPIC"},
    "msc": {"MSC FANTASIA","MSC SPLENDIDA","MSC DIVINA","MSC PREZIOSA","MSC SEASIDE","MSC SEAVIEW","MSC SEASHORE","MSC SEASCAPE","MSC GRANDIOSA","MSC EURIBIA","MSC VIRTUOSA","MSC WORLD EUROPA","MSC WORLD AMERICA","MSC ORCHESTRA","MSC POESIA","MSC MAGNIFICA","MSC LIRICA","MSC MUSICA","MSC OPERA","MSC ARMONIA","MSC MERAVIGLIA","MSC BELLISSIMA"},
    "virgin": {"SCARLET LADY","VALIANT LADY","RESILIENT LADY","BRILLIANT LADY"},
    "disney": {"DISNEY MAGIC","DISNEY WONDER","DISNEY DREAM","DISNEY FANTASY","DISNEY WISH","DISNEY TREASURE","DISNEY DESTINY","DISNEY ADVENTURE"},
}

trip_state = {}     # mmsi -> {trip_id,last_ts,last_lat,last_lon}
mmsi_registry = {}  # mmsi -> {name,line}

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def normalize_name(name: str) -> str:
    safe = (name or "").replace("\x00", " ")
    return " ".join(safe.strip().upper().split())

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

def find_line_for_ship(ship_name: str):
    for line, fleet in LINE_FLEETS.items():
        if ship_name in fleet:
            return line
    return None

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

def on_open(ws):
    print("Connected to AISStream")
    ws.send(json.dumps({
        "APIKey": API_KEY,
        "BoundingBoxes": [[[-90, -180], [90, 180]]],
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }))

def on_message(ws, message):
    global mmsi_registry, trip_state
    db = get_client()

    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        return

    mtype = data.get("MessageType")
    msg = data.get("Message", {})

    if mtype == "ShipStaticData":
        s = msg.get("ShipStaticData", {})
        mmsi = s.get("UserID")
        raw_name = s.get("Name")
        if not mmsi or not raw_name:
            return

        name = normalize_name(raw_name)
        line = find_line_for_ship(name)
        if not line:
            return

        mmsi_str = str(mmsi)
        mmsi_registry[mmsi_str] = {"name": name, "line": line}
        upsert_ship_last_seen(db, mmsi_str, {
            "name": name,
            "line": line,
            "lat": None,
            "lon": None,
            "speed": None,
            "course": None,
            "last_seen": None,
        })
        return

    if mtype == "PositionReport":
        p = msg.get("PositionReport", {})
        mmsi = p.get("UserID")
        if not mmsi:
            return
        mmsi_str = str(mmsi)

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

        upsert_ship_last_seen(db, mmsi_str, {
            "name": name,
            "line": line,
            "lat": lat,
            "lon": lon,
            "speed": sog,
            "course": cog,
            "last_seen": ts,
        })

        prev = trip_state.get(mmsi_str)
        if maybe_new_trip(prev, lat, lon, ts):
            trip_id = (prev["trip_id"] + 1) if prev else 1
        else:
            trip_id = prev["trip_id"]

        if should_record_point(prev, lat, lon, ts):
            append_track_point(db, mmsi_str, trip_id, ts, lat, lon, sog, cog)

        trip_state[mmsi_str] = {"trip_id": trip_id, "last_ts": ts, "last_lat": lat, "last_lon": lon}

        print(f"[{ts}] {name} [{line}] MMSI={mmsi_str} lat={lat} lon={lon} sog={sog} cog={cog}")

def on_error(ws, error):
    print("Error:", error)

def on_close(ws, code, msg):
    print("Closed:", code, msg)

def main():
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
        except Exception as e:
            print("Worker exception:", e)

        print(f"Reconnecting in {backoff}s...")
        time.sleep(backoff)
        backoff = min(backoff * 2, 30)

if __name__ == "__main__":
    main()
