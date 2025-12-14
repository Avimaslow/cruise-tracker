from datetime import datetime
from math import radians, sin, cos, sqrt, atan2

STOP_SPEED = 1.0          # knots
MIN_STOP_MIN = 45         # minutes
PORT_RADIUS_KM = 15
EARTH_KM = 6371.0

def haversine_km(a, b):
    lat1, lon1 = radians(a[0]), radians(a[1])
    lat2, lon2 = radians(b[0]), radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = sin(dlat/2)**2 + cos(lat1)*cos(lat2)*sin(dlon/2)**2
    return 2 * EARTH_KM * atan2(sqrt(h), sqrt(1-h))

def nearest_port(lat, lon, ports):
    best = None
    best_d = None
    for p in ports:
        d = haversine_km((lat, lon), (p["lat"], p["lon"]))
        if d <= PORT_RADIUS_KM and (best_d is None or d < best_d):
            best = p
            best_d = d
    return best

def detect_port_stops(points, ports):
    """
    points = [{lat, lon, ts, speed}]
    ports  = [{name, lat, lon}]
    """
    stops = []
    window = []

    for p in points:
        if p["speed"] <= STOP_SPEED:
            window.append(p)
        else:
            window.clear()

        if len(window) < 2:
            continue

        t0 = datetime.fromisoformat(window[0]["ts"])
        t1 = datetime.fromisoformat(window[-1]["ts"])
        minutes = (t1 - t0).total_seconds() / 60

        if minutes < MIN_STOP_MIN:
            continue

        center = (
            sum(x["lat"] for x in window) / len(window),
            sum(x["lon"] for x in window) / len(window),
        )

        port = nearest_port(center[0], center[1], ports)
        if not port:
            continue

        stops.append({
            "port": port["name"],
            "country": port["country"],
            "arrived": window[0]["ts"],
            "departed": window[-1]["ts"],
            "dwell_min": round(minutes),
        })

        window.clear()

    return stops
