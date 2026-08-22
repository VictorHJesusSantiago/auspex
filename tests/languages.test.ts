import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, detectShebang, summarizeByFamily, allLanguages } from '../src/languages/registry.ts';
import { extractOutline, flattenSymbols, offsetToPosition, computeLineStarts } from '../src/languages/outline.ts';
import { parseDataDocument, parseDelimitedRows } from '../src/languages/data.ts';
import { parseJsonc, stripJsonComments, isBinary, normalizePath } from '../src/platform/files.ts';
import { extractPathArguments, tokenizeCommandLine } from '../src/platform/processes.ts';

/** Finds a symbol by name anywhere in a nested outline. */
function find(symbols: ReturnType<typeof extractOutline>['symbols'], name: string) {
  return flattenSymbols(symbols).find((symbol) => symbol.name === name);
}

describe('language detection', () => {
  test('identifies programming languages by extension', () => {
    for (const [path, expected] of [
      ['a.ts', 'typescript'], ['a.tsx', 'typescriptreact'], ['a.rs', 'rust'],
      ['a.go', 'go'], ['a.cs', 'csharp'], ['a.kt', 'kotlin'], ['a.swift', 'swift'],
      ['a.ex', 'elixir'], ['a.zig', 'zig'], ['a.sol', 'solidity'],
    ] as const) {
      assert.equal(detectLanguage(path).id, expected, path);
    }
  });

  test('covers markup, style, data, config, query and shell, not only programming', () => {
    // The brief is "indifferent to the language, markup, styling or data", so this is the check
    // that the registry actually spans those families rather than being a list of languages.
    for (const [path, family] of [
      ['a.html', 'markup'], ['a.md', 'markup'], ['a.tex', 'markup'],
      ['a.scss', 'style'], ['a.less', 'style'],
      ['a.yaml', 'data'], ['a.toml', 'data'], ['a.csv', 'data'], ['a.proto', 'data'],
      ['Dockerfile', 'config'], ['Makefile', 'config'], ['a.tf', 'config'],
      ['a.sql', 'query'], ['a.ps1', 'shell'], ['a.sh', 'shell'],
    ] as const) {
      assert.equal(detectLanguage(path).family, family, path);
    }
  });

  test('recognizes extensionless files by exact name', () => {
    // These are among the most important files in a repository and none of them has an extension.
    assert.equal(detectLanguage('Dockerfile').id, 'dockerfile');
    assert.equal(detectLanguage('Makefile').id, 'makefile');
    assert.equal(detectLanguage('.gitignore').id, 'gitignore');
    assert.equal(detectLanguage('.editorconfig').id, 'editorconfig');
  });

  test('falls back to the shebang when there is no extension', () => {
    assert.equal(detectLanguage('deploy', '#!/usr/bin/env python3').id, 'python');
    assert.equal(detectLanguage('build', '#!/bin/bash').id, 'bash');
    assert.equal(detectShebang('#!/usr/bin/env node')?.id, 'javascript');
    assert.equal(detectShebang('not a shebang'), undefined);
  });

  test('exact filename beats extension', () => {
    // `.babelrc` has no extension to speak of but is JSON; `CMakeLists.txt` would otherwise be text.
    assert.equal(detectLanguage('CMakeLists.txt').id, 'cmake');
    assert.equal(detectLanguage('.babelrc').id, 'json');
  });

  test('handles compound extensions a naive extname would get wrong', () => {
    assert.equal(detectLanguage('types.d.ts').id, 'typescript');
    assert.equal(detectLanguage('.env.production').id, 'dotenv');
  });

  test('classifies binaries so nothing tries to read them as text', () => {
    for (const path of ['a.png', 'a.exe', 'a.zip', 'a.pdf', 'a.woff2']) {
      assert.equal(detectLanguage(path).family, 'binary', path);
    }
  });

  test('summarizes a language census by family', () => {
    const summary = summarizeByFamily({ typescript: 10, css: 3, json: 5, markdown: 2 });
    assert.equal(summary.programming, 10);
    assert.equal(summary.style, 3);
    assert.equal(summary.data, 5);
    assert.equal(summary.markup, 2);
  });

  test('every registered language has a unique id', () => {
    const ids = allLanguages().map((language) => language.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('outline: data formats are genuinely parsed', () => {
  test('JSON yields keys with their types', () => {
    const outline = extractOutline('a.json', '{"name":"x","port":8080,"tags":[1,2],"db":{"host":"h"}}');

    assert.equal(outline.source, 'parsed');
    assert.equal(find(outline.symbols, 'port')?.detail, '8080');
    assert.equal(find(outline.symbols, 'tags')?.detail, 'array[2]');
    assert.equal(find(outline.symbols, 'host')?.detail, '"h"', 'nested keys must appear');
  });

  test('YAML nests by indentation and marks positions', () => {
    const outline = extractOutline('a.yaml', 'spec:\n  replicas: 3\n  template:\n    name: web\n');

    assert.equal(outline.source, 'parsed');
    const replicas = find(outline.symbols, 'replicas')!;
    assert.equal(replicas.detail, '3');
    assert.equal(replicas.depth, 1, 'replicas is nested under spec');
    assert.equal(find(outline.symbols, 'name')?.depth, 2);
  });

  test('YAML ignores content inside a block scalar', () => {
    // Lines inside a `|` block are text, not structure. Treating them as keys is the classic
    // line-oriented YAML mistake.
    const outline = extractOutline('a.yaml', 'script: |\n  not: a key\n  neither: this\nreal: yes\n');
    const names = flattenSymbols(outline.symbols).map((symbol) => symbol.name);

    assert.ok(names.includes('script'));
    assert.ok(names.includes('real'));
    assert.ok(!names.includes('not'), 'block scalar contents must not become symbols');
  });

  test('TOML separates tables from arrays of tables', () => {
    const outline = extractOutline('a.toml', '[package]\nname = "x"\n\n[[bin]]\nname = "cli"\n');

    assert.equal(find(outline.symbols, 'package')?.kind, 'namespace');
    assert.equal(find(outline.symbols, 'bin')?.detail, 'array of tables');
  });

  test('an .env file yields names and never values', () => {
    // The one deliberately lossy outline: the names are useful context and the values are secrets.
    const outline = extractOutline('.env', 'SECRET_TOKEN=abc123xyz\nexport DATABASE_URL=postgres://u:p@h/d\n');
    const serialized = JSON.stringify(outline.symbols);

    assert.ok(serialized.includes('SECRET_TOKEN'));
    assert.ok(serialized.includes('DATABASE_URL'));
    assert.ok(!serialized.includes('abc123xyz'), 'values must never appear');
    assert.ok(!serialized.includes('postgres://'));
  });

  test('CSV yields columns with inferred types, not rows', () => {
    const outline = extractOutline('a.csv',
      'id,email,active,score\n1,a@b.com,true,1.5\n2,c@d.com,false,2.5\n3,e@f.com,true,3.5\n');

    assert.equal(find(outline.symbols, 'id')?.detail?.startsWith('integer'), true);
    assert.equal(find(outline.symbols, 'email')?.detail?.startsWith('email'), true);
    assert.equal(find(outline.symbols, 'active')?.detail?.startsWith('boolean'), true);
    assert.equal(find(outline.symbols, 'score')?.detail?.startsWith('number'), true);
  });

  test('a delimited reader honours quoting, doubled quotes and embedded commas', () => {
    const rows = parseDelimitedRows('a,"b,c","say ""hi"""\n1,2,3\n', ',');
    assert.deepEqual(rows[0], ['a', 'b,c', 'say "hi"']);
    assert.deepEqual(rows[1], ['1', '2', '3']);
  });

  test('INI groups keys under their section', () => {
    const outline = extractOutline('a.ini', '[server]\nhost = localhost\n[db]\nport = 5432\n');
    assert.equal(find(outline.symbols, 'host')?.depth, 1);
    assert.equal(find(outline.symbols, 'port')?.detail, '5432');
  });

  test('a Dockerfile yields its build stages', () => {
    const outline = extractOutline('Dockerfile',
      'FROM node:22 AS build\nWORKDIR /app\nRUN npm ci\nFROM nginx\nEXPOSE 80\n');

    assert.equal(find(outline.symbols, 'build')?.kind, 'namespace');
    assert.equal(find(outline.symbols, 'WORKDIR')?.detail, '/app');
    assert.equal(find(outline.symbols, 'RUN'), undefined, 'RUN lines are too numerous for an outline');
  });

  test('an unknown data format returns undefined rather than guessing', () => {
    assert.equal(parseDataDocument('made-up-format', 'x'), undefined);
  });
});

describe('outline: heuristics for programming languages', () => {
  test('finds declarations across unrelated languages with one pattern set', () => {
    // The point of grouping by family: `class Foo` looks the same in a dozen languages, so a
    // language the registry has never met still gets a usable outline.
    const cases: Array<[string, string, string]> = [
      ['a.ts', 'export class Widget {}', 'Widget'],
      ['a.rs', 'pub struct Point { x: i32 }', 'Point'],
      ['a.go', 'func Handle(w http.ResponseWriter) {}', 'Handle'],
      ['a.py', 'def compute(values):\n    pass', 'compute'],
      ['a.java', 'public interface Repository {}', 'Repository'],
      ['a.kt', 'data class User(val id: Int)', 'User'],
      ['a.rb', 'class Account\nend', 'Account'],
      ['a.ex', 'defmodule Thing do\nend', 'Thing'],
    ];
    for (const [path, source, expected] of cases) {
      const outline = extractOutline(path, source);
      assert.ok(find(outline.symbols, expected), `${path}: expected to find ${expected}`);
    }
  });

  test('labels itself heuristic and says how to do better', () => {
    // Honesty about which tier produced a result is the whole reason the source field exists.
    const outline = extractOutline('a.ts', 'class A {}');
    assert.equal(outline.source, 'heuristic');
    assert.match(outline.note!, /language server/);
  });

  test('Python nests methods under their class by indentation', () => {
    const outline = extractOutline('a.py', 'class Animal:\n    def speak(self):\n        pass\n\ndef main():\n    pass\n');

    assert.equal(find(outline.symbols, 'speak')?.depth, 1);
    assert.equal(find(outline.symbols, 'main')?.depth, 0);
  });

  test('Markdown headings nest by level and ignore fenced code', () => {
    const outline = extractOutline('a.md', '# T\n\n## A\n\n```\n# not a heading\n```\n\n## B\n### C\n');
    const names = flattenSymbols(outline.symbols).map((symbol) => symbol.name);

    assert.deepEqual(names, ['T', 'A', 'B', 'C']);
    assert.equal(find(outline.symbols, 'C')?.depth, 2);
  });

  test('SQL finds tables, views, functions and indexes', () => {
    const outline = extractOutline('a.sql',
      'CREATE TABLE users (id INT);\nCREATE VIEW active AS SELECT 1;\nCREATE INDEX idx ON users(id);');

    assert.equal(find(outline.symbols, 'users')?.kind, 'class');
    assert.equal(find(outline.symbols, 'active')?.kind, 'interface');
    assert.ok(find(outline.symbols, 'idx'));
  });

  test('CSS finds variables, selectors and at-rules', () => {
    const outline = extractOutline('a.scss', '$brand: red;\n.button { color: $brand; }\n@media print { .x { } }\n');
    const names = flattenSymbols(outline.symbols).map((symbol) => symbol.name);

    assert.ok(names.includes('$brand'));
    assert.ok(names.some((name) => name.includes('.button')));
    assert.ok(names.some((name) => name.includes('@media')));
  });

  test('a binary or unknown file yields no symbols rather than nonsense', () => {
    assert.deepEqual(extractOutline('a.png', 'nonsense').symbols, []);
  });

  test('offset conversion is correct at line boundaries', () => {
    const text = 'ab\ncd\nef';
    const starts = computeLineStarts(text);

    assert.deepEqual(offsetToPosition(0, starts), { line: 0, character: 0 });
    assert.deepEqual(offsetToPosition(3, starts), { line: 1, character: 0 });
    assert.deepEqual(offsetToPosition(7, starts), { line: 2, character: 1 });
  });
});

describe('file helpers', () => {
  test('parses JSONC, which is what every editor config actually is', () => {
    // VS Code's settings.json and launch.json are JSONC by design; JSON.parse fails on all of them.
    const parsed = parseJsonc<{ a: number; b: number[] }>('{ /* c */ "a": 1, // note\n "b": [2,], }');
    assert.deepEqual(parsed, { a: 1, b: [2] });
  });

  test('comment stripping does not mangle URLs inside strings', () => {
    // The naive regex breaks on every `https://` in a config file.
    const stripped = stripJsonComments('{"url": "https://example.com/a"}');
    assert.equal(JSON.parse(stripped).url, 'https://example.com/a');
  });

  test('detects binary content by a NUL byte', () => {
    assert.equal(isBinary(Buffer.from([0x48, 0x00, 0x49])), true);
    assert.equal(isBinary(Buffer.from('plain text')), false);
  });

  test('normalizes file URIs, including the Windows leading-slash form', () => {
    assert.equal(normalizePath('file:///c:/Users/x/a.ts'), 'c:/Users/x/a.ts');
    assert.equal(normalizePath('C:\\Users\\x\\a.ts'), 'C:/Users/x/a.ts');
    assert.equal(normalizePath('/home/u/a.ts'), '/home/u/a.ts');
  });
});

describe('process command lines', () => {
  test('tokenizes quoted paths with spaces', () => {
    const tokens = tokenizeCommandLine('"C:\\Program Files\\Editor\\ed.exe" --flag "C:\\My Projects\\app"');
    assert.equal(tokens.length, 3);
    assert.equal(tokens[2], 'C:\\My Projects\\app');
  });

  test('extracts folder arguments and skips flag values', () => {
    // `--user-data-dir /tmp/x` must not be mistaken for an opened folder.
    const paths = extractPathArguments('code --user-data-dir /tmp/profile /home/u/project');
    assert.deepEqual(paths, ['/home/u/project']);
  });

  test('ignores flags entirely', () => {
    assert.deepEqual(extractPathArguments('nvim --headless -n'), []);
  });
});
