/**
 * squirrel-trace-connect/openai — automatic OpenAI call tracing for Squirrel.
 *
 * Wrap an OpenAI client once and every `chat.completions.create` /
 * `responses.create` call is recorded as a Squirrel turn: input, output,
 * model, token usage and duration — no per-call code needed.
 * The wrapped client behaves exactly like the original (same return values,
 * same thrown errors); tracing is fail-open via squirrel-trace.
 *
 * @example
 * import OpenAI from 'openai';
 * import Squirrel from 'squirrel-trace';
 * import { wrapOpenAI } from 'squirrel-trace-connect/openai';
 *
 * const run = new Squirrel().startRun();
 * const openai = wrapOpenAI(new OpenAI(), run, { thread: 'chat-1' });
 *
 * const res = await openai.chat.completions.create({
 *   model: 'gpt-4o-mini',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * });
 * await run.end();
 */

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    }
  }
  return '';
}

function extractChatOutput(result) {
  const choice = result?.choices?.[0];
  if (!choice) return '';
  if (typeof choice.message?.content === 'string') return choice.message.content;
  if (choice.message?.tool_calls?.length) return JSON.stringify(choice.message.tool_calls);
  return '';
}

function extractResponsesOutput(result) {
  if (typeof result?.output_text === 'string') return result.output_text;
  if (Array.isArray(result?.output)) return JSON.stringify(result.output);
  return '';
}

function extractUsage(result) {
  const usage = result?.usage;
  if (!usage) return null;
  return {
    input: Number(usage.prompt_tokens ?? usage.input_tokens) || 0,
    output: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
  };
}

// ---------- streaming aggregation ----------
// A streamed call is traced by watching the chunks as the CALLER consumes
// them: text deltas are aggregated into the turn output and
// usage is read from the final chunk when the API provides it (chat streams
// include it only with `stream_options: { include_usage: true }`).

function chatChunkInto(chunk, acc) {
  const delta = chunk?.choices?.[0]?.delta;
  if (typeof delta?.content === 'string') acc.text += delta.content;
  if (chunk?.usage) acc.usage = extractUsage(chunk);
}

function responsesChunkInto(event, acc) {
  if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') acc.text += event.delta;
  if (event?.type === 'response.completed' && event.response) {
    if (typeof event.response.output_text === 'string') acc.text = event.response.output_text;
    acc.usage = extractUsage(event.response);
  }
}

function wrapStream(stream, chunkInto, onDone, onError) {
  // Object.create keeps the stream's own surface (tee(), controller, …);
  // only iteration is intercepted, and only the first iteration is observed.
  const wrapped = Object.create(stream);
  let observed = false;
  wrapped[Symbol.asyncIterator] = function iterate() {
    if (observed) return stream[Symbol.asyncIterator]();
    observed = true;
    const inner = stream[Symbol.asyncIterator]();
    const acc = { text: '', usage: null };
    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; fn(acc); } };
    return {
      async next() {
        try {
          const step = await inner.next();
          if (step.done) settle(onDone);
          else chunkInto(step.value, acc);
          return step;
        } catch (error) {
          settle(() => onError(error, acc));
          throw error;
        }
      },
      async return(value) {
        // Caller stopped early (break / abort): record what was streamed so far.
        settle(onDone);
        return inner.return ? inner.return(value) : { value, done: true };
      },
      async throw(error) {
        settle(() => onError(error, acc));
        if (inner.throw) return inner.throw(error);
        throw error;
      },
    };
  };
  return wrapped;
}

function traced(run, options, kind, inputOf, outputOf, chunkInto, original) {
  return async function create(params, ...rest) {
    const turn = run.turn({
      input: inputOf(params),
      thread: options.thread ?? null,
      category: options.category ?? kind,
      tags: options.tags ?? [],
      metadata: { ...(options.metadata || {}), model: params?.model || 'unknown', ...(params?.stream ? { stream: true } : {}) },
    });
    const startedAt = Date.now();
    const fail = (error) => {
      turn.tool(`openai:${params?.model || kind}`, 'error', { durationMs: Date.now() - startedAt });
      turn.error(error?.code || error?.name || 'OPENAI_ERROR', error?.message || String(error));
      return turn.end({ output: '', status: 'failed', reason: 'exception' });
    };
    try {
      const result = await original(params, ...rest);
      if (params?.stream && result && typeof result[Symbol.asyncIterator] === 'function') {
        return wrapStream(
          result,
          chunkInto,
          (acc) => {
            turn.tool(`openai:${params?.model || kind}`, 'success', { durationMs: Date.now() - startedAt });
            if (acc.usage) turn.usage(acc.usage);
            turn.end({ output: acc.text, status: 'completed' });
          },
          (error, acc) => {
            turn.tool(`openai:${params?.model || kind}`, 'error', { durationMs: Date.now() - startedAt });
            turn.error(error?.code || error?.name || 'OPENAI_ERROR', error?.message || String(error));
            turn.end({ output: acc.text, status: 'failed', reason: 'exception' });
          },
        );
      }
      turn.tool(`openai:${params?.model || kind}`, 'success', { durationMs: Date.now() - startedAt });
      const usage = extractUsage(result);
      if (usage) turn.usage(usage);
      await turn.end({ output: outputOf(result), status: 'completed' });
      return result;
    } catch (error) {
      await fail(error);
      throw error;
    }
  };
}

/**
 * Wrap an OpenAI client so its calls are recorded as Squirrel turns.
 * Traced: `chat.completions.create` and `responses.create` — including
 * streaming calls, whose text deltas are aggregated as the caller consumes
 * the stream (usage is recorded when the API includes it; for chat streams
 * pass `stream_options: { include_usage: true }`).
 *
 * @param {object} client An OpenAI SDK client instance.
 * @param {import('squirrel-trace').SquirrelRun} run The Squirrel run to record into.
 * @param {object} [options]
 * @param {string|null} [options.thread] Thread id applied to every recorded turn.
 * @param {string|null} [options.category] Category label (defaults to the API kind).
 * @param {string[]} [options.tags] Tags applied to every recorded turn.
 * @param {object} [options.metadata] Metadata merged into every turn (model is added automatically).
 * @returns {object} A client with the same surface as the original.
 */
export function wrapOpenAI(client, run, options = {}) {
  if (!client || typeof client !== 'object') throw new Error('squirrel-trace-connect: `client` must be an OpenAI client instance.');
  if (!run || typeof run.turn !== 'function') throw new Error('squirrel-trace-connect: `run` must be a SquirrelRun (call sq.startRun() first).');

  const wrapped = Object.create(client);
  if (client.chat?.completions?.create) {
    const original = client.chat.completions.create.bind(client.chat.completions);
    wrapped.chat = Object.create(client.chat);
    wrapped.chat.completions = Object.create(client.chat.completions);
    wrapped.chat.completions.create = traced(
      run, options, 'chat.completions',
      (params) => lastUserMessage(params?.messages),
      extractChatOutput,
      chatChunkInto,
      original,
    );
  }
  if (client.responses?.create) {
    const original = client.responses.create.bind(client.responses);
    wrapped.responses = Object.create(client.responses);
    wrapped.responses.create = traced(
      run, options, 'responses',
      (params) => (typeof params?.input === 'string' ? params.input : JSON.stringify(params?.input ?? '')),
      extractResponsesOutput,
      responsesChunkInto,
      original,
    );
  }
  return wrapped;
}

export default wrapOpenAI;
