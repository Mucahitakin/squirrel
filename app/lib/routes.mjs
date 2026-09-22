// Squirrel — HTTP yönlendirici.
// Tüm istekler tek noktadan geçer; beklenmedik bir hata süreci düşürmek
// yerine 500 JSON döner. Statik dosyalar (ui/, assets/) doğru content-type
// ile servis edilir.
import fs from 'node:fs';
import path from 'node:path';
import {
  PORT, UI_DIR, ASSETS_DIR, CONFIG_FILE, DESKTOP_OUT,
  OUTPUT_DIR, API_KEY, readJson, liveConfig, findProjectRoot, setProject, describeProject,
} from './env.mjs';
import { exportProject, importProject } from './packages.mjs';
import {
  loadProjects, createProject, deleteProject, rotateProjectKey, projectByKey, projectOfRun,
} from './projects.mjs';
import {
  listDatasets, datasetItems, createDataset, addItem, deleteItem,
  deleteDataset, updateItem, updateDatasetMeta,
} from './datasets.mjs';
import {
  listArchive, archiveRun, archiveTurn, compareRuns, addScore, threadTurns,
  invalidateArchiveList,
} from './archive.mjs';
import { runRows, allRows, aggregate } from './monitor.mjs';
import { broadcast, attachStream } from './sse.mjs';
import { state, startRun, runGeneric, stopRun } from './runs.mjs';
import { liteRecord } from './records.mjs';

// ---------- yardımcılar ----------
function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const BODY_LIMIT = 8 * 1024 * 1024; // 8 MB — ingest toplu gönderimleri için yeterli
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('İstek gövdesi çok büyük (8 MB sınırı).');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, baseDir, fileName, cache) {
  const file = path.join(baseDir, path.basename(fileName)); // path traversal koruması
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('yok'); return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': cache || 'no-cache',
  });
  res.end(fs.readFileSync(file));
}

// ---------- ingest ----------
function handleIngest(res, keyProject, body) {
  // Anahtar hangi projeye aitse oraya yazılır; default anahtar body.project verebilir.
  const project = keyProject.name !== 'default'
    ? keyProject.name
    : (String(body.project || 'sdk').trim().toLowerCase().replace(/[^a-z0-9-_]+/gu, '-').slice(0, 40) || 'sdk');
  const runKey = String(body.run || '').trim().replace(/[^A-Za-z0-9-_.:]+/gu, '').slice(0, 60);
  if (!runKey) throw new Error('run alanı gerekli (koşu kimliği).');
  const records = Array.isArray(body.records) ? body.records : [];
  if (!records.length) throw new Error('records boş.');
  const dir = path.join(OUTPUT_DIR, `sdk-${project}`, runKey);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'results.jsonl');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length : 0;
  const stored = records.map((entry, position) => ({
    index: entry.index ?? existing + position + 1,
    category: entry.category ?? null,
    message: String(entry.input ?? entry.user ?? entry.message ?? ''),
    logical_thread: entry.thread ?? null,
    thread_id: entry.thread_id ?? entry.thread ?? null,
    run_id: entry.turn_id ?? null,
    status: entry.status ?? 'completed',
    completion_status: entry.status ?? 'completed',
    terminal_reason: entry.reason ?? (entry.status === 'completed' || !entry.status ? 'final_answer' : null),
    duration_ms: Number(entry.duration_ms) || 0,
    assistant_text: String(entry.output ?? entry.agent_text ?? ''),
    artifacts: entry.artifacts ?? [],
    tools: (entry.tools ?? []).map((tool) => (typeof tool === 'string'
      ? { capability: tool, status: 'success' }
      : {
        capability: String(tool.capability || tool.name || ''),
        status: tool.status || 'success',
        ...(Number(tool.duration_ms) > 0 ? { duration_ms: Number(tool.duration_ms) } : {}),
      })),
    errors: entry.errors ?? [],
    event_type_counts: {},
    raw_events: entry.events ?? [],
    started_at: entry.started_at ?? null,
    finished_at: entry.finished_at ?? null,
    expectation_status: 'none', expectation_checks: [],
    tags: (Array.isArray(entry.tags) ? entry.tags : [])
      .map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean).slice(0, 12),
    metadata: entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata)
      ? entry.metadata : null,
    scores: (Array.isArray(entry.scores) ? entry.scores : [])
      .map((score) => ({
        key: String(score.key || 'score').trim().slice(0, 40) || 'score',
        value: Number(score.value),
        ...(score.comment ? { comment: String(score.comment).slice(0, 400) } : {}),
        source: 'sdk',
      }))
      .filter((score) => Number.isFinite(score.value)).slice(0, 20),
  }));
  fs.appendFileSync(file, `${stored.map((row) => JSON.stringify(row)).join('\n')}\n`);
  invalidateArchiveList(); // yeni koşu dizini TTL beklemeden listede görünsün
  // Canlı SSE: config.live_ingest kapatılmadıysa arayüze anında yansıt.
  if (liveConfig().live_ingest !== false) {
    broadcast('ingest', {
      run: `sdk-${project}/${runKey}`, project,
      records: stored.map((row) => liteRecord(row)),
    });
  }
  return { ok: true, stored: records.length, run: `sdk-${project}/${runKey}` };
}

// ---------- ana yönlendirici ----------
export async function handleRequest(req, res) {
  try {
    await route(req, res);
  } catch (error) {
    // Beklenmedik hata: süreç düşmesin, istemci anlamlı bir cevap alsın.
    // Gövde yarım okunmuş olabilir; soket yeniden kullanılmasın diye kapatılır
    // (aksi halde kalan yükleme baytları sonraki isteği bozar).
    req.on('error', () => { /* yut */ });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 400) }));
    } else { try { res.end(); } catch { /* yut */ } }
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const routePath = url.pathname;

  // ---- statik ----
  if (routePath.startsWith('/assets/')) return serveStatic(res, ASSETS_DIR, routePath, 'max-age=3600');
  if (routePath.startsWith('/ui/')) return serveStatic(res, UI_DIR, routePath);
  if (routePath === '/' || routePath === '/index.html') return serveStatic(res, UI_DIR, 'index.html');

  // ---- yapılandırma ----
  if (routePath === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const next = { ...readJson(CONFIG_FILE, {}) };
      let project = null;
      if (body.repo_root !== undefined || body.harness_script !== undefined) {
        if (state.running) return json(res, 409, { ok: false, error: 'Koşu sürerken proje değiştirilemez.' });
        if (body.repo_root !== undefined) {
          const wanted = String(body.repo_root || '').trim();
          // Boş = proje bağlantısını kaldır (bağımsız kip). Dolu = var olan herhangi bir klasör.
          const root = wanted ? findProjectRoot(wanted) : '';
          if (root === null) return json(res, 400, { ok: false, error: `Klasör bulunamadı: ${wanted}` });
          next.repo_root = root;
          next.harness_script = ''; // yeni projede betik yeniden otomatik bulunur
        }
        if (body.harness_script !== undefined) {
          const script = String(body.harness_script || '').trim();
          if (script && !(fs.existsSync(script) && fs.statSync(script).isFile())) {
            return json(res, 400, { ok: false, error: `Betik dosyası bulunamadı: ${script}` });
          }
          next.harness_script = script;
        }
        project = setProject(next.repo_root || '', next.harness_script || ''); // yeniden başlatma gerekmez
        invalidateArchiveList();
      }
      if (body.live_ingest !== undefined) next.live_ingest = Boolean(body.live_ingest);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
      return json(res, 200, { ok: true, needs_restart: false, ...(project || {}) });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/config') {
    return json(res, 200, {
      ...describeProject(),
      desktop_out: DESKTOP_OUT, datasets: listDatasets(),
      api_key: API_KEY, ingest_url: `http://localhost:${PORT}/api/ingest`,
      live_ingest: liveConfig().live_ingest !== false,
    });
  }

  // ---- projeler ----
  if (routePath === '/api/projects') {
    const rowsByProject = new Map();
    for (const run of listArchive(100)) {
      const project = projectOfRun(run.id);
      if (!rowsByProject.has(project)) rowsByProject.set(project, { runs: 0, last: '', rows: [] });
      const bucket = rowsByProject.get(project);
      bucket.runs += 1;
      if (run.stamp > bucket.last) bucket.last = run.stamp;
      bucket.rows.push(...runRows(run.id));
    }
    const projects = loadProjects().map((project) => {
      const bucket = rowsByProject.get(project.name) || { runs: 0, last: '', rows: [] };
      const turns = bucket.rows.length;
      const ok = bucket.rows.reduce((a, r) => a + r.ok, 0);
      return {
        name: project.name, description: project.description || '', api_key: project.api_key,
        runs: bucket.runs, turns, error_rate: turns ? Math.round(100 * (turns - ok) / turns) : 0,
        tokens: bucket.rows.reduce((a, r) => a + r.tin + r.tout, 0),
        avg_s: turns ? Math.round(bucket.rows.reduce((a, r) => a + r.dur, 0) / turns) : 0,
        last_run: bucket.last || null,
      };
    });
    return json(res, 200, { projects });
  }
  if (routePath === '/api/project-create' && req.method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, project: createProject(body.name, body.description) }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/project-delete' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const project = deleteProject(String(body.name || ''));
      // Projenin tüm koşu verileri de KALICI olarak silinir (geri getirilemez).
      // Ad create sırasında [a-z0-9-_] ile sınırlandığı için path guard'ı
      // aşamaz; yine de resolve kontrolüyle doğrulanır.
      let removedRuns = 0;
      for (const prefix of ['sdk-', 'gen-']) {
        const dir = path.join(OUTPUT_DIR, `${prefix}${project.name}`);
        if (!path.resolve(dir).startsWith(path.resolve(OUTPUT_DIR) + path.sep)) continue;
        if (fs.existsSync(dir)) {
          removedRuns += fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      invalidateArchiveList();
      return json(res, 200, { ok: true, name: project.name, removed_runs: removedRuns });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/project-key-rotate' && req.method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, project: rotateProjectKey(String(body.name || '')) }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/validate') {
    const project = projectByKey(String(req.headers['x-api-key'] || ''));
    return project
      ? json(res, 200, { ok: true, project: project.name })
      : json(res, 401, { ok: false, error: 'Invalid API key.' });
  }

  // ---- arşiv / karşılaştırma ----
  if (routePath === '/api/archive') {
    const project = String(url.searchParams.get('project') || '').trim();
    let runs = listArchive();
    if (project) runs = runs.filter((run) => projectOfRun(run.id) === project);
    return json(res, 200, { runs });
  }
  if (routePath === '/api/archive-run') {
    const run = archiveRun(String(url.searchParams.get('id') || ''));
    return run ? json(res, 200, run) : json(res, 404, { error: 'bulunamadı' });
  }
  if (routePath === '/api/compare') {
    const idA = String(url.searchParams.get('a') || '').trim();
    const idB = String(url.searchParams.get('b') || '').trim();
    if (!idA || !idB) return json(res, 400, { error: 'a ve b koşu kimlikleri gerekli.' });
    const result = compareRuns(idA, idB);
    return result ? json(res, 200, result) : json(res, 404, { error: 'Koşulardan biri bulunamadı.' });
  }
  if (routePath === '/api/turn') {
    // canlı koşu da arşivle aynı yerden okunur — out_dir arşiv id'sine denk gelir
    const id = String(url.searchParams.get('id') || '') || (state.outDir ? state.outDir.split('/').slice(-2).join('/') : '');
    const detail = archiveTurn(id, Number(url.searchParams.get('index')));
    return detail ? json(res, 200, detail) : json(res, 404, { error: 'tur bulunamadı' });
  }

  // ---- geri bildirim (skor) ----
  if (routePath === '/api/score' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const saved = addScore(String(body.run || ''), body.index, {
        key: body.key, value: body.value, comment: body.comment,
      });
      broadcast('score', saved);
      return json(res, 200, { ok: true, ...saved });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  // ---- thread görünümü ----
  if (routePath === '/api/thread') {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return json(res, 400, { error: 'id gerekli.' });
    const project = String(url.searchParams.get('project') || '').trim();
    return json(res, 200, { id, turns: threadTurns(id, project) });
  }

  // ---- monitoring ----
  if (routePath === '/api/monitor') {
    const groupBy = url.searchParams.get('group') === 'thread' ? 'thread' : 'run';
    const wanted = String(url.searchParams.get('threads') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const project = String(url.searchParams.get('project') || '').trim();
    let rows = allRows();
    if (project) rows = rows.filter((row) => projectOfRun(row.run) === project);
    if (wanted.length) rows = rows.filter((row) => wanted.includes(row.thread) || wanted.includes(row.logical));
    const runs = aggregate(rows, groupBy);
    if (groupBy === 'run') runs.reverse();
    else runs.sort((a, b) => b.turns - a.turns);
    return json(res, 200, { runs: runs.slice(0, 30), group: groupBy });
  }
  if (routePath === '/api/monitor-threads') {
    const seen = new Map();
    for (const row of allRows()) {
      const key = row.logical || row.thread; if (!key) continue;
      if (!seen.has(key)) seen.set(key, { id: key, thread_id: row.thread, dataset: row.dataset, turns: 0 });
      seen.get(key).turns += 1;
    }
    return json(res, 200, { threads: [...seen.values()].sort((a, b) => b.turns - a.turns).slice(0, 200) });
  }

  // ---- dataset'ler ----
  if (routePath === '/api/dataset-items') {
    try { return json(res, 200, { items: datasetItems(String(url.searchParams.get('name') || '')) }); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (routePath === '/api/dataset-create' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const created = createDataset(body.name, body.description, body.items || []);
      return json(res, 200, { ok: true, name: created.name, count: created.count });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/dataset-item-add' && req.method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, item: addItem(body.dataset, body) }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/dataset-item-update' && req.method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, item: updateItem(body.dataset, body.id, body) }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/dataset-item-delete' && req.method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, remaining: deleteItem(body.dataset, body.id) }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/dataset-delete' && req.method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, name: deleteDataset(body.name) }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/dataset-meta' && req.method === 'POST') {
    const body = await readBody(req);
    try { updateDatasetMeta(body.name, body.description); return json(res, 200, { ok: true }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  // ---- proje paketi (taşınabilir betik + dataset'ler) ----
  if (routePath === '/api/project-export' && req.method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, { ok: true, ...(await exportProject(String(body.dest || ''))) }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/project-import' && req.method === 'POST') {
    const body = await readBody(req);
    if (state.running) return json(res, 409, { ok: false, error: 'Koşu sürerken proje değiştirilemez.' });
    try {
      const { root, harness } = await importProject(String(body.file || ''));
      const next = { ...readJson(CONFIG_FILE, {}), repo_root: root, harness_script: harness };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
      const project = setProject(root, harness);
      invalidateArchiveList();
      return json(res, 200, { ok: true, ...project });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  // ---- canlı koşu ----
  if (routePath === '/api/state') {
    return json(res, 200, {
      running: state.running, dataset: state.dataset, out_dir: state.outDir,
      results: state.results, export_path: state.exportPath,
    });
  }
  if (routePath === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      startRun({
        dataset: String(body.dataset || ''),
        from: Number(body.from) || null,
        to: Number(body.to) || null,
        multiThread: Boolean(body.multi_thread),
        thread: body.thread || null,
        base: body.base || null,
        refreshToken: body.refresh_token || '',
        env: body.env || '',
        args: body.args || '',
      });
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/run-generic' && req.method === 'POST') {
    const body = await readBody(req);
    try { await runGeneric(body); return json(res, 200, { ok: true }); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (routePath === '/api/stop' && req.method === 'POST') {
    return stopRun()
      ? json(res, 200, { ok: true })
      : json(res, 200, { ok: false, error: 'Çalışan koşu yok.' });
  }

  // ---- ingest ----
  if (routePath === '/api/ingest' && req.method === 'POST') {
    const keyProject = projectByKey(String(req.headers['x-api-key'] || ''));
    if (!keyProject) return json(res, 401, { ok: false, error: 'Geçersiz API anahtarı (x-api-key).' });
    const body = await readBody(req);
    try { return json(res, 200, handleIngest(res, keyProject, body)); }
    catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }

  // ---- SSE ----
  if (routePath === '/api/stream') return attachStream(req, res);

  res.writeHead(404); res.end('not found');
}
