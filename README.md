# Cruise Tracker — Real-Time Global Cruise Ship Tracking Platform

A production-ready, real-time cruise ship tracking platform built on **live AIS data**, **FastAPI**, and **Google Cloud Run**.

This system continuously ingests global AIS messages, automatically identifies cruise ships by line, tracks live positions and voyage routes, and exposes the data via a scalable API for map-based visualization.

---

##  Live Architecture (Production)

```
AISStream WebSocket (Global AIS)	
        │	
        ▼	
Cloud Run Worker (Always-On)
  - Persistent WebSocket connection
  - Filters cruise ships by line
  - Writes live positions to Firestore
  - Appends voyage tracks	
        │	
        ▼	
Cloud Run Backend API (FastAPI)
  /api/last-seen
  /api/track/{mmsi}	
        │	
        ▼	
Frontend (Leaflet Map UI)
  Live positions
  Routes + filters
```

---

##  Key Features

###  Live Cruise Ship Tracking

* Real-time global AISStream WebSocket ingestion
* Continuous background worker (Cloud Run)
* Automatic cruise ship detection and classification

###  Supported Cruise Lines

* Royal Caribbean
* Carnival
* Norwegian (NCL)
* MSC Cruises
* Virgin Voyages
* Disney Cruise Line

###  Interactive Map Experience

* Live ship positions
* Route visualization per ship
* Toggle between:

  * Current voyage only
  * Full historical tracks
* Search by ship name
* Filter by cruise line
* Auto-refreshing UI

###  Smart Route Tracking

* Ships grouped into **voyages (trips)**
* New voyage starts when:

  * ≥ 6 hours of inactivity **or**
  * ≥ 150 km position jump
* Efficient storage:

  * Points saved only if:

    * ≥ 200 meters moved **or**
    * ≥ 60 seconds elapsed

---

##  Project Structure

```
cruise-tracker/
├── backend/
│   ├── server.py            # FastAPI backend (Cloud Run)
│   ├── TrackAPI.py          # AIS ingestion + worker logic
│   ├── firestore_db.py      # Firestore read/write helpers
│   ├── requirements.txt
│   └── Dockerfile
│
├── web/
│   ├── index.html           # Frontend UI
│   ├── styles.css
│   └── app.js
│
├── .gitignore
└── README.md
```

---

##  Cloud Deployment (Current Setup)

### Backend API

* **Google Cloud Run**
* Public HTTP service
* Stateless FastAPI application
* Auto-scales on demand

### AIS Worker

* **Google Cloud Run (background worker)**
* `min-instances = 1` (always running)
* Maintains live WebSocket connection
* CPU throttling enabled for cost efficiency

### Data Storage

* **Firestore (Native mode)**

  * Ship metadata
  * Last-seen positions
  * Voyage track points

### Secrets

* **Google Secret Manager**

  * `AISSTREAM_API_KEY`
* No API keys committed to GitHub

---

##  Security & Safety

* No credentials hardcoded
* Secrets injected at runtime
* Firestore access via service account
* Worker service is **not publicly invokable**
* Safe for public GitHub repositories

---

##  API Endpoints

### Get Live Ship Positions

```
GET /api/last-seen
```

Returns all discovered cruise ships with latest known positions.

---

### Get Ship Route

```
GET /api/track/{mmsi}?mode=current|all
```

* `current` → current voyage only
* `all` → full historical track

---

##  Local Development (Optional)

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --reload
```

### Worker (local testing)

```bash
export AISSTREAM_API_KEY="your_key_here"
python TrackAPI.py
```

### Frontend

```bash
cd web
python -m http.server 5173
```

---

##  Cost Awareness

This system is designed to be **cheap to run**:

* Cloud Run worker (0.25 CPU, 512MB, throttled)
* Firestore free tier
* No VMs

**Typical cost:** ~$7–9/month
Billing alerts recommended (and configured).

---

##  Future Improvements

* Playback timeline for voyages
* Port arrival/departure detection
* Heatmaps of cruise traffic
* PostgreSQL or BigQuery analytics
* Mobile UI optimization
* Authentication + saved views

---

##  Author

**Avi Maslow**
Columbia University — Computer Science
Focus: real-time systems, cloud architecture, data pipelines, and visualization

---

⭐ If you like this project, feel free to **star**, **fork**, or build on it.

---


