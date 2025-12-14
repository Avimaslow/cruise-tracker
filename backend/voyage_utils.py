import json
import math
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple

# IMPORTANT:
# server.py will pass TRACK_DIR into load_track_points(),
# so we do NOT hardcode paths here.


# ---------------------------
# Small utilities
# ---------------------------

def _to_float(x, default=None):
    try:
        if x is None:
            return default
        return float(x)
    except Exception:
        return default

def _parse_ts(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        # Handles "2025-12-14T01:14:54+00:00"
        return datetime.fromisoformat(ts)
    except Exception:
        return None


# ---------------------------
# Geo math
# ---------------------------

def haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    x = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return 2 * R * math.asin(math.sqrt(x))

def bearing_deg(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    # initial bearing from a->b in degrees [0,360)
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    brng = math.degrees(math.atan2(x, y))
    return (brng + 360) % 360

def angle_diff(a: float, b: float) -> float:
    d = abs((a - b) % 360)
    return min(d, 360 - d)

def heading_score(ship_course: Optional[float], ship_pos: Tuple[float, float], port_pos: Tuple[float, float]) -> float:
    """
    Returns a score in [0,1]. 1 = perfect heading match, 0 = opposite.
    """
    if ship_course is None:
        return 0.0
    try:
        brng = bearing_deg(ship_pos, port_pos)
        diff = angle_diff(float(ship_course), brng)
        return max(0.0, 1.0 - (diff / 180.0))
    except Exception:
        return 0.0


# ---------------------------
# Track loading
# ---------------------------

def load_track_points(mmsi: str, track_dir: Path, max_points: int = 6000) -> List[Dict[str, Any]]:
    """
    Loads points from backend/data/tracks/{mmsi}.jsonl
    Returns list of dicts: lat, lon, ts, speed, course, trip_id
    """
    fp = track_dir / f"{mmsi}.jsonl"
    if not fp.exists():
        return []

    pts = []
    with fp.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
                lat = _to_float(r.get("lat"))
                lon = _to_float(r.get("lon"))
                if lat is None or lon is None:
                    continue

                pts.append({
                    "lat": lat,
                    "lon": lon,
                    "ts": r.get("ts"),
                    "speed": _to_float(r.get("speed"), default=0.0),
                    "course": _to_float(r.get("course"), default=None),
                    "trip_id": r.get("trip_id"),
                })
            except Exception:
                continue

    if len(pts) > max_points:
        pts = pts[-max_points:]

    return pts


def get_latest_trip(points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not points:
        return []
    last_trip = None
    for p in points:
        if p.get("trip_id") is not None:
            last_trip = p.get("trip_id")
    if last_trip is None:
        return points
    return [p for p in points if p.get("trip_id") == last_trip]


# ---------------------------
# Port stop detection
# ---------------------------

def detect_port_stops(
    points: List[Dict[str, Any]],
    ports: List[Dict[str, Any]],
    near_km: float = 6.0,
    slow_kn: float = 1.2,
    min_dwell_min: int = 30,
) -> List[Dict[str, Any]]:
    """
    Finds port "stops" based on:
      - points near a port (<= near_km)
      - speed <= slow_kn (or, if speed missing, we treat as possible stop)
      - dwell >= min_dwell_min based on timestamps
    Returns a list of stops in time order.
    """
    if not points or not ports:
        return []

    pts = get_latest_trip(points)

    def nearest_port(lat, lon):
        best = None
        best_d = 1e9
        for prt in ports:
            d = haversine_km((lat, lon), (prt["lat"], prt["lon"]))
            if d < best_d:
                best_d = d
                best = prt
        return best, best_d

    stops = []
    current = None  # {port, start_ts, end_ts, min_dist_km}

    for p in pts:
        ts = _parse_ts(p.get("ts"))
        if not ts:
            continue

        port, dkm = nearest_port(p["lat"], p["lon"])
        if not port or dkm > near_km:
            # finalize current
            if current:
                dwell = (current["end_ts"] - current["start_ts"]).total_seconds() / 60.0
                if dwell >= min_dwell_min:
                    stops.append({
                        "name": current["port"]["name"],
                        "country": current["port"].get("country", ""),
                        "lat": current["port"]["lat"],
                        "lon": current["port"]["lon"],
                        "arrived_at": current["start_ts"].isoformat(),
                        "departed_at": current["end_ts"].isoformat(),
                        "dwell_minutes": int(round(dwell)),
                        "min_distance_km": round(current["min_dist_km"], 2),
                    })
                current = None
            continue

        speed = _to_float(p.get("speed"), default=0.0)
        slow = speed <= slow_kn

        if not slow:
            if current:
                dwell = (current["end_ts"] - current["start_ts"]).total_seconds() / 60.0
                if dwell >= min_dwell_min:
                    stops.append({
                        "name": current["port"]["name"],
                        "country": current["port"].get("country", ""),
                        "lat": current["port"]["lat"],
                        "lon": current["port"]["lon"],
                        "arrived_at": current["start_ts"].isoformat(),
                        "departed_at": current["end_ts"].isoformat(),
                        "dwell_minutes": int(round(dwell)),
                        "min_distance_km": round(current["min_dist_km"], 2),
                    })
                current = None
            continue

        # extend or start
        if current and current["port"]["name"] == port["name"]:
            current["end_ts"] = ts
            current["min_dist_km"] = min(current["min_dist_km"], dkm)
        else:
            current = {
                "port": port,
                "start_ts": ts,
                "end_ts": ts,
                "min_dist_km": dkm,
            }

    # finalize if ended in a stop
    if current:
        dwell = (current["end_ts"] - current["start_ts"]).total_seconds() / 60.0
        if dwell >= min_dwell_min:
            stops.append({
                "name": current["port"]["name"],
                "country": current["port"].get("country", ""),
                "lat": current["port"]["lat"],
                "lon": current["port"]["lon"],
                "arrived_at": current["start_ts"].isoformat(),
                "departed_at": current["end_ts"].isoformat(),
                "dwell_minutes": int(round(dwell)),
                "min_distance_km": round(current["min_dist_km"], 2),
            })

    return stops


# ---------------------------
# Next port prediction
# ---------------------------

def predict_next_port(
    last_point: Dict[str, Any],
    ports: List[Dict[str, Any]],
    max_km: float = 900.0,
    heading_weight: float = 0.65,
    distance_weight: float = 0.35,
) -> Optional[Dict[str, Any]]:
    """
    Candidate ports within max_km. Score combines:
      - heading match (if course is present) in [0,1]
      - distance score (closer is better) in [0,1]
    Returns the best port with metadata.
    """
    if not last_point or not ports:
        return None

    lat = _to_float(last_point.get("lat"))
    lon = _to_float(last_point.get("lon"))
    if lat is None or lon is None:
        return None

    course = _to_float(last_point.get("course"), default=None)

    candidates = []
    for p in ports:
        dkm = haversine_km((lat, lon), (p["lat"], p["lon"]))
        if dkm <= max_km:
            candidates.append((p, dkm))

    if not candidates:
        return None

    dmax = max(d for _, d in candidates) or 1.0

    best = None
    best_score = -1e9
    best_d = None
    best_hdiff = None

    for p, dkm in candidates:
        dist_score = 1.0 - (dkm / dmax)

        if course is not None:
            brng = bearing_deg((lat, lon), (p["lat"], p["lon"]))
            diff = angle_diff(course, brng)
            head_score = max(0.0, 1.0 - (diff / 180.0))
            score = heading_weight * head_score + distance_weight * dist_score
            hdiff = diff
        else:
            score = dist_score
            hdiff = None

        if score > best_score:
            best_score = score
            best = p
            best_d = dkm
            best_hdiff = hdiff

    return {
        "name": best["name"],
        "country": best.get("country", ""),
        "lat": best["lat"],
        "lon": best["lon"],
        "distance_km": round(best_d, 1) if best_d is not None else None,
        "heading_diff_deg": round(best_hdiff, 1) if best_hdiff is not None else None,
        "score": round(best_score, 3),
    }


def estimate_eta_hours(distance_km: Optional[float], speed_kn: Optional[float]) -> Optional[float]:
    """
    speed_kn in knots. 1 knot = 1.852 km/h.
    """
    if distance_km is None:
        return None
    try:
        s = float(speed_kn or 0.0)
        if s <= 2.0:
            return None
        kmph = s * 1.852
        return distance_km / kmph
    except Exception:
        return None


def confidence_score(points_count: int, has_last_port: bool, heading_known: bool) -> float:
    """
    Simple transparent confidence:
    - more points => better
    - if we detected a last port stop => better
    - if we have course => better
    """
    base = 0.35
    base += min(0.35, points_count / 1200.0)  # ramps up to +0.35
    if has_last_port:
        base += 0.15
    if heading_known:
        base += 0.10
    return round(min(0.95, base), 2)
