#  Cruise Tracker — Real-Time Global Cruise Ship Map

A real-time cruise ship tracking platform built with **AIS live data**, **FastAPI**, and a **modern Leaflet-based UI**.  
This project streams global AIS data, identifies cruise ships by line, tracks live movement and historical routes, and renders everything on a beautiful, interactive map.

**Live UI (local):**  
 http://127.0.0.1:5173

---

##  Features

-  **Live global cruise ship tracking** (AISStream WebSocket)
-  **Automatic cruise line detection**
  - Royal Caribbean
  - Carnival
  - Norwegian (NCL)
  - MSC
  - Virgin Voyages
  - Disney Cruise Line
-  **Modern, dark-themed interactive map**
-  **Route history per ship**
  - View **current voyage only**
  - Toggle to **full historical routes**
-  **Search + filter by cruise line**
-  **Auto-refreshing UI (every 5 seconds)**
-  **Efficient disk storage**
  - JSON snapshot for last-seen positions
  - JSONL append-only files for routes
-  **Environment-variable–based API key handling**

---

##  Architecture Overview

AISStream WebSocket │ ▼ Backend Tracker (Python)
* Filters cruise ships by line
* Writes route points to disk
* Maintains last-seen snapshot │ ▼ FastAPI Server
* /api/last-seen
* /api/track/{mmsi} │ ▼ Frontend (Vanilla JS + Leaflet)
* Live map rendering
* Route visualization
	•	Filters + search
---

##  Project Structure

CruiseSite/ ├── backend/ │ ├── tracker.py # AIS WebSocket + data ingestion │ ├── server.py # FastAPI API │ ├── last_seen.json # Live snapshot (ignored by git) │ └── data/ │ ├── tracks/ # Per-ship route history (.jsonl) │ └── mmsi_registry.json │ ├── web/ │ ├── index.html │ ├── styles.css │ └── app.js │ ├── .env # API key (NOT committed) ├── .gitignore └── README.md
---

##  Environment Setup (Required)

This project uses **environment variables** to protect API keys.

###  Create `.env`
```bash
touch .env
Add:
AISSTREAM_API_KEY=your_real_aisstream_key_here
 Never commit this file — it is ignored by .gitignore.

 Export the key to your shell
(macOS / Linux)
export AISSTREAM_API_KEY="your_real_aisstream_key_here"
(Optional: add this line to ~/.zshrc or ~/.bashrc)

 Backend Setup
 Create and activate virtual environment
cd backend
python3 -m venv .venv
source .venv/bin/activate
 Install dependencies
pip install fastapi uvicorn websocket-client

 Running the Project (3 terminals)
 Terminal 1 — Start AIS Tracker
Streams live AIS data and writes ship positions + routes.
cd backend
source .venv/bin/activate
python tracker.py
You should see output like:
[DISCOVERED] ICON OF THE SEAS [royal]
[2025-12-14T00:27:54+00:00] NORWEGIAN JADE [ncl] | Lat: ...

 Terminal 2 — Start FastAPI Server
Serves ship data to the frontend.
cd backend
source .venv/bin/activate
uvicorn server:app --reload --port 8000
API endpoints:
* GET /api/last-seen
* GET /api/track/{mmsi}?mode=current|all

 Terminal 3 — Start Frontend
Serves the UI.
cd web
python -m http.server 5173
 Open in browser:
http://127.0.0.1:5173

 How Route Tracking Works
* Ships are grouped into voyages ("trips")
* A new trip starts when:
    * Time gap ≥ 6 hours, or
    * Distance jump ≥ 150 km
* Only meaningful points are saved:
    * ≥ 200 meters moved OR
    * ≥ 60 seconds elapsed
* Routes are drawn using Leaflet polylines

 Security Notes
* API keys are never hardcoded
* .env is ignored by Git
* Live data files are excluded from version control
* Safe for public GitHub repositories

 Future Improvements
* Production deployment (Fly.io / Railway / AWS)
* Database-backed storage (Postgres)
* Playback timeline for routes
* Heatmaps of cruise traffic
* Mobile UI optimizations

 Author
Built by Avi Maslow Columbia University — Computer Science Focus: real-time systems, data pipelines, and clean visualizations

⭐ If you like this project
Give it a star ⭐ and feel free to fork or contribute!
