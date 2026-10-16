#!/usr/bin/env python3
"""
Завантажує приватний iCal-фід Google Calendar і зберігає зайняті проміжки в JSON.

З календаря на сайт потрапляє ЛИШЕ час початку й кінця подій:
жодних назв, описів, учасників чи посилань.

Налаштування через змінні середовища:
  ICAL_URL      — секретна адреса календаря в форматі iCal (обов'язково)
  CALENDAR_TZ   — твій часовий пояс, за замовчуванням Europe/Warsaw
  DAYS_BACK     — скільки днів назад зберігати, за замовчуванням 7
  DAYS_AHEAD    — на скільки днів уперед, за замовчуванням 92
  ALL_DAY_BUSY  — чи вважати події «на весь день» зайнятим часом (true/false), за замовчуванням true

Запуск:  python scripts/sync_calendar.py calendar/schedule.json
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import icalendar
import recurring_ical_events


DOTENV_PATH = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))


def load_dotenv(path=DOTENV_PATH):
    """Локально бере змінні з файлу .env у корені репозиторію.
    У GitHub Actions цього файлу немає — там змінні приходять із Secrets.
    Непорожні змінні, які вже задані в середовищі, не перезаписуються."""
    if not os.path.exists(path):
        return False
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):].strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if not os.environ.get(key):
                os.environ[key] = value
    return True


DOTENV_FOUND = load_dotenv()


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        sys.exit(f"Змінна {name} має бути числом")


ICAL_URL = os.environ.get("ICAL_URL", "").strip()
TZ = ZoneInfo(os.environ.get("CALENDAR_TZ", "Europe/Warsaw"))
DAYS_BACK = env_int("DAYS_BACK", 7)
DAYS_AHEAD = env_int("DAYS_AHEAD", 92)
ALL_DAY_BUSY = os.environ.get("ALL_DAY_BUSY", "true").strip().lower() == "true"
OUT_PATH = sys.argv[1] if len(sys.argv) > 1 else "calendar/schedule.json"


def fetch_ical(url):
    # Адресу навмисно ніде не друкуємо: вона секретна.
    req = urllib.request.Request(url, headers={"User-Agent": "calendar-sync"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"Не вдалося завантажити календар: HTTP {e.code}")
    except urllib.error.URLError:
        sys.exit("Не вдалося завантажити календар: помилка мережі")


def to_utc(value):
    """date / datetime з iCal → datetime в UTC."""
    if isinstance(value, datetime):
        if value.tzinfo is None:  # «плаваючий» час — вважаємо, що він у твоєму поясі
            value = value.replace(tzinfo=TZ)
        return value.astimezone(timezone.utc)
    # подія на весь день: початок дати у твоєму часовому поясі
    return datetime.combine(value, time.min, tzinfo=TZ).astimezone(timezone.utc)


def event_end(event, start):
    if "DTEND" in event:
        return event.decoded("DTEND")
    if "DURATION" in event:
        return start + event.decoded("DURATION")
    # За стандартом iCal: подія на весь день без кінця триває один день
    return start + timedelta(days=1) if not isinstance(start, datetime) else start


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    if not ICAL_URL:
        if os.environ.get("GITHUB_ACTIONS"):
            sys.exit("Не задано ICAL_URL: додай секрет у Settings → Secrets and variables → Actions")
        if DOTENV_FOUND:
            sys.exit(f"Файл {DOTENV_PATH} знайдено, але в ньому немає рядка ICAL_URL=... (перевір назву змінної)")
        sys.exit(f"Не знайдено файл {DOTENV_PATH} — створи його з рядком ICAL_URL=...")

    today = datetime.now(TZ).date()
    window_start = datetime.combine(today - timedelta(days=DAYS_BACK), time.min, tzinfo=TZ)
    window_end = datetime.combine(today + timedelta(days=DAYS_AHEAD), time.min, tzinfo=TZ)

    calendar = icalendar.Calendar.from_ical(fetch_ical(ICAL_URL))
    # Розгортаємо повторювані події (щотижневі уроки тощо) у конкретні дати
    occurrences = recurring_ical_events.of(calendar).between(window_start, window_end)

    intervals = []
    for event in occurrences:
        if str(event.get("STATUS", "")).upper() == "CANCELLED":
            continue
        if str(event.get("TRANSP", "")).upper() == "TRANSPARENT":  # подія позначена як «вільний»
            continue

        start = event.decoded("DTSTART")
        all_day = isinstance(start, date) and not isinstance(start, datetime)
        if all_day and not ALL_DAY_BUSY:
            continue

        s = to_utc(start)
        e = to_utc(event_end(event, start))
        # обрізаємо по вікну
        s = max(s, window_start.astimezone(timezone.utc))
        e = min(e, window_end.astimezone(timezone.utc))
        if e > s:
            intervals.append([s, e])

    # Зливаємо проміжки, що перетинаються, — щоб не видавати кількість і межі окремих подій
    intervals.sort()
    merged = []
    for s, e in intervals:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    data = {
        "timezone": str(TZ),
        "generatedAt": iso(datetime.now(timezone.utc)),
        "range": {"from": iso(window_start), "to": iso(window_end)},
        "busy": [{"start": iso(s), "end": iso(e)} for s, e in merged],
    }

    os.makedirs(os.path.dirname(OUT_PATH) or ".", exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"Збережено {len(merged)} зайнятих проміжків у {OUT_PATH}")


if __name__ == "__main__":
    main()
