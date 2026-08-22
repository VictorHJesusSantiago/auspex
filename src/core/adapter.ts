import type {
  AdapterReport, Confidence, Diagnostic, EditorInstance, OpenDocument, Snapshot, TerminalCapture,
} from './model.ts';

/**
 * What an adapter is capable of producing. Declared up front so a caller can pick adapters by what
 * it needs rather than running all of them and hoping.
 *
 * This matters because the capabilities genuinely differ by an order of magnitude. A filesystem
 * adapter can tell you a project's shape for any editor ever written; only an in-editor plugin can
 * tell you where the caret is. Advertising that difference is more useful than pretending it away.
 */
export interface AdapterCapabilities {
  /** Can identify running instances of its editor. */
  discovery: boolean;
  /** Can list open workspaces/projects. */
  workspaces: boolean;
  /** Can list open documents. */
  documents: boolean;
  /** Can report the caret and selection — only ever true for live sources. */
  cursor: boolean;
  /** Can read unsaved buffer contents. */
  dirtyBuffers: boolean;
  /** Can report compiler/linter problems. */
  diagnostics: boolean;
  /** Can report debug session state. */
  debug: boolean;
  /** Can capture terminal or task output. */
  terminals: boolean;
  /** Can list installed extensions/plugins. */
  extensions: boolean;
  /** Can read editor settings. */
  settings: boolean;
}

/** Everything false — the base every adapter starts from and overrides what it actually does. */
export const NO_CAPABILITIES: AdapterCapabilities = {
  discovery: false, workspaces: false, documents: false, cursor: false, dirtyBuffers: false,
  diagnostics: false, debug: false, terminals: false, extensions: false, settings: false,
};

/** Options a caller passes down to every adapter for one capture. */
export interface CaptureOptions {
  /** Restrict to these workspace roots. Empty means "wherever the editors are". */
  roots?: string[];
  /** Include the text of open documents. Off by default: it is the bulk of a snapshot's size. */
  includeText?: boolean;
  /** Include a file tree per workspace. */
  includeTree?: boolean;
  /** Maximum tree depth. */
  maxTreeDepth?: number;
  /** Maximum files to walk per workspace, so a monorepo cannot hang a capture. */
  maxFiles?: number;
  /** Largest file to read, in bytes. Anything bigger is listed but not read. */
  maxFileBytes?: number;
  /** Include version-control state. */
  includeVcs?: boolean;
  /** Include a working-tree diff. Off by default; diffs are large. */
  includeDiff?: boolean;
  /** Give up on any single adapter after this long. */
  timeoutMs?: number;
  /** Adapter ids to run. Empty means all registered ones. */
  only?: string[];
  /** Adapter ids to skip. */
  exclude?: string[];
}

/** Sensible defaults, chosen so a bare `auspex capture` is fast and small enough to paste. */
export const DEFAULT_CAPTURE_OPTIONS: Required<Omit<CaptureOptions, 'roots' | 'only' | 'exclude'>> & CaptureOptions = {
  roots: [],
  includeText: false,
  includeTree: true,
  maxTreeDepth: 4,
  maxFiles: 4000,
  maxFileBytes: 512 * 1024,
  includeVcs: true,
  includeDiff: false,
  timeoutMs: 10_000,
  only: [],
  exclude: [],
};

/** What one adapter returns from a capture. Every field is optional: partial results are normal. */
export interface AdapterResult {
  editors?: EditorInstance[];
  documents?: OpenDocument[];
  diagnostics?: Diagnostic[];
  terminals?: TerminalCapture[];
  warnings?: string[];
  /** Free-text summary for the provenance report. */
  detail?: string;
}

/**
 * The interface every editor connector implements.
 *
 * Adapters are deliberately small and independent. Adding support for an editor nobody has heard of
 * means writing one of these and registering it — no change to the model, the servers, the CLI or
 * the GUI. That is the extension point the whole design is arranged around.
 */
export interface Adapter {
  /** Stable identifier used in configuration and provenance: `vscode`, `jetbrains`, `lsp`. */
  readonly id: string;
  /** Human name for display. */
  readonly name: string;
  /** The best confidence anything this adapter produces can have. */
  readonly confidence: Confidence;
  readonly capabilities: AdapterCapabilities;
  /**
   * Whether this adapter has anything to offer on this machine, checked cheaply.
   *
   * Called before {@link capture} so a machine with no JetBrains products installed does not pay to
   * scan for them on every snapshot. Must not throw; a probe that cannot tell should return true
   * and let `capture` find out.
   */
  probe(): Promise<boolean>;
  /** Do the work. Should honour `options.timeoutMs` and never throw — return a warning instead. */
  capture(options: CaptureOptions): Promise<AdapterResult>;
}

/**
 * Runs one adapter with a timeout and turns any failure into a report rather than an exception.
 *
 * A capture involves half a dozen adapters poking at other programs' private files. Something will
 * eventually be locked, missing, or in a format a version bump changed. One adapter failing must
 * degrade the snapshot, never abort it — an incomplete answer is useful and a stack trace is not.
 */
export async function runAdapter(
  adapter: Adapter,
  options: CaptureOptions,
): Promise<{ result: AdapterResult; report: AdapterReport }> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_OPTIONS.timeoutMs;

  try {
    const available = await adapter.probe();
    if (!available) {
      return {
        result: {},
        report: {
          adapter: adapter.id,
          status: 'not-found',
          durationMs: Date.now() - started,
          reason: 'not installed or not running on this machine',
        },
      };
    }

    // A hard timeout rather than cooperative cancellation, because an adapter blocked on a locked
    // file or an unresponsive socket cannot be asked politely to stop.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });

    let result: AdapterResult;
    try {
      result = await Promise.race([adapter.capture(options), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const found = (result.editors?.length ?? 0) + (result.documents?.length ?? 0) +
      (result.diagnostics?.length ?? 0) + (result.terminals?.length ?? 0);

    return {
      result,
      report: {
        adapter: adapter.id,
        status: result.warnings?.length ? 'partial' : found > 0 ? 'ok' : 'not-found',
        confidence: adapter.confidence,
        durationMs: Date.now() - started,
        detail: result.detail,
        reason: result.warnings?.[0],
      },
    };
  } catch (error) {
    return {
      result: {},
      report: {
        adapter: adapter.id,
        status: 'error',
        durationMs: Date.now() - started,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** The empty snapshot every capture starts from. */
export function emptySnapshot(schemaVersion: string): Snapshot {
  return {
    capturedAt: new Date().toISOString(),
    schemaVersion,
    host: {
      platform: process.platform,
      arch: process.arch,
      hostname: '',
      cwd: process.cwd(),
    },
    editors: [],
    workspaces: [],
    documents: [],
    diagnostics: [],
    provenance: [],
    warnings: [],
  };
}
