/**
 * The public API, for using Auspex as a library rather than as a command.
 *
 * The whole pipeline is importable: build a custom adapter set, capture, shape the result for a
 * provider, or embed the servers in another program. Nothing here is a wrapper — these are the same
 * entry points the CLI uses.
 */

export type {
  AdapterReport, Breakpoint, Confidence, DebugState, Diagnostic, DiagnosticSeverity,
  DocumentSymbol, EditorInstance, FileNode, OpenDocument, Position, ProjectManifest, Range,
  RedactionReport, Snapshot, StackFrame, SymbolKind, TerminalCapture, Variable, VcsFileStatus,
  VcsState, Workspace,
} from './core/model.ts';
export { CONFIDENCE_RANK } from './core/model.ts';

export type { Adapter, AdapterCapabilities, AdapterResult, CaptureOptions } from './core/adapter.ts';
export { DEFAULT_CAPTURE_OPTIONS, NO_CAPABILITIES, runAdapter } from './core/adapter.ts';

export { capture, defaultAdapters, summarize, SCHEMA_VERSION } from './core/snapshot.ts';
export { Redactor, REDACTION_RULES, SENSITIVE_FILE_PATTERNS } from './core/redact.ts';
export { fitToBudget, estimateTokens, rankDocuments, rankDiagnostics } from './core/budget.ts';

export { detectLanguage, languageById, allLanguages, summarizeByFamily } from './languages/registry.ts';
export type { Language, LanguageFamily } from './languages/registry.ts';
export { extractOutline, flattenSymbols } from './languages/outline.ts';
export { parseDataDocument, parseDelimitedRows } from './languages/data.ts';

export { readGitState, findRepositoryRoot, isGitAvailable } from './vcs/git.ts';

export { GenericFilesystemAdapter, describeWorkspace, detectManifests } from './adapters/generic.ts';
export { VsCodeAdapter, readEditorState, readRecentlyOpened } from './adapters/vscode.ts';
export { JetBrainsAdapter, readWorkspaceXml, readRecentProjects } from './adapters/jetbrains.ts';
export { VisualStudioAdapter, readSolution } from './adapters/visualstudio.ts';
export { OtherEditorsAdapter, UnknownEditorAdapter, listDetectedEditors } from './adapters/editors.ts';
export {
  ProtocolAdapter, ProtocolStore, MessageFramer, protocolStore,
  observeLspMessage, observeDapMessage, createStdioProxy, frame,
} from './adapters/protocols.ts';
export { PushAdapter, PushStore, pushStore } from './adapters/push.ts';
export type { PushPayload } from './adapters/push.ts';

export { startHttpServer, openApiDocument } from './server/http.ts';
export { McpServer, mcpClientConfig, callTool } from './server/mcp.ts';
export { renderDashboard } from './server/gui.ts';

export { shapeForProvider, toMarkdown, PROVIDERS, openAiToolDefinitions, geminiFunctionDeclarations } from './ai/providers.ts';
export type { ProviderId, ProviderProfile, ShapedPayload } from './ai/providers.ts';

// -- Deep debug capture -------------------------------------------------------------------------

export { DebugRecorder, debugRecorder, DEFAULT_LIMITS, buildDiff, flattenStop, toHexDump } from './adapters/debug.ts';
export type { RecorderLimits, ProbeTransport } from './adapters/debug.ts';
export type {
  DebugSessionRecord, DebugStop, DebugStackFrame, DebugScope, DebugVariable, DebugThread,
  DebugMemory, DebugModule, DebugBreakpoint, DebugExceptionInfo, DebugEvent, DebugStopDiff,
  DebugCapabilities, DebugInstruction, DebugEvaluation, DebugOutput, DebugLoadedSource,
  DebugVariableDelta,
} from './core/debug-model.ts';
export { publishSession, readSession, listSessions, pruneSessions, sessionDirectory } from './core/debug-store.ts';

export { analyseSession } from './debug/analysis.ts';
export type { AnalysisResult, Finding, FindingSeverity } from './debug/analysis.ts';
export { DebugJournal, journalPath, summarizeJournal, readStops, replayJournal } from './debug/journal.ts';
export type { JournalEntry, JournalSummary } from './debug/journal.ts';
export { findLaunchConfigurations, wiringFor, recommendAdapters } from './debug/launch-config.ts';
export type { LaunchConfiguration, WiringInstruction } from './debug/launch-config.ts';
export { KNOWN_ADAPTERS, adapterById, adaptersForLanguage, isUserCode, explainNoMemory } from './debug/registry.ts';
export type { KnownAdapter } from './debug/registry.ts';
export { readFrameSource, readStopSource, renderSource, currentLine } from './debug/source-context.ts';
export type { FrameSource, SourceLine } from './debug/source-context.ts';

export { debugReport, debugSummary, debugSizeReport } from './ai/debug-report.ts';
export { fitDebugToBudget, measureDebugRecord, minimalStop } from './ai/debug-budget.ts';
export type { DebugBudgetOptions, DebugBudgetResult } from './ai/debug-budget.ts';
export {
  DEBUG_TOOL_SPECS, openAiDebugTools, geminiDebugTools, anthropicDebugTools, debugToolRoutes,
} from './ai/debug-tools.ts';
export type { DebugToolSpec } from './ai/debug-tools.ts';
export { renderDebugSession, renderStop, renderDiff } from './cli/debug-format.ts';

// Language-agnostic value, memory and concurrency interpretation.
export {
  interpretValue, interpretTree, inferShape, summarizeCollection, renderCollectionSummary,
} from './debug/values.ts';
export type { InterpretedValue, ValueKind, InferredShape, CollectionSummary } from './debug/values.ts';
export {
  decodeMemory, decodeBytes, decodeRegisters, renderDecodedMemory,
} from './debug/memory-decode.ts';
export type { DecodedMemory, DecodedRegister, Reading, Endianness } from './debug/memory-decode.ts';
export { analyseConcurrency, classifyStack, renderConcurrency } from './debug/concurrency.ts';
export type { ConcurrencyReport, ThreadGroup, ThreadActivity } from './debug/concurrency.ts';

// Searching a session across time, and sharing one.
export {
  queryRecord, queryJournal, trajectory, trajectoryFromJournal, renderTrajectory, renderMatches,
} from './debug/query.ts';
export type { VariableQuery, QueryResult, QueryMatch, Trajectory } from './debug/query.ts';
export {
  createBundle, readBundle, writeBundle, compareBundles, renderBundleSummary, BUNDLE_VERSION,
} from './debug/bundle.ts';
export type { DebugBundle, BundleOptions } from './debug/bundle.ts';

export { renderSnapshot } from './cli/format.ts';
export { runTui, renderFrame } from './cli/tui.ts';
