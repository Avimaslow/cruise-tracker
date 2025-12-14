from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from google.cloud import firestore

# Collections:
# ships/{mmsi} -> last seen snapshot (name, line, lat, lon, speed, course, last_seen)
# ships/{mmsi}/tracks/{autoId} -> track points (trip_id, ts, lat, lon, sog, cog)

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def get_client() -> firestore.Client:
    # Uses Application Default Credentials on Cloud Run
    return firestore.Client()

def upsert_ship_last_seen(db: firestore.Client, mmsi: str, data: Dict[str, Any]) -> None:
    db.collection("ships").document(str(mmsi)).set(data, merge=True)

def append_track_point(
    db: firestore.Client,
    mmsi: str,
    trip_id: int,
    ts: str,
    lat: float,
    lon: float,
    sog: Optional[float],
    cog: Optional[float],
) -> None:
    doc = {
        "trip_id": int(trip_id),
        "ts": ts,
        "lat": float(lat),
        "lon": float(lon),
        "sog": sog,
        "cog": cog,
    }
    db.collection("ships").document(str(mmsi)).collection("tracks").add(doc)

def get_all_ships(db: firestore.Client) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for doc in db.collection("ships").stream():
        out[doc.id] = doc.to_dict() or {}
    return out

def get_track_points(
    db: firestore.Client,
    mmsi: str,
    mode: str = "current",
    limit: int = 20000,
) -> Tuple[Optional[int], List[List[Any]]]:
    """
    Returns (trip_id, points)
    - mode=current -> points for latest trip_id
    - mode=all     -> all points across all trips
    points format matches your existing API:
      current: [[lat, lon, ts], ...]
      all:     [[lat, lon, ts, trip_id], ...]
    """
    tracks_ref = (
        db.collection("ships")
        .document(str(mmsi))
        .collection("tracks")
        .order_by("ts")
        .limit(limit)
    )

    docs = list(tracks_ref.stream())
    if not docs:
        return None, []

    # find latest trip_id
    last_trip = None
    for d in docs:
        rec = d.to_dict() or {}
        last_trip = rec.get("trip_id", last_trip)

    points: List[List[Any]] = []
    for d in docs:
        rec = d.to_dict() or {}
        trip_id = rec.get("trip_id")
        if mode != "all" and trip_id != last_trip:
            continue

        lat = rec.get("lat")
        lon = rec.get("lon")
        ts = rec.get("ts")
        if lat is None or lon is None:
            continue

        if mode == "all":
            points.append([lat, lon, ts, trip_id])
        else:
            points.append([lat, lon, ts])

    return last_trip, points
