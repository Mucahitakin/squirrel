# Squirrel 🐿️

**Local, open-source LLM observability and testing.** Squirrel is a desktop app
(macOS / Windows) with a headless server mode: trace your AI app's runs, turns,
tool calls, token usage and feedback scores — on your own machine, with your
data never leaving it.

- **Runs & Traces** — every turn with its tool-call chain (`llm → tool → llm`),
  measured durations, errors and events on a timeline.
- **Live Test** — run a dataset against *any* chat endpoint straight from the
  app: pluggable auth (API key header, Bearer, session cookie, Basic, custom
  header, or a refresh-token flow that renews on 401), custom headers/body.
- **Monitoring** — success rate, token usage and latency charts per run,
  project or conversation thread.
- **Threads** — read any conversation end-to-end as chat bubbles.
- **Datasets** — build test sets from CSV/JSON/JSONL or from scratch; compare
  two runs turn-by-turn.
- **Projects & API keys** — HMAC-signed per-project keys; rotating or deleting
  a project invalidates its key instantly.

## Download (desktop app)

Grab the installer from **[Releases](../../releases/latest)**:

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `Squirrel-<version>-arm64.dmg` |
| macOS (Intel) | `Squirrel-<version>.dmg` |
| Windows | `Squirrel Setup <version>.exe` |

The builds are not notarized yet: on macOS right-click → Open the first time
(if macOS still refuses, run `xattr -cr /Applications/Squirrel.app` once); on
Windows choose “More info → Run anyway” at the SmartScreen prompt.

## Send data from your app

Install the SDK ([`squirrel-trace`](https://www.npmjs.com/package/squirrel-trace),
zero dependencies) and copy a project API key from the app's **Projects** page:

```js
import Squirrel from 'squirrel-trace';

const sq = new Squirrel({ apiKey: 'sq1....' });   // or SQUIRREL_API_KEY env
const run = sq.startRun();
const turn = run.turn({ input: 'Hello!', thread: 'chat-1' });
turn.tool('web.search').usage({ input: 1200, output: 240 });
await turn.end({ output: 'Hi! How can I help?' });
await run.end();
```

Automatic tracing for OpenAI clients (streaming included) and chain-framework
callbacks lives in
[`squirrel-trace-connect`](https://www.npmjs.com/package/squirrel-trace-connect):

```js
import { wrapOpenAI } from 'squirrel-trace-connect/openai';
const openai = wrapOpenAI(new OpenAI(), run);      // every call → a traced turn
```

Not on Node? Any language can integrate over the documented
[wire protocol](https://www.npmjs.com/package/squirrel-trace#wire-protocol) — a single
`POST /api/ingest` endpoint (see the zero-dependency Python example pattern in
the SDK docs).

## Run your own test script (harness)

Pick **any project folder** in *Live Test → Test script*. Squirrel finds
datasets in `datasets/` (one sub-folder per dataset with a
`conversation_dataset.json`, `messages.json` or `messages.txt`) and your test
script at `squirrel.harness.{mjs,js,py,sh}` — or point it at any script with
**Pick script…**. JavaScript scripts run on Squirrel's bundled runtime, so the
target machine needs no Node install.

The contract is small:

| Squirrel gives your script | Your script does |
|---|---|
| `--dataset <name>` (+ `--from`/`--to`, your extra args) | print `# item=<n>` when it starts an item (live progress) |
| `SQUIRREL_DATASET_FILE`, `SQUIRREL_DATASET_DIR` | read the items |
| `SQUIRREL_OUT_DIR` | append one JSON line per item to `SQUIRREL_OUT_DIR/results.jsonl` |
| your env vars from the form (`API_URL=…`) | — |

A result line needs only `{"index": 1, "input": "…", "output": "…"}`; add
`status`, `duration_ms`, `tools`, `errors`, `thread` for richer traces.

```js
// squirrel.harness.mjs
import fs from 'node:fs'; import path from 'node:path';
const items = JSON.parse(fs.readFileSync(process.env.SQUIRREL_DATASET_FILE, 'utf8'));
for (const item of items) {
  console.log(`# item=${item.id}`);
  const output = await callMyBot(item.prompt);          // your system
  fs.appendFileSync(path.join(process.env.SQUIRREL_OUT_DIR, 'results.jsonl'),
    JSON.stringify({ index: item.id, input: item.prompt, output }) + '\n');
}
```

**Take it to another machine:** *Package project* zips the script and its
datasets (layout preserved, no `node_modules`/`.git`/outputs); on the other
machine *Import package…* unpacks it into Squirrel's own data folder, so it
runs there without the original repository.

## Server / Docker (headless)

The UI is a plain web app served by a dependency-free Node server — you can
host Squirrel for a team:

```bash
docker compose up -d          # UI on http://HOST:4590, data in a named volume
```

or without Docker (Node 18+):

```bash
SQUIRREL_HOST=0.0.0.0 SQUIRREL_PORT=4590 SQUIRREL_DATA_DIR=/var/lib/squirrel node app/server.mjs
```

> **Security note:** the web UI has no built-in login. If you bind to anything
> other than `127.0.0.1`, put it behind a VPN or a reverse proxy with TLS and
> authentication. Ingest itself always requires a project API key.

## Development

```bash
npm install
npm start         # Electron desktop app
npm run server    # headless server only
npm test          # end-to-end smoke suite (mock chat API + real server)
npm run dist      # build macOS + Windows installers (electron-builder)
```

Repo layout: [`app/`](app) desktop app & server · [`test/`](test) e2e suite.
The SDKs are developed separately and published on npm.

## License

[MIT](LICENSE)
