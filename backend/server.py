from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import json

BASE_DIR = Path(__file__).resolve().parent

STATE_FILE = BASE_DIR / "last_seen.json"      # <-- IMPORTANT: now using last_seen.json
TRACK_DIR = BASE_DIR / "data" / "tracks"      # <-- IMPORTANT: matches TrackAPI.py output
TRACK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
                    points.append([rec["lat"], rec["lon"], rec["ts"], rec.get("trip_id")])
                else:
                    if rec.get("trip_id") == last_trip:
                        points.append([rec["lat"], rec["lon"], rec["ts"]])
            except Exception:
                continue

    return {
        "mmsi": mmsi,
        "mode": "all" if mode == "all" else "current",
        "trip_id": last_trip,
        "points": points,
    }
