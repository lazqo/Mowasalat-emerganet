"""Wenak / وينك backend package.

Live information & demand-visibility layer for existing shared transport
lines (pilot: Irbid ↔ Bani Kinana). Not ride-hailing: no booking, no
dispatch, no fares.

Storage split (privacy architecture, enforced):
- MongoDB  : durable configuration/account data only (drivers, aggregate
             demand counters). Never movement data.
- Redis    : all realtime state (active trips, waiting requests, driver
             sessions, OTP challenges, rate-limit counters) with TTLs. It
             expires on its own and never becomes trip history.
- Backend never receives or stores raw GPS. Phones project their position
  onto a route corridor locally and send route/direction/progress/speed.
"""
