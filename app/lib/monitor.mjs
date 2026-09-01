// Squirrel — monitoring toplulaştırması (tur/başarı/süre/token/tool).
// Satır üretimi dosya imzasıyla önbelleklenir; dosya değişmediyse
// raw_events yeniden taranmaz.
import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from './env.mjs';
import { readJsonl, tokensFromPayload } from './records.mjs';
import { listArchive } from './archive.mjs';

const monitorCache = new Map(); // file -> {sig, data}
const MONITOR_CACHE_MAX = 120;

export function runRows(runId) {
  const file = path.join(OUTPUT_DIR, runId, 'results.jsonl');
  let stat = null;
  try { stat = fs.statSync(file); } catch { return []; }
  const sig = `${stat.size}:${stat.mtimeMs}`;
  const cached = monitorCache.get(file);
  if (cached && cached.sig === sig) return cached.data;
  const rows = [];
  for (const record of readJsonl(file)) {
    const status = record.completion_status || record.status || '';
    const acc = { in: 0, out: 0 };
    for (const event of record.raw_events || []) tokensFromPayload(event.payload, acc);
    const scores = (Array.isArray(record.scores) ? record.scores : [])
      .map((score) => Number(score.value)).filter((value) => Number.isFinite(value));
    rows.push({
      run: runId, dataset: runId.split('/')[0], stamp: runId.split('/')[1] || '',
      thread: record.thread_id || null, logical: record.logical_thread || null,
      ok: status === 'completed' || record.terminal_reason === 'final_answer' ? 1 : 0,
      dur: Math.round((record.duration_ms || 0) / 1000),
      tools: (record.tools || []).length,
      tin: acc.in, tout: acc.out,
      scs: scores.reduce((a, b) => a + b, 0), scn: scores.length,
    });
  }
  monitorCache.set(file, { sig, data: rows });
  if (monitorCache.size > MONITOR_CACHE_MAX) {
    monitorCache.delete(monitorCache.keys().next().value);
  }
  return rows;
}

export function allRows(limit = 30) {
  const rows = [];
  for (const run of listArchive(limit)) rows.push(...runRows(run.id));
  return rows;
}

export function aggregate(rows, groupBy) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupBy === 'thread'
      ? (row.logical || row.thread || 'bilinmeyen')
      : row.run;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        dataset: groupBy === 'thread' ? (row.logical || (row.thread || '').slice(0, 14)) : row.dataset,
        stamp: groupBy === 'thread' ? `${row.dataset}` : row.stamp,
        turns: 0, ok: 0, bad: 0, duration_s: 0, tool_calls: 0, tokens_in: 0, tokens_out: 0,
        score_sum: 0, score_n: 0,
      });
    }
    const g = groups.get(key);
    g.turns += 1; g.ok += row.ok; g.bad += row.ok ? 0 : 1;
    g.duration_s += row.dur; g.tool_calls += row.tools;
    g.tokens_in += row.tin; g.tokens_out += row.tout;
    g.score_sum += row.scs || 0; g.score_n += row.scn || 0;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    avg_s: g.turns ? Math.round(g.duration_s / g.turns) : 0,
    avg_score: g.score_n ? Math.round(100 * g.score_sum / g.score_n) / 100 : null,
  }));
}
