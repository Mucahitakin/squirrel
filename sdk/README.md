# squirrel-trace

Lightweight, zero-dependency tracing SDK for **Squirrel** — a local,
open-source LLM observability and testing app. Send runs, turns, tool calls,
token usage and trace events from any Node.js application with a few lines of
code; they show up live in Squirrel's **Runs**, **Trace** and **Monitoring**
views.

- **Fail-open delivery** — if Squirrel is not running, your app never throws;
  records are buffered and retried on the next `flush()` / `end()`.
- **Project API keys** — the key you pass determines which project the data
  lands in (copy a key from Squirrel's *Projects* table).
- **Cross-language contract** — the API surface is designed to be mirrored
  one-to-one by the upcoming Python SDK (see the parity table below).

## Installation

```bash
npm install squirrel-trace
# local install while unpublished:
npm install /path/to/Squirrel/sdk
```

Requires Node.js 18+ (built-in `fetch`).

## Configuration

Explicit options always win; otherwise these environment variables are read:

| Variable | Meaning | Default |
|---|---|---|
| `SQUIRREL_API_KEY` | Project API key | — (required) |
| `SQUIRREL_URL` | Squirrel instance URL | `http://localhost:4590` |
| `SQUIRREL_PROJECT` | Fallback project slug | `app` |

With the environment set, integration is two lines:

```js
import Squirrel from 'squirrel-trace';
const sq = new Squirrel();   // reads SQUIRREL_API_KEY / SQUIRREL_URL
await sq.validate();         // optional: throws if the key/instance is wrong
```

## Quickstart

```js
import Squirrel, { traceable, withRun } from 'squirrel-trace';

const sq = new Squirrel({
  url: 'http://localhost:4590',   // your Squirrel instance
  apiKey: 'sq_PROJECT_KEY',       // Squirrel → Projects → copy key
});

const run = sq.startRun();
const turn = run.turn({
  input: 'Hello!', thread: 'chat-1', category: 'greeting',
  tags: ['prod', 'v2'],                          // filterable in the Runs view
  metadata: { model: 'gpt-4o', region: 'eu' },   // shown in the detail panel
});
const search = turn.startTool('web.search');
// ... do the search ...
search.end();                                    // duration measured automatically
turn.usage({ input: 1200, output: 240 });        // token counts → Monitoring
turn.score('correctness', 0.9);                  // feedback → detail panel + Monitoring
await turn.end({ output: 'Hi! How can I help?', status: 'completed' });
await run.end();
```

### Wrapping existing functions

```js
// Decorator-style wrapper — every call becomes a recorded turn:
await withRun(sq, async (run) => {
  const answer = traceable(run, answerFn, { name: 'answer', thread: 'customer-1' });
  await answer('What are your prices?');  // input/output/duration/errors recorded
});
```

## Running datasets (evaluate-style)

Run a Squirrel dataset through your own function — no HTTP endpoint needed.
Every call is recorded as a turn; report internals from inside your pipeline:

```js
import Squirrel, { runDataset } from 'squirrel-trace';

const sq = new Squirrel();  // SQUIRREL_API_KEY / SQUIRREL_URL from env

const summary = await runDataset(sq, {
  dataset: 'agent-60',
  concurrency: 4,             // optional: items in parallel (default 1)
  target: async (input, { turn }) => {
    turn.tool('vector.search');                 // internal steps → trace
    const answer = await myChatbot(input);
    turn.usage({ input: 900, output: 180 });    // tokens → Monitoring
    return answer;
  },
});
console.log(summary);  // { total, completed, failed, run }
```

## API reference

| API | Description |
|---|---|
| `new Squirrel({url, apiKey, project?})` | Client. A project-scoped `apiKey` routes records to that project. |
| `sq.validate()` | Verify key + connection; resolves with the project name, throws otherwise. |
| `sq.startRun({name?})` | Start a run. `name` defaults to an ISO timestamp; reusing a name appends to the same run. |
| `run.turn({input, thread?, category?, tags?, metadata?})` | Start a turn (one user interaction). |
| `turn.tool(capability, status?, {durationMs?})` | Record a tool call, optionally with its duration. Chainable. |
| `turn.startTool(capability)` | Start a measured tool call; `.end(status?)` records it with the elapsed duration. |
| `turn.score(key, value, {comment?})` | Attach a feedback score (0–1); averaged in Monitoring. Chainable. |
| `turn.tag(...tags)` | Add tags; turns are filterable by tag in the Runs view. Chainable. |
| `turn.meta({...})` | Merge key/value metadata; shown in the detail panel. Chainable. |
| `turn.usage({input, output})` | Record token usage; aggregated in Monitoring. Chainable. |
| `turn.event(type, payload)` | Record a free-form trace event. Chainable. |
| `turn.error(code, message?)` | Record an error. Chainable. |
| `turn.end({output, status?, reason?})` | Finish the turn. `status`: `completed` / `failed` / `blocked` / `needs_user`. |
| `run.flush()` / `run.end()` | Deliver buffered records (fail-open, returns `boolean`). |
| `traceable(run, fn, {name?, thread?})` | Wrap an async function; every call becomes a recorded turn. |
| `withRun(sq, work, {name?})` | Open a run, do the work, flush automatically. |
| `runDataset(sq, {dataset, target, from?, to?, concurrency?})` | Fetch a Squirrel dataset and run it through a local `target` function; every call becomes a recorded turn. |

## Cross-language API contract (Python parity)

The Python SDK will mirror this surface with idiomatic naming:

| JavaScript | Python (planned) |
|---|---|
| `new Squirrel({...})` | `Squirrel(url=..., api_key=..., project=...)` |
| `sq.startRun({name})` | `sq.start_run(name=...)` |
| `run.turn({input, thread, category})` | `run.turn(input=..., thread=..., category=...)` |
| `turn.tool(cap, status)` | `turn.tool(cap, status=...)` |
| `turn.score(key, v)` | `turn.score(key, v, comment=...)` |
| `turn.tag('a', 'b')` | `turn.tag('a', 'b')` |
| `turn.meta({...})` | `turn.meta(**kwargs)` |
| `turn.usage({input, output})` | `turn.usage(input=..., output=...)` |
| `turn.end({output, status})` | `turn.end(output=..., status=...)` |
| `traceable(run, fn, {...})` | `@traceable(run, name=..., thread=...)` |
| `withRun(sq, work)` | `with sq.run() as run:` |

## Wire protocol

Any language can integrate directly; the SDK is a thin wrapper around one
endpoint:

```
POST {url}/api/ingest
Headers: Content-Type: application/json
         x-api-key: <project api key>
Body: {
  "project": "<slug>",          // optional; ignored for project-scoped keys
  "run": "<run identifier>",    // required, stable per run
  "records": [{
    "index": 1,                 // optional; auto-assigned when omitted
    "input": "user message",
    "output": "assistant answer",
    "status": "completed",      // completed | failed | blocked | needs_user
    "thread": "chat-1",
    "category": "greeting",
    "tags": ["prod", "v2"],
    "scores": [{"key": "correctness", "value": 0.9, "comment": "..."}],
    "metadata": {"model": "gpt-4o"},
    "duration_ms": 1234,
    "tools": [{"capability": "web.search", "status": "success"}],
    "errors": [{"type": "error", "payload": {"code": "X", "message": "..."}}],
    "events": [{"sequence": 0, "type": "usage", "created_at": "...",
                "payload": {"usage": {"input_tokens": 1200, "output_tokens": 240}}}],
    "started_at": "ISO-8601", "finished_at": "ISO-8601"
  }]
}
```

Responses: `200 {"ok": true, "stored": n}` · `401` invalid key · `400` invalid payload.

## License

MIT
