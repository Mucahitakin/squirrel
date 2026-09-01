/** Type declarations for squirrel-trace. */

export type TurnStatus = 'completed' | 'failed' | 'blocked' | 'needs_user';

export interface SquirrelOptions {
  /** Project API key. Falls back to the SQUIRREL_API_KEY environment variable. */
  apiKey?: string;
  /** Base URL of the Squirrel instance. Default: http://localhost:4590 */
  url?: string;
  /** Fallback project slug (used only with a master key). */
  project?: string;
  /** Custom fetch implementation. */
  fetchImpl?: typeof fetch;
}

export interface TurnOptions {
  /** User input for the turn. */
  input?: string;
  /** Conversation/thread identifier; feeds the Monitoring thread filter. */
  thread?: string | null;
  /** Free-form category label. */
  category?: string | null;
  /** Tags for filtering in the Runs view (e.g. ['prod', 'v2']). */
  tags?: string[];
  /** Arbitrary key/value metadata, shown in the turn detail panel. */
  metadata?: Record<string, unknown> | null;
}

export interface TurnEndOptions {
  /** Assistant output for the turn. */
  output?: string;
  status?: TurnStatus;
  /** Optional terminal reason. */
  reason?: string | null;
  /** Flush immediately after enqueueing. Default: true. */
  flush?: boolean;
}

export declare class SquirrelTurn {
  /** Record a tool call. Chainable. */
  tool(capability: string, status?: 'success' | 'error', options?: { durationMs?: number }): this;
  /** Start a measured tool call; `.end()` records it with the elapsed duration. */
  startTool(capability: string): { end: (status?: 'success' | 'error') => SquirrelTurn };
  /** Attach a feedback score (0–1) to the turn; averaged in Monitoring. Chainable. */
  score(key: string, value: number, options?: { comment?: string }): this;
  /** Add one or more tags to the turn; filterable in the Runs view. Chainable. */
  tag(...tags: string[]): this;
  /** Merge key/value metadata into the turn; shown in the detail panel. Chainable. */
  meta(metadata: Record<string, unknown>): this;
  /** Record an error. Chainable. */
  error(code: string, message?: string): this;
  /** Record a free-form trace event. Chainable. */
  event(type: string, payload?: Record<string, unknown>): this;
  /** Record token usage; aggregated in Monitoring. Chainable. */
  usage(options?: { input?: number; output?: number }): this;
  /** Finish the turn and enqueue it for delivery. */
  end(options?: TurnEndOptions): Promise<void>;
}

export declare class SquirrelRun {
  /** Start a new turn (one user interaction). */
  turn(options?: TurnOptions): SquirrelTurn;
  /** Send all buffered records. Never throws on network failure. */
  flush(): Promise<boolean>;
  /** Flush remaining records and finish the run. */
  end(): Promise<boolean>;
}

export declare class Squirrel {
  constructor(options: SquirrelOptions);
  /**
   * Verify the API key against the Squirrel instance.
   * Resolves with the project name; throws if unreachable or invalid.
   */
  validate(): Promise<string>;
  /** Start a new run (one test session / batch of turns). */
  startRun(options?: { name?: string }): SquirrelRun;
}

/**
 * Wrap an async function so every call is recorded as a turn.
 */
export declare function traceable<F extends (...args: any[]) => Promise<any>>(
  run: SquirrelRun,
  fn: F,
  options?: {
    name?: string;
    thread?: string | null;
    category?: string | null;
    tags?: string[];
    metadata?: Record<string, unknown> | null;
  },
): F;

/** Result of runDataset(). */
export interface RunDatasetSummary {
  total: number;
  completed: number;
  failed: number;
  run: string;
}

/**
 * Run a Squirrel dataset through a local target function (evaluation runner).
 */
export declare function runDataset(
  client: Squirrel,
  options: {
    dataset: string;
    target: (input: string, ctx: { item: any; turn: SquirrelTurn }) => Promise<any>;
    name?: string;
    from?: number;
    to?: number;
    /** Items processed in parallel (1–16). Default: 1. */
    concurrency?: number;
  },
): Promise<RunDatasetSummary>;

/** Open a run, do the work, flush automatically. */
export declare function withRun<T>(
  client: Squirrel,
  work: (run: SquirrelRun) => Promise<T>,
  options?: { name?: string },
): Promise<T>;

export default Squirrel;
