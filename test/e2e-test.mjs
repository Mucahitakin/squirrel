// Squirrel uçtan uca test: SDK ingest + validate + generic koşu auth tipleri.
const BASE = 'http://localhost:4591';
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
}

const cfg = await (await fetch(`${BASE}/api/config`)).json();
const KEY = cfg.api_key;

// ---- 1. SDK: validate + run/turn/score/usage ingest ----
const { default: Squirrel } = await import('squirrel-trace');
const sq = new Squirrel({ url: BASE, apiKey: KEY, project: 'sqtest-sdk' });
const projName = await sq.validate();
check('sdk.validate', projName === 'default', `project=${projName}`);

const run = sq.startRun({ name: 'sqtest-run-1' });
const turn = run.turn({ input: 'merhaba', thread: 'sohbet-1', tags: ['test'], metadata: { model: 'x' } });
turn.tool('web.search', 'success', { durationMs: 42 });
turn.usage({ input: 100, output: 20 });
turn.score('correctness', 0.9, { comment: 'ok' });
await turn.end({ output: 'selam!' });
const flushed = await run.end();
check('sdk.ingest.flush', flushed === true);

const arc = await (await fetch(`${BASE}/api/archive-run?id=sdk-sqtest-sdk/sqtest-run-1`)).json();
const t0 = arc.turns?.[0];
check('sdk.ingest.stored', Boolean(t0 && t0.agent_text === 'selam!' && (t0.tools || []).length === 1));

// ---- 2. traceable `this` korunumu ----
const { traceable } = await import('squirrel-trace');
const obj = { suffix: '!', async greet(x) { return x + this.suffix; } };
const run2 = sq.startRun({ name: 'sqtest-run-2' });
obj.greet = traceable(run2, obj.greet, { name: 'greet' });
const greeted = await obj.greet('hey');
await run2.end();
check('sdk.traceable.this', greeted === 'hey!');

// ---- 3. wrapOpenAI streaming ----
const { wrapOpenAI } = await import('squirrel-trace-connect/openai');
async function* fakeChunks() {
  yield { choices: [{ delta: { content: 'par' } }] };
  yield { choices: [{ delta: { content: 'ça' } }] };
  yield { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } };
}
const fakeClient = { chat: { completions: { create: async (p) => (p.stream ? fakeChunks() : { choices: [{ message: { content: 'düz' } }] }) } } };
const run3 = sq.startRun({ name: 'sqtest-run-3' });
const oa = wrapOpenAI(fakeClient, run3, { thread: 'ai-1' });
let streamed = '';
for await (const chunk of await oa.chat.completions.create({ model: 'gpt-x', stream: true, messages: [{ role: 'user', content: 'soru' }] })) {
  streamed += chunk.choices?.[0]?.delta?.content || '';
}
await new Promise((r) => setTimeout(r, 150)); // stream sonu turn.end asenkron flush
await run3.end();
check('connect.stream.passthrough', streamed === 'parça');
const arc3 = await (await fetch(`${BASE}/api/archive-run?id=sdk-sqtest-sdk/sqtest-run-3`)).json();
const t3 = arc3.turns?.[0];
check('connect.stream.recorded', Boolean(t3 && t3.agent_text === 'parça'), JSON.stringify(t3 && { out: t3.agent_text }));

// ---- 4. dataset oluştur + generic koşu auth tipleri ----
await fetch(`${BASE}/api/dataset-create`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'sqtest-tmp', description: 'e2e test', items: [
    { prompt: 'soru bir', category: 'Genel', thread: 'th1' },
    { prompt: 'soru iki', category: 'Genel', thread: 'th1' },
  ] }) });

async function waitRunDone() {
  for (let i = 0; i < 100; i += 1) {
    const st = await (await fetch(`${BASE}/api/state`)).json();
    if (!st.running) return st;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('koşu bitmedi');
}

async function generic(name, endpoint, expectOkTurns) {
  const res = await fetch(`${BASE}/api/run-generic`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset: 'sqtest-tmp', project: 'sqtest-gen', endpoint }) });
  const data = await res.json();
  if (!data.ok) { check(name, false, data.error); return null; }
  const st = await waitRunDone();
  const id = st.out_dir.split('/').slice(-2).join('/');
  const arcg = await (await fetch(`${BASE}/api/archive-run?id=${encodeURIComponent(id)}`)).json();
  const okTurns = (arcg.turns || []).filter((t) => t.completion_status === 'completed').length;
  check(name, okTurns === expectOkTurns, `ok=${okTurns}/${(arcg.turns || []).length} · ${JSON.stringify((arcg.turns || [])[0]?.agent_text || '')}`);
  return arcg;
}

const MOCK = 'http://localhost:4977';
// 4a. api_key
await generic('generic.auth.api_key', {
  url: `${MOCK}/chat-key`, reply_path: 'data.reply', timeout_s: 10,
  auth: { type: 'api_key', header: 'x-my-key', value: 'KEY-42' },
}, 2);
// 4b. cookie + özel mesaj/thread alanları + ek gövde
await generic('generic.auth.cookie', {
  url: `${MOCK}/chat-cookie`, reply_path: 'data.reply', timeout_s: 10,
  message_field: 'msg', thread_field: 'tid', body_extra: '{"kanal":"test"}',
  auth: { type: 'cookie', cookie_name: '_sid', value: 'SID-7' },
}, 2);
// 4c. refresh akışı — ilk access token tek kullanımlık: 2. istekte 401 → renew → retry
await generic('generic.auth.refresh', {
  url: `${MOCK}/chat-refresh`, reply_path: 'data.reply', timeout_s: 10,
  auth: { type: 'refresh', token_url: `${MOCK}/auth/refresh`, refresh_token: 'REF-123', token_field: 'refresh_token', access_path: 'data.access_token' },
}, 2);
// 4d. yanlış anahtar → failed turlar
await generic('generic.auth.bad_key', {
  url: `${MOCK}/chat-key`, reply_path: 'data.reply', timeout_s: 10,
  auth: { type: 'api_key', header: 'x-my-key', value: 'YANLIS' },
}, 0);
// 4e. eski biçim (auth_header/auth_value) geriye dönük uyum
await generic('generic.auth.legacy_header', {
  url: `${MOCK}/chat-key`, reply_path: 'data.reply', timeout_s: 10,
  auth_header: 'x-my-key', auth_value: 'KEY-42',
}, 2);

// ---- 5. proje oluştur + sil (verileri dahil, geri getirilemez) ----
const pc = await (await fetch(`${BASE}/api/project-create`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'sqtest-del', description: 'e2e silme testi' }) })).json();
check('project.create', pc.ok === true);
const sq2 = new Squirrel({ url: BASE, apiKey: pc.project.api_key });
const runX = sq2.startRun({ name: 'sqtest-del-run' });
await runX.turn({ input: 'x' }).end({ output: 'y' });
await runX.end();
const arcX = await (await fetch(`${BASE}/api/archive-run?id=sdk-sqtest-del/sqtest-del-run`)).json();
check('project.ingest', (arcX.turns || []).length === 1);
const del = await (await fetch(`${BASE}/api/project-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'sqtest-del' }) })).json();
check('project.delete', del.ok === true && del.removed_runs === 1, JSON.stringify(del));
const arcGone = await fetch(`${BASE}/api/archive-run?id=sdk-sqtest-del/sqtest-del-run`);
check('project.data_gone', arcGone.status === 404);
const valGone = await fetch(`${BASE}/api/validate`, { headers: { 'x-api-key': pc.project.api_key } });
check('project.key_invalid', valGone.status === 401);
const delDefault = await (await fetch(`${BASE}/api/project-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'default' }) })).json();
check('project.default_protected', delDefault.ok === false);

// ---- 6. genel proje: herhangi bir klasör + kendi test betiği ----
const fsm = await import('node:fs');
const pathm = await import('node:path');
const SANDBOX = process.env.SQUIRREL_TEST_SANDBOX;
const post = async (route, body) => (await fetch(`${BASE}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();
async function waitIdle() {
  for (let i = 0; i < 100; i += 1) {
    const st = await (await fetch(`${BASE}/api/state`)).json();
    if (!st.running) return st;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('koşu bitmedi');
}
const proj = pathm.join(SANDBOX, 'ornek-proje');
fsm.mkdirSync(pathm.join(proj, 'datasets', 'mini-2'), { recursive: true });
fsm.writeFileSync(pathm.join(proj, 'datasets', 'mini-2', 'conversation_dataset.json'), JSON.stringify([
  { id: 1, conversation_thread_id: 't1', prompt: 'bir' },
  { id: 2, conversation_thread_id: 't1', prompt: 'iki' },
]));
// Sözleşme: SQUIRREL_DATASET_FILE'ı oku, '# item=N' bas, SQUIRREL_OUT_DIR/results.jsonl'e yaz.
fsm.writeFileSync(pathm.join(proj, 'squirrel.harness.mjs'), `
import fs from 'node:fs'; import path from 'node:path';
const items = JSON.parse(fs.readFileSync(process.env.SQUIRREL_DATASET_FILE, 'utf8'));
for (const it of items) {
  console.log('# item=' + it.id);
  fs.appendFileSync(path.join(process.env.SQUIRREL_OUT_DIR, 'results.jsonl'), JSON.stringify({
    index: it.id, input: it.prompt, output: process.env.BOT + ':' + it.prompt + ':' + process.argv.includes('--hizli'),
  }) + '\\n');
}
`);
const pj = await post('/api/config', { repo_root: proj });
check('project.generic_select', pj.ok && pj.harness_kind === 'custom' && pj.datasets_in_project, JSON.stringify({ kind: pj.harness_kind }));
const bad = await post('/api/config', { repo_root: pathm.join(SANDBOX, 'yok-boyle-klasor') });
check('project.missing_folder_rejected', bad.ok === false);
const runGen = await post('/api/run', { dataset: 'mini-2', env: 'BOT=botx', args: '--hizli' });
const stGen = await waitIdle();
const outs = (stGen.results || []).map((r) => r.agent_text);
check('harness.generic_run', runGen.ok && outs.join('|') === 'botx:bir:true|botx:iki:true', outs.join('|'));
check('harness.no_write_into_project', !fsm.existsSync(pathm.join(proj, 'output')));

// ---- 7. proje paketi: dışa aktar → temizle → içe aktar → repo olmadan koş ----
const zip = pathm.join(SANDBOX, 'ornek-proje.squirrel.zip');
const exp = await post('/api/project-export', { dest: zip });
check('package.export', exp.ok && fsm.existsSync(zip), JSON.stringify(exp).slice(0, 80));
fsm.rmSync(proj, { recursive: true, force: true }); // orijinal proje artık yok
const imp = await post('/api/project-import', { file: zip });
check('package.import', imp.ok && imp.harness_kind === 'custom' && imp.repo_root.includes(`${pathm.sep}projects${pathm.sep}`), imp.error || '');
await post('/api/run', { dataset: 'mini-2', env: 'BOT=paket' });
const stImp = await waitIdle();
check('package.runs_without_repo', (stImp.results || []).length === 2 && stImp.results[0].agent_text.startsWith('paket:'));
await post('/api/config', { repo_root: '' });

// ---- 8. e2e-chat betiği düzensiz bir klasörde, dataset Squirrel'de ----
// run-chat-suite.mjs sözleşmesini taklit eden sahte betik: dataset'i yalnız
// kendi yanında ya da --file ile bulur, çıktısını betik/../../output'a yazar
// ve '# cikti=' ile bildirir; ekleri attachment.url'den okur.
const loose = pathm.join(SANDBOX, 'rastgele-klasor');
fsm.mkdirSync(loose, { recursive: true });
fsm.writeFileSync(pathm.join(loose, 'run-chat-suite.mjs'), `
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2); const get = (n) => { const i = args.indexOf('--' + n); return i < 0 ? null : args[i + 1]; };
const HARNESS_DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HARNESS_DIR, '../..');
const ds = get('dataset'); const fileArg = get('file');
const FILE = fileArg ? path.resolve(ROOT, fileArg) : path.join(HARNESS_DIR, 'datasets', ds, 'conversation_dataset.json');
if (!fs.existsSync(FILE)) { console.error('Mesaj dosyasi yok: ' + FILE); process.exit(1); }
const suite = fileArg ? path.basename(fileArg, path.extname(fileArg)) : ds;
const out = path.join(ROOT, 'output', 'e2e-chat', suite, String(Date.now()));
fs.mkdirSync(out, { recursive: true });
console.log('# cikti=' + path.relative(ROOT, out));
for (const it of JSON.parse(fs.readFileSync(FILE, 'utf8'))) {
  console.log('[' + it.id + '] gonderiliyor');
  const att = (it.attachments || []).every((a) => fs.existsSync(String(a.url || '').replace(/^file:\\/\\//, '')));
  fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify({ index: it.id, message: it.prompt,
    assistant_text: 'sid=' + process.env.MMX_REFRESH_TOKEN + ' ek=' + att, status: 'completed',
    completion_status: 'completed', terminal_reason: 'final_answer' }) + '\\n');
}
`);
const ownDs = pathm.join(SANDBOX, 'data', 'data', 'datasets', 'gorsel-1');
fsm.mkdirSync(pathm.join(ownDs, 'attachments'), { recursive: true });
fsm.writeFileSync(pathm.join(ownDs, 'attachments', 'resim.png'), 'png');
fsm.writeFileSync(pathm.join(ownDs, 'conversation_dataset.json'), JSON.stringify([
  { id: 1, prompt: 'bu görsel ne', attachments: [{ name: 'resim.png', type: 'image/png' }] },
]));
const sel = await post('/api/config', { repo_root: loose });
check('e2e.loose_script_recognized', sel.ok && sel.harness_kind === 'e2e-chat', sel.harness_kind);
const runE2E = await post('/api/run', { dataset: 'gorsel-1', refresh_token: 'SID-9' });
const stE2E = await waitIdle();
const e2eOut = (stE2E.results || []).map((r) => r.agent_text).join('|');
check('e2e.dataset_via_file_with_attachments', runE2E.ok && e2eOut === 'sid=SID-9 ek=true', e2eOut || runE2E.error);
check('e2e.no_output_in_user_folders', !fsm.existsSync(pathm.join(SANDBOX, 'output')) && !fsm.existsSync(pathm.join(loose, 'output')));
const arcE2E = await (await fetch(`${BASE}/api/archive`)).json();
check('e2e.run_in_archive', (arcE2E.runs || []).some((r) => r.id.startsWith('gorsel-1/')));
await post('/api/config', { repo_root: '' });

// ---- temizlik ----
await fetch(`${BASE}/api/dataset-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'sqtest-tmp' }) });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} geçti`);
process.exit(failed ? 1 : 0);
