/** Strip Electron's "Error invoking remote method 'x': Error:" prefix. */
export function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

export const api = window.terminalTab;
