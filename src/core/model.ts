/**
 * The editor-agnostic data model.
 *
 * Everything Auspex extracts, from every editor, is normalized into these shapes. That
 * normalization is the whole product: an AI asking "what is the user looking at" should not have to
 * know whether the answer came from VS Code's SQLite state, IntelliJ's XML, a Language Server
 * Protocol stream, or a bare directory listing.
 *
 * Two properties are load-bearing throughout and appear on almost every record:
 *
 * - `source` — which adapter produced this, so a consumer can tell a live push from a disk scrape.
 * - `confidence` — how much to trust it. See {@link Confidence}. A tool that reports a stale
 *   cursor position with the same authority as a live one is worse than a tool that reports
 *   nothing, because the consumer cannot tell which it got.
 */

/**
 * How much a datum should be trusted, which depends entirely on how it was obtained.
 *
 * This exists because the honest answer to "can you extract everything from any IDE" is: not by the
 * same means, and not with the same fidelity. Ranked, and each tier is a genuinely different
 * mechanism:
 *
 * - `live` — pushed by a plugin running *inside* the editor, or read from an active protocol
 *   stream. Reflects the editor's actual current state, including unsaved buffers.
 * - `session` — read from the editor's own on-disk session state while that editor is running.
 *   Accurate as of the editor's last flush, which for most editors is seconds to minutes old.
 * - `persisted` — read from on-disk configuration or project files with no running editor. Says
 *   what the project *is*, not what anyone is doing with it.
 * - `inferred` — derived by heuristic (file extensions, directory layout, naming conventions).
 *   Usually right, occasionally not, and never authoritative.
 */
export type Confidence = 'live' | 'session' | 'persisted' | 'inferred';

/** Ordering used when two adapters report the same fact and one has to win. */
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  live: 3,
  session: 2,
  persisted: 1,
  inferred: 0,
};

/** A zero-based position in a text document, in the LSP convention (UTF-16 code units). */
export interface Position {
  line: number;
  character: number;
}

/** A half-open range: `start` inclusive, `end` exclusive. */
export interface Range {
  start: Position;
  end: Position;
}

/** How serious a diagnostic is. Mirrors LSP's own scale so no translation is lossy. */
export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

/**
 * A problem reported about a file — a compiler error, a linter warning, a type error.
 *
 * Deliberately not tied to any language: a TypeScript type error, a Rust borrow-check failure and a
 * YAML schema violation are all this shape, because that is what makes the model useful to an AI
 * that does not know which language it is looking at.
 */
export interface Diagnostic {
  file: string;
  range: Range;
  severity: DiagnosticSeverity;
  message: string;
  /** The rule or error code, when the producer supplies one — `TS2345`, `E0502`, `no-unused-vars`. */
  code?: string;
  /** Which tool said so: `tsc`, `eslint`, `rustc`, `roslyn`. */
  source?: string;
  /** Related locations, such as "first defined here". */
  related?: Array<{ file: string; range: Range; message: string }>;
}

/** What kind of thing a symbol is. The LSP symbol kinds, minus the ones nothing ever emits. */
export type SymbolKind =
  | 'file' | 'module' | 'namespace' | 'package' | 'class' | 'method' | 'property'
  | 'field' | 'constructor' | 'enum' | 'interface' | 'function' | 'variable'
  | 'constant' | 'struct' | 'event' | 'operator' | 'typeParameter' | 'key' | 'section';

/** One entry in a file's structural outline. Nested, because code is. */
export interface DocumentSymbol {
  name: string;
  kind: SymbolKind;
  range: Range;
  /** A signature or type, when the producer knows one. */
  detail?: string;
  children?: DocumentSymbol[];
}

/**
 * A file the user has open in an editor.
 *
 * `text` is present only when the adapter could obtain it *and* the caller asked for content. The
 * distinction between `dirty` and clean matters more than it looks: for a dirty document, the file
 * on disk is not what the user is looking at, so an AI reading the path instead of this record
 * would be answering about different text than the one on screen.
 */
export interface OpenDocument {
  /** Absolute path, or a URI for documents with no file behind them (`untitled:`, `git:`). */
  path: string;
  /** Detected language id — see `languages/registry.ts`. */
  languageId: string;
  /** True when the buffer has unsaved changes. */
  dirty: boolean;
  /** True for the document the user is actually looking at. */
  active: boolean;
  /** Editor group / split pane index, where the editor exposes one. */
  group?: number;
  /** Where the caret is. Only available from `live` sources. */
  cursor?: Position;
  /** Selected ranges. Multi-cursor editors report several. */
  selections?: Range[];
  /** The lines currently scrolled into view — what the user can literally see. */
  visibleRange?: Range;
  /** Buffer contents, when requested and available. For a dirty buffer this is the only truth. */
  text?: string;
  /** Byte length on disk, when known. */
  size?: number;
  /** Last modified time on disk, ISO 8601. */
  modified?: string;
}

/** A breakpoint the user has set. */
export interface Breakpoint {
  file: string;
  line: number;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  /** False when the debugger could not bind it to real code — a common source of confusion. */
  verified?: boolean;
}

/** One frame of a paused call stack. */
export interface StackFrame {
  id: number;
  name: string;
  file?: string;
  line?: number;
  column?: number;
}

/** A variable visible at a paused frame. */
export interface Variable {
  name: string;
  value: string;
  type?: string;
  /** Present when the value has children that were not expanded. */
  expandable?: boolean;
  children?: Variable[];
}

/**
 * The state of a debug session.
 *
 * Populated only by the DAP adapter or by an editor plugin, because there is simply no way to read
 * a paused program's stack out of an editor's config files. When a debugger is not running this is
 * absent rather than empty, which is a meaningful difference to a consumer.
 */
export interface DebugState {
  active: boolean;
  /** `paused`, `running`, `terminated`. */
  status: 'running' | 'paused' | 'terminated';
  /** The adapter type: `node`, `coreclr`, `debugpy`, `lldb`, `java`. */
  adapterType?: string;
  /** Why execution stopped: `breakpoint`, `step`, `exception`, `pause`. */
  stoppedReason?: string;
  threadId?: number;
  stack?: StackFrame[];
  /** Variables in the top frame's scopes, keyed by scope name (`Locals`, `Arguments`). */
  scopes?: Record<string, Variable[]>;
  breakpoints?: Breakpoint[];
  /** Recent output from the debuggee's stdout/stderr. */
  output?: string[];
}

/** Where a file stands with version control. */
export type VcsFileStatus =
  | 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'ignored' | 'conflicted';

/** Version-control state for a workspace. Git today; the shape is not git-specific. */
export interface VcsState {
  system: 'git' | 'hg' | 'svn' | 'none';
  root?: string;
  branch?: string;
  /** The upstream branch, when one is configured. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** True during a merge, rebase, cherry-pick or bisect — states that change what advice is safe. */
  operationInProgress?: string;
  files?: Array<{ path: string; status: VcsFileStatus; staged: boolean }>;
  recentCommits?: Array<{ hash: string; author: string; date: string; subject: string }>;
  /** Unified diff of the working tree, when requested. Redacted like everything else. */
  diff?: string;
}

/** A node in a project's file tree. */
export interface FileNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  languageId?: string;
  children?: FileNode[];
  /** True when the tree was cut short here by a depth or count limit. */
  truncated?: boolean;
}

/**
 * A build system, package manager or toolchain detected in a workspace.
 *
 * Language-agnostic by design: `package.json`, `Cargo.toml`, `pom.xml`, `go.mod`, `*.csproj`,
 * `pyproject.toml`, `Gemfile`, `CMakeLists.txt` and a dozen others all reduce to this, which is what
 * lets an AI ask "how is this built" without knowing the ecosystem first.
 */
export interface ProjectManifest {
  /** `npm`, `cargo`, `maven`, `gradle`, `go`, `dotnet`, `pip`, `poetry`, `bundler`, `cmake`, ... */
  kind: string;
  file: string;
  name?: string;
  version?: string;
  /** Runnable entry points the manifest declares: npm scripts, cargo bins, make targets. */
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  /** The language runtime or SDK version the project pins, when it pins one. */
  toolchain?: string;
}

/** A project or folder the user has open. */
export interface Workspace {
  /** Absolute path to the workspace root. */
  root: string;
  name: string;
  /** Extra roots for a multi-root workspace. */
  additionalRoots?: string[];
  manifests?: ProjectManifest[];
  vcs?: VcsState;
  tree?: FileNode;
  /** Languages present, with how many files of each — the fastest way to characterize a project. */
  languages?: Record<string, number>;
  /** Total files and bytes scanned, so a consumer knows the scale of what it is looking at. */
  fileCount?: number;
  totalBytes?: number;
}

/** A running editor Auspex found. */
export interface EditorInstance {
  /** Adapter id that produced this: `vscode`, `jetbrains`, `visualstudio`, `neovim`, ... */
  adapter: string;
  /** Product name as the user would say it: "Visual Studio Code", "IntelliJ IDEA", "Neovim". */
  name: string;
  version?: string;
  /** OS process id, when the editor was found by process discovery. */
  pid?: number;
  /** Path to the executable. */
  executable?: string;
  /** Workspaces this instance has open. */
  workspaces: Workspace[];
  /** Documents open in this instance. */
  documents: OpenDocument[];
  /** Debug session, if one is running. */
  debug?: DebugState;
  /** Installed extensions or plugins, when the editor's layout makes them readable. */
  extensions?: Array<{ id: string; name?: string; version?: string; enabled?: boolean }>;
  /** Editor settings that actually affect how code is written — indentation, formatters, rulers. */
  settings?: Record<string, unknown>;
  confidence: Confidence;
}

/** A terminal or task output captured from an editor. */
export interface TerminalCapture {
  name: string;
  /** `terminal`, `task`, `test`, `build`, `debug-console`. */
  kind: string;
  cwd?: string;
  command?: string;
  /** Recent lines, newest last. */
  lines: string[];
  exitCode?: number;
}

/**
 * The complete answer to "what is going on in this developer's environment right now".
 *
 * This is what gets served to an AI. Everything else in Auspex exists to fill one in.
 */
export interface Snapshot {
  /** ISO 8601 timestamp of when this was assembled. */
  capturedAt: string;
  /** Auspex's own version, so a consumer can reason about schema changes. */
  schemaVersion: string;
  host: {
    platform: NodeJS.Platform;
    arch: string;
    hostname: string;
    /** The user's shell and home directory, useful for interpreting paths and commands. */
    shell?: string;
    home?: string;
    cwd: string;
  };
  editors: EditorInstance[];
  /** Workspaces, merged across every editor that had them open. */
  workspaces: Workspace[];
  /** All open documents across all editors, most recently active first. */
  documents: OpenDocument[];
  /** Diagnostics gathered from every source that had any. */
  diagnostics: Diagnostic[];
  /** File outlines, keyed by path — present only for files that were explicitly requested. */
  symbols?: Record<string, DocumentSymbol[]>;
  debug?: DebugState;
  terminals?: TerminalCapture[];
  /** What each adapter managed to contribute, and what it could not. */
  provenance: AdapterReport[];
  /** What redaction removed. Reported, never silent. */
  redactions?: RedactionReport;
  /** Non-fatal problems: an editor found but unreadable, a permission denied, a parse failure. */
  warnings: string[];
}

/** What one adapter did during a capture. */
export interface AdapterReport {
  adapter: string;
  /** Whether the adapter found anything at all. */
  status: 'ok' | 'not-found' | 'partial' | 'error';
  confidence?: Confidence;
  /** How long it took, in milliseconds — adapters that scan disks can be slow, and it shows here. */
  durationMs: number;
  /** What it found, in the adapter's own words: "3 windows, 12 open editors". */
  detail?: string;
  /** Why it could not do better. Present whenever status is not `ok`. */
  reason?: string;
}

/** What the redactor removed, so nothing disappears silently. */
export interface RedactionReport {
  /** How many values were replaced. */
  count: number;
  /** Which rules fired and how often — `api-key`, `private-key`, `env-value`, `connection-string`. */
  byRule: Record<string, number>;
  /** Files that were skipped entirely because their whole content is secret by nature. */
  skippedFiles: string[];
}
