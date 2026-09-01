/** Type declarations for squirrel-trace-connect/chains. */
import type { SquirrelRun } from 'squirrel-trace';

export interface SquirrelCallbackHandlerOptions {
  /** Thread id applied to every recorded turn. */
  thread?: string | null;
  /** Tags applied to every recorded turn. */
  tags?: string[];
  /** Metadata applied to every recorded turn. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Chain-framework callback handler that records chains, LLM calls and tool steps
 * into a Squirrel run. Pass an instance in `callbacks`.
 */
export declare class SquirrelCallbackHandler {
  constructor(run: SquirrelRun, options?: SquirrelCallbackHandlerOptions);
  readonly name: 'squirrel_tracer';
  handleChainStart(chain: unknown, inputs: unknown, runId: string, parentRunId?: string): void;
  handleChainEnd(outputs: unknown, runId: string, parentRunId?: string): Promise<void>;
  handleChainError(error: unknown, runId: string, parentRunId?: string): Promise<void>;
  handleLLMStart(llm: unknown, prompts: string[], runId: string, parentRunId?: string): void;
  handleChatModelStart(llm: unknown, messages: unknown[][], runId: string, parentRunId?: string): void;
  handleLLMEnd(output: unknown, runId: string): Promise<void>;
  handleLLMError(error: unknown, runId: string): Promise<void>;
  handleToolStart(tool: unknown, input: string, runId: string, parentRunId?: string): void;
  handleToolEnd(output: unknown, runId: string): void;
  handleToolError(error: unknown, runId: string): void;
  handleRetrieverStart(retriever: unknown, query: string, runId: string, parentRunId?: string): void;
  handleRetrieverEnd(documents: unknown[], runId: string): void;
  handleRetrieverError(error: unknown, runId: string): void;
}

export default SquirrelCallbackHandler;
