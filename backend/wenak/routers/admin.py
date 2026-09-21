from fastapi import APIRouter, Depends

from ..deps import get_store, require_admin
from ..state import RealtimeStore

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/state")
async def admin_state(store: RealtimeStore = Depends(get_store)):
    """Aggregate counts only. There is intentionally no endpoint that lists
    trips, waits or sessions."""
    return await store.counts()
