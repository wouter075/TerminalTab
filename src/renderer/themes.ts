import type { ITheme } from '@xterm/xterm';

export interface TerminalTheme {
  id: string;
  name: string;
  /** Light background: the UI around the terminal uses this too. */
  light?: boolean;
  colors: ITheme & { background: string; foreground: string };
}

export const DEFAULT_FONT =
  '"Cascadia Mono", "Cascadia Code", Consolas, "DejaVu Sans Mono", "Ubuntu Mono", "Liberation Mono", "Courier New", monospace';

/** Suggestions for the font field (used if installed). */
export const FONT_SUGGESTIONS = [
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'JetBrains Mono',
  'Fira Code',
  'Source Code Pro',
  'Hack',
  'DejaVu Sans Mono',
  'Ubuntu Mono',
  'Liberation Mono',
];

/** A font family typed by the user, with the default stack as fallback. */
export function fontStack(family: string): string {
  const f = family.trim();
  if (!f) return DEFAULT_FONT;
  const quoted = /[",]/.test(f) ? f : `"${f}"`;
  return `${quoted}, ${DEFAULT_FONT}`;
}

export const THEMES: TerminalTheme[] = [
  {
    id: 'terminaltab',
    name: 'TerminalTab Dark',
    colors: {
      background: '#0f1115',
      foreground: '#d6dae2',
      cursor: '#8ab4ff',
      selectionBackground: '#2c3e66',
      black: '#1b1e25',
      brightBlack: '#5c6370',
      red: '#e06c75',
      brightRed: '#ff7a85',
      green: '#98c379',
      brightGreen: '#b5e890',
      yellow: '#e5c07b',
      brightYellow: '#ffd88a',
      blue: '#61afef',
      brightBlue: '#82c4ff',
      magenta: '#c678dd',
      brightMagenta: '#de97f5',
      cyan: '#56b6c2',
      brightCyan: '#7fd8e3',
      white: '#d6dae2',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    colors: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      black: '#3f4451',
      brightBlack: '#4f5666',
      red: '#e06c75',
      brightRed: '#ff7b86',
      green: '#98c379',
      brightGreen: '#b1e18b',
      yellow: '#d19a66',
      brightYellow: '#efb074',
      blue: '#61afef',
      brightBlue: '#67cdff',
      magenta: '#c678dd',
      brightMagenta: '#e48bff',
      cyan: '#56b6c2',
      brightCyan: '#63d4e0',
      white: '#d7dae0',
      brightWhite: '#e6e6e6',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    colors: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#93a1a1',
      selectionBackground: '#0a4b5c',
      black: '#073642',
      brightBlack: '#586e75',
      red: '#dc322f',
      brightRed: '#cb4b16',
      green: '#859900',
      brightGreen: '#a4b81a',
      yellow: '#b58900',
      brightYellow: '#d6a51d',
      blue: '#268bd2',
      brightBlue: '#4aa5e8',
      magenta: '#d33682',
      brightMagenta: '#6c71c4',
      cyan: '#2aa198',
      brightCyan: '#45c0b6',
      white: '#eee8d5',
      brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    light: true,
    colors: {
      background: '#fdf6e3',
      foreground: '#586e75',
      cursor: '#586e75',
      selectionBackground: '#e4ddc8',
      black: '#073642',
      brightBlack: '#657b83',
      red: '#dc322f',
      brightRed: '#cb4b16',
      green: '#859900',
      brightGreen: '#6b7a00',
      yellow: '#b58900',
      brightYellow: '#946f00',
      blue: '#268bd2',
      brightBlue: '#1a6fae',
      magenta: '#d33682',
      brightMagenta: '#6c71c4',
      cyan: '#2aa198',
      brightCyan: '#1d8079',
      white: '#93a1a1',
      brightWhite: '#839496',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    colors: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      selectionBackground: '#504945',
      black: '#282828',
      brightBlack: '#928374',
      red: '#cc241d',
      brightRed: '#fb4934',
      green: '#98971a',
      brightGreen: '#b8bb26',
      yellow: '#d79921',
      brightYellow: '#fabd2f',
      blue: '#458588',
      brightBlue: '#83a598',
      magenta: '#b16286',
      brightMagenta: '#d3869b',
      cyan: '#689d6a',
      brightCyan: '#8ec07c',
      white: '#a89984',
      brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    colors: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      brightBlack: '#4c566a',
      red: '#bf616a',
      brightRed: '#d08770',
      green: '#a3be8c',
      brightGreen: '#b6d1a0',
      yellow: '#ebcb8b',
      brightYellow: '#f2d9a6',
      blue: '#81a1c1',
      brightBlue: '#88c0d0',
      magenta: '#b48ead',
      brightMagenta: '#c9a5c2',
      cyan: '#88c0d0',
      brightCyan: '#8fbcbb',
      white: '#e5e9f0',
      brightWhite: '#eceff4',
    },
  },
];

export function themeById(id: string): TerminalTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
