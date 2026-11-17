import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable no-control-regex */
// CSI (ESC [ … final), OSC (ESC ] … BEL or ESC \), other two-byte escapes, and stray control characters.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x1b[()][0-9A-Za-z]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/**
 * Turn terminal output into plain text. Returns the text and any unfinished escape sequence
 * at the end, which should be prepended to the next chunk.
 */
export function stripAnsi(input: string): { text: string; rest: string } {
  let rest = '';
  const lastEsc = input.lastIndexOf('\x1b');
  if (lastEsc >= 0) {
    const tail = input.slice(lastEsc);
    ANSI.lastIndex = 0;
    const m = ANSI.exec(tail);
    // An escape at the very end without its terminator: keep it for the next chunk.
    if (!m || m.index !== 0) {
      if (tail.length < 256) {
        rest = tail;
        input = input.slice(0, lastEsc);
      }
    }
  }
  const text = input
    .replace(ANSI, '')
    .replace(/\r+\n/g, '\n')
    .replace(/\r/g, '')
    .replace(CONTROL, '');
  return { text, rest };
}

const pad = (n: number) => String(n).padStart(2, '0');
export function logFileName(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.log`;
}

/** Characters not allowed in folder names on Windows / Linux. */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'server';
}

interface Log {
  stream: fs.WriteStream;
  rest: string;
  decoder: TextDecoder;
}

/** Writes each session's output to <dir>/<server>/<date>.log as plain text. */
export class SessionLogger {
  private logs = new Map<string, Log>();

  start(sessionId: string, dir: string, serverName: string, header: string): void {
    if (!dir) return;
    try {
      const folder = path.join(dir, safeName(serverName));
      fs.mkdirSync(folder, { recursive: true });
      const stream = fs.createWriteStream(path.join(folder, logFileName(new Date())), { flags: 'a' });
      stream.on('error', () => this.logs.delete(sessionId));
      stream.write(`# ${header}\n# Started ${new Date().toString()}\n\n`);
      this.logs.set(sessionId, { stream, rest: '', decoder: new TextDecoder('utf-8') });
    } catch {
      // Logging must never break the session (e.g. folder not writable).
    }
  }

  write(sessionId: string, data: Uint8Array): void {
    const log = this.logs.get(sessionId);
    if (!log) return;
    const { text, rest } = stripAnsi(log.rest + log.decoder.decode(data, { stream: true }));
    log.rest = rest;
    if (text) log.stream.write(text);
  }

  end(sessionId: string, message?: string): void {
    const log = this.logs.get(sessionId);
    if (!log) return;
    this.logs.delete(sessionId);
    log.stream.end(`\n\n# ${message ?? 'Closed'} — ${new Date().toString()}\n`);
  }

  endAll(): void {
    for (const id of this.logs.keys()) this.end(id);
  }
}
