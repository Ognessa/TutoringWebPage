/**
 * <my-calendar> — календар вільних годин репетитора.
 *
 * Використання:
 *   <script type="module" src="calendar/my-calendar.js"></script>
 *   <my-calendar
 *       src="calendar/schedule.json"
 *       work-hours="mon-fri 15:00-20:00; sat 10:00-14:00"
 *       slot-minutes="60"
 *       timezone="Europe/Warsaw"
 *       view="week">
 *   </my-calendar>
 *
 * Атрибути:
 *   src           — JSON з зайнятими проміжками (генерує scripts/sync_calendar.py)
 *   work-hours    — твої робочі години у ТВОЄМУ часовому поясі.
 *                   Формат: "дні час-час, час-час; дні час-час"
 *                   Дні: mon tue wed thu fri sat sun, діапазони "mon-fri", списки "mon,wed".
 *   slot-minutes  — тривалість одного вікна, хв (за замовчуванням 60)
 *   timezone      — твій часовий пояс (за замовчуванням береться з JSON, інакше Europe/Warsaw)
 *   view          — вид за замовчуванням: day | week | month (week)
 *
 * Кольори й шрифт налаштовуються CSS-змінними ззовні, наприклад у styles.css:
 *   my-calendar { --cal-free: #FFD4BC; --cal-accent: #1F6B54; }
 * Повний список змінних — у блоці :host нижче.
 */

const LOCALE = 'uk';
const DAY_MS = 86400000;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const VIEWS = [
  { id: 'day', label: 'День' },
  { id: 'week', label: 'Тиждень' },
  { id: 'month', label: 'Місяць' },
];

/* ---------- Дати й часові пояси ---------- */

const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfWeek = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // тиждень з понеділка
const timeLabel = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const fmtCache = new Map();
function fmt(options) {
  const key = JSON.stringify(options);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(LOCALE, options));
  return fmtCache.get(key);
}

/** «Пʼятниця, 16 жовтня». День тижня форматуємо окремо, щоб він був у називному відмінку. */
const dayTitle = (d) => `${cap(fmt({ weekday: 'long' }).format(d))}, ${fmt({ day: 'numeric', month: 'long' }).format(d)}`;

/** Зсув часового поясу tz відносно UTC (у хвилинах) у момент date. */
function tzOffset(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Годинник у поясі tz (рік, місяць, день, хв від півночі) → абсолютний момент часу. */
function zonedToDate(y, m, d, minutes, tz) {
  const guess = Date.UTC(y, m, d, 0, minutes);
  let result = guess - tzOffset(new Date(guess), tz) * 60000;
  const corrected = guess - tzOffset(new Date(result), tz) * 60000; // поправка на перехід літній/зимовий час
  if (corrected !== result) result = corrected;
  return new Date(result);
}

/* ---------- Розбір атрибута work-hours ---------- */

function parseDays(spec) {
  const days = new Set();
  for (const part of spec.toLowerCase().split(',')) {
    const [a, b] = part.trim().split('-').map((s) => DAY_KEYS.indexOf(s.trim()));
    if (a < 0) continue;
    if (b === undefined) { days.add(a); continue; }
    if (b < 0) continue;
    for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (i === b) break; }
  }
  return days;
}

function parseMinutes(hhmm) {
  const [h, m = '0'] = hhmm.trim().split(':');
  return Number(h) * 60 + Number(m);
}

/** "mon-fri 15:00-20:00; sat 10:00-14:00" → { 1: [[900,1200]], ..., 6: [[600,840]] } */
function parseWorkHours(value) {
  const map = {};
  for (const rule of (value || '').split(';')) {
    const trimmed = rule.trim();
    if (!trimmed) continue;
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace < 0) continue;
    const days = parseDays(trimmed.slice(0, firstSpace));
    const ranges = trimmed.slice(firstSpace + 1).split(',').map((r) => {
      const [from, to] = r.split('-');
      return [parseMinutes(from), parseMinutes(to)];
    }).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a);
    for (const day of days) (map[day] ||= []).push(...ranges);
  }
  return map;
}

/* ---------- Українські множини ---------- */

function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

/* ---------- Компонент ---------- */

const STYLE = `
:host {
  /* Налаштування вигляду — їх можна перевизначити ззовні */
  --cal-font: inherit;
  --cal-ink: #23302B;
  --cal-muted: #4D5E57;
  --cal-card: #FFFFFF;
  --cal-surface: #FBF8F4;
  --cal-accent: #1F6B54;
  --cal-accent-ink: #FFFFFF;
  --cal-mint: #C8EBDC;
  --cal-free: #FFD4BC;
  --cal-busy: #E6EEEA;
  --cal-line: #CBD6D0;
  --cal-border: #23302B;
  --cal-radius: 24px;

  display: block;
  container-type: inline-size;
  font-family: var(--cal-font);
  color: var(--cal-ink);
}
* { box-sizing: border-box; }
button, input { font: inherit; color: inherit; }

.card {
  background: var(--cal-card);
  border: 2px solid var(--cal-border);
  border-radius: var(--cal-radius);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Шапка */
.toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.title { margin: 0; font-size: 20px; font-weight: 700; line-height: 1.3; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.nav, .views { display: flex; gap: 6px; }
.btn {
  min-height: 40px;
  padding: 8px 14px;
  border: 2px solid var(--cal-border);
  border-radius: 999px;
  background: var(--cal-card);
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
}
.btn:hover { background: var(--cal-surface); }
.btn:focus-visible, .date:focus-visible, .mcell:focus-visible { outline: 3px solid var(--cal-accent); outline-offset: 2px; }
.btn[disabled] { opacity: .45; cursor: default; }
.btn.icon { width: 40px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.views { background: var(--cal-surface); border: 2px solid var(--cal-border); border-radius: 999px; padding: 3px; }
.views .btn { border: 0; min-height: 34px; padding: 6px 14px; background: transparent; }
.views .btn[aria-pressed="true"] { background: var(--cal-accent); color: var(--cal-accent-ink); }
.date {
  min-height: 40px;
  padding: 6px 12px;
  border: 2px solid var(--cal-border);
  border-radius: 999px;
  background: var(--cal-card);
  font-size: 15px;
  color-scheme: light;
}
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* Повідомлення */
.note { margin: 0; padding: 14px 16px; border-radius: 16px; background: var(--cal-surface); color: var(--cal-muted); }
.note.error { background: #FDE8E4; color: #7A2E1F; }

/* Статуси вікон */
.slot { position: relative; border-radius: 10px; min-height: 40px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; }
.slot.free { background: var(--cal-free); border: 2px solid var(--cal-border); }
.slot.busy { background: var(--cal-busy); color: var(--cal-muted); }
.slot.past, .slot.unknown { border: 1.5px dashed var(--cal-line); color: var(--cal-line); }
.slot.empty { visibility: hidden; }

/* Тиждень: сітка (широкий екран) */
.week-grid { display: grid; gap: 6px; overflow-x: auto; }
.week-grid .head { text-align: center; font-weight: 600; font-size: 15px; padding: 4px 0 6px; line-height: 1.25; }
.week-grid .head small { display: block; font-weight: 500; color: var(--cal-muted); }
.week-grid .head.today { color: var(--cal-accent); }
.week-grid .head.today small { color: var(--cal-accent); }
.week-grid .time { font-size: 14px; color: var(--cal-muted); font-variant-numeric: tabular-nums; align-self: center; }

/* Тиждень: картки днів (вузький екран) */
.week-cards { display: none; flex-direction: column; gap: 10px; }
.day-card { border: 1.5px solid var(--cal-line); border-radius: 16px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.day-card.today { border: 2px solid var(--cal-accent); }
.day-card h3 { margin: 0; font-size: 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 6px 12px; border-radius: 999px; background: var(--cal-free); border: 2px solid var(--cal-border); font-weight: 600; font-size: 14px; font-variant-numeric: tabular-nums; }
.muted { margin: 0; color: var(--cal-muted); font-size: 14px; }

/* День */
.day-list { display: flex; flex-direction: column; gap: 8px; }
.day-row { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 12px; align-items: center; }
.day-row .time { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; min-width: 7.5em; }
.day-row .slot { justify-content: flex-start; padding: 0 14px; }

/* Місяць */
.month { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
.month .wd { text-align: center; font-size: 14px; font-weight: 600; color: var(--cal-muted); padding-bottom: 4px; }
.mcell {
  min-height: 84px;
  border: 1.5px solid var(--cal-line);
  border-radius: 14px;
  background: var(--cal-card);
  padding: 8px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
  text-align: left;
  cursor: pointer;
}
.mcell:hover { border-color: var(--cal-border); }
.mcell .num { font-weight: 700; font-variant-numeric: tabular-nums; }
.mcell.other { opacity: .4; }
.mcell.past { background: var(--cal-surface); }
.mcell.today { border: 2px solid var(--cal-accent); }
.mcell.today .num { color: var(--cal-accent); }
.badge { font-size: 12px; font-weight: 600; line-height: 1.2; padding: 4px 8px; border-radius: 999px; background: var(--cal-free); border: 1.5px solid var(--cal-border); }
.badge .short { display: none; }

/* Легенда */
.footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; font-size: 14px; color: var(--cal-muted); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 16px; height: 16px; border-radius: 5px; display: inline-block; }
.swatch.free { background: var(--cal-free); border: 2px solid var(--cal-border); }
.swatch.busy { background: var(--cal-busy); }
.footer strong { color: var(--cal-ink); }

/* Вузький екран */
@container (max-width: 640px) {
  .card { padding: 14px; border-radius: 18px; }
  .controls { width: 100%; }
  .views { flex: 1 1 auto; justify-content: space-between; }
  .views .btn { flex: 1 1 0; padding: 6px 8px; }
  .date { flex: 1 1 140px; }
  .week-grid { display: none; }
  .week-cards { display: flex; }
  .day-row .time { min-width: 0; font-size: 15px; }
  .month { gap: 4px; }
  .mcell { min-height: 54px; padding: 6px; border-radius: 10px; align-items: center; }
  .badge { padding: 2px 7px; }
  .badge .long { display: none; }
  .badge .short { display: inline; }
}
`;

const ICON_PREV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
const ICON_NEXT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';

const STATUS_TEXT = { free: 'вільно', busy: 'зайнято', past: 'минуло', unknown: 'немає даних' };

class MyCalendar extends HTMLElement {
  static get observedAttributes() { return ['src', 'work-hours', 'slot-minutes', 'timezone', 'view']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.state = { view: 'week', anchor: startOfDay(new Date()), data: null, error: null, loading: true };
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('change', (e) => this.onChange(e));
  }

  connectedCallback() {
    const v = this.getAttribute('view');
    if (VIEWS.some((x) => x.id === v)) this.state.view = v;
    this.load();
    // щоб «минулі» вікна оновлювались, якщо сторінка довго відкрита
    this.timer = setInterval(() => this.render(), 5 * 60 * 1000);
  }

  disconnectedCallback() { clearInterval(this.timer); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (!this.isConnected || oldValue === newValue) return;
    if (name === 'src') return this.load();
    if (name === 'view' && VIEWS.some((x) => x.id === newValue)) this.state.view = newValue;
    this.render();
  }

  /* ---------- Дані ---------- */

  async load() {
    this.state.loading = true;
    this.state.error = null;
    this.render();
    try {
      const res = await fetch(this.getAttribute('src') || 'calendar/schedule.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const json = await res.json();
      this.state.data = {
        timezone: json.timezone,
        from: new Date(json.range.from),
        to: new Date(json.range.to),
        busy: (json.busy || []).map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()]),
      };
    } catch (err) {
      this.state.data = null;
      this.state.error = 'Не вдалося завантажити розклад. Спробуйте оновити сторінку трохи пізніше.';
    }
    this.state.loading = false;
    this.render();
  }

  get tutorTz() {
    return this.getAttribute('timezone') || this.state.data?.timezone || 'Europe/Warsaw';
  }

  get slotMinutes() {
    const n = Number(this.getAttribute('slot-minutes'));
    return n > 0 ? n : 60;
  }

  /** Усі вікна, що починаються в [from, to) за часом відвідувача. */
  slotsBetween(from, to) {
    const hours = parseWorkHours(this.getAttribute('work-hours') || 'mon-fri 15:00-20:00; sat 10:00-14:00');
    const tz = this.tutorTz;
    const step = this.slotMinutes;
    const now = Date.now();
    const data = this.state.data;
    const slots = [];

    // Перебираємо дати у поясі репетитора з запасом в один день з кожного боку
    const first = new Date(from.getTime() - DAY_MS);
    for (let t = Date.UTC(first.getFullYear(), first.getMonth(), first.getDate()); t <= to.getTime() + DAY_MS; t += DAY_MS) {
      const d = new Date(t);
      const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
      for (const [a, b] of hours[d.getUTCDay()] || []) {
        for (let min = a; min + step <= b; min += step) {
          const start = zonedToDate(y, m, day, min, tz);
          if (start < from || start >= to) continue;
          const end = new Date(start.getTime() + step * 60000);
          slots.push({ start, end, status: this.statusOf(start, end, now, data) });
        }
      }
    }
    return slots.sort((x, y) => x.start - y.start);
  }

  statusOf(start, end, now, data) {
    if (end.getTime() <= now) return 'past';
    if (!data || start < data.from || end > data.to) return 'unknown';
    const s = start.getTime(), e = end.getTime();
    return data.busy.some(([bs, be]) => s < be && e > bs) ? 'busy' : 'free';
  }

  /* ---------- Події ---------- */

  onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action } = el.dataset;
    const { view, anchor } = this.state;
    if (action === 'prev' || action === 'next') {
      const dir = action === 'prev' ? -1 : 1;
      this.state.anchor = view === 'day' ? addDays(anchor, dir)
        : view === 'week' ? addDays(anchor, 7 * dir)
        : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
    } else if (action === 'today') {
      this.state.anchor = startOfDay(new Date());
    } else if (action === 'view') {
      this.state.view = el.dataset.view;
    } else if (action === 'open-day') {
      const [y, m, d] = el.dataset.date.split('-').map(Number);
      this.state.anchor = new Date(y, m - 1, d);
      this.state.view = 'day';
    }
    this.render();
    this.shadowRoot.querySelector(`[data-action="${action}"]${action === 'view' ? `[data-view="${el.dataset.view}"]` : ''}`)?.focus();
  }

  onChange(e) {
    if (!e.target.matches('.date') || !e.target.value) return;
    const [y, m, d] = e.target.value.split('-').map(Number);
    this.state.anchor = new Date(y, m - 1, d);
    this.render();
  }

  /* ---------- Відмалювання ---------- */

  range() {
    const { view, anchor } = this.state;
    if (view === 'day') return [anchor, addDays(anchor, 1)];
    if (view === 'week') { const s = startOfWeek(anchor); return [s, addDays(s, 7)]; }
    const s = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    const e = addDays(startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)), 7);
    return [s, e];
  }

  titleText() {
    const { view, anchor } = this.state;
    if (view === 'day') return `${dayTitle(anchor)} ${anchor.getFullYear()}`;
    if (view === 'month') return `${cap(fmt({ month: 'long' }).format(anchor))} ${anchor.getFullYear()}`;
    const s = startOfWeek(anchor), e = addDays(s, 6);
    const dm = fmt({ day: 'numeric', month: 'long' });
    if (s.getFullYear() !== e.getFullYear()) return `${dm.format(s)} ${s.getFullYear()} – ${dm.format(e)} ${e.getFullYear()}`;
    if (s.getMonth() !== e.getMonth()) return `${dm.format(s)} – ${dm.format(e)} ${e.getFullYear()}`;
    return `${s.getDate()}–${dm.format(e)} ${e.getFullYear()}`;
  }

  render() {
    const { view, anchor, loading, error } = this.state;
    const [from, to] = this.range();
    const today = startOfDay(new Date());
    const todayInView = today >= from && today < to && (view !== 'month' || today.getMonth() === anchor.getMonth());
    const slots = this.slotsBetween(from, to);
    // Деякі браузери досі повертають стару назву Europe/Kiev
    const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone.replace('Europe/Kiev', 'Europe/Kyiv');

    let body;
    if (loading) body = '<p class="note">Завантажуємо розклад…</p>';
    else if (view === 'day') body = this.renderDay(slots);
    else if (view === 'week') body = this.renderWeek(from, slots, today);
    else body = this.renderMonth(from, to, slots, today);

    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <section class="card" aria-label="Розклад вільних годин">
        <div class="toolbar">
          <h3 class="title" aria-live="polite">${this.titleText()}</h3>
          <div class="controls">
            <div class="nav">
              <button class="btn icon" data-action="prev" aria-label="Назад">${ICON_PREV}</button>
              <button class="btn" data-action="today" ${todayInView ? 'disabled' : ''}>Сьогодні</button>
              <button class="btn icon" data-action="next" aria-label="Вперед">${ICON_NEXT}</button>
            </div>
            <div class="views" role="group" aria-label="Вид календаря">
              ${VIEWS.map((v) => `<button class="btn" data-action="view" data-view="${v.id}" aria-pressed="${v.id === view}">${v.label}</button>`).join('')}
            </div>
            <label class="sr" for="jump">Перейти до дати</label>
            <input class="date" id="jump" type="date" value="${dayKey(anchor)}" title="Перейти до дати">
          </div>
        </div>
        ${error ? `<p class="note error" role="alert">${error}</p>` : ''}
        ${!loading && !error && slots.some((s) => s.status === 'unknown') ? '<p class="note">Розклад на ці дати ще не опубліковано. Напишіть мені, щоб домовитися про час.</p>' : ''}
        ${body}
        <div class="footer">
          <div class="legend">
            <span><i class="swatch free"></i>Вільно</span>
            <span><i class="swatch busy"></i>Зайнято</span>
          </div>
          <span>Час у вашому часовому поясі: <strong>${viewerTz}</strong></span>
        </div>
      </section>`;
  }

  slotCell(slot, dayLabel) {
    // Видимий текст короткий, а для читачів екрана — повний опис вікна
    const label = `${dayLabel}, ${timeLabel(slot.start)}–${timeLabel(slot.end)}: ${STATUS_TEXT[slot.status]}`;
    const text = slot.status === 'free' ? '<span aria-hidden="true">вільно</span>' : '';
    return `<div class="slot ${slot.status}">${text}<span class="sr">${label}</span></div>`;
  }

  renderDay(slots) {
    if (!slots.length) return '<p class="note">У цей день занять немає — вихідний.</p>';
    return `<div class="day-list">
      ${slots.map((s) => `
        <div class="day-row">
          <span class="time">${timeLabel(s.start)} – ${timeLabel(s.end)}</span>
          <div class="slot ${s.status}">${cap(STATUS_TEXT[s.status])}</div>
        </div>`).join('')}
    </div>`;
  }

  renderWeek(from, slots, today) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const byDay = new Map(days.map((d) => [dayKey(d), []]));
    for (const s of slots) byDay.get(dayKey(s.start))?.push(s);
    const activeDays = days.filter((d) => byDay.get(dayKey(d)).length);
    if (!activeDays.length) return '<p class="note">На цьому тижні занять немає.</p>';

    // Рядки сітки — усі різні часи початку за часом відвідувача
    const times = [...new Set(slots.map((s) => s.start.getHours() * 60 + s.start.getMinutes()))].sort((a, b) => a - b);
    const short = fmt({ weekday: 'short' });
    const dm = fmt({ day: 'numeric', month: 'short' });

    const head = activeDays.map((d) => `
      <div class="head ${sameDay(d, today) ? 'today' : ''}" aria-hidden="true">${cap(short.format(d))}<small>${dm.format(d)}</small></div>`).join('');
    const rows = times.map((t) => {
      const label = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      const cells = activeDays.map((d) => {
        const s = byDay.get(dayKey(d)).find((x) => x.start.getHours() * 60 + x.start.getMinutes() === t);
        return s ? this.slotCell(s, dayTitle(d)) : '<div class="slot empty"></div>';
      }).join('');
      return `<span class="time" aria-hidden="true">${label}</span>${cells}`;
    }).join('');

    const grid = `<div class="week-grid"
      style="grid-template-columns: 56px repeat(${activeDays.length}, minmax(72px, 1fr))">
      <span></span>${head}${rows}</div>`;

    // На телефоні дні, що вже минули, не показуємо — щоб не гортати зайве
    const upcoming = activeDays.filter((d) => !byDay.get(dayKey(d)).every((s) => s.status === 'past'));
    const cards = upcoming.map((d) => {
      const list = byDay.get(dayKey(d));
      const free = list.filter((s) => s.status === 'free');
      let content;
      if (free.length) content = `<div class="chips">${free.map((s) => `<span class="chip">${timeLabel(s.start)}</span>`).join('')}</div>`;
      else if (list.some((s) => s.status === 'unknown')) content = '<p class="muted">Розклад ще не опубліковано</p>';
      else content = '<p class="muted">Вільних годин немає</p>';
      return `<div class="day-card ${sameDay(d, today) ? 'today' : ''}"><h3>${dayTitle(d)}</h3>${content}</div>`;
    }).join('') || '<p class="note">Цей тиждень уже минув.</p>';

    return `${grid}<div class="week-cards">${cards}</div>`;
  }

  renderMonth(from, to, slots, today) {
    const month = this.state.anchor.getMonth();
    const freeByDay = new Map();
    for (const s of slots) if (s.status === 'free') freeByDay.set(dayKey(s.start), (freeByDay.get(dayKey(s.start)) || 0) + 1);

    const weekdays = Array.from({ length: 7 }, (_, i) => cap(fmt({ weekday: 'short' }).format(addDays(from, i))));
    const cells = [];
    for (let d = from; d < to; d = addDays(d, 1)) {
      const n = freeByDay.get(dayKey(d)) || 0;
      const cls = [d.getMonth() !== month && 'other', d < today && 'past', sameDay(d, today) && 'today'].filter(Boolean).join(' ');
      const words = plural(n, 'вільне вікно', 'вільні вікна', 'вільних вікон');
      const badge = n ? `<span class="badge"><span class="long">${n} ${words}</span><span class="short">${n}</span></span>` : '';
      cells.push(`<button class="mcell ${cls}" data-action="open-day" data-date="${dayKey(d)}"
        aria-label="${dayTitle(d)}${n ? `, ${n} ${words}` : ''}"><span class="num">${d.getDate()}</span>${badge}</button>`);
    }
    return `<div class="month">${weekdays.map((w) => `<span class="wd" aria-hidden="true">${w}</span>`).join('')}${cells.join('')}</div>`;
  }
}

customElements.define('my-calendar', MyCalendar);
