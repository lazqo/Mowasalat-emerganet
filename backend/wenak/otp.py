"""OTP delivery providers behind one interface.

`OtpProvider.send(phone, code)` delivers a one-time code. The code itself is
generated, hashed and verified in `state.py`; providers only deliver.
Credentials are read from environment variables only.
"""
from __future__ import annotations

import logging
import secrets
from typing import Protocol

from .phone import mask_phone

logger = logging.getLogger(__name__)


def generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


class OtpProvider(Protocol):
    name: str

    async def send(self, phone: str, code: str) -> None: ...


class MockOtpProvider:
    """Development/test provider: nothing is sent. The code is logged at
    DEBUG only; the API returns it in non-production environments."""
    name = "mock"

    async def send(self, phone: str, code: str) -> None:
        logger.debug("[MOCK OTP] code for %s generated (not sent)", mask_phone(phone))


class TwilioOtpProvider:
    """Phase 3: SMS delivery through Twilio. Wired in when TWILIO_* secrets exist."""
    name = "twilio"

    def __init__(self) -> None:
        raise NotImplementedError(
            "Twilio OTP delivery is scheduled for Phase 3. Set OTP_PROVIDER=mock until then."
        )

    async def send(self, phone: str, code: str) -> None:  # pragma: no cover
        raise NotImplementedError


def build_provider(name: str) -> OtpProvider:
    if name == "mock":
        return MockOtpProvider()
    if name == "twilio":
        return TwilioOtpProvider()
    raise ValueError(f"Unknown OTP_PROVIDER: {name}")
