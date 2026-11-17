import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeName, SessionLogger, stripAnsi } from './sessionLog';

describe('stripAnsi', () => {
  it('removes colours, cursor moves, titles and carriage returns', () => {
    const raw = '\x1b]0;user@host: ~\x07\x1b[01;32muser@host\x1b[00m:\x1b[01;34m~\x1b[00m$ ls\r\nfile1  \x1b[0m\x1b[01;34mdir\x1b[0m\r\n\x1b[?2004h';
    expect(stripAnsi(raw)).toEqual({ text: 'user@host:~$ ls\nfile1  dir\n', rest: '' });
  });

  it('keeps an escape sequence split across chunks for the next chunk', () => {
    const a = stripAnsi('hello \x1b[01;3');
    expect(a).toEqual({ text: 'hello ', rest: '\x1b[01;3' });
    expect(stripAnsi(a.rest + '2mworld\x1b[0m').text).toBe('world');
  });
});

describe('safeName', () => {
  it('makes server names safe as folder names', () => {
    expect(safeName('web: prod/eu?')).toBe('web_ prod_eu_');
    expect(safeName('...')).toBe('server');
  });
});

describe('SessionLogger', () => {
  it('writes plain text per server', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tt-log-'));
    try {
      const log = new SessionLogger();
      log.start('s1', dir, 'My server', 'root@example.com:22');
      log.write('s1', Buffer.from('\x1b[32mok\x1b[0m\r\n'));
      // A UTF-8 character split over two chunks.
      const euro = Buffer.from('€\r\n');
      log.write('s1', euro.subarray(0, 1));
      log.write('s1', euro.subarray(1));
      log.end('s1', 'Session ended');
      await new Promise((r) => setTimeout(r, 100));
      const [file] = await fs.promises.readdir(path.join(dir, 'My server'));
      expect(file).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
      const text = await fs.promises.readFile(path.join(dir, 'My server', file), 'utf8');
      expect(text).toContain('# root@example.com:22');
      expect(text).toContain('ok\n€\n');
      expect(text).toContain('# Session ended');
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when logging is off or the folder is not writable', () => {
    const log = new SessionLogger();
    log.start('s', '', 'x', 'h');
    log.write('s', Buffer.from('a'));
    log.end('s');
    log.start('t', path.join(os.tmpdir(), 'tt-log-file-not-dir', '\0bad'), 'x', 'h');
    log.end('t');
  });
});
