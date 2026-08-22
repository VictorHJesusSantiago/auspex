import type { Snapshot } from '../core/model.ts';
import { fitToBudget, estimateTokens } from '../core/budget.ts';
import { summarize } from '../core/snapshot.ts';

/**
 * Shaping a snapshot for a particular assistant.
 *
 * **What this module is for, and what it deliberately is not.** Auspex does not call any AI API and
 * holds no API keys — that would make it a client for one vendor rather than a connector for all of
 * them, and it would mean asking a developer to give a context-extraction tool their credentials.
 * What it does instead is produce the *payload* each provider expects, which the user's own
 * assistant then consumes: an MCP tool result, an OpenAI function-call result, a Gemini function
 * response, or plain Markdown to paste anywhere at all.
 *
 * The differences between providers are real but shallow. All of them want structured context; they
 * disagree about the envelope, about how much fits, and about whether they prefer JSON or prose.
 * Those three things are what this module encodes.
 *
 * The Markdown target is not a fallback, it is the universal one: every assistant that exists
 * accepts pasted text, including ones released after this was written.
 */

/** A target an assistant can consume. */
export type ProviderId = 'claude' | 'openai' | 'gemini' | 'markdown' | 'json';

export interface ProviderProfile {
  id: ProviderId;
  name: string;
  /**
   * A default context budget in tokens, deliberately well under each model's ceiling.
   *
   * Context is shared with the conversation, the system prompt and the reply. A tool result that
   * consumed the whole window would leave no room to think, so these are a working allowance rather
   * than a limit — roughly a tenth of the smaller models in each family.
   */
  defaultBudget: number;
  /** Whether the provider reads JSON well, or does better with prose. */
  prefers: 'json' | 'markdown';
}

export const PROVIDERS: Record<ProviderId, ProviderProfile> = {
  claude: { id: 'claude', name: 'Claude', defaultBudget: 20000, prefers: 'json' },
  openai: { id: 'openai', name: 'OpenAI GPT', defaultBudget: 12000, prefers: 'json' },
  gemini: { id: 'gemini', name: 'Google Gemini', defaultBudget: 16000, prefers: 'json' },
  markdown: { id: 'markdown', name: 'Markdown (any assistant)', defaultBudget: 8000, prefers: 'markdown' },
  json: { id: 'json', name: 'Raw JSON', defaultBudget: 100000, prefers: 'json' },
};

export interface ShapeOptions {
  provider: ProviderId;
  maxTokens?: number;
  /** Include a prose summary above the data. Helps a model orient before reading structure. */
  includeSummary?: boolean;
}

export interface ShapedPayload {
  provider: ProviderId;
  /** What to send. A string for prose targets, an object for structured ones. */
  content: string | Record<string, unknown>;
  estimatedTokens: number;
  dropped: string[];
}

/** Produces the payload for one provider. */
export function shapeForProvider(snapshot: Snapshot, options: ShapeOptions): ShapedPayload {
  const profile = PROVIDERS[options.provider];
  const maxTokens = options.maxTokens ?? profile.defaultBudget;
  const { snapshot: fitted, dropped } = fitToBudget(snapshot, { maxTokens });

  if (profile.prefers === 'markdown') {
    const content = toMarkdown(fitted, options.includeSummary !== false);
    return { provider: profile.id, content, estimatedTokens: estimateTokens(content), dropped };
  }

  // Structured providers get the snapshot with a prose header attached, which is not redundant:
  // a model reads "the user is in auspex on branch main with two errors" far faster than it
  // reconstructs the same fact from six nested objects, and then uses the structure for detail.
  const content: Record<string, unknown> = options.includeSummary === false
    ? (fitted as unknown as Record<string, unknown>)
    : { summary: summarize(fitted), ...(fitted as unknown as Record<string, unknown>) };

  return { provider: profile.id, content, estimatedTokens: estimateTokens(content), dropped };
}

/**
 * Renders a snapshot as Markdown.
 *
 * The layout follows the same priority order the budget uses, and for the same reason: what a
 * reader sees first should be what matters most. Active file, then problems, then version control,
 * then everything else — which is roughly the order a colleague looking over someone's shoulder
 * would take it in.
 */
export function toMarkdown(snapshot: Snapshot, includeSummary = true): string {
  const lines: string[] = [];

  lines.push('# Development context');
  lines.push('');
  if (includeSummary) {
    lines.push(`_${summarize(snapshot)}_ · captured ${snapshot.capturedAt}`);
    lines.push('');
  }

  const active = snapshot.documents.find((document) => document.active);
  if (active) {
    lines.push('## Active file');
    lines.push('');
    lines.push(`\`${active.path}\` (${active.languageId})${active.dirty ? ' — **unsaved changes**' : ''}`);
    if (active.cursor) {
      lines.push(`Caret at line ${active.cursor.line + 1}, column ${active.cursor.character + 1}.`);
    }
    if (active.text) {
      lines.push('');
      lines.push('```' + active.languageId);
      lines.push(active.text);
      lines.push('```');
    }
    lines.push('');
  }

  const errors = snapshot.diagnostics.filter((item) => item.severity === 'error');
  const warnings = snapshot.diagnostics.filter((item) => item.severity === 'warning');
  if (errors.length > 0 || warnings.length > 0) {
    lines.push('## Problems');
    lines.push('');
    for (const item of [...errors, ...warnings].slice(0, 30)) {
      const location = `${item.file}:${item.range.start.line + 1}`;
      const code = item.code ? ` [${item.code}]` : '';
      lines.push(`- **${item.severity}** \`${location}\`${code} — ${item.message}`);
    }
    if (errors.length + warnings.length > 30) {
      lines.push(`- …and ${errors.length + warnings.length - 30} more`);
    }
    lines.push('');
  }

  if (snapshot.workspaces.length > 0) {
    lines.push('## Projects');
    lines.push('');
    for (const workspace of snapshot.workspaces) {
      lines.push(`### ${workspace.name}`);
      lines.push('');
      lines.push(`\`${workspace.root}\``);

      if (workspace.languages) {
        const top = Object.entries(workspace.languages)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([language, count]) => `${language} (${count})`);
        if (top.length > 0) lines.push(`Languages: ${top.join(', ')}`);
      }
      if (workspace.manifests?.length) {
        lines.push(`Build: ${workspace.manifests.map((manifest) => manifest.kind).join(', ')}`);
        const scripts = workspace.manifests.flatMap((manifest) => Object.keys(manifest.scripts ?? {}));
        if (scripts.length > 0) lines.push(`Commands: ${scripts.slice(0, 12).join(', ')}`);
      }
      if (workspace.vcs?.system === 'git') {
        const vcs = workspace.vcs;
        const parts = [`branch \`${vcs.branch ?? '?'}\``];
        if (vcs.ahead || vcs.behind) parts.push(`${vcs.ahead ?? 0} ahead, ${vcs.behind ?? 0} behind`);
        if (vcs.operationInProgress) parts.push(`**${vcs.operationInProgress} in progress**`);
        if (vcs.files?.length) parts.push(`${vcs.files.length} changed file(s)`);
        lines.push(`Git: ${parts.join(' · ')}`);
      }
      lines.push('');
    }
  }

  const others = snapshot.documents.filter((document) => !document.active).slice(0, 25);
  if (others.length > 0) {
    lines.push('## Other open files');
    lines.push('');
    for (const document of others) {
      lines.push(`- \`${document.path}\`${document.dirty ? ' (unsaved)' : ''}`);
    }
    lines.push('');
  }

  if (snapshot.debug?.active) {
    lines.push('## Debug session');
    lines.push('');
    lines.push(`Status: ${snapshot.debug.status}${snapshot.debug.stoppedReason ? ` (${snapshot.debug.stoppedReason})` : ''}`);
    for (const frame of snapshot.debug.stack?.slice(0, 10) ?? []) {
      lines.push(`- ${frame.name}${frame.file ? ` at \`${frame.file}:${frame.line ?? '?'}\`` : ''}`);
    }
    lines.push('');
  }

  if (snapshot.terminals?.length) {
    lines.push('## Terminal output');
    lines.push('');
    for (const terminal of snapshot.terminals.slice(0, 3)) {
      lines.push(`**${terminal.name}**${terminal.command ? ` — \`${terminal.command}\`` : ''}`);
      lines.push('```');
      lines.push(terminal.lines.slice(-25).join('\n'));
      lines.push('```');
    }
    lines.push('');
  }

  // The provenance and redaction notes go last and are never omitted. A consumer reading a thin
  // context deserves to know whether that is because nothing is happening or because nothing could
  // be read, and those are very different situations.
  lines.push('---');
  lines.push('');
  const sources = snapshot.provenance
    .filter((report) => report.status === 'ok' || report.status === 'partial')
    .map((report) => `${report.adapter} (${report.confidence ?? 'unknown'})`);
  lines.push(`Sources: ${sources.join(', ') || 'none'}`);

  if (snapshot.redactions) {
    lines.push(`Redacted ${snapshot.redactions.count} secret value(s).`);
  }
  for (const warning of snapshot.warnings.slice(0, 5)) {
    lines.push(`Note: ${warning}`);
  }

  return lines.join('\n');
}

/**
 * The tool definitions an OpenAI-compatible client needs.
 *
 * Provided as data rather than prose so a user can paste them straight into their client's
 * configuration. Gemini's function-declaration format is close enough that the same shape works
 * after unwrapping the `function` key, which {@link geminiFunctionDeclarations} does.
 */
export function openAiToolDefinitions(baseUrl = 'http://127.0.0.1:4278'): Array<Record<string, unknown>> {
  return [
    {
      type: 'function',
      function: {
        name: 'get_development_context',
        description:
          'Read the developer\'s live environment: which editors and projects are open, which files ' +
          'are being edited, what errors the compiler reports, and what git says. Call this before ' +
          'answering questions about "my code", "this project" or "the file I have open".',
        parameters: {
          type: 'object',
          properties: {
            maxTokens: { type: 'integer', description: 'Budget for the response.' },
            root: { type: 'string', description: 'Restrict to one project path.' },
            includeDiff: { type: 'boolean', description: 'Include uncommitted changes.' },
          },
        },
      },
      'x-auspex-endpoint': `${baseUrl}/context`,
    },
    {
      type: 'function',
      function: {
        name: 'read_project_file',
        description: 'Read one file from the developer\'s machine, or its structural outline.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            outline: { type: 'boolean' },
          },
          required: ['path'],
        },
      },
      'x-auspex-endpoint': `${baseUrl}/file`,
    },
  ];
}

/** The same declarations in Gemini's shape. */
export function geminiFunctionDeclarations(baseUrl?: string): Array<Record<string, unknown>> {
  return openAiToolDefinitions(baseUrl).map((tool) => tool.function as Record<string, unknown>);
}
