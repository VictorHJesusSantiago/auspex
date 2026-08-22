import { basename, extname } from 'node:path';

/**
 * Language identification, covering programming languages, markup, stylesheets, data formats,
 * configuration and build files.
 *
 * The requirement Auspex is built against is "indifferent to the language", and this file is where
 * that is made true. Two things follow from taking it seriously:
 *
 * 1. **Families matter more than names.** Downstream code almost never wants to know that a file is
 *    Kotlin specifically; it wants to know that it is *programming* rather than *data*, because that
 *    decides whether to look for functions or for keys. So every language carries a
 *    {@link LanguageFamily}, and the generic outline extractor dispatches on family rather than on
 *    language.
 * 2. **Identification has to work three ways.** Extension covers most files, but a great many
 *    important files have no extension at all (`Dockerfile`, `Makefile`, `.gitignore`, `LICENSE`) or
 *    a misleading one, so filename matching and shebang sniffing are both needed. Resolution order
 *    is exact filename, then shebang, then extension, most specific first.
 *
 * Language ids follow the VS Code / LSP convention wherever one exists, so a consumer that already
 * speaks LSP does not have to translate.
 */

/**
 * What kind of thing a language is. This is the axis nearly all downstream logic actually branches
 * on.
 */
export type LanguageFamily =
  /** Executable code: TypeScript, Rust, Go, C#, Python, Kotlin, ... */
  | 'programming'
  /** Document markup: HTML, XML, Markdown, LaTeX, reStructuredText. */
  | 'markup'
  /** Presentation: CSS, SCSS, Less, Stylus, Tailwind config. */
  | 'style'
  /** Structured data: JSON, YAML, TOML, CSV, Protobuf, GraphQL schema. */
  | 'data'
  /** Machine configuration: INI, .env, Dockerfile, Makefile, CI manifests. */
  | 'config'
  /** Database and query languages: SQL, Cypher, SPARQL. */
  | 'query'
  /** Shell and automation: Bash, PowerShell, Batch. */
  | 'shell'
  /** Prose and documentation with no markup semantics. */
  | 'text'
  /** Anything not text at all. */
  | 'binary';

export interface Language {
  id: string;
  name: string;
  family: LanguageFamily;
  /** Line-comment prefix, when the language has one. Used by the outline extractor. */
  lineComment?: string;
  /** Block comment delimiters. */
  blockComment?: [string, string];
}

/**
 * The table. Deliberately long: a connector that quietly does not recognize a user's language is
 * exactly the failure this project exists to avoid, and each entry costs one line.
 */
const LANGUAGES: Language[] = [
  // -- Programming
  { id: 'typescript', name: 'TypeScript', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'typescriptreact', name: 'TypeScript JSX', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'javascript', name: 'JavaScript', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'javascriptreact', name: 'JavaScript JSX', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'python', name: 'Python', family: 'programming', lineComment: '#', blockComment: ['"""', '"""'] },
  { id: 'java', name: 'Java', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'kotlin', name: 'Kotlin', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'scala', name: 'Scala', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'groovy', name: 'Groovy', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'csharp', name: 'C#', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'fsharp', name: 'F#', family: 'programming', lineComment: '//', blockComment: ['(*', '*)'] },
  { id: 'vb', name: 'Visual Basic', family: 'programming', lineComment: "'" },
  { id: 'c', name: 'C', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'cpp', name: 'C++', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'objective-c', name: 'Objective-C', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'objective-cpp', name: 'Objective-C++', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'swift', name: 'Swift', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'rust', name: 'Rust', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'go', name: 'Go', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'ruby', name: 'Ruby', family: 'programming', lineComment: '#', blockComment: ['=begin', '=end'] },
  { id: 'php', name: 'PHP', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'perl', name: 'Perl', family: 'programming', lineComment: '#' },
  { id: 'lua', name: 'Lua', family: 'programming', lineComment: '--', blockComment: ['--[[', ']]'] },
  { id: 'dart', name: 'Dart', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'elixir', name: 'Elixir', family: 'programming', lineComment: '#' },
  { id: 'erlang', name: 'Erlang', family: 'programming', lineComment: '%' },
  { id: 'haskell', name: 'Haskell', family: 'programming', lineComment: '--', blockComment: ['{-', '-}'] },
  { id: 'ocaml', name: 'OCaml', family: 'programming', blockComment: ['(*', '*)'] },
  { id: 'clojure', name: 'Clojure', family: 'programming', lineComment: ';' },
  { id: 'lisp', name: 'Lisp', family: 'programming', lineComment: ';' },
  { id: 'scheme', name: 'Scheme', family: 'programming', lineComment: ';' },
  { id: 'racket', name: 'Racket', family: 'programming', lineComment: ';' },
  { id: 'julia', name: 'Julia', family: 'programming', lineComment: '#', blockComment: ['#=', '=#'] },
  { id: 'r', name: 'R', family: 'programming', lineComment: '#' },
  { id: 'matlab', name: 'MATLAB', family: 'programming', lineComment: '%' },
  { id: 'fortran', name: 'Fortran', family: 'programming', lineComment: '!' },
  { id: 'cobol', name: 'COBOL', family: 'programming', lineComment: '*' },
  { id: 'pascal', name: 'Pascal', family: 'programming', lineComment: '//', blockComment: ['{', '}'] },
  { id: 'ada', name: 'Ada', family: 'programming', lineComment: '--' },
  { id: 'zig', name: 'Zig', family: 'programming', lineComment: '//' },
  { id: 'nim', name: 'Nim', family: 'programming', lineComment: '#' },
  { id: 'crystal', name: 'Crystal', family: 'programming', lineComment: '#' },
  { id: 'v', name: 'V', family: 'programming', lineComment: '//' },
  { id: 'odin', name: 'Odin', family: 'programming', lineComment: '//' },
  { id: 'solidity', name: 'Solidity', family: 'programming', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'move', name: 'Move', family: 'programming', lineComment: '//' },
  { id: 'assembly', name: 'Assembly', family: 'programming', lineComment: ';' },
  { id: 'verilog', name: 'Verilog', family: 'programming', lineComment: '//' },
  { id: 'vhdl', name: 'VHDL', family: 'programming', lineComment: '--' },
  { id: 'apex', name: 'Apex', family: 'programming', lineComment: '//' },
  { id: 'abap', name: 'ABAP', family: 'programming', lineComment: '*' },
  { id: 'elm', name: 'Elm', family: 'programming', lineComment: '--' },
  { id: 'purescript', name: 'PureScript', family: 'programming', lineComment: '--' },
  { id: 'reason', name: 'Reason', family: 'programming', lineComment: '//' },
  { id: 'svelte', name: 'Svelte', family: 'programming', blockComment: ['<!--', '-->'] },
  { id: 'vue', name: 'Vue', family: 'programming', blockComment: ['<!--', '-->'] },
  { id: 'astro', name: 'Astro', family: 'programming', blockComment: ['<!--', '-->'] },

  // -- Markup
  { id: 'html', name: 'HTML', family: 'markup', blockComment: ['<!--', '-->'] },
  { id: 'xml', name: 'XML', family: 'markup', blockComment: ['<!--', '-->'] },
  { id: 'xhtml', name: 'XHTML', family: 'markup', blockComment: ['<!--', '-->'] },
  { id: 'markdown', name: 'Markdown', family: 'markup', blockComment: ['<!--', '-->'] },
  { id: 'mdx', name: 'MDX', family: 'markup', blockComment: ['<!--', '-->'] },
  { id: 'restructuredtext', name: 'reStructuredText', family: 'markup' },
  { id: 'asciidoc', name: 'AsciiDoc', family: 'markup', lineComment: '//' },
  { id: 'latex', name: 'LaTeX', family: 'markup', lineComment: '%' },
  { id: 'bibtex', name: 'BibTeX', family: 'markup', lineComment: '%' },
  { id: 'org', name: 'Org Mode', family: 'markup', lineComment: '#' },
  { id: 'jinja', name: 'Jinja', family: 'markup', blockComment: ['{#', '#}'] },
  { id: 'handlebars', name: 'Handlebars', family: 'markup', blockComment: ['{{!--', '--}}'] },
  { id: 'liquid', name: 'Liquid', family: 'markup', blockComment: ['{% comment %}', '{% endcomment %}'] },
  { id: 'razor', name: 'Razor', family: 'markup', blockComment: ['@*', '*@'] },
  { id: 'blade', name: 'Blade', family: 'markup', blockComment: ['{{--', '--}}'] },
  { id: 'erb', name: 'ERB', family: 'markup', blockComment: ['<%#', '%>'] },
  { id: 'pug', name: 'Pug', family: 'markup', lineComment: '//' },
  { id: 'haml', name: 'Haml', family: 'markup', lineComment: '-#' },
  { id: 'svg', name: 'SVG', family: 'markup', blockComment: ['<!--', '-->'] },

  // -- Style
  { id: 'css', name: 'CSS', family: 'style', blockComment: ['/*', '*/'] },
  { id: 'scss', name: 'SCSS', family: 'style', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'sass', name: 'Sass', family: 'style', lineComment: '//' },
  { id: 'less', name: 'Less', family: 'style', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'stylus', name: 'Stylus', family: 'style', lineComment: '//' },
  { id: 'postcss', name: 'PostCSS', family: 'style', blockComment: ['/*', '*/'] },

  // -- Data
  { id: 'json', name: 'JSON', family: 'data' },
  { id: 'jsonc', name: 'JSON with Comments', family: 'data', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'json5', name: 'JSON5', family: 'data', lineComment: '//', blockComment: ['/*', '*/'] },
  { id: 'jsonl', name: 'JSON Lines', family: 'data' },
  { id: 'yaml', name: 'YAML', family: 'data', lineComment: '#' },
  { id: 'toml', name: 'TOML', family: 'data', lineComment: '#' },
  { id: 'csv', name: 'CSV', family: 'data' },
  { id: 'tsv', name: 'TSV', family: 'data' },
  { id: 'protobuf', name: 'Protocol Buffers', family: 'data', lineComment: '//' },
  { id: 'graphql', name: 'GraphQL', family: 'data', lineComment: '#' },
  { id: 'avro', name: 'Avro Schema', family: 'data' },
  { id: 'thrift', name: 'Thrift', family: 'data', lineComment: '//' },
  { id: 'parquet', name: 'Parquet', family: 'binary' },
  { id: 'ndjson', name: 'Newline-delimited JSON', family: 'data' },

  // -- Config
  { id: 'ini', name: 'INI', family: 'config', lineComment: ';' },
  { id: 'properties', name: 'Java Properties', family: 'config', lineComment: '#' },
  { id: 'dotenv', name: 'Environment File', family: 'config', lineComment: '#' },
  { id: 'dockerfile', name: 'Dockerfile', family: 'config', lineComment: '#' },
  { id: 'dockercompose', name: 'Docker Compose', family: 'config', lineComment: '#' },
  { id: 'makefile', name: 'Makefile', family: 'config', lineComment: '#' },
  { id: 'cmake', name: 'CMake', family: 'config', lineComment: '#' },
  { id: 'terraform', name: 'Terraform', family: 'config', lineComment: '#' },
  { id: 'hcl', name: 'HCL', family: 'config', lineComment: '#' },
  { id: 'nginx', name: 'nginx', family: 'config', lineComment: '#' },
  { id: 'apache', name: 'Apache Config', family: 'config', lineComment: '#' },
  { id: 'gitignore', name: 'Git Ignore', family: 'config', lineComment: '#' },
  { id: 'editorconfig', name: 'EditorConfig', family: 'config', lineComment: '#' },
  { id: 'gradle', name: 'Gradle', family: 'config', lineComment: '//' },
  { id: 'bazel', name: 'Bazel', family: 'config', lineComment: '#' },
  { id: 'nix', name: 'Nix', family: 'config', lineComment: '#' },
  { id: 'puppet', name: 'Puppet', family: 'config', lineComment: '#' },
  { id: 'ansible', name: 'Ansible', family: 'config', lineComment: '#' },

  // -- Query
  { id: 'sql', name: 'SQL', family: 'query', lineComment: '--', blockComment: ['/*', '*/'] },
  { id: 'plsql', name: 'PL/SQL', family: 'query', lineComment: '--' },
  { id: 'tsql', name: 'T-SQL', family: 'query', lineComment: '--' },
  { id: 'cypher', name: 'Cypher', family: 'query', lineComment: '//' },
  { id: 'sparql', name: 'SPARQL', family: 'query', lineComment: '#' },

  // -- Shell
  { id: 'shellscript', name: 'Shell Script', family: 'shell', lineComment: '#' },
  { id: 'bash', name: 'Bash', family: 'shell', lineComment: '#' },
  { id: 'zsh', name: 'Zsh', family: 'shell', lineComment: '#' },
  { id: 'fish', name: 'Fish', family: 'shell', lineComment: '#' },
  { id: 'powershell', name: 'PowerShell', family: 'shell', lineComment: '#', blockComment: ['<#', '#>'] },
  { id: 'bat', name: 'Batch', family: 'shell', lineComment: 'REM' },

  // -- Text and binary
  { id: 'plaintext', name: 'Plain Text', family: 'text' },
  { id: 'log', name: 'Log', family: 'text' },
  { id: 'binary', name: 'Binary', family: 'binary' },
];

const BY_ID = new Map(LANGUAGES.map((language) => [language.id, language]));

/** Extension to language id. Lower-case, without the dot. */
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  py: 'python', pyi: 'python', pyw: 'python',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala',
  groovy: 'groovy', gvy: 'groovy',
  cs: 'csharp', csx: 'csharp', fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  vb: 'vb', bas: 'vb',
  c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp', ipp: 'cpp',
  m: 'objective-c', mm: 'objective-cpp',
  swift: 'swift', rs: 'rust', go: 'go',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  php: 'php', phtml: 'php', pl: 'perl', pm: 'perl',
  lua: 'lua', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang', hrl: 'erlang',
  hs: 'haskell', lhs: 'haskell', ml: 'ocaml', mli: 'ocaml',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  lisp: 'lisp', el: 'lisp', scm: 'scheme', ss: 'scheme', rkt: 'racket',
  jl: 'julia', r: 'r', rmd: 'r',
  f: 'fortran', f90: 'fortran', f95: 'fortran', f03: 'fortran',
  cob: 'cobol', cbl: 'cobol', pas: 'pascal', dpr: 'pascal',
  adb: 'ada', ads: 'ada', zig: 'zig', nim: 'nim', nims: 'nim',
  cr: 'crystal', odin: 'odin', sol: 'solidity', move: 'move',
  asm: 'assembly', s: 'assembly', nasm: 'assembly',
  sv: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  cls: 'apex', trigger: 'apex', abap: 'abap',
  elm: 'elm', purs: 'purescript', re: 'reason', rei: 'reason',
  svelte: 'svelte', vue: 'vue', astro: 'astro',

  html: 'html', htm: 'html', xhtml: 'xhtml',
  xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', wsdl: 'xml', plist: 'xml',
  csproj: 'xml', vbproj: 'xml', fsproj: 'xml', vcxproj: 'xml', props: 'xml', targets: 'xml',
  nuspec: 'xml', resx: 'xml', axaml: 'xml', xaml: 'xml', storyboard: 'xml', xib: 'xml',
  md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  rst: 'restructuredtext', adoc: 'asciidoc', asciidoc: 'asciidoc',
  tex: 'latex', sty: 'latex', cls_tex: 'latex', bib: 'bibtex',
  org: 'org', j2: 'jinja', jinja: 'jinja', jinja2: 'jinja',
  hbs: 'handlebars', handlebars: 'handlebars', liquid: 'liquid',
  cshtml: 'razor', razor: 'razor', vbhtml: 'razor',
  erb: 'erb', pug: 'pug', jade: 'pug', haml: 'haml', svg: 'svg',

  css: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus', pcss: 'postcss',

  json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'jsonl', ndjson: 'ndjson',
  yaml: 'yaml', yml: 'yaml', toml: 'toml',
  csv: 'csv', tsv: 'tsv',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql',
  avsc: 'avro', thrift: 'thrift', parquet: 'parquet',

  ini: 'ini', cfg: 'ini', conf: 'ini',
  properties: 'properties', env: 'dotenv',
  tf: 'terraform', tfvars: 'terraform', hcl: 'hcl',
  gradle: 'gradle', bzl: 'bazel', nix: 'nix', pp: 'puppet',

  sql: 'sql', ddl: 'sql', dml: 'sql', pls: 'plsql', cypher: 'cypher', rq: 'sparql',

  sh: 'shellscript', bash: 'bash', zsh: 'zsh', fish: 'fish',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',

  txt: 'plaintext', text: 'plaintext', log: 'log',
};

/** Exact filenames, checked before extensions. Many of the most important files have no extension. */
const BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  'docker-compose.yml': 'dockercompose',
  'docker-compose.yaml': 'dockercompose',
  'compose.yml': 'dockercompose',
  'compose.yaml': 'dockercompose',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitignore',
  '.dockerignore': 'gitignore',
  '.npmignore': 'gitignore',
  '.editorconfig': 'editorconfig',
  '.env': 'dotenv',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.prettierrc': 'json',
  '.npmrc': 'ini',
  '.gitconfig': 'ini',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  'build.gradle': 'gradle',
  'settings.gradle': 'gradle',
  'build.gradle.kts': 'kotlin',
  'build.bazel': 'bazel',
  'workspace.bazel': 'bazel',
  'go.mod': 'config',
  'go.sum': 'config',
  'cargo.toml': 'toml',
  'cargo.lock': 'toml',
  'pyproject.toml': 'toml',
  'nginx.conf': 'nginx',
  '.htaccess': 'apache',
  'requirements.txt': 'config',
  license: 'plaintext',
  'license.md': 'markdown',
  readme: 'plaintext',
  notice: 'plaintext',
  authors: 'plaintext',
  changelog: 'plaintext',
};

/** Interpreter names in a shebang line, mapped to language ids. */
const BY_SHEBANG: Record<string, string> = {
  node: 'javascript', deno: 'typescript', bun: 'typescript', 'ts-node': 'typescript',
  python: 'python', python2: 'python', python3: 'python',
  ruby: 'ruby', perl: 'perl', php: 'php', lua: 'lua',
  bash: 'bash', sh: 'shellscript', zsh: 'zsh', fish: 'fish', dash: 'shellscript',
  pwsh: 'powershell', powershell: 'powershell',
  Rscript: 'r', julia: 'julia', groovy: 'groovy', scala: 'scala',
};

const UNKNOWN: Language = { id: 'plaintext', name: 'Plain Text', family: 'text' };

/**
 * Identifies a file's language from its path, and optionally from its first line.
 *
 * Resolution order is exact filename, then shebang, then extension. Filename first because a file
 * called `Dockerfile` must not be mistaken for extensionless plain text; shebang before extension
 * because an executable script called `deploy` with `#!/usr/bin/env python3` really is Python and
 * has no extension to consult.
 */
export function detectLanguage(path: string, firstLine?: string): Language {
  const name = basename(path).toLowerCase();

  const byName = BY_FILENAME[name];
  if (byName) return BY_ID.get(byName) ?? UNKNOWN;

  // Compound extensions that a plain `extname` would get wrong.
  if (name.endsWith('.d.ts')) return BY_ID.get('typescript')!;
  if (name.startsWith('.env')) return BY_ID.get('dotenv')!;
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return BY_ID.get('binary')!;

  if (firstLine?.startsWith('#!')) {
    const shebang = detectShebang(firstLine);
    if (shebang) return shebang;
  }

  const extension = extname(name).slice(1);
  const byExtension = BY_EXTENSION[extension];
  if (byExtension) return BY_ID.get(byExtension) ?? UNKNOWN;

  if (BINARY_EXTENSIONS.has(extension)) return BY_ID.get('binary')!;

  return UNKNOWN;
}

/** Resolves a shebang line to a language, handling both direct and `env`-mediated forms. */
export function detectShebang(line: string): Language | undefined {
  const match = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(line);
  if (!match) return undefined;

  const first = basename(match[1] ?? '');
  // `#!/usr/bin/env python3` puts the real interpreter in the second token.
  const interpreter = first === 'env' && match[2] ? basename(match[2]) : first;
  const normalized = interpreter.replace(/\d+(\.\d+)*$/, '') || interpreter;

  const id = BY_SHEBANG[interpreter] ?? BY_SHEBANG[normalized];
  return id ? BY_ID.get(id) : undefined;
}

/** Extensions whose contents are never text worth reading. */
export const BINARY_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'o', 'obj', 'pdb', 'class', 'jar', 'war', 'ear',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso', 'msi', 'deb', 'rpm', 'apk',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'psd', 'ai', 'heic',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlite3', 'mdb', 'bin', 'dat', 'pyc', 'pyo', 'wasm', 'node',
]);

export function languageById(id: string): Language | undefined {
  return BY_ID.get(id);
}

export function allLanguages(): readonly Language[] {
  return LANGUAGES;
}

/** True for languages whose files are worth reading as text at all. */
export function isTextual(language: Language): boolean {
  return language.family !== 'binary';
}

/** Groups a language count map by family — the fastest one-line characterization of a project. */
export function summarizeByFamily(counts: Record<string, number>): Record<LanguageFamily, number> {
  const summary: Record<string, number> = {};
  for (const [id, count] of Object.entries(counts)) {
    const family = BY_ID.get(id)?.family ?? 'text';
    summary[family] = (summary[family] ?? 0) + count;
  }
  return summary as Record<LanguageFamily, number>;
}
