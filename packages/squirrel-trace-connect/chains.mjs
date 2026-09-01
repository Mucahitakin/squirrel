/**
 * squirrel-trace-connect/chains — chain-framework callback handler for Squirrel.
 *
 * A drop-in callback handler: pass it in `callbacks` and every top-level
 * chain (or bare LLM call) is recorded as a Squirrel turn — with nested
 * LLM/tool steps as measured tool calls, token usage from the LLM output,
 * and errors marking the turn failed.
 *
 * Implemented as a plain object conforming to the CallbackHandlerMethods
 * interface, so this module has NO framework dependency and works across
 * chain-framework versions.
 *
 * @example
 * import Squirrel from 'squirrel-trace';
 * import { SquirrelCallbackHandler } from 'squirrel-trace-connect/chains';
 *
 * const run = new Squirrel().startRun();
 * const tracer = new SquirrelCallbackHandler(run, { thread: 'chat-1' });
 *
 * await chain.invoke({ question: 'Hello!' }, { callbacks: [tracer] });
 * await run.end();
 */

function asText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function llmName(llm) {
  return llm?.id?.[llm.id.length - 1] || llm?.name || 'llm';
}

export class SquirrelCallbackHandler {
  /**
   * @param {import('squirrel-trace').SquirrelRun} run The Squirrel run to record into.
   * @param {object} [options]
   * @param {string|null} [options.thread] Thread id applied to every recorded turn.
   * @param {string[]} [options.tags] Tags applied to every recorded turn.
   * @param {object|null} [options.metadata] Metadata applied to every recorded turn.
   */
  constructor(run, { thread = null, tags = [], metadata = null } = {}) {
    if (!run || typeof run.turn !== 'function') {
      throw new Error('squirrel-trace-connect: `run` must be a SquirrelRun (call sq.startRun() first).');
    }
    this.name = 'squirrel_tracer';
    this.run = run;
    this.options = { thread, tags, metadata };
    /** @internal open turns keyed by the framework run id that opened them */
    this.open = new Map();
    /** @internal in-flight nested steps keyed by their framework run id */
    this.steps = new Map();
  }

  /** @internal Root turn for a callback: the turn opened by the outermost runId. */
  _turnFor(parentRunId) {
    if (parentRunId && this.open.has(parentRunId)) return this.open.get(parentRunId).turn;
    // fall back to any open turn (single-conversation case)
    const first = this.open.values().next().value;
    return first ? first.turn : null;
  }

  _openTurn(runId, input, category) {
    const turn = this.run.turn({
      input,
      thread: this.options.thread,
      category,
      tags: this.options.tags,
      metadata: this.options.metadata,
    });
    this.open.set(runId, { turn });
    return turn;
  }

  async _closeTurn(runId, { output = '', status = 'completed', reason = null } = {}) {
    const entry = this.open.get(runId);
    if (!entry) return;
    this.open.delete(runId);
    await entry.turn.end({ output, status, reason });
  }

  // ---------- chains ----------
  handleChainStart(chain, inputs, runId, parentRunId) {
    if (parentRunId) return; // only top-level chains become turns
    this._openTurn(runId, asText(inputs), chain?.id?.[chain.id.length - 1] || 'chain');
  }

  async handleChainEnd(outputs, runId, parentRunId) {
    if (parentRunId) return;
    await this._closeTurn(runId, { output: asText(outputs), status: 'completed' });
  }

  async handleChainError(error, runId, parentRunId) {
    if (parentRunId) return;
    const entry = this.open.get(runId);
    if (entry) entry.turn.error(error?.code || error?.name || 'CHAIN_ERROR', error?.message || String(error));
    await this._closeTurn(runId, { output: '', status: 'failed', reason: 'exception' });
  }

  // ---------- LLM calls ----------
  handleLLMStart(llm, prompts, runId, parentRunId) {
    if (!parentRunId && !this.open.has(runId)) {
      // bare LLM call outside a chain — the call itself becomes the turn
      this._openTurn(runId, (prompts || []).join('\n'), llmName(llm));
    }
    this.steps.set(runId, { kind: 'llm', name: llmName(llm), startedAt: Date.now(), parentRunId });
  }

  handleChatModelStart(llm, messages, runId, parentRunId) {
    const flat = (messages || []).flat();
    const last = flat[flat.length - 1];
    const text = asText(last?.content ?? last?.kwargs?.content ?? '');
    if (!parentRunId && !this.open.has(runId)) this._openTurn(runId, text, llmName(llm));
    this.steps.set(runId, { kind: 'llm', name: llmName(llm), startedAt: Date.now(), parentRunId });
  }

  async handleLLMEnd(output, runId) {
    const step = this.steps.get(runId);
    this.steps.delete(runId);
    const turn = this.open.get(runId)?.turn || this._turnFor(step?.parentRunId);
    if (!turn) return;
    if (step) turn.tool(`llm:${step.name}`, 'success', { durationMs: Date.now() - step.startedAt });
    // Older versions report usage in llmOutput; newer chat models attach
    // usage_metadata to the generated message instead — support both.
    const usage = output?.llmOutput?.tokenUsage || output?.llmOutput?.usage
      || output?.generations?.[0]?.[0]?.message?.usage_metadata
      || output?.generations?.[0]?.[0]?.message?.kwargs?.usage_metadata;
    if (usage) {
      turn.usage({
        input: Number(usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens) || 0,
        output: Number(usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens) || 0,
      });
    }
    // bare LLM call: generation text closes the turn
    if (this.open.has(runId)) {
      const generation = output?.generations?.[0]?.[0];
      const text = generation?.text ?? asText(generation?.message?.content ?? '');
      await this._closeTurn(runId, { output: text, status: 'completed' });
    }
  }

  async handleLLMError(error, runId) {
    const step = this.steps.get(runId);
    this.steps.delete(runId);
    const turn = this.open.get(runId)?.turn || this._turnFor(step?.parentRunId);
    if (!turn) return;
    if (step) turn.tool(`llm:${step.name}`, 'error', { durationMs: Date.now() - step.startedAt });
    turn.error(error?.code || error?.name || 'LLM_ERROR', error?.message || String(error));
    if (this.open.has(runId)) await this._closeTurn(runId, { output: '', status: 'failed', reason: 'exception' });
  }

  // ---------- tools ----------
  handleToolStart(tool, input, runId, parentRunId) {
    this.steps.set(runId, {
      kind: 'tool',
      name: tool?.id?.[tool.id.length - 1] || tool?.name || 'tool',
      startedAt: Date.now(),
      parentRunId,
    });
  }

  handleToolEnd(output, runId) {
    const step = this.steps.get(runId);
    this.steps.delete(runId);
    if (!step) return;
    const turn = this._turnFor(step.parentRunId);
    if (turn) turn.tool(step.name, 'success', { durationMs: Date.now() - step.startedAt });
  }

  handleToolError(error, runId) {
    const step = this.steps.get(runId);
    this.steps.delete(runId);
    if (!step) return;
    const turn = this._turnFor(step.parentRunId);
    if (!turn) return;
    turn.tool(step.name, 'error', { durationMs: Date.now() - step.startedAt });
    turn.error(error?.code || error?.name || 'TOOL_ERROR', error?.message || String(error));
  }

  // ---------- retrievers ----------
  handleRetrieverStart(retriever, query, runId, parentRunId) {
    this.steps.set(runId, {
      kind: 'retriever',
      name: `retriever:${retriever?.id?.[retriever.id.length - 1] || retriever?.name || 'retriever'}`,
      startedAt: Date.now(),
      parentRunId,
    });
  }

  handleRetrieverEnd(documents, runId) {
    const step = this.steps.get(runId);
    this.steps.delete(runId);
    if (!step) return;
    const turn = this._turnFor(step.parentRunId);
    if (!turn) return;
    turn.tool(step.name, 'success', { durationMs: Date.now() - step.startedAt });
    turn.event('retriever.completed', { documents: Array.isArray(documents) ? documents.length : 0 });
  }

  handleRetrieverError(error, runId) {
    const step = this.steps.get(runId);
    this.steps.delete(runId);
    if (!step) return;
    const turn = this._turnFor(step.parentRunId);
    if (!turn) return;
    turn.tool(step.name, 'error', { durationMs: Date.now() - step.startedAt });
    turn.error(error?.code || error?.name || 'RETRIEVER_ERROR', error?.message || String(error));
  }
}

export default SquirrelCallbackHandler;
