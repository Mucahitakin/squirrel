// Squirrel — canlı koşu motorları.
// 1) Harness: repo'daki run-chat-suite.mjs child process olarak koşar,
//    stdout + results.jsonl canlı izlenir.
// 2) Generic: herhangi bir HTTP chat endpoint'i dataset ile beslenir.
// İkisi de aynı results.jsonl şemasına yazar ve aynı SSE olaylarını yayınlar.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT, HARNESS, OUTPUT_DIR, DESKTOP_OUT } from './env.mjs';
import { liteRecord } from './records.mjs';
import { datasetItems } from './datasets.mjs';
import { broadcast } from './sse.mjs';

export const state = {
  running: false, child: null, dataset: null, startedAt: null,
  outDir: null, results: [], tailOffset: 0, tailTimer: null,
  stdoutBuffer: '', itemsByIndex: new Map(), exportPath: null,
  stopFlag: false, lastLines: [],
};

function tailResults() {
  if (!state.outDir) return;
  const file = path.join(REPO_ROOT, state.outDir, 'results.jsonl');
  let text = '';
  try {
    const stat = fs.statSync(file);
    if (stat.size <= state.tailOffset) return;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - state.tailOffset);
    fs.readSync(fd, buffer, 0, buffer.length, state.tailOffset);
    fs.closeSync(fd);
    state.tailOffset = stat.size;
    text = buffer.toString('utf8');
  } catch { return; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const lite = liteRecord(record);
      state.results.push(lite);
      broadcast('item_result', lite);
    } catch { /* yarım satır */ }
  }
}

function handleStdout(chunk) {
  state.stdoutBuffer += chunk.toString('utf8');
  const outMatch = state.stdoutBuffer.match(/# cikti=([^\s]+)/u);
  if (outMatch && !state.outDir) {
    state.outDir = outMatch[1];
    broadcast('run_meta', { out_dir: state.outDir, run_id: state.outDir.split('/').slice(-2).join('/') });
    state.tailTimer = setInterval(tailResults, 600);
  }
  let match;
  const startRe = /\[(\d+)\][^\n]*?gonderiliyor/gu;
  while ((match = startRe.exec(state.stdoutBuffer)) !== null) {
    const index = Number(match[1]);
    const item = state.itemsByIndex.get(index);
    if (item && !item.announced) {
      item.announced = true;
      broadcast('item_started', {
        index, user: item.prompt, category: item.category,
        thread: item.thread, attachments: item.attachments,
      });
    }
  }
  if (state.stdoutBuffer.length > 65536) state.stdoutBuffer = state.stdoutBuffer.slice(-8192);
  for (const line of chunk.toString('utf8').split('\n')) {
    if (line.trim()) broadcast('log', { line: line.slice(0, 400) });
  }
}

function exportToDesktop() {
  if (!state.outDir) return null;
  const source = path.join(REPO_ROOT, state.outDir);
  const stamp = new Date().toISOString().replace(/[:T]/gu, '-').slice(0, 16);
  const target = path.join(DESKTOP_OUT, `${state.dataset}-${stamp}`);
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['summary.md', 'conversation.json', 'results.jsonl']) {
    const file = path.join(source, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(target, name));
  }
  const counts = {};
  for (const record of state.results) {
    const key = record.completion_status || record.status || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  fs.writeFileSync(path.join(target, 'test-results.json'), JSON.stringify({
    tool: 'squirrel',
    dataset: state.dataset,
    started_at: state.startedAt,
    finished_at: new Date().toISOString(),
    total: state.results.length,
    status_counts: counts,
    turns: state.results,
  }, null, 2));
  return target;
}

// ---------- harness koşusu ----------
export function startRun(options) {
  if (state.running) throw new Error('Zaten bir koşu sürüyor.');
  if (!String(options.refreshToken || options.authToken || '').trim()) {
    throw new Error("Oturum çerezi (_sid) boş — tarayıcıda localhost:8080'e girişten sonra DevTools → Application → Cookies → _sid değerini yapıştır.");
  }
  if (!HARNESS || !fs.existsSync(HARNESS)) throw new Error('Harness bağlı değil — Ayarlar > Repo klasörü bölümünden (ya da bu formdaki "Klasör seç" ile) harness içeren repo klasörünü seç.');
  const args = [HARNESS, '--dataset', options.dataset];
  if (options.from) args.push('--from', String(options.from));
  if (options.to) args.push('--to', String(options.to));
  if (options.multiThread) args.push('--multi-thread');
  if (options.thread) args.push('--thread', String(options.thread));
  if (options.base) args.push('--base', String(options.base));

  Object.assign(state, {
    running: true, dataset: options.dataset, startedAt: new Date().toISOString(),
    outDir: null, results: [], tailOffset: 0, stdoutBuffer: '', exportPath: null,
    stopFlag: false, lastLines: [],
    itemsByIndex: new Map(datasetItems(options.dataset).map((item) => [item.index, item])),
  });

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',            // Electron içinden node gibi çalış
      MMX_REFRESH_TOKEN: options.refreshToken || '',
      MMX_AUTH_TOKEN: options.authToken || '',
    },
  });
  state.child = child;
  broadcast('run_started', {
    dataset: options.dataset, from: options.from || 1, to: options.to || null,
    total: state.itemsByIndex.size, multi_thread: Boolean(options.multiThread),
  });
  const remember = (text) => {
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      state.lastLines.push(line.slice(0, 300));
      if (state.lastLines.length > 30) state.lastLines.shift();
    }
  };
  child.stdout.on('data', (chunk) => { remember(chunk); handleStdout(chunk); });
  child.stderr.on('data', (chunk) => { remember(chunk); broadcast('log', { line: `stderr: ${String(chunk).slice(0, 400)}` }); });
  child.on('error', (error) => { remember(`spawn hatasi: ${error.message}`); });
  child.on('close', (code) => {
    if (state.tailTimer) { clearInterval(state.tailTimer); state.tailTimer = null; }
    tailResults();
    let exportPath = null;
    try { exportPath = exportToDesktop(); } catch (error) { broadcast('log', { line: `export hatası: ${error.message}` }); }
    state.exportPath = exportPath;
    state.running = false;
    state.child = null;
    broadcast('run_finished', {
      exit_code: code, total: state.results.length,
      export_path: exportPath, out_dir: state.outDir,
      error_tail: (code !== 0 || state.results.length === 0) ? state.lastLines.slice(-12) : [],
    });
  });
}

// ---------- genel chat koşucusu (harness'tan bağımsız) ----------
function digPath(value, dotPath) {
  if (!dotPath) return null;
  let node = value;
  for (const key of String(dotPath).split('.')) {
    if (node == null) return null;
    node = node[key];
  }
  return node;
}

// ---------- kimlik doğrulama (sisteme özel değil, tip seçilir) ----------
// endpoint.auth = { type: 'none'|'api_key'|'bearer'|'cookie'|'basic'|'header'|'refresh', ... }
// Eski biçim (endpoint.auth_header + auth_value) 'header' tipine eşlenir.
function parseExtraHeaders(raw) {
  const headers = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, value] of Object.entries(raw)) headers[String(name).trim()] = String(value);
    return headers;
  }
  for (const line of String(raw || '').split('\n')) {
    const at = line.indexOf(':');
    if (at < 1) continue;
    const name = line.slice(0, at).trim();
    if (name) headers[name] = line.slice(at + 1).trim();
  }
  return headers;
}

async function fetchAccessToken(auth, timeoutMs) {
  const tokenUrl = String(auth.token_url || '').trim();
  if (!/^https?:\/\//u.test(tokenUrl)) throw new Error('Refresh akışı için geçerli bir token endpoint URL\'i gerekli.');
  const field = String(auth.token_field || 'refresh_token').trim() || 'refresh_token';
  const accessPath = String(auth.access_path || 'access_token').trim() || 'access_token';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: String(auth.refresh_token || '') }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Token endpoint'ine ulaşılamadı: ${String(error?.message || error).slice(0, 200)}`);
  } finally { clearTimeout(timer); }
  const text = await response.text();
  if (!response.ok) throw new Error(`Access token alınamadı (HTTP ${response.status}): ${text.slice(0, 200)}`);
  let data = null;
  try { data = JSON.parse(text); } catch { /* düz metin token */ }
  const token = data == null ? text.trim() : digPath(data, accessPath);
  if (!token || typeof token !== 'string') throw new Error(`Token cevabında '${accessPath}' alanı bulunamadı.`);
  return token;
}

export async function createAuth(endpoint, timeoutMs) {
  const legacy = endpoint.auth_header && endpoint.auth_value
    ? { type: 'header', header: endpoint.auth_header, value: endpoint.auth_value }
    : null;
  const auth = endpoint.auth && typeof endpoint.auth === 'object' && endpoint.auth.type
    ? endpoint.auth
    : (legacy || { type: 'none' });
  const type = String(auth.type || 'none');
  const state = { accessToken: null };
  if (type === 'refresh') state.accessToken = await fetchAccessToken(auth, timeoutMs);
  return {
    type,
    // Her istekte taze uygulanır; refresh sonrası yeni token otomatik girer.
    apply(headers) {
      switch (type) {
        case 'api_key':
          headers[String(auth.header || 'x-api-key').trim() || 'x-api-key'] = String(auth.value || '');
          break;
        case 'bearer':
          headers.Authorization = `Bearer ${String(auth.value || '').replace(/^Bearer\s+/iu, '')}`;
          break;
        case 'cookie':
          headers.Cookie = `${String(auth.cookie_name || 'session_id').trim() || 'session_id'}=${String(auth.value || '')}`;
          break;
        case 'basic':
          headers.Authorization = `Basic ${Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64')}`;
          break;
        case 'header':
          headers[String(auth.header || 'Authorization').trim() || 'Authorization'] = String(auth.value || '');
          break;
        case 'refresh':
          headers.Authorization = `Bearer ${state.accessToken}`;
          break;
        default: break;
      }
      return headers;
    },
    // 401/403'te bir kez çağrılır; yalnızca refresh akışında anlamlı.
    async renew() {
      if (type !== 'refresh') return false;
      state.accessToken = await fetchAccessToken(auth, timeoutMs);
      return true;
    },
  };
}

export async function runGeneric(options) {
  if (state.running) throw new Error('Zaten bir koşu sürüyor.');
  const endpoint = options.endpoint || {};
  const endpointUrl = String(endpoint.url || '').trim();
  if (!/^https?:\/\//u.test(endpointUrl)) throw new Error('Geçerli bir chat endpoint URL\'i gir.');
  const items = datasetItems(options.dataset);
  const from = Number(options.from) || 1;
  const to = Number(options.to) || items.length;
  const selected = items.filter((item) => item.index >= from && item.index <= to);
  if (!selected.length) throw new Error('Seçilen aralıkta madde yok.');
  const timeoutMs = (Number(endpoint.timeout_s) || 120) * 1000;
  // Kimlik doğrulama koşu başlamadan hazırlanır: refresh akışı token alamazsa
  // koşu hiç başlamaz ve kullanıcı hatayı formda görür.
  const auth = await createAuth(endpoint, timeoutMs);
  let bodyExtra = null;
  if (endpoint.body_extra) {
    try {
      const parsed = typeof endpoint.body_extra === 'string' ? JSON.parse(endpoint.body_extra) : endpoint.body_extra;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bodyExtra = parsed;
      else throw new Error('nesne değil');
    } catch { throw new Error('Ek gövde (body_extra) geçerli bir JSON nesnesi olmalı.'); }
  }
  const project = String(options.project || 'generic').trim().toLowerCase().replace(/[^a-z0-9-_]+/gu, '-') || 'generic';
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outAbs = path.join(OUTPUT_DIR, `gen-${project}`, stamp);
  fs.mkdirSync(outAbs, { recursive: true });

  Object.assign(state, {
    running: true, child: null, stopFlag: false, dataset: options.dataset,
    startedAt: new Date().toISOString(), outDir: path.relative(REPO_ROOT, outAbs),
    results: [], tailOffset: 0, stdoutBuffer: '', exportPath: null, lastLines: [],
    itemsByIndex: new Map(selected.map((item) => [item.index, item])),
  });
  broadcast('run_started', {
    dataset: options.dataset, from, to, total: selected.length, multi_thread: false, engine: 'generic',
  });
  broadcast('run_meta', { out_dir: state.outDir, run_id: `gen-${project}/${stamp}` });

  const resultsFile = path.join(outAbs, 'results.jsonl');
  const messageField = String(endpoint.message_field || 'message').trim() || 'message';
  const threadField = String(endpoint.thread_field || '').trim();
  const replyPath = String(endpoint.reply_path || '').trim();
  const delayMs = Number(endpoint.delay_ms) || 0;
  const method = /^[A-Z]+$/u.test(String(endpoint.method || '').toUpperCase()) ? String(endpoint.method).toUpperCase() : 'POST';
  const extraHeaders = parseExtraHeaders(endpoint.headers);
  const buildHeaders = () => auth.apply({ 'Content-Type': 'application/json', ...extraHeaders });

  (async () => {
    for (const item of selected) {
      if (state.stopFlag) break;
      broadcast('item_started', {
        index: item.index, user: item.prompt, category: item.category,
        thread: item.thread, attachments: item.attachments,
      });
      const t0 = Date.now();
      const record = {
        index: item.index, category: item.category, message: item.prompt,
        logical_thread: item.thread, thread_id: item.thread, run_id: null,
        status: 'completed', completion_status: 'completed', terminal_reason: 'final_answer',
        duration_ms: 0, assistant_text: '', artifacts: [], tools: [], errors: [],
        event_type_counts: {}, raw_events: [],
        started_at: new Date(t0).toISOString(), finished_at: null,
        expectation_status: 'none', expectation_checks: [],
      };
      try {
        const body = { ...(bodyExtra || {}), [messageField]: item.prompt };
        if (threadField && item.thread) body[threadField] = item.thread;
        const send = async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await fetch(endpointUrl, {
              method, headers: buildHeaders(), body: JSON.stringify(body), signal: controller.signal,
            });
          } finally { clearTimeout(timer); }
        };
        let response = await send();
        // Refresh akışı: token süresi dolduysa bir kez yenile ve isteği tekrarla.
        if ((response.status === 401 || response.status === 403) && auth.type === 'refresh') {
          let renewed = false;
          try { renewed = await auth.renew(); } catch (error) { broadcast('log', { line: `token yenileme hatası: ${String(error?.message || error).slice(0, 300)}` }); }
          if (renewed) response = await send();
        }
        const text = await response.text();
        if (!response.ok) {
          record.status = `request_error:HTTP_${response.status}`;
          record.completion_status = 'failed'; record.terminal_reason = 'http_error';
          record.errors.push({ type: 'request_error', payload: { code: `HTTP_${response.status}`, message: text.slice(0, 400) } });
        } else {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* düz metin cevap */ }
          const reply = parsed == null ? text : (replyPath ? digPath(parsed, replyPath) : (parsed.reply ?? parsed.response ?? parsed.answer ?? parsed.output ?? parsed.text ?? parsed.message ?? text));
          record.assistant_text = typeof reply === 'string' ? reply : JSON.stringify(reply);
          record.raw_events.push({ sequence: 0, type: 'http.response', created_at: new Date().toISOString(), payload: { status: response.status } });
        }
      } catch (error) {
        const timedOut = error?.name === 'AbortError';
        record.status = timedOut ? 'request_error:TIMEOUT' : `request_error:${error?.code || 'FETCH_FAILED'}`;
        record.completion_status = 'failed'; record.terminal_reason = timedOut ? 'timeout' : 'network_error';
        record.errors.push({ type: 'request_error', payload: { code: timedOut ? 'TIMEOUT' : (error?.code || 'FETCH_FAILED'), message: String(error?.message || error).slice(0, 400) } });
      }
      record.duration_ms = Date.now() - t0;
      record.finished_at = new Date().toISOString();
      fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
      const lite = liteRecord(record);
      state.results.push(lite);
      broadcast('item_result', lite);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    let exportPath = null;
    try { exportPath = exportToDesktop(); } catch { /* yut */ }
    state.exportPath = exportPath; state.running = false;
    broadcast('run_finished', { exit_code: 0, total: state.results.length, export_path: exportPath, out_dir: state.outDir, error_tail: [] });
  })();
}

export function stopRun() {
  if (state.child) { state.child.kill('SIGTERM'); return true; }
  if (state.running) { state.stopFlag = true; return true; }
  return false;
}
