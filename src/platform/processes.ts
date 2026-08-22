import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(exec);

/** One running process, as much as the platform will tell us. */
export interface ProcessInfo {
  pid: number;
  /** Executable name without a path: `Code.exe`, `idea64.exe`, `nvim`. */
  name: string;
  /** Full command line when available. This is where an editor's open folder usually appears. */
  command: string;
  ppid?: number;
}

/**
 * Cross-platform process discovery.
 *
 * There is no portable way to do this in Node without a native module, and adding one would defeat
 * the point of a zero-dependency connector. So each platform gets the shell command that actually
 * works there, and the parsing differences are handled once, here.
 *
 * Windows gets PowerShell's CIM rather than `tasklist`, because `tasklist` does not report the
 * command line at all — and the command line is the single most valuable field, since that is where
 * an editor records which folder it was launched with.
 */
export async function listProcesses(): Promise<ProcessInfo[]> {
  try {
    if (process.platform === 'win32') return await listWindows();
    return await listPosix();
  } catch {
    // Process listing failing is survivable: every adapter that uses it falls back to scanning
    // on-disk state, which is less current but still useful.
    return [];
  }
}

async function listWindows(): Promise<ProcessInfo[]> {
  // CSV rather than JSON: PowerShell's ConvertTo-Json collapses a single-element array into an
  // object, which is a classic source of intermittent parse failures on a machine running exactly
  // one editor.
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Csv -NoTypeInformation';
  const { stdout } = await run(`powershell -NoProfile -NonInteractive -Command "${script}"`, {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return parseCsv(stdout);
}

/** A small CSV reader, because the field we care about routinely contains commas and quotes. */
function parseCsv(text: string): ProcessInfo[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  if (!header) return [];
  const index = {
    pid: header.indexOf('ProcessId'),
    ppid: header.indexOf('ParentProcessId'),
    name: header.indexOf('Name'),
    command: header.indexOf('CommandLine'),
  };

  const processes: ProcessInfo[] = [];
  for (const cells of rows) {
    const pid = Number(cells[index.pid]);
    if (!Number.isFinite(pid)) continue;
    processes.push({
      pid,
      ppid: Number(cells[index.ppid]) || undefined,
      name: cells[index.name] ?? '',
      command: cells[index.command] ?? '',
    });
  }
  return processes;
}

async function listPosix(): Promise<ProcessInfo[]> {
  // `-ww` disables the column-width truncation that would otherwise cut off exactly the tail of the
  // command line where the folder argument lives.
  const { stdout } = await run('ps -Aww -o pid=,ppid=,comm=,args=', {
    maxBuffer: 32 * 1024 * 1024,
  });

  const processes: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, pid, ppid, comm, args] = match;
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      name: comm!.split('/').pop() ?? comm!,
      command: args ?? '',
    });
  }
  return processes;
}

/**
 * Finds processes whose executable name matches any of `names`, case-insensitively.
 *
 * Matching on the executable rather than the command line on purpose: an adapter looking for VS
 * Code should not match a shell whose command line happens to mention `code`, which is exactly what
 * a naive substring search over the full command produces.
 */
export function matchByExecutable(processes: ProcessInfo[], names: string[]): ProcessInfo[] {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return processes.filter((info) => {
    const base = info.name.toLowerCase().replace(/\.exe$/, '');
    return wanted.has(base) || wanted.has(info.name.toLowerCase());
  });
}

/**
 * Extracts folder paths from an editor's command line.
 *
 * Every graphical editor is launched as `editor [flags] <folder>` at least some of the time, so the
 * command line is often the fastest and most current statement of what is open — more current than
 * any session file, since it is fixed at launch and never goes stale.
 *
 * Flags are skipped, and so are the values of flags known to take one, which is what keeps
 * `--user-data-dir /tmp/x` from being mistaken for an opened folder.
 */
export function extractPathArguments(command: string): string[] {
  const tokens = tokenizeCommandLine(command);
  const flagsTakingValue = new Set([
    '--user-data-dir', '--extensions-dir', '--locale', '--log', '--crash-reporter-directory',
    '--profile', '--remote', '--folder-uri', '--file-uri', '-p', '--port', '--socket',
  ]);

  const paths: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('-')) {
      const [flag] = token.split('=');
      if (flagsTakingValue.has(flag!) && !token.includes('=')) i++;
      continue;
    }
    // A bare token that looks like a path: absolute, or containing a separator.
    if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith('/') || token.startsWith('~') ||
        token.includes('/') || token.includes('\\')) {
      paths.push(token);
    }
  }
  return paths;
}

/** Splits a command line, honouring double quotes — Windows paths with spaces make this needed. */
export function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of command) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
