'use strict';

// Sentry mode: read monitoring alerts through MCP tools and tell what is new.
// Nothing here knows a product: each source in agent-runtime.json
// (telegram.sentry.sources) names the MCP server and tool to call and the
// fields to read, e.g.
//   { "name": "Monitoring", "server": "monitoring", "tool": "active_alerts",
//     "args": { "min_severity": 2 }, "list": "result", "id": "AlertID",
//     "title": "AlertName", "object": ["Entity", "Node"], "severity": "SeverityText",
//     "time": "Triggered", "skip_if": "Acknowledged", "only": { "Severity": [2, 3] },
//     "object_lookup": { "tool": "get_resource", "args": { "id": "{ResourceID}" }, "field": "resource.name" } }
// This module only reads tool results and compares them; the daemon polls.

// "a.b.0.c" → value, or undefined.
function pick(obj, dotted) {
  if (!dotted) return obj;
  return String(dotted).split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

// Deep copy of `args` with every "{field}" filled from the alert item.
function fill(args, item) {
  if (typeof args === 'string') return args.replace(/\{([\w.]+)\}/g, (_m, field) => String(pick(item, field) ?? ''));
  if (Array.isArray(args)) return args.map(a => fill(a, item));
  if (args && typeof args === 'object') return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, fill(v, item)]));
  return args;
}

// Epoch seconds or ms, or a date string → ms; null when unreadable.
function alertTime(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

const text = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();

// One tool result → the alerts it lists that the source cares about:
// [{ key, id, title, object, severity, time, item }]. Throws when the list
// is not where the source says.
function readAlerts(source, data) {
  const list = source.list ? pick(data, source.list) : data;
  if (!Array.isArray(list)) throw new Error(`no alert list at "${source.list || '(top level)'}" in the ${source.tool} result`);
  const only = source.only || {};
  return list
    .filter(item => item && typeof item === 'object')
    .filter(item => !(source.skip_if && pick(item, source.skip_if)))
    .filter(item => Object.entries(only).every(([field, allowed]) => [].concat(allowed).map(String).includes(String(pick(item, field)))))
    .map((item) => {
      const id = text(pick(item, source.id));
      const object = [].concat(source.object || []).map(f => text(pick(item, f))).filter((v, i, all) => v && all.indexOf(v) === i).join(' · ');
      return {
        key: `${source.name}#${id}`,
        id,
        title: text(pick(item, source.title)) || '(untitled alert)',
        object,
        severity: text(pick(item, source.severity)),
        time: alertTime(pick(item, source.time)),
        item,
      };
    })
    .filter(alert => alert.id);
}

// Compare one source's current alerts with what is known (key → entry with
// .source): the new ones, and the known ones of this source that are gone.
function diffAlerts(known, sourceName, alerts) {
  const now = new Set(alerts.map(a => a.key));
  return {
    added: alerts.filter(a => !known[a.key]),
    cleared: Object.entries(known).filter(([key, entry]) => entry.source === sourceName && !now.has(key)).map(([key, entry]) => ({ key, entry })),
  };
}

// What a mute applies to: the same alert on the same object, whatever its id.
const muteKey = (sourceName, alert) => `${sourceName}|${alert.title}|${alert.object}`.toLowerCase();

// Ignored alert types: a title matches a pattern when it contains it (any
// case), or, for "/regex/", when the regex matches. A bad regex matches nothing.
function titleIgnored(title, patterns) {
  const t = String(title || '');
  return (patterns || []).some((p) => {
    const re = /^\/(.+)\/([a-z]*)$/.exec(String(p));
    if (!re) return String(p).trim() !== '' && t.toLowerCase().includes(String(p).trim().toLowerCase());
    try { return new RegExp(re[1], re[2].includes('i') ? re[2] : `${re[2]}i`).test(t); } catch (_) { return false; }
  });
}

module.exports = { pick, fill, alertTime, readAlerts, diffAlerts, muteKey, titleIgnored };
