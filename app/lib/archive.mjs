// Squirrel — koşu arşivi ve deney karşılaştırma.
// Arşiv okumaları dosya imzasıyla (boyut+mtime) önbelleklenir: dosya
// değişmediyse jsonl yeniden ayrıştırılmaz. Liste taraması kısa TTL ile
// önbelleklenir (SSE tetikli art arda yenilemelerde diski yormamak için).
import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from './env.mjs';
import { readJsonl, liteRecord, detailRecord, tokensFromPayload } from './records.mjs';
import { projectOfRun } from './projects.mjs';

// ---------- koşu listesi (kısa TTL önbelleği) ----------
let listCache = { at: 0, limit: 0, data: [] };
const LIST_TTL_MS = 1200;

// Yeni bir koşu dizini oluşturan yazmalar (ör. ingest) sonrası çağrılır;
// TTL beklemeden listenin tazelenmesini sağlar.
export function invalidateArchiveList() { listCache = { at: 0, limit: 0, data: [] }; }

export function listArchive(limit = 60) {
  const now = Date.now();
  if (now - listCache.at < LIST_TTL_MS && listCache.limit >= limit) {
    return listCache.data.slice(0, limit);
  }
  const runs = [];
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const setName of fs.readdirSync(OUTPUT_DIR)) {
      const setDir = path.join(OUTPUT_DIR, setName);
      let stamps = [];
      try { stamps = fs.readdirSync(setDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
      for (const stampEntry of stamps) {
        const file = path.join(setDir, stampEntry.name, 'results.jsonl');
        if (!fs.existsSync(file)) continue;
        runs.push({ id: `${setName}/${stampEntry.name}`, dataset: setName, stamp: stampEntry.name });
      }
    }
  }
  runs.sort((a, b) => b.stamp.localeCompare(a.stamp));
  listCache = { at: now, limit: Math.max(limit, 200), data: runs };
  return runs.slice(0, limit);
}

// ---------- güvenli yol + imza önbelleği ----------
function runDir(id) {
  const dir = path.join(OUTPUT_DIR, id);
  if (!path.resolve(dir).startsWith(path.resolve(OUTPUT_DIR))) return null; // path guard
  return dir;
}

function fileSig(file) {
  try { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}`; } catch { return null; }
}

// file -> {sig, records} — ham kayıtlar tek yerden, imza değişince tazelenir.
const recordCache = new Map();
const RECORD_CACHE_MAX = 40;

function readRunRecords(id) {
  const dir = runDir(id);
  if (!dir) return null;
  const file = path.join(dir, 'results.jsonl');
  const sig = fileSig(file);
  if (!sig) return null;
  const cached = recordCache.get(file);
  if (cached && cached.sig === sig) return cached.records;
  const records = [...readJsonl(file)];
  recordCache.set(file, { sig, records });
  if (recordCache.size > RECORD_CACHE_MAX) {
    recordCache.delete(recordCache.keys().next().value); // en eski girdiyi at
  }
  return records;
}

export function archiveRun(id) {
  const records = readRunRecords(id);
  if (!records) return null;
  const turns = [];
  const counts = {};
  for (const record of records) {
    const lite = liteRecord(record);
    turns.push(lite);
    const key = lite.completion_status || lite.status || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return { id, turns, counts };
}

export function archiveTurn(id, index) {
  const records = readRunRecords(id);
  if (!records) return null;
  for (const record of records) {
    if (Number(record.index) === Number(index)) return detailRecord(record);
  }
  return null;
}

// ---------- geri bildirim (feedback / skor) ----------
// Elle veya SDK sonrası verilen skorlar doğrudan results.jsonl'e işlenir;
// dosya imzası değiştiği için tüm önbellekler kendiliğinden tazelenir.
export function addScore(id, index, { key, value, comment } = {}) {
  const dir = runDir(id);
  if (!dir) throw new Error('Geçersiz koşu.');
  const file = path.join(dir, 'results.jsonl');
  if (!fs.existsSync(file)) throw new Error('Koşu bulunamadı.');
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) throw new Error('Skor 0 ile 1 arasında olmalı.');
  const cleanKey = String(key || 'rating').trim().slice(0, 40) || 'rating';
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  let found = false;
  const next = lines.map((line) => {
    let record;
    try { record = JSON.parse(line); } catch { return line; }
    if (Number(record.index) !== Number(index)) return line;
    found = true;
    const scores = Array.isArray(record.scores) ? record.scores : [];
    scores.push({
      key: cleanKey, value: numeric,
      ...(comment ? { comment: String(comment).slice(0, 400) } : {}),
      source: 'manual', at: new Date().toISOString(),
    });
    record.scores = scores;
    return JSON.stringify(record);
  });
  if (!found) throw new Error('Tur bulunamadı.');
  fs.writeFileSync(file, `${next.join('\n')}\n`);
  return { run: id, index: Number(index), key: cleanKey, value: numeric };
}

// ---------- thread görünümü ----------
// Bir konuşmanın turlarını tüm koşulardan toplayıp zaman sırasına dizer.
export function threadTurns(threadId, project = '') {
  const turns = [];
  for (const run of listArchive(100)) {
    if (project && projectOfRun(run.id) !== project) continue;
    const data = archiveRun(run.id);
    if (!data) continue;
    for (const turn of data.turns) {
      if (turn.logical_thread === threadId || turn.thread_id === threadId) {
        turns.push({ ...turn, run: run.id });
      }
    }
  }
  turns.sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || ''))
    || a.run.localeCompare(b.run) || (a.index - b.index));
  return turns;
}

// ---------- deney karşılaştırma ----------
// İki koşuyu tur bazında hizalar (index'e göre) ve özet deltaları hesaplar.
function compareSide(record) {
  if (!record) return null;
  const acc = { in: 0, out: 0 };
  for (const event of record.raw_events || []) tokensFromPayload(event.payload, acc);
  const status = record.completion_status || record.status || '';
  return {
    output: String(record.assistant_text || '').slice(0, 1200),
    status,
    ok: status === 'completed' || record.terminal_reason === 'final_answer' ? 1 : 0,
    duration_s: Math.round((record.duration_ms || 0) / 1000),
    tools: (record.tools || []).map((tool) => tool.capability),
    tokens: acc.in + acc.out,
    error_codes: (record.errors || []).map((error) => error?.payload?.code || error?.type).filter(Boolean),
    tags: Array.isArray(record.tags) ? record.tags : [],
  };
}

function compareTotals(sides) {
  const total = { turns: 0, ok: 0, duration_s: 0, tool_calls: 0, tokens: 0 };
  for (const side of sides) {
    if (!side) continue;
    total.turns += 1; total.ok += side.ok;
    total.duration_s += side.duration_s; total.tool_calls += side.tools.length;
    total.tokens += side.tokens;
  }
  total.avg_s = total.turns ? Math.round(total.duration_s / total.turns) : 0;
  total.success_rate = total.turns ? Math.round(100 * total.ok / total.turns) : 0;
  return total;
}

export function compareRuns(idA, idB) {
  const recordsA = readRunRecords(idA);
  const recordsB = readRunRecords(idB);
  if (!recordsA || !recordsB) return null;
  const mapA = new Map(recordsA.map((record) => [Number(record.index), record]));
  const mapB = new Map(recordsB.map((record) => [Number(record.index), record]));
  const indices = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((x, y) => x - y);
  const items = indices.map((index) => {
    const recordA = mapA.get(index); const recordB = mapB.get(index);
    const a = compareSide(recordA); const b = compareSide(recordB);
    return {
      index,
      input: String((recordA || recordB)?.message || '').slice(0, 400),
      category: (recordA || recordB)?.category || null,
      a, b,
      changed: Boolean(a && b && (a.status !== b.status || a.output !== b.output)),
    };
  });
  return {
    a: { id: idA, totals: compareTotals(items.map((item) => item.a)) },
    b: { id: idB, totals: compareTotals(items.map((item) => item.b)) },
    items,
  };
}
