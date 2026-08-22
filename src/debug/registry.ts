/**
 * The debug adapters of the world, and what each one can actually tell you.
 *
 * Every editor drives its debuggers through the Debug Adapter Protocol, but adapters differ
 * enormously in what they implement, and those differences are not cosmetic — they decide whether
 * a question is answerable at all. Asking `debugpy` for a memory address is not a bug to be fixed;
 * Python objects do not have stable ones. Asking `lldb` for a rich string representation of a
 * `std::map` and getting `{...}` is not a failure either; that is what a native debugger without a
 * formatter gives you.
 *
 * So this table exists to let Auspex answer three questions it is otherwise forced to guess at:
 *
 * 1. **"Why is memory empty?"** — because the adapter cannot read it, not because nothing was
 *    found. The distinction is the difference between a useful answer and a confusing one.
 * 2. **"What should I run?"** — the concrete command that starts this adapter, so
 *    `auspex debug wire` can print a working proxy invocation rather than a placeholder.
 * 3. **"Which frames are the user's code?"** — every runtime buries user frames under its own
 *    machinery, and the paths that machinery lives in are known per ecosystem.
 *
 * The table is a **fallback, not the authority.** When a session is live, the adapter's own
 * `capabilities` from its `initialize` response wins, always: it describes the version actually
 * running, and this describes the version that existed when this was written. The table matters
 * before a session starts and after it ends, which is exactly when capabilities are unavailable.
 */

export interface KnownAdapter {
  /** The `type` field editors use in a launch configuration. */
  id: string;
  name: string;
  /** Language ids from `languages/registry.ts` that this adapter debugs. */
  languages: string[];
  /** How the adapter is normally started, for generating a proxy command. */
  command?: {
    /** A shell-visible executable, when there is one. */
    program: string;
    args: string[];
    /** How to install it, when it is not part of the toolchain. */
    install?: string;
  };
  /**
   * Where the adapter binary usually lives inside an editor's extension directory.
   *
   * VS Code ships most adapters inside extensions rather than on the PATH, so "run the adapter" is
   * rarely a command a user could type. These fragments let `debug wire` find the real one.
   */
  extensionHint?: string;
  /** What it supports, absent a live session to ask. */
  expected: {
    memory: boolean;
    disassembly: boolean;
    dataBreakpoints: boolean;
    stepBack: boolean;
    setVariable: boolean;
    /** Whether frames carry a module id worth grouping by. */
    modules: boolean;
  };
  /**
   * Path fragments that mark a frame as runtime or library code rather than the user's.
   *
   * Not a blocklist — nothing is hidden. These drive the `userCode` classification that lets an
   * analysis say "your code is at frame 4" instead of making a reader scroll past thirty frames of
   * framework.
   */
  runtimePaths: string[];
  /** Anything a person reading a capture from this adapter should know. */
  notes?: string;
}

const NONE = {
  memory: false, disassembly: false, dataBreakpoints: false,
  stepBack: false, setVariable: true, modules: false,
};

const NATIVE = {
  memory: true, disassembly: true, dataBreakpoints: true,
  stepBack: false, setVariable: true, modules: true,
};

export const KNOWN_ADAPTERS: KnownAdapter[] = [
  {
    id: 'debugpy',
    name: 'Python (debugpy)',
    languages: ['python'],
    command: { program: 'python', args: ['-m', 'debugpy.adapter'], install: 'pip install debugpy' },
    expected: { ...NONE, dataBreakpoints: false },
    runtimePaths: ['site-packages', 'lib/python', 'importlib', '<frozen', 'runpy.py', 'threading.py'],
    notes:
      'Rich variable values through repr(), including for containers. No memory addresses: CPython ' +
      'objects have no stable address a debugger can hand out.',
  },
  {
    id: 'python',
    name: 'Python (legacy type alias)',
    languages: ['python'],
    command: { program: 'python', args: ['-m', 'debugpy.adapter'] },
    expected: NONE,
    runtimePaths: ['site-packages', 'lib/python'],
    notes: 'VS Code renamed this type to `debugpy`; older launch.json files still say `python`.',
  },
  {
    id: 'node',
    name: 'Node.js',
    languages: ['javascript', 'typescript'],
    extensionHint: 'ms-vscode.js-debug',
    expected: { ...NONE, setVariable: true },
    runtimePaths: ['node:internal', 'internal/', 'node_modules/', '<anonymous>'],
    notes:
      'js-debug maps through source maps, so frames often point at TypeScript that never ran. ' +
      'Values come from the V8 inspector and are structurally accurate.',
  },
  {
    id: 'pwa-node',
    name: 'Node.js (js-debug)',
    languages: ['javascript', 'typescript'],
    extensionHint: 'ms-vscode.js-debug',
    expected: NONE,
    runtimePaths: ['node:internal', 'internal/', 'node_modules/'],
    notes: 'The modern VS Code Node type. Same adapter as `node`.',
  },
  {
    id: 'chrome',
    name: 'Chrome / Edge',
    languages: ['javascript', 'typescript'],
    extensionHint: 'ms-vscode.js-debug',
    expected: NONE,
    runtimePaths: ['node_modules/', 'webpack://', 'chrome-extension://'],
  },
  {
    id: 'coreclr',
    name: '.NET (coreclr)',
    languages: ['csharp', 'fsharp', 'vb'],
    extensionHint: 'ms-dotnettools.csharp',
    expected: { ...NONE, modules: true, dataBreakpoints: true },
    runtimePaths: [
      'System.Private.CoreLib', 'Microsoft.AspNetCore', 'System.Threading',
      'System.Runtime.CompilerServices', '/usr/share/dotnet', 'Program Files/dotnet',
    ],
    notes:
      'Frames carry a module id and a symbol status; a stack that is unreadable is almost always ' +
      'a module whose symbolStatus is not `loaded`, which the capture reports rather than hides.',
  },
  {
    id: 'go',
    name: 'Go (Delve)',
    languages: ['go'],
    command: { program: 'dlv', args: ['dap'], install: 'go install github.com/go-delve/delve/cmd/dlv@latest' },
    expected: { ...NATIVE, disassembly: true, stepBack: false },
    runtimePaths: ['/usr/local/go/src/', 'runtime/', 'go/pkg/mod/'],
    notes:
      'Delve speaks DAP natively via `dlv dap`, so the proxy needs no wrapper. Goroutines appear ' +
      'as threads, and a busy server can present thousands of them.',
  },
  {
    id: 'cppdbg',
    name: 'C / C++ (MI: gdb or lldb)',
    languages: ['c', 'cpp'],
    extensionHint: 'ms-vscode.cpptools',
    expected: NATIVE,
    runtimePaths: ['/usr/include/', '/usr/lib/', 'libc.so', 'libstdc++'],
    notes:
      'Memory, registers and disassembly are all available. Container values depend on pretty ' +
      'printers being loaded; without them a std::map reads as raw structure.',
  },
  {
    id: 'lldb',
    name: 'LLDB (CodeLLDB)',
    languages: ['c', 'cpp', 'rust', 'swift'],
    extensionHint: 'vadimcn.vscode-lldb',
    expected: NATIVE,
    runtimePaths: ['/rustc/', '.cargo/registry/', '/usr/lib/', 'core/src/', 'std/src/'],
    notes: 'The usual Rust adapter. Full memory and register access.',
  },
  {
    id: 'gdb',
    name: 'GDB',
    languages: ['c', 'cpp', 'rust', 'fortran'],
    command: { program: 'gdb', args: ['--interpreter=dap'] },
    expected: NATIVE,
    runtimePaths: ['/usr/include/', '/usr/lib/', 'libc.so'],
    notes: 'GDB 14 and later speak DAP directly with --interpreter=dap.',
  },
  {
    id: 'java',
    name: 'Java',
    languages: ['java'],
    extensionHint: 'vscjava.vscode-java-debug',
    expected: { ...NONE, dataBreakpoints: true, modules: true },
    runtimePaths: ['java.base/', 'jdk.internal', 'org.springframework', 'jakarta.', 'javax.'],
    notes: 'Hot code replace is supported by the adapter; Auspex never uses it, as it writes.',
  },
  {
    id: 'php',
    name: 'PHP (Xdebug)',
    languages: ['php'],
    extensionHint: 'xdebug.php-debug',
    expected: NONE,
    runtimePaths: ['vendor/', '/usr/share/php'],
  },
  {
    id: 'ruby_lsp',
    name: 'Ruby (debug gem)',
    languages: ['ruby'],
    command: { program: 'rdbg', args: ['--open', '--stop-at-load'], install: 'gem install debug' },
    expected: NONE,
    runtimePaths: ['/gems/', 'lib/ruby/'],
  },
  {
    id: 'dart',
    name: 'Dart / Flutter',
    languages: ['dart'],
    extensionHint: 'dart-code.dart-code',
    expected: NONE,
    runtimePaths: ['package:flutter/', 'dart:', 'package:'],
  },
  {
    id: 'elixir-ls',
    name: 'Elixir',
    languages: ['elixir'],
    extensionHint: 'jakebecker.elixir-ls',
    expected: NONE,
    runtimePaths: ['/deps/', 'lib/elixir/'],
  },
  {
    id: 'delve',
    name: 'Go (Delve, alternate type name)',
    languages: ['go'],
    command: { program: 'dlv', args: ['dap'] },
    expected: NATIVE,
    runtimePaths: ['/usr/local/go/src/', 'go/pkg/mod/'],
  },
];

/** Looks up an adapter by the `type` a launch configuration uses. Case-insensitive. */
export function adapterById(type: string): KnownAdapter | undefined {
  const wanted = type.toLowerCase();
  return KNOWN_ADAPTERS.find((adapter) => adapter.id.toLowerCase() === wanted);
}

/** Every adapter that debugs a language. */
export function adaptersForLanguage(languageId: string): KnownAdapter[] {
  return KNOWN_ADAPTERS.filter((adapter) => adapter.languages.includes(languageId));
}

/**
 * Whether a frame's file looks like the user's own code.
 *
 * Deliberately conservative: **a frame with no path at all is treated as runtime**, because an
 * unmapped frame is nearly always inside a runtime that has no source to show, and a frame whose
 * path does not match any known runtime fragment is treated as the user's. Being wrong in the
 * generous direction shows a reader one extra frame; being wrong in the strict direction hides the
 * line their bug is on, and only one of those is recoverable.
 */
export function isUserCode(file: string | undefined, adapter?: KnownAdapter): boolean {
  if (!file) return false;

  const path = file.replace(/\\/g, '/').toLowerCase();
  const fragments = adapter?.runtimePaths ?? [];

  for (const fragment of fragments) {
    if (path.includes(fragment.replace(/\\/g, '/').toLowerCase())) return false;
  }
  // Package directories are library code under every ecosystem, whether or not the adapter is
  // known. This is the check that makes an unknown adapter still produce a sensible answer.
  return !/\/(node_modules|site-packages|vendor|\.cargo\/registry|go\/pkg\/mod|\.gradle|\.m2|packages)\//.test(path);
}

/** What Auspex expects an adapter to support, for use before a session exists. */
export function expectedCapabilities(type: string | undefined): KnownAdapter['expected'] | undefined {
  return type ? adapterById(type)?.expected : undefined;
}

/**
 * Explains an empty memory capture.
 *
 * Three genuinely different reasons produce the same empty list, and conflating them is how a tool
 * teaches someone the wrong thing about their own runtime.
 */
export function explainNoMemory(adapterType: string | undefined, liveSupport: boolean | undefined): string {
  if (liveSupport === true) {
    return 'this adapter can read memory, but no variable at this stop carried an address';
  }
  const known = adapterType ? adapterById(adapterType) : undefined;
  if (known && !known.expected.memory) {
    return `${known.name} does not expose memory addresses${known.notes ? ` — ${known.notes}` : ''}`;
  }
  return 'this debug adapter did not advertise support for reading memory';
}
