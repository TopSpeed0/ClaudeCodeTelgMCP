'use strict';

// Time rules for /remind (runs once) and /every (repeats). Pure functions, no
// I/O; times are the PC's local time.
//   /remind 45m <task> · 1h30m · in 2h · 14:30 · tomorrow 07:30 · mon 09:00
//   /every 30m <task> · 2h · 07:30 (every day) · day 07:30 · weekdays 7:30am
//          · sun-thu 07:30 · mon,wed,fri at 09:00

const MINUTE = 60 * 1000;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MIN_INTERVAL_MS = 10 * MINUTE; // each run is a Claude session, so no tighter polling
const MAX_DELAY_MS = 366 * 24 * 60 * MINUTE;

// "45m", "2h", "1h30m", "1d", "90min" → ms, else null.
function parseDuration(token) {
  const m = /^(?:(\d+)d)?(?:(\d+)h(?:rs?)?)?(?:(\d+)m(?:in)?)?$/i.exec(String(token || ''));
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const ms = ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * MINUTE;
  return ms > 0 ? ms : null;
}

// "07:30", "7:30", "7am", "7:30pm" → { hh, mm }, else null.
function parseClock(token) {
  const t = String(token || '').toLowerCase();
  let m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) {
    const hh = Number(m[1]), mm = Number(m[2]);
    return hh < 24 && mm < 60 ? { hh, mm } : null;
  }
  m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(t);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2] || 0);
  if (hh < 1 || hh > 12 || mm > 59) return null;
  if (m[3] === 'am' && hh === 12) hh = 0;
  if (m[3] === 'pm' && hh !== 12) hh += 12;
  return { hh, mm };
}

const dayIndex = (name) => DAY_NAMES.indexOf(String(name).slice(0, 3));

// "day", "daily", "weekdays" (Mon–Fri), "weekend" (Sat–Sun), "mon",
// "mon,wed,fri", "sun-thu" → sorted day numbers (0 = Sunday), else null.
function parseDays(token) {
  const t = String(token || '').toLowerCase().replace(/s$/, '');
  if (t === 'day' || t === 'daily' || t === 'everyday') return [0, 1, 2, 3, 4, 5, 6];
  if (t === 'weekday') return [1, 2, 3, 4, 5];
  if (t === 'weekend') return [0, 6];
  const days = new Set();
  for (const part of String(token).toLowerCase().split(',')) {
    const range = /^([a-z]{3,9})(?:-([a-z]{3,9}))?$/.exec(part);
    if (!range) return null;
    const from = dayIndex(range[1]), to = range[2] ? dayIndex(range[2]) : from;
    if (from < 0 || to < 0) return null;
    for (let d = from; ; d = (d + 1) % 7) { days.add(d); if (d === to) break; }
  }
  return days.size ? [...days].sort((a, b) => a - b) : null;
}

// The first moment after `after` that falls on one of `days` at hh:mm.
function nextClock(after, { hh, mm, days }) {
  const d = new Date(after);
  for (let i = 0; i <= 8; i++) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hh, mm, 0, 0);
    if (at.getTime() > after && days.includes(at.getDay())) return at.getTime();
  }
  return null;
}

// Next run of a repeating rule, strictly after `after` (ms).
function nextRun(rule, after) {
  if (rule.kind === 'interval') return after + rule.ms;
  return nextClock(after, rule);
}

const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function describeDays(days) {
  const key = days.join(',');
  if (key === '0,1,2,3,4,5,6') return 'every day';
  if (key === '1,2,3,4,5') return 'Mon–Fri';
  if (key === '0,1,2,3,4') return 'Sun–Thu';
  if (key === '0,6') return 'weekends';
  return days.map(d => cap(DAY_NAMES[d])).join(', ');
}

function formatDuration(ms) {
  const mins = Math.round(ms / MINUTE);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join('') || '0m';
}

// "every 30m", "every day at 07:30", "Mon–Fri at 07:30".
function describeRule(rule) {
  if (rule.kind === 'interval') return `every ${formatDuration(rule.ms)}`;
  return `${describeDays(rule.days)} at ${pad(rule.hh)}:${pad(rule.mm)}`;
}

function words(argument) {
  return String(argument || '').trim().split(/\s+/).filter(Boolean);
}

const REMIND_USAGE = 'Usage: <code>/remind 45m check if the vMotion finished</code> · also <code>2h</code>, <code>14:30</code>, <code>tomorrow 07:30</code>, <code>mon 09:00</code>';
const EVERY_USAGE = 'Usage: <code>/every weekdays 07:30 check SnapMirror lag, tell me only if bad</code> · also <code>30m</code>, <code>2h</code>, <code>day 18:00</code>, <code>sun-thu 07:30</code>, <code>mon,wed 09:00</code>';

// /remind → { at, text } or { error }.
function parseRemind(argument, now = Date.now()) {
  const w = words(argument);
  if (w[0] && w[0].toLowerCase() === 'in') w.shift();
  let at = null;
  const duration = parseDuration(w[0]);
  if (duration) { w.shift(); at = now + duration; }
  else {
    let days = null, tomorrow = false;
    const first = (w[0] || '').toLowerCase();
    if (first === 'tomorrow') { tomorrow = true; w.shift(); }
    else if (first === 'today') w.shift();
    else if (parseDays(w[0]) && parseDays(w[0]).length === 1 && parseClock(w[1] === 'at' ? w[2] : w[1])) days = parseDays(w.shift());
    if ((w[0] || '').toLowerCase() === 'at') w.shift();
    const clock = parseClock(w[0]);
    if (!clock) return { error: REMIND_USAGE };
    w.shift();
    const all = [0, 1, 2, 3, 4, 5, 6];
    const from = tomorrow ? new Date(new Date(now).setHours(23, 59, 59, 999)).getTime() : now;
    at = nextClock(from, { ...clock, days: days || all });
  }
  const text = w.join(' ');
  if (!text) return { error: REMIND_USAGE };
  if (at - now > MAX_DELAY_MS) return { error: 'That is more than a year away.' };
  return { at, text };
}

// /every → { rule, text } or { error }.
function parseEvery(argument) {
  const w = words(argument);
  const duration = parseDuration(w[0]);
  let rule;
  if (duration) {
    if (duration < MIN_INTERVAL_MS) return { error: `The shortest repeat is ${formatDuration(MIN_INTERVAL_MS)}: each run is a full Claude session.` };
    w.shift();
    rule = { kind: 'interval', ms: duration };
  } else {
    let days = [0, 1, 2, 3, 4, 5, 6];
    if (!parseClock(w[0]) && parseDays(w[0])) days = parseDays(w.shift());
    if ((w[0] || '').toLowerCase() === 'at') w.shift();
    const clock = parseClock(w[0]);
    if (!clock) return { error: EVERY_USAGE };
    w.shift();
    rule = { kind: 'clock', days, ...clock };
  }
  const text = w.join(' ');
  if (!text) return { error: EVERY_USAGE };
  return { rule, text };
}

module.exports = {
  MIN_INTERVAL_MS, REMIND_USAGE, EVERY_USAGE,
  parseDuration, parseClock, parseDays, nextRun, describeRule, formatDuration, parseRemind, parseEvery,
};
