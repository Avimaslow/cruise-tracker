from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from firestore_db import get_client, get_all_ships, get_track_points

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)



@app.get("/")
def root():
    return {"ok": True, "service": "cruise-backend"}







@app.get("/api/last-seen")
def api_last_seen():
    db = get_client()
    ships = get_all_ships(db)
    return {"ships": ships}

@app.get("/api/track/{mmsi}")
def api_track(mmsi: str, mode: str = "current"):
    db = get_client()
    trip_id, points = get_track_points(db, mmsi=mmsi, mode=mode)
    return {
        "mmsi": str(mmsi),
        "mode": "all" if mode == "all" else "current",
        "trip_id": trip_id,
        "points": points,
    }

# keep your existing /api/ports and /api/voyage routes if you want:
# You can paste them below unchanged OR we can move ports to Firestore later.
