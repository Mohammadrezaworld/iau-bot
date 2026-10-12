"""
بررسی بازه سکوت گروه (به وقت تهران).
فعلاً ساعت‌ها ثابت هستن؛ بعداً از D1 خونده میشن.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

TEHRAN = ZoneInfo("Asia/Tehran")
QUIET_START_HOUR = 2   # ۰۲:۰۰
QUIET_END_HOUR = 6     # ۰۶:۰۰


def in_quiet_hours(now: datetime | None = None) -> bool:
    now = (now or datetime.now(TEHRAN)).astimezone(TEHRAN)
    return QUIET_START_HOUR <= now.hour < QUIET_END_HOUR
