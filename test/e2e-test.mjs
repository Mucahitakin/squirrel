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

// ---- temizlik ----
await fetch(`${BASE}/api/dataset-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'sqtest-tmp' }) });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} geçti`);
process.exit(failed ? 1 : 0);
