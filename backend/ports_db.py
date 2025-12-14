from __future__ import annotations
from pathlib import Path
import csv
from typing import Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent
PORTS_CSV = BASE_DIR / "data" / "ports.csv"

_ports_cache: Optional[List[Dict]] = None

def load_ports() -> List[Dict]:
    global _ports_cache
    if _ports_cache is not None:
        return _ports_cache

    ports: List[Dict] = []
    if not PORTS_CSV.exists():
        _ports_cache = []
        return _ports_cache

    with PORTS_CSV.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            # expected: name,country,lat,lon
            if len(row) < 4:
                continue
            name = (row[0] or "").strip()
            country = (row[1] or "").strip()
            try:
                lat = float(row[2])
                lon = float(row[3])
            except Exception:
                continue
            ports.append({"name": name, "country": country, "lat": lat, "lon": lon})

    _ports_cache = ports
    return ports

def query_ports(min_lat: float, min_lon: float, max_lat: float, max_lon: float, limit: int = 1200) -> List[Dict]:
    ports = load_ports()
    out: List[Dict] = []

    for p in ports:
        lat = p["lat"]
        lon = p["lon"]
        if (min_lat <= lat <= max_lat) and (min_lon <= lon <= max_lon):
            out.append(p)
            if len(out) >= limit:
                break

    return out
