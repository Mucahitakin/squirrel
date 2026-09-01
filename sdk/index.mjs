/**
 * squirrel-trace — lightweight tracing SDK for Squirrel.
 *
 * Sends runs, turns, tool calls, token usage and free-form events from any
 * Node.js application to a local Squirrel instance, where they appear in the
 * Runs, Trace and Monitoring views (local LLM observability).
 *
 * Delivery is fail-open by design: if Squirrel is not running, your
 * application never throws — records are buffered in memory and retried on
 * the next `flush()` / `end()`.
 *
 * @example
 * import Squirrel, { traceable, withRun } from 'squirrel-trace';
 *
 * const sq = new Squirrel({ apiKey: 'sq_PROJECT_KEY' });
 * const run = sq.startRun();
 * const turn = run.turn({ input: 'Hello!', thread: 'chat-1' });
 * turn.tool('web.search').usage({ input: 1200, output: 240 });
 * await turn.end({ output: 'Hi, how can I help?' });
 * await run.end();
 */

/** @typedef {'completed' | 'failed' | 'blocked' | 'needs_user'} TurnStatus */

export class Squirrel {
  /**
   * @param {object} options
   * @param {string} options.apiKey Project API key (copy it from the Squirrel
   *   Projects table). The key determines which project records are stored in.
   * @param {string} [options.url='http://localhost:4590'] Base URL of the
   *   Squirrel instance.
   * @param {string} [options.project='app'] Fallback project slug. Only used
   *   when the key is a master key; a project-scoped key always wins.
   * @param {typeof fetch} [options.fetchImpl=fetch] Custom fetch implementation.
   */
  constructor({
    url = process.env.SQUIRREL_URL || 'http://localhost:4590',
    apiKey = process.env.SQUIRREL_API_KEY,
    project = process.env.SQUIRREL_PROJECT || 'app',
    fetchImpl = fetch,
  } = {}) {
    if (!apiKey) {
      throw new Error(
        'squirrel-trace: `apiKey` is required — pass it explicitly or set the SQUIRREL_API_KEY environment variable (copy the key from the Squirrel Projects page).',
      );
    }
    this.url = String(url).replace(/\/+$/u, '');
    this.apiKey = apiKey;
    this.project = project;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Verify the API key against the Squirrel instance. Resolves with the project name the key is
   * scoped to; throws if Squirrel is unreachable or the key is invalid.
   * @returns {Promise<string>} The project name the key belongs to.
   */
  async validate() {
    let res;
    try {
      res = await this.fetchImpl(`${this.url}/api/validate`, { headers: { 'x-api-key': this.apiKey } });
    } catch (error) {
      throw new Error(`squirrel-trace: could not reach Squirrel at ${this.url} — ${error?.message || error}`);
    }
    if (!res.ok) throw new Error(`squirrel-trace: API key rejected by ${this.url} (HTTP ${res.status}).`);
    const { project } = await res.json();
    return project;
  }

  /**
   * Start a new run (one test session / one batch of turns).
   * @param {object} [options]
   * @param {string} [options.name] Stable run identifier. Defaults to an
   *   ISO-8601 timestamp; reusing a name appends to the same run.
   * @returns {SquirrelRun}
   */
  startRun({ name } = {}) {
    // Normalized the same way the server stores it, so `run.runKey` always
    // matches the run id you will see in Squirrel.
    const raw = name || new Date().toISOString().replace(/[:.]/gu, '-');
    const runKey = String(raw).trim().replace(/[^A-Za-z0-9-_.:]+/gu, '').slice(0, 60);
    if (!runKey) throw new Error('squirrel-trace: run `name` must contain at least one of [A-Za-z0-9-_.:].');
    return new SquirrelRun(this, runKey);
  }
}

/**
 * Safety cap for the in-memory buffer: if Squirrel stays unreachable, the
 * oldest records are dropped past this point so a long-running app can
 * never leak unbounded memory through the SDK.
 */
const MAX_PENDING = 5000;

export class SquirrelRun {
  /** @internal */
  constructor(client, runKey) {
    this.client = client;
    this.runKey = runKey;
    this.pending = [];
    this.counter = 0;
  }

  /**
   * Start a new turn (one user interaction).
   * @param {object} [options]
   * @param {string} [options.input=''] The user input for this turn.
   * @param {string|null} [options.thread=null] Conversation/thread identifier.
   *   Feeds the thread filter in Monitoring.
   * @param {string|null} [options.category=null] Free-form category label.
   * @param {string[]} [options.tags=[]] Tags for filtering in the Runs view
   *   (e.g. ['prod', 'v2']).
   * @param {object|null} [options.metadata=null] Arbitrary key/value metadata,
   *   shown in the turn detail panel.
   * @returns {SquirrelTurn}
   */
  turn({ input = '', thread = null, category = null, tags = [], metadata = null } = {}) {
    this.counter += 1;
    return new SquirrelTurn(this, {
      index: this.counter,
      input: String(input),
      thread,
      category,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      metadata: metadata && typeof metadata === 'object' ? { ...metadata } : null,
      tools: [],
      errors: [],
      events: [],
      scores: [],
      started_at: new Date().toISOString(),
      _t0: Date.now(),
    });
  }

  /** @internal */
  _queue(record) {
    this.pending.push(record);
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
  }

  /**
   * Send all buffered records. Never throws on network failure.
   * Concurrent calls are serialized: a flush started while another is in
   * flight waits for it, then delivers anything still pending — so records
   * are never sent twice or out of order.
   * @returns {Promise<boolean>} true if everything was delivered.
   */
  async flush() {
    if (this._flushing) {
      await this._flushing.catch(() => {});
      if (!this.pending.length) return true;
    }
    this._flushing = this._deliver();
    try { return await this._flushing; }
    finally { this._flushing = null; }
  }

  /** @internal */
  async _deliver() {
    if (!this.pending.length) return true;
    const batch = this.pending.splice(0, this.pending.length);
    try {
      const res = await this.client.fetchImpl(`${this.client.url}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.client.apiKey },
        body: JSON.stringify({ project: this.client.project, run: this.runKey, records: batch }),
      });
      if (!res.ok) { this.pending.unshift(...batch); return false; }
      return true;
    } catch {
      this.pending.unshift(...batch);
      return false;
    }
  }

  /**
   * Flush remaining records and finish the run.
   * @returns {Promise<boolean>} true if nothing is left pending.
   */
  async end() { return this.flush(); }
}

export class SquirrelTurn {
  /** @internal */
  constructor(run, record) {
    this.run = run;
    this.r = record;
    this.ended = false;
  }

  /**
   * Record a tool call. Chainable.
   * @param {string} capability Tool/capability name, e.g. 'web.search'.
   * @param {'success'|'error'} [status='success']
   * @param {object} [options]
   * @param {number} [options.durationMs] How long the tool call took.
   * @returns {this}
   */
  tool(capability, status = 'success', { durationMs } = {}) {
    const entry = { capability: String(capability), status };
    if (Number(durationMs) > 0) entry.duration_ms = Math.round(Number(durationMs));
    this.r.tools.push(entry);
    this.event('tool.completed', { ...entry });
    return this;
  }

  /**
   * Start a measured tool call; call `.end()` when it finishes and the
   * duration is recorded automatically.
   *
   * @example
   * const search = turn.startTool('web.search');
   * const hits = await doSearch(query);
   * search.end();                    // success, duration measured
   * // or on failure: search.end('error')
   *
   * @param {string} capability
   * @returns {{end: (status?: 'success'|'error') => SquirrelTurn}}
   */
  startTool(capability) {
    const startedAt = Date.now();
    let done = false;
    return {
      end: (status = 'success') => {
        if (!done) {
          done = true;
          this.tool(capability, status, { durationMs: Date.now() - startedAt });
        }
        return this;
      },
    };
  }

  /**
   * Attach a feedback score to the turn. Scores are shown in the turn detail panel and
   * averaged per run/project in Monitoring. Chainable.
   *
   * @example
   * turn.score('correctness', 0.9);
   * turn.score('helpfulness', 1, { comment: 'answered directly' });
   *
   * @param {string} key Score name, e.g. 'correctness'.
   * @param {number} value Score between 0 and 1.
   * @param {object} [options]
   * @param {string} [options.comment] Optional explanation.
   * @returns {this}
   */
  score(key, value, { comment } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
      throw new Error('squirrel-trace: score `value` must be a number between 0 and 1.');
    }
    this.r.scores.push({
      key: String(key || 'score'),
      value: numeric,
      ...(comment ? { comment: String(comment) } : {}),
    });
    return this;
  }

  /**
   * Add one or more tags to the turn; tags are filterable in the Runs view.
   * Chainable.
   * @param {...string} tags
   * @returns {this}
   */
  tag(...tags) {
    for (const tag of tags) {
      const clean = String(tag).trim();
      if (clean && !this.r.tags.includes(clean)) this.r.tags.push(clean);
    }
    return this;
  }

  /**
   * Merge key/value metadata into the turn; shown in the detail panel.
   * Chainable.
   * @param {object} metadata
   * @returns {this}
   */
  meta(metadata) {
    if (metadata && typeof metadata === 'object') {
      this.r.metadata = { ...(this.r.metadata || {}), ...metadata };
    }
    return this;
  }

  /**
   * Record an error. Chainable.
   * @param {string} code Machine-readable error code.
   * @param {string} [message='']
   * @returns {this}
   */
  error(code, message = '') {
    this.r.errors.push({ type: 'error', payload: { code: String(code), message: String(message) } });
    this.event('error', { code: String(code), message: String(message) });
    return this;
  }

  /**
   * Record a free-form event; it shows up on the trace timeline. Chainable.
   * @param {string} type Event type, e.g. 'model.completed'.
   * @param {object} [payload={}]
   * @returns {this}
   */
  event(type, payload = {}) {
    this.r.events.push({
      sequence: this.r.events.length,
      type: String(type),
      created_at: new Date().toISOString(),
      payload,
    });
    return this;
  }

  /**
   * Record token usage; aggregated in Monitoring. Chainable.
   * @param {object} [options]
   * @param {number} [options.input=0] Input (prompt) tokens.
   * @param {number} [options.output=0] Output (completion) tokens.
   * @returns {this}
   */
  usage({ input = 0, output = 0 } = {}) {
    return this.event('usage', {
      usage: { input_tokens: Number(input) || 0, output_tokens: Number(output) || 0 },
    });
  }

  /**
   * Finish the turn and enqueue it for delivery.
   * @param {object} [options]
   * @param {string} [options.output=''] The assistant output for this turn.
   * @param {TurnStatus} [options.status='completed']
   * @param {string|null} [options.reason=null] Optional terminal reason.
   * @param {boolean} [options.flush=true] Flush immediately after enqueueing.
   */
  async end({ output = '', status = 'completed', reason = null, flush = true } = {}) {
    if (this.ended) return;
    this.ended = true;
    const { _t0, input, thread, ...rest } = this.r;
    this.run._queue({
      ...rest,
      input,
      thread,
      output: String(output),
      status,
      reason,
      duration_ms: Date.now() - _t0,
      finished_at: new Date().toISOString(),
    });
    if (flush) await this.run.flush();
  }
}

/**
 * Wrap an async function so every call is recorded as a turn (decorator
 * style). Input, output, duration
 * and thrown errors are captured automatically; the wrapped function's
 * behavior (return value / thrown error) is unchanged.
 *
 * @template {(...args: any[]) => Promise<any>} F
 * @param {SquirrelRun} run
 * @param {F} fn
 * @param {object} [options]
 * @param {string} [options.name] Turn category; defaults to `fn.name`.
 * @param {string|null} [options.thread=null]
 * @param {string|null} [options.category=null] Overrides `name` as category.
 * @param {string[]} [options.tags=[]] Tags applied to every recorded turn.
 * @param {object|null} [options.metadata=null] Metadata applied to every turn.
 * @returns {F}
 */
export function traceable(run, fn, { name = fn.name || 'fn', thread = null, category = null, tags = [], metadata = null } = {}) {
  // Plain function (not arrow) so `this` is forwarded — wrapping an object
  // method keeps working: obj.answer = traceable(run, obj.answer).
  return /** @type {any} */ (async function traced(...args) {
    const input = args.length === 1 ? args[0] : args;
    const turn = run.turn({
      input: typeof input === 'string' ? input : JSON.stringify(input),
      thread,
      category: category || name,
      tags,
      metadata,
    });
    try {
      const result = await fn.apply(this, args);
      await turn.end({
        output: typeof result === 'string' ? result : JSON.stringify(result),
        status: 'completed',
      });
      return result;
    } catch (error) {
      turn.error(error?.code || error?.name || 'ERROR', error?.message || String(error));
      await turn.end({ output: '', status: 'failed', reason: 'exception' });
      throw error;
    }
  });
}

/**
 * Open a run, do the work, flush automatically — the counterpart of a Python
 * context manager (`with squirrel.run() as run:`).
 *
 * @template T
 * @param {Squirrel} client
 * @param {(run: SquirrelRun) => Promise<T>} work
 * @param {{name?: string}} [options]
 * @returns {Promise<T>}
 */
export async function withRun(client, work, options = {}) {
  const run = client.startRun(options);
  try { return await work(run); }
  finally { await run.end(); }
}

/**
 * Run a Squirrel dataset through a local target function (evaluation
 * runner). Items are fetched from the Squirrel
 * instance, passed to `target` one by one, and every call is recorded as a
 * turn (input, output, duration, thrown errors).
 *
 * The target runs inside YOUR process, so it can also report internals:
 * the second argument is the live turn — call `turn.tool()` / `turn.usage()` /
 * `turn.event()` from inside your pipeline for full traces.
 *
 * @example
 * const summary = await runDataset(sq, {
 *   dataset: 'agent-60',
 *   target: async (input, { turn, item }) => {
 *     turn.tool('vector.search');
 *     const answer = await myBot(input);
 *     turn.usage({ input: 900, output: 180 });
 *     return answer;
 *   },
 * });
 * // -> { total, completed, failed, run }
 *
 * @param {Squirrel} client
 * @param {object} options
 * @param {string} options.dataset Dataset name in Squirrel.
 * @param {(input: string, ctx: {item: object, turn: SquirrelTurn}) => Promise<any>} options.target
 * @param {string} [options.name] Run name (defaults to `<dataset>-<timestamp>`).
 * @param {number} [options.from] First item index (1-based, inclusive).
 * @param {number} [options.to] Last item index (inclusive).
 * @param {number} [options.concurrency=1] Items processed in parallel (1–16).
 * @returns {Promise<{total: number, completed: number, failed: number, run: string}>}
 */
export async function runDataset(client, { dataset, target, name, from, to, concurrency = 1 } = {}) {
  if (!dataset) throw new Error('squirrel-trace: `dataset` is required.');
  if (typeof target !== 'function') throw new Error('squirrel-trace: `target` must be a function.');
  const res = await client.fetchImpl(
    `${client.url}/api/dataset-items?name=${encodeURIComponent(dataset)}`,
    { headers: { 'x-api-key': client.apiKey } },
  );
  if (!res.ok) throw new Error(`squirrel-trace: could not fetch dataset '${dataset}' (HTTP ${res.status}).`);
  const { items = [] } = await res.json();
  const selected = items.filter((item) => (
    (from == null || item.index >= from) && (to == null || item.index <= to)
  ));
  const run = client.startRun({ name: name || `${dataset}-${new Date().toISOString().replace(/[:.]/gu, '-')}` });
  let completed = 0; let failed = 0;
  let cursor = 0;
  const workers = Math.max(1, Math.min(Math.floor(Number(concurrency)) || 1, 16));
  const worker = async () => {
    while (cursor < selected.length) {
      const item = selected[cursor];
      cursor += 1;
      const turn = run.turn({ input: item.prompt, thread: item.thread, category: item.category });
      try {
        const output = await target(item.prompt, { item, turn });
        await turn.end({ output: typeof output === 'string' ? output : JSON.stringify(output ?? '') });
        completed += 1;
      } catch (error) {
        turn.error(error?.code || error?.name || 'ERROR', error?.message || String(error));
        await turn.end({ output: '', status: 'failed', reason: 'exception' });
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  await run.end();
  return { total: selected.length, completed, failed, run: run.runKey };
}

export default Squirrel;
