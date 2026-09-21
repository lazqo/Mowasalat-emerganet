"""Uvicorn entrypoint (kept for the hosting platform): `uvicorn server:app`."""
from wenak.main import create_app

app = create_app()
