# squirrel-trace-connect

Official integrations for [`squirrel-trace`](https://www.npmjs.com/package/squirrel-trace) —
the tracing SDK of **Squirrel**, the local, open-source LLM observability app.
One package, subpath imports, zero framework dependencies:

```js
import { wrapOpenAI } from 'squirrel-trace-connect/openai';
import { SquirrelCallbackHandler } from 'squirrel-trace-connect/chains';
```

## Installation

```bash
npm install squirrel-trace squirrel-trace-connect
```

Requires Node.js 18+ and `squirrel-trace` >= 0.5.0 (peer dependency).

## `/openai` — automatic OpenAI call tracing

Wrap your OpenAI client once; every `chat.completions.create` and
`responses.create` call is recorded as a Squirrel turn with **input, output,
model, token usage and duration**. The wrapped client behaves exactly like
the original (same return values, same thrown errors).

```js
import OpenAI from 'openai';
import Squirrel from 'squirrel-trace';
import { wrapOpenAI } from 'squirrel-trace-connect/openai';

const sq = new Squirrel();                 // SQUIRREL_API_KEY / SQUIRREL_URL from env
const run = sq.startRun();
const openai = wrapOpenAI(new OpenAI(), run, {
  thread: 'chat-1',                        // optional: Monitoring thread filter
  tags: ['prod'],                          // optional: filterable in the Runs view
});

const res = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
});
// -> recorded in Squirrel: input, output, model (metadata),
//    prompt/completion tokens (Monitoring), call duration (trace)

await run.end();
```

| Squirrel field | Source |
|---|---|
| Turn input | Last `user` message (chat) / `input` (responses) |
| Turn output | `choices[0].message.content` / `output_text` |
| Tool call + duration | `openai:<model>` with measured latency |
| Token usage | `usage.prompt_tokens` / `completion_tokens` (or `input_tokens` / `output_tokens`) |
| Metadata | `{ model }` merged with your `options.metadata` |
| Errors | Exception code/message; the turn is marked `failed` and the error re-thrown |

Streaming: `stream: true` calls are traced too — text deltas are aggregated
as your code consumes the stream, the duration covers the full stream, and
usage is recorded when the API includes it (for chat streams pass
`stream_options: { include_usage: true }`). Breaking out of the stream early
records the partial output.

Limitations: other OpenAI APIs (embeddings, images, audio) are not traced
yet — call `run.turn()` manually for those.

## `/chains` — chain-framework callback handler

A drop-in callback handler for chain frameworks:
pass it in `callbacks` and every top-level chain (or bare LLM call) is
recorded as a Squirrel turn — with nested LLM/tool steps as **measured tool
calls**, token usage from the LLM output, and errors marking the turn failed.

Implemented as a plain object conforming to the `CallbackHandlerMethods`
interface, so this package has **no framework dependency** and works across
chain-framework versions.

```js
import Squirrel from 'squirrel-trace';
import { SquirrelCallbackHandler } from 'squirrel-trace-connect/chains';

const sq = new Squirrel();
const run = sq.startRun();
const tracer = new SquirrelCallbackHandler(run, { thread: 'chat-1', tags: ['prod'] });

// pass it anywhere callbacks are accepted — per call or globally:
await chain.invoke({ question: 'Hello!' }, { callbacks: [tracer] });

await run.end();
```

| Framework event | Squirrel record |
|---|---|
| Top-level chain start/end | One turn: inputs → outputs, duration, status |
| Bare LLM call (no chain) | One turn: prompt → generation text |
| Nested LLM call | `llm:<name>` tool call with measured duration |
| Tool start/end | `<tool name>` tool call with measured duration |
| Retriever start/end | `retriever:<name>` tool call with measured duration |
| `llmOutput.tokenUsage` / message `usage_metadata` | Token usage, aggregated in Monitoring |
| Chain/LLM/tool error | Error on the turn; top-level errors mark it `failed` |

Notes: only **top-level** chains open turns (nested chains stay inside their
parent's turn); both prompt-style (`handleLLMStart`) and chat-style
(`handleChatModelStart`) models are supported.

## Roadmap

More subpaths will land in this same package — e.g. `/anthropic`, `/gemini` —
so one install keeps covering your stack.

## License

MIT
