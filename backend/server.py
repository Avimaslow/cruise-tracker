from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from firestore_db import get_client, get_all_ships, get_track_points
from ports_db import query_ports  




from voyage_utils import (
    detect_port_stops,
    predict_next_port,
    estimate_eta_hours,
    confidence_score,
)











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

@app.get("/api/ports")
def api_ports(
    min_lat: float = Query(...),
    min_lon: float = Query(...),
    max_lat: float = Query(...),
    max_lon: float = Query(...),
    limit: int = Query(1200, ge=1, le=5000),
):
    ports = query_ports(min_lat, min_lon, max_lat, max_lon, limit)
    return {"ports": ports}































@app.get("/api/voyage/{mmsi}")
def api_voyage(mmsi: str, mode: str = "current"):
    db = get_client()

    # ---- live ship record ----
    ships = get_all_ships(db) or {}
    rec = ships.get(str(mmsi), {}) if isinstance(ships, dict) else {}

    ship_lat = rec.get("lat")
    ship_lon = rec.get("lon")
    ship_speed = rec.get("speed")
    ship_course = rec.get("course")

    # ---- track points from Firestore ----
    trip_id, raw_points = get_track_points(db, mmsi=mmsi, mode=mode)

    # Your /api/track returns points as arrays (frontend uses [lat, lon, ...]).
    # We'll normalize to voyage_utils format.
    points = []
    for p in (raw_points or []):
        try:
            # expected: [lat, lon, ts, sog, cog] (or similar)
            lat = p[0] if len(p) > 0 else None
            lon = p[1] if len(p) > 1 else None
            ts  = p[2] if len(p) > 2 else None
            sog = p[3] if len(p) > 3 else None
            cog = p[4] if len(p) > 4 else None

            if lat is None or lon is None:
                continue

            points.append({
                "lat": float(lat),
                "lon": float(lon),
                "ts": ts,
                "speed": float(sog) if sog is not None else 0.0,
                "course": float(cog) if cog is not None else None,
                "trip_id": trip_id,
            })
        except Exception:
            continue

    # pick a "last point" for prediction
    last_point = points[-1] if points else None

    # If we don't have a live position (rare), fall back to last track point
    if ship_lat is None and last_point:
        ship_lat = last_point["lat"]
    if ship_lon is None and last_point:
        ship_lon = last_point["lon"]

    # ---- ports near the ship (bbox query using your existing /api/ports logic) ----
    ports = []
    if ship_lat is not None and ship_lon is not None:
        try:
            lat = float(ship_lat)
            lon = float(ship_lon)

            # ~6 degrees is a decently wide search region for port inference
            PAD = 6.0
            min_lat = max(-90.0, lat - PAD)
            max_lat = min(90.0,  lat + PAD)
            min_lon = max(-180.0, lon - PAD)
            max_lon = min(180.0,  lon + PAD)

            ports = query_ports(min_lat, min_lon, max_lat, max_lon, limit=1200) or []
        except Exception:
            ports = []

    # ---- detect last port stop ----
    stops = detect_port_stops(points, ports) if points and ports else []
    last_port = stops[-1] if stops else None

    # ---- predict next port ----
    next_port = None
    eta_h = None
    if last_point and ports:
        next_port = predict_next_port(last_point, ports)

        # use live speed if available, else last_point speed
        sp = ship_speed if ship_speed is not None else last_point.get("speed")
        eta_h = estimate_eta_hours(
            next_port.get("distance_km") if next_port else None,
            sp,
        )

    # ---- confidence ----
    conf = confidence_score(
        points_count=len(points),
        has_last_port=bool(last_port),
        heading_known=bool(last_point and last_point.get("course") is not None),
    )

    return {
        "mmsi": str(mmsi),
        "trip_id": trip_id,
        "last_port": last_port,  # {name, arrived_at, departed_at, ...} or null
        "at_sea": {
            "speed_kn": ship_speed,
            "course_deg": ship_course,
        },
        "likely_next_port": (
            {"name": next_port["name"], "eta_hours": eta_h} if next_port else None
        ),
        "confidence": conf,
    }
