from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import json
import csv

from voyage_utils import (
    load_track_points,
    detect_port_stops,
    predict_next_port,
    estimate_eta_hours,
    confidence_score,
)

BASE_DIR = Path(__file__).resolve().parent

STATE_FILE = BASE_DIR / "last_seen.json"
TRACK_DIR = BASE_DIR / "data" / "tracks"
TRACK_DIR.mkdir(parents=True, exist_ok=True)

PORTS_CSV = BASE_DIR / "data" / "ports.csv"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Ships: last seen + tracks
# ----------------------------

@app.get("/api/last-seen")
def api_last_seen():
    if not STATE_FILE.exists():
        return {"ships": {}}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    return {"ships": data}


@app.get("/api/track/{mmsi}")
def api_track(mmsi: str, mode: str = "current"):
    """
    mode=current -> only latest trip_id
    mode=all     -> all points across all trips
    """
    fp = TRACK_DIR / f"{mmsi}.jsonl"
    if not fp.exists():
        return {"mmsi": mmsi, "mode": mode, "points": [], "trip_id": None}

    last_trip = None

    # pass 1: find last trip id
    with fp.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
                last_trip = rec.get("trip_id", last_trip)
            except Exception:
                continue

    points = []

    # pass 2: collect points
    with fp.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                rec = json.loads(line)
                if mode == "all":
                    points.append([rec["lat"], rec["lon"], rec.get("ts"), rec.get("trip_id")])
                else:
                    if rec.get("trip_id") == last_trip:
                        points.append([rec["lat"], rec["lon"], rec.get("ts")])
            except Exception:
                continue

    return {
        "mmsi": mmsi,
        "mode": "all" if mode == "all" else "current",
        "trip_id": last_trip,
        "points": points,
    }


# ----------------------------
# Ports: cached CSV + bbox filter
# ----------------------------

_ports_cache = None

def _load_ports():
    global _ports_cache
    if _ports_cache is not None:
        return _ports_cache

    ports = []
    if not PORTS_CSV.exists():
        _ports_cache = ports
        return ports

    with PORTS_CSV.open("r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                name = (row.get("PORT_NAME") or "").strip()
                if not name:
                    continue
                ports.append({
                    "name": name,
                    "country": (row.get("COUNTRY") or "").strip(),
                    "lat": float(row["LATITUDE"]),
                    "lon": float(row["LONGITUDE"]),
                })
            except Exception:
                continue

    _ports_cache = ports
    return ports


@app.get("/api/ports")
def api_ports(
    min_lat: float = Query(...),
    min_lon: float = Query(...),
    max_lat: float = Query(...),
    max_lon: float = Query(...),
    limit: int = Query(1200, ge=1, le=5000),
):
    ports = _load_ports()
    out = []
    for p in ports:
        if min_lat <= p["lat"] <= max_lat and min_lon <= p["lon"] <= max_lon:
            out.append(p)
            if len(out) >= limit:
                break
    return {"count": len(out), "ports": out}


# ----------------------------
# Voyage: “Estimated Voyage” card
# ----------------------------

@app.get("/api/voyage/{mmsi}")
def api_voyage(mmsi: str):
    ports = _load_ports()
    points = load_track_points(mmsi, TRACK_DIR)

    if len(points) < 5 or not ports:
        return {
            "mmsi": str(mmsi),
            "last_port": None,
            "at_sea": None,
            "likely_next_port": None,
            "confidence": 0.0,
        }

    last = points[-1]
    stops = detect_port_stops(points, ports)
    last_port = stops[-1] if stops else None

    next_port = predict_next_port(last, ports, max_km=900.0)
    eta_hours = None
    if next_port:
        eta_hours = estimate_eta_hours(next_port.get("distance_km"), last.get("speed"))

    at_sea = {
        "speed_kn": float(last.get("speed") or 0.0),
        "course_deg": last.get("course"),
        "position": {"lat": last["lat"], "lon": last["lon"]},
        "ts": last.get("ts"),
    }

    # Attach ETA onto likely_next_port
    if next_port:
        next_port = {
            **next_port,
            "eta_hours": round(eta_hours, 1) if eta_hours is not None else None,
        }

    conf = confidence_score(
        points_count=len(points),
        has_last_port=(last_port is not None),
        heading_known=(last.get("course") is not None),
    )

    return {
        "mmsi": str(mmsi),
        "last_port": last_port,
        "at_sea": at_sea,
        "likely_next_port": next_port,
        "confidence": conf,
    }
