import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where each editor keeps its state on each operating system.
 *
 * This file is unglamorous and it is also most of what makes the tool work. Every editor invented
 * its own answer to "where does configuration live", and the answers differ per platform on top of
 * that. Getting these right is the difference between an adapter that finds a user's real workspace
 * and one that finds nothing.
 *
 * The lists are ordered by likelihood, and every consumer is expected to try all of them and take
 * what exists — a developer with both VS Code and VSCodium installed has two of these directories,
 * and both are legitimate.
 */

const home = homedir();

/** The platform's roaming application data directory. */
export function appDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
}

/** The platform's local (non-roaming) application data directory. */
export function localAppDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
}

/** The platform's cache directory. */
export function cacheDir(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches');
  }
  return process.env.XDG_CACHE_HOME ?? join(home, '.cache');
}

/**
 * One product in the VS Code family, with the directory name it uses.
 *
 * The family is large and growing — the fork-and-rebrand pattern gave us VSCodium, Cursor,
 * Windsurf, Trae and others, all of which keep byte-identical state layouts under a different
 * folder name. One adapter covers all of them precisely because the only thing that differs is this
 * string, which is a good argument for listing them as data rather than writing an adapter each.
 */
export interface VsCodeVariant {
  id: string;
  name: string;
  /** Directory under the app-data root. */
  dir: string;
  /** Executable names to look for in the process list. */
  executables: string[];
}

export const VSCODE_VARIANTS: VsCodeVariant[] = [
  { id: 'vscode', name: 'Visual Studio Code', dir: 'Code', executables: ['Code', 'code'] },
  { id: 'vscode-insiders', name: 'VS Code Insiders', dir: 'Code - Insiders', executables: ['Code - Insiders', 'code-insiders'] },
  { id: 'vscodium', name: 'VSCodium', dir: 'VSCodium', executables: ['VSCodium', 'codium'] },
  { id: 'cursor', name: 'Cursor', dir: 'Cursor', executables: ['Cursor', 'cursor'] },
  { id: 'windsurf', name: 'Windsurf', dir: 'Windsurf', executables: ['Windsurf', 'windsurf'] },
  { id: 'trae', name: 'Trae', dir: 'Trae', executables: ['Trae', 'trae'] },
  { id: 'positron', name: 'Positron', dir: 'Positron', executables: ['Positron', 'positron'] },
  { id: 'theia', name: 'Eclipse Theia', dir: 'Theia', executables: ['Theia', 'theia'] },
];

/** Candidate user-data roots for a VS Code family member, most likely first. */
export function vsCodeUserDataRoots(variant: VsCodeVariant): string[] {
  const roots = [join(appDataDir(), variant.dir)];
  if (process.platform === 'linux') {
    // Snap and Flatpak relocate the whole tree, and a Linux user very often has one of them.
    roots.push(join(home, 'snap', variant.dir.toLowerCase(), 'current', '.config', variant.dir));
    roots.push(join(home, '.var', 'app', `com.visualstudio.${variant.dir.toLowerCase()}`, 'config', variant.dir));
  }
  return roots;
}

/**
 * A JetBrains product. They all share one layout, differing only in the product directory name and
 * the year-versioned suffix, so — as with the VS Code family — this is data rather than code.
 */
export interface JetBrainsProduct {
  id: string;
  name: string;
  /** Prefix of the config directory, e.g. `IntelliJIdea` matches `IntelliJIdea2024.3`. */
  prefix: string;
  executables: string[];
}

export const JETBRAINS_PRODUCTS: JetBrainsProduct[] = [
  { id: 'intellij', name: 'IntelliJ IDEA', prefix: 'IntelliJIdea', executables: ['idea64', 'idea', 'intellij'] },
  { id: 'intellij-ce', name: 'IntelliJ IDEA Community', prefix: 'IdeaIC', executables: ['idea64', 'idea'] },
  { id: 'webstorm', name: 'WebStorm', prefix: 'WebStorm', executables: ['webstorm64', 'webstorm'] },
  { id: 'pycharm', name: 'PyCharm', prefix: 'PyCharm', executables: ['pycharm64', 'pycharm'] },
  { id: 'rider', name: 'Rider', prefix: 'Rider', executables: ['rider64', 'rider'] },
  { id: 'goland', name: 'GoLand', prefix: 'GoLand', executables: ['goland64', 'goland'] },
  { id: 'clion', name: 'CLion', prefix: 'CLion', executables: ['clion64', 'clion'] },
  { id: 'phpstorm', name: 'PhpStorm', prefix: 'PhpStorm', executables: ['phpstorm64', 'phpstorm'] },
  { id: 'rubymine', name: 'RubyMine', prefix: 'RubyMine', executables: ['rubymine64', 'rubymine'] },
  { id: 'datagrip', name: 'DataGrip', prefix: 'DataGrip', executables: ['datagrip64', 'datagrip'] },
  { id: 'rustrover', name: 'RustRover', prefix: 'RustRover', executables: ['rustrover64', 'rustrover'] },
  { id: 'android-studio', name: 'Android Studio', prefix: 'AndroidStudio', executables: ['studio64', 'studio'] },
  { id: 'appcode', name: 'AppCode', prefix: 'AppCode', executables: ['appcode'] },
  { id: 'aqua', name: 'Aqua', prefix: 'Aqua', executables: ['aqua64', 'aqua'] },
];

/** The directory holding every JetBrains product's per-version config folder. */
export function jetBrainsConfigRoot(): string {
  if (process.platform === 'win32') {
    return join(appDataDir(), 'JetBrains');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'JetBrains');
  }
  return join(home, '.config', 'JetBrains');
}

/** Other editors, each with the executables to look for and the config root to read. */
export interface SimpleEditor {
  id: string;
  name: string;
  executables: string[];
  configDirs: string[];
}

export const OTHER_EDITORS: SimpleEditor[] = [
  {
    id: 'sublime',
    name: 'Sublime Text',
    executables: ['sublime_text', 'subl'],
    configDirs: [
      join(appDataDir(), 'Sublime Text', 'Local'),
      join(appDataDir(), 'Sublime Text 3', 'Local'),
      join(home, 'Library', 'Application Support', 'Sublime Text', 'Local'),
      join(home, '.config', 'sublime-text', 'Local'),
    ],
  },
  {
    id: 'zed',
    name: 'Zed',
    executables: ['zed', 'Zed'],
    configDirs: [
      join(localAppDataDir(), 'Zed'),
      join(home, 'Library', 'Application Support', 'Zed'),
      join(home, '.local', 'share', 'zed'),
      join(home, '.config', 'zed'),
    ],
  },
  {
    id: 'neovim',
    name: 'Neovim',
    executables: ['nvim', 'nvim-qt', 'neovide'],
    configDirs: [
      join(localAppDataDir(), 'nvim-data'),
      join(home, '.local', 'share', 'nvim'),
      join(home, '.config', 'nvim'),
    ],
  },
  {
    id: 'vim',
    name: 'Vim',
    executables: ['vim', 'gvim', 'mvim'],
    configDirs: [join(home, '.vim'), join(home, 'vimfiles')],
  },
  {
    id: 'emacs',
    name: 'Emacs',
    executables: ['emacs', 'emacsclient', 'runemacs'],
    configDirs: [join(home, '.emacs.d'), join(home, '.config', 'emacs')],
  },
  {
    id: 'helix',
    name: 'Helix',
    executables: ['hx', 'helix'],
    configDirs: [join(appDataDir(), 'helix'), join(home, '.config', 'helix')],
  },
  {
    id: 'nova',
    name: 'Nova',
    executables: ['Nova'],
    configDirs: [join(home, 'Library', 'Application Support', 'Nova')],
  },
  {
    id: 'xcode',
    name: 'Xcode',
    executables: ['Xcode'],
    configDirs: [join(home, 'Library', 'Developer', 'Xcode')],
  },
  {
    id: 'eclipse',
    name: 'Eclipse',
    executables: ['eclipse', 'eclipsec'],
    configDirs: [join(home, '.eclipse'), join(home, 'eclipse-workspace', '.metadata')],
  },
  {
    id: 'netbeans',
    name: 'NetBeans',
    executables: ['netbeans', 'netbeans64'],
    configDirs: [
      join(appDataDir(), 'NetBeans'),
      join(home, '.netbeans'),
      join(home, 'Library', 'Application Support', 'NetBeans'),
    ],
  },
  {
    id: 'notepadpp',
    name: 'Notepad++',
    executables: ['notepad++'],
    configDirs: [join(appDataDir(), 'Notepad++')],
  },
  {
    id: 'kate',
    name: 'Kate',
    executables: ['kate'],
    configDirs: [join(home, '.local', 'share', 'kate'), join(home, '.config')],
  },
  {
    id: 'geany',
    name: 'Geany',
    executables: ['geany'],
    configDirs: [join(appDataDir(), 'geany'), join(home, '.config', 'geany')],
  },
];

/** Visual Studio keeps per-version private settings under a local app-data folder. */
export function visualStudioRoots(): string[] {
  if (process.platform !== 'win32') return [];
  return [
    join(localAppDataDir(), 'Microsoft', 'VisualStudio'),
    join(appDataDir(), 'Microsoft', 'VisualStudio'),
  ];
}

/** Where Auspex itself stores configuration and its own logs. */
export function auspexConfigDir(): string {
  return join(appDataDir(), 'auspex');
}
