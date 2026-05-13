export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * True when this query is being invoked because the batch contains a
   * scheduled (cron) task message. The Claude provider uses this to skip
   * the per-tool-call approval gate — cron-initiated calls are implicitly
   * authorised by the schedule, and there is no human in the loop to tap
   * the Discord approval card. The budget cap still applies.
   *
   * Set by poll-loop.ts when any message in the keep batch has kind='task'.
   */
  fromScheduledTask?: boolean;
}

/**
 * MCP server config — discriminated union matching the Claude Agent SDK shape.
 *
 * stdio: spawned as a subprocess inside the container. Use for tools that
 *   need container-local state (e.g. the nanoclaw built-in).
 *
 * http: fetched over HTTP. Use for tools that run on the host (e.g. qmd —
 *   keeping its 2GB of LLM models off the container image). Container reaches
 *   the host via http://host.docker.internal:<port> (Linux Docker maps
 *   host-gateway to docker0, set up in src/container-runtime.ts).
 */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig;

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  alwaysLoad?: boolean;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, the server's tools are always present in the prompt (not
   * deferred behind tool search). Set this on memory-lookup MCP servers
   * (e.g. qmd) so the agent reaches for them at turn 1 instead of having
   * to discover them.
   */
  alwaysLoad?: boolean;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
