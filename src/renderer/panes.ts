/** What the app can do with a mounted terminal pane (registered by TerminalPane, keyed by tab id). */
export interface PaneHandle {
  /** Insert text like a paste (respects bracketed paste mode); `run` presses Enter afterwards. */
  insert(text: string, run: boolean): boolean;
  focus(): void;
}

export const panes = new Map<string, PaneHandle>();
