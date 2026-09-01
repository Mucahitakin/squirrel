# Changelog

## 0.6.0
- `sq.validate()` — verify the API key / connection before a run; resolves
  with the project name the key is scoped to.
- `runDataset({ concurrency })` — process dataset items in parallel (1–16)
  for faster evaluation runs.
- `traceable()` now forwards `this`, so wrapped object methods keep working.

## 0.5.0
- Feedback scores: `turn.score('correctness', 0.9, { comment })` — shown in
  the turn detail panel, averaged per run/project in Monitoring.
- Companion package released: `squirrel-trace-connect` — official
  integrations under one name (`squirrel-trace-connect/openai` for automatic
  OpenAI call tracing, `squirrel-trace-connect/chains` for a chain-framework
  callback handler).

## 0.4.0
- Tags: `run.turn({ tags: ['prod'] })` and chainable `turn.tag('a', 'b')` —
  turns are filterable by tag in Squirrel's Runs view.
- Metadata: `run.turn({ metadata: {...} })` and chainable `turn.meta({...})` —
  shown in the turn detail panel.
- `traceable()` accepts `tags` / `metadata`, applied to every recorded turn.
- Works with Squirrel's new run comparison view (`/api/compare`).
- Robustness: concurrent `flush()` calls are serialized (no duplicated or
  reordered records), the offline buffer is capped at 5000 records, and run
  names are normalized client-side so `run.runKey` always matches the run id
  shown in Squirrel.

## 0.3.0
- `turn.tool()` accepts `{ durationMs }`; per-tool durations show in Squirrel.
- New `turn.startTool(capability)` helper — measures duration automatically.
- Live ingest: records appear in the Squirrel UI in real time (server-side SSE).

## 0.2.0
- English-only public API, docs and error messages.
- TypeScript type declarations (`index.d.ts`).
- `traceable()` wrapper and `withRun()` helper.
- Per-project API keys: the key determines the target project.

## 0.1.0
- Initial release: `Squirrel` client, runs, turns, tools, usage, events, fail-open flush.
