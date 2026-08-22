import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Adapter, AdapterResult, CaptureOptions } from '../core/adapter.ts';
import { NO_CAPABILITIES } from '../core/adapter.ts';
import type { ProjectManifest, Workspace } from '../core/model.ts';
import { readJsonFile, readTextFile, walkDirectory } from '../platform/files.ts';
import { readGitState } from '../vcs/git.ts';

/**
 * The filesystem adapter: the one that works for every editor, including ones nobody has written an
 * adapter for.
 *
 * This is the floor the whole design rests on. The brief is "any IDE or editor, whichever it is",
 * and no amount of per-editor adapters can literally satisfy that — someone will always be using a
 * niche editor, a private fork, or something released next year. What *is* universal is that they
 * all edit files in directories, and those directories contain the project's manifests, its layout
 * and its version control.
 *
 * So this adapter answers the question "what is this project" without caring what is editing it.
 * It cannot tell you where the caret is — nothing on the filesystem knows that — and it does not
 * pretend to: it reports `persisted` confidence and leaves the live details to adapters that can
 * actually see them.
 */
export class GenericFilesystemAdapter implements Adapter {
  readonly id = 'filesystem';
  readonly name = 'Filesystem';
  readonly confidence = 'persisted' as const;
  readonly capabilities = { ...NO_CAPABILITIES, workspaces: true };

  async probe(): Promise<boolean> {
    return true; // A filesystem is always there. That is the point of this adapter.
  }

  async capture(options: CaptureOptions): Promise<AdapterResult> {
    const roots = options.roots?.length ? options.roots : [process.cwd()];
    const warnings: string[] = [];
    const workspaces: Workspace[] = [];

    for (const root of roots) {
      try {
        workspaces.push(await describeWorkspace(root, options));
      } catch (error) {
        warnings.push(`could not read ${root}: ${error instanceof Error ? error.message : error}`);
      }
    }

    return {
      editors: workspaces.length > 0
        ? [{
            adapter: this.id,
            name: 'Filesystem (no editor detected)',
            workspaces,
            documents: [],
            confidence: this.confidence,
          }]
        : [],
      warnings,
      detail: `${workspaces.length} workspace(s) scanned`,
    };
  }
}

/**
 * Builds a full workspace description from a directory: manifests, languages, tree, git.
 *
 * Exported because every other adapter uses it. A VS Code adapter knows *which* folder is open but
 * has nothing better than this for describing what is in it, so there is one implementation and
 * every adapter benefits from improvements to it.
 */
export async function describeWorkspace(root: string, options: CaptureOptions): Promise<Workspace> {
  const workspace: Workspace = { root, name: basename(root) || root };

  const manifests = await detectManifests(root);
  if (manifests.length > 0) workspace.manifests = manifests;

  if (options.includeTree !== false) {
    const walk = await walkDirectory(root, {
      maxDepth: options.maxTreeDepth ?? 4,
      maxFiles: options.maxFiles ?? 4000,
    });
    workspace.tree = walk.tree;
    workspace.languages = walk.languages;
    workspace.fileCount = walk.files.length;
    workspace.totalBytes = walk.totalBytes;
  }

  if (options.includeVcs !== false) {
    const vcs = await readGitState(root, { includeDiff: options.includeDiff ?? false });
    if (vcs.system !== 'none') workspace.vcs = vcs;
  }

  return workspace;
}

/**
 * Manifest files worth detecting, and what ecosystem each implies.
 *
 * The list is long on purpose and it is the language-agnostic heart of project understanding: an
 * assistant that knows a directory contains `Cargo.toml` knows the language, the build command, the
 * test command and the dependency file without being told any of them. Missing an ecosystem here
 * means an assistant asking a user what they are working in, which is the experience this exists to
 * avoid.
 */
const MANIFEST_KINDS: Array<{ file: string; kind: string }> = [
  { file: 'package.json', kind: 'npm' },
  { file: 'deno.json', kind: 'deno' },
  { file: 'deno.jsonc', kind: 'deno' },
  { file: 'bun.lockb', kind: 'bun' },
  { file: 'Cargo.toml', kind: 'cargo' },
  { file: 'go.mod', kind: 'go' },
  { file: 'pom.xml', kind: 'maven' },
  { file: 'build.gradle', kind: 'gradle' },
  { file: 'build.gradle.kts', kind: 'gradle' },
  { file: 'settings.gradle', kind: 'gradle' },
  { file: 'pyproject.toml', kind: 'python' },
  { file: 'setup.py', kind: 'python' },
  { file: 'requirements.txt', kind: 'pip' },
  { file: 'Pipfile', kind: 'pipenv' },
  { file: 'poetry.lock', kind: 'poetry' },
  { file: 'Gemfile', kind: 'bundler' },
  { file: 'composer.json', kind: 'composer' },
  { file: 'mix.exs', kind: 'mix' },
  { file: 'rebar.config', kind: 'rebar' },
  { file: 'stack.yaml', kind: 'stack' },
  { file: 'cabal.project', kind: 'cabal' },
  { file: 'dune-project', kind: 'dune' },
  { file: 'CMakeLists.txt', kind: 'cmake' },
  { file: 'Makefile', kind: 'make' },
  { file: 'meson.build', kind: 'meson' },
  { file: 'BUILD.bazel', kind: 'bazel' },
  { file: 'WORKSPACE', kind: 'bazel' },
  { file: 'pubspec.yaml', kind: 'pub' },
  { file: 'Package.swift', kind: 'swiftpm' },
  { file: 'Podfile', kind: 'cocoapods' },
  { file: 'project.clj', kind: 'leiningen' },
  { file: 'deps.edn', kind: 'clojure' },
  { file: 'build.sbt', kind: 'sbt' },
  { file: 'shard.yml', kind: 'shards' },
  { file: 'nimble.toml', kind: 'nimble' },
  { file: 'build.zig', kind: 'zig' },
  { file: 'Dockerfile', kind: 'docker' },
  { file: 'docker-compose.yml', kind: 'docker-compose' },
  { file: 'compose.yaml', kind: 'docker-compose' },
  { file: 'main.tf', kind: 'terraform' },
  { file: 'Chart.yaml', kind: 'helm' },
  { file: 'serverless.yml', kind: 'serverless' },
  { file: 'flake.nix', kind: 'nix' },
];

/** Detects every manifest at a workspace root, plus .NET projects, which are found by glob. */
export async function detectManifests(root: string): Promise<ProjectManifest[]> {
  const manifests: ProjectManifest[] = [];

  for (const { file, kind } of MANIFEST_KINDS) {
    const path = join(root, file);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    manifests.push(await readManifest(kind, path));
  }

  // .NET has no fixed manifest name: the project file is `<AnyName>.csproj`. So the directory is
  // listed rather than probed, which is also how `dotnet build` itself finds it.
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (/\.(sln|slnx)$/i.test(entry.name)) {
        manifests.push({ kind: 'dotnet-solution', file: join(root, entry.name), name: entry.name });
      } else if (/\.(csproj|fsproj|vbproj)$/i.test(entry.name)) {
        manifests.push(await readDotNetProject(join(root, entry.name)));
      }
    }
  } catch {
    // Unreadable root: the manifests found so far still stand.
  }

  return manifests;
}

/** Reads a manifest's interesting fields, dispatching on ecosystem. */
async function readManifest(kind: string, path: string): Promise<ProjectManifest> {
  const manifest: ProjectManifest = { kind, file: path };

  switch (kind) {
    case 'npm':
    case 'deno': {
      const json = await readJsonFile<Record<string, unknown>>(path);
      if (json) {
        manifest.name = asString(json.name);
        manifest.version = asString(json.version);
        manifest.scripts = asStringRecord(json.scripts) ?? asStringRecord((json.tasks as object));
        manifest.dependencies = asStringRecord(json.dependencies);
        manifest.devDependencies = asStringRecord(json.devDependencies);
        const engines = json.engines as Record<string, string> | undefined;
        if (engines?.node) manifest.toolchain = `node ${engines.node}`;
      }
      break;
    }
    case 'cargo':
    case 'python':
    case 'nimble': {
      const text = await readTextFile(path);
      if (text) {
        manifest.name = matchToml(text, 'name');
        manifest.version = matchToml(text, 'version');
        const requires = matchToml(text, 'requires-python') ?? matchToml(text, 'rust-version');
        if (requires) manifest.toolchain = requires;
        manifest.dependencies = extractTomlSection(text, kind === 'cargo' ? 'dependencies' : 'project.dependencies');
      }
      break;
    }
    case 'go': {
      const text = await readTextFile(path);
      if (text) {
        manifest.name = /^module\s+(\S+)/m.exec(text)?.[1];
        manifest.toolchain = /^go\s+(\S+)/m.exec(text)?.[1];
      }
      break;
    }
    case 'maven': {
      const text = await readTextFile(path);
      if (text) {
        manifest.name = /<artifactId>([^<]+)<\/artifactId>/.exec(text)?.[1];
        manifest.version = /<version>([^<]+)<\/version>/.exec(text)?.[1];
        manifest.toolchain = /<maven\.compiler\.(?:source|release)>([^<]+)</.exec(text)?.[1];
      }
      break;
    }
    case 'make': {
      const text = await readTextFile(path);
      if (text) {
        // Make targets are the closest thing it has to declared entry points, and they are exactly
        // what an assistant needs to know how to build and test the project.
        const scripts: Record<string, string> = {};
        for (const match of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)\s*(.*)$/gm)) {
          if (Object.keys(scripts).length >= 40) break;
          scripts[match[1]!] = match[2]?.trim() || '(no prerequisites)';
        }
        if (Object.keys(scripts).length > 0) manifest.scripts = scripts;
      }
      break;
    }
    default:
      break;
  }
  return manifest;
}

/** Reads a .NET project file's target framework and package references. */
async function readDotNetProject(path: string): Promise<ProjectManifest> {
  const manifest: ProjectManifest = { kind: 'dotnet', file: path, name: basename(path) };
  const text = await readTextFile(path);
  if (!text) return manifest;

  manifest.toolchain = /<TargetFrameworks?>([^<]+)</.exec(text)?.[1];

  const dependencies: Record<string, string> = {};
  for (const match of text.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g)) {
    dependencies[match[1]!] = match[2] ?? '*';
  }
  if (Object.keys(dependencies).length > 0) manifest.dependencies = dependencies;

  return manifest;
}

/** Pulls a top-level `key = "value"` out of TOML without a full parse. */
function matchToml(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*=\\s*["']?([^"'\\n]+)["']?`, 'm').exec(text)?.[1]?.trim();
}

/** Pulls the `key = value` lines of one TOML table. */
function extractTomlSection(text: string, section: string): Record<string, string> | undefined {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\[|\\Z)`, 'm').exec(text);
  if (!match?.[1]) return undefined;

  const entries: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const pair = /^\s*([\w.-]+)\s*=\s*(.+)$/.exec(line);
    if (pair) entries[pair[1]!] = pair[2]!.trim();
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') record[key] = item;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}
