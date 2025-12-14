import asyncio
import logging
from fastapi import FastAPI

app = FastAPI()

# TrackAPI.py must NOT auto-run on import. It must expose run_worker_forever().
from TrackAPI import run_worker_forever

@app.get("/health")
def health():
    return {"ok": True}

@app.on_event("startup")
async def startup_event():
    logging.basicConfig(level=logging.INFO)
    logging.info("Starting AIS worker background task...")
    asyncio.create_task(run_worker_forever())
