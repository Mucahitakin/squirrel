# Changelog

## 0.2.0
- `/openai`: streaming calls (`stream: true`) are now traced — text deltas
  are aggregated as the caller consumes the stream, the call duration covers
  the full stream, and token usage is recorded when the API includes it
  (for chat streams pass `stream_options: { include_usage: true }`).
  Early termination (break/abort) records the partial output.
- `/chains`: token usage is also read from `usage_metadata` on the generated
  message (newer chat-framework versions), and retriever steps
  (`handleRetrieverStart/End/Error`) are recorded as measured
  `retriever:<name>` tool calls.

## 0.1.0
- Initial release with two integrations:
  - `squirrel-trace-connect/openai` — `wrapOpenAI(client, run, options)`:
    records `chat.completions.create` and `responses.create` calls as Squirrel
    turns with input, output, model, token usage and duration. Streaming calls
    pass through untraced.
  - `squirrel-trace-connect/chains` — `SquirrelCallbackHandler(run, options)`:
    a plain CallbackHandlerMethods object (no framework dependency) that
    records top-level chains and bare LLM calls as turns, nested LLM/tool
    steps as measured tool calls, token usage and errors.
