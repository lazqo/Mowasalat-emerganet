"""Phone number normalisation to E.164. Jordan (+962) is the default region."""
from __future__ import annotations

import phonenumbers
from phonenumbers import NumberParseException

DEFAULT_REGION = "JO"


def normalize_phone(raw: str) -> str:
    raw = (raw or "").strip()
    try:
        num = phonenumbers.parse(raw, DEFAULT_REGION)
    except NumberParseException as e:
        raise ValueError("Invalid phone number") from e
    if not phonenumbers.is_possible_number(num) or not phonenumbers.is_valid_number(num):
        raise ValueError("Invalid phone number")
    return phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164)


def mask_phone(e164: str) -> str:
    """For logs: keep country code and last 2 digits only."""
    if len(e164) < 6:
        return "***"
    return e164[:4] + "*" * (len(e164) - 6) + e164[-2:]
