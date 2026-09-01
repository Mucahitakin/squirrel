/** Type declarations for squirrel-trace-connect/openai. */
import type { SquirrelRun } from 'squirrel-trace';

export interface WrapOpenAIOptions {
  /** Thread id applied to every recorded turn. */
  thread?: string | null;
  /** Category label (defaults to the API kind, e.g. 'chat.completions'). */
  category?: string | null;
  /** Tags applied to every recorded turn. */
  tags?: string[];
  /** Metadata merged into every turn (model is added automatically). */
  metadata?: Record<string, unknown>;
}

/**
 * Wrap an OpenAI client so its calls are recorded as Squirrel turns.
 * Traced: chat.completions.create and responses.create, including streaming
 * calls (text deltas are aggregated as the caller consumes the stream).
 */
export declare function wrapOpenAI<T extends object>(
  client: T,
  run: SquirrelRun,
  options?: WrapOpenAIOptions,
): T;

export default wrapOpenAI;
