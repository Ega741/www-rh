/**
 * `@beagle/mcp`: the Beagle MCP server for agents (SPEC §6) — the {@link BeagleApi} contract and
 * its REST client, the wallet executor / unsigned-step builder, and {@link createBeagleMcpServer}.
 *
 * @module
 */
export {
  BeagleApiError,
  completionMetaFromHeaders,
  createRestBeagleApi,
  type BeagleApi,
  type BeagleChatCompletion,
  type BeagleCompletionMeta,
  type CompletionOptions,
  type FetchLike,
  type QuoteQuery,
  type RestBeagleApiOptions,
  type UsageQuery,
  type UsageResult,
  type UsageWindow,
} from './api.js';
export {
  buildUnsignedSteps,
  createViemWalletExecutor,
  errorMessage,
  WalletError,
  type BuyComputeParams,
  type BuyComputeResult,
  type OpenBudgetParams,
  type OpenBudgetResult,
  type UnsignedStep,
  type UnsignedStepsInput,
  type UnsignedTransactionRequest,
  type ViemWalletExecutorOptions,
  type WalletDeployment,
  type WalletExecutor,
} from './wallet.js';
export {
  balanceSummary,
  BEAGLE_RESOURCE_URIS,
  BEAGLE_TOOL_NAMES,
  createBeagleMcpServer,
  MAX_BUDGET_HOURS,
  MCP_SERVER_INFO,
  modelsMarkdown,
  quickstartMarkdown,
  tokenInputToRaw,
  toolErrorInfo,
  ToolInputError,
  toWire,
  usdInputToMicro,
  type BeagleMcpServerOptions,
  type BeagleToolName,
  type ToolErrorInfo,
} from './server.js';
export { ConfigError, DEFAULT_API_URL, main, readBinConfig, type BinConfig } from './cli.js';
