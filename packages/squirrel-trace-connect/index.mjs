/**
 * squirrel-trace-connect — official integrations for squirrel-trace.
 *
 * Subpath imports keep your bundle lean:
 *   import { wrapOpenAI } from 'squirrel-trace-connect/openai';
 *   import { SquirrelCallbackHandler } from 'squirrel-trace-connect/chains';
 *
 * The root export re-exports everything for convenience.
 */
export { wrapOpenAI, default as wrapOpenAIDefault } from './openai.mjs';
export { SquirrelCallbackHandler } from './chains.mjs';
