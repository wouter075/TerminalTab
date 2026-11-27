import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, utils, type Attributes } from 'ssh2';
import type { TransferProgress } from '../shared/types';
import { SessionManager } from './sessions';
import { SftpManager } from './sftp';

const { STATUS_CODE, OPEN_MODE } = utils.sftp;
const hostKey = utils.generateKeyPairSync('ed25519');

/** Tiny in-memory filesystem behind an SFTP subsystem. */
type Node = { dir: true; mtime: number } | { dir: false; data: Buffer; mtime: number };
const files = new Map<string, Node>();
const reset = () => {
  files.clear();
  files.set('/', { dir: true, mtime: 0 });
  files.set('/home', { dir: true, mtime: 0 });
  files.set('/home/alice', { dir: true, mtime: 0 });
  files.set('/home/alice/notes.txt', { dir: false, data: Buffer.from('hello sftp'), mtime: 1_700_000_000 });
};
const attrsOf = (n: Node): Attributes => ({
  mode: n.dir ? 0o040755 : 0o100644,
  uid: 0,
  gid: 0,
  size: n.dir ? 0 : n.data.length,
  atime: n.mtime,
  mtime: n.mtime,
});
const norm = (p: string) => path.posix.resolve('/home/alice', p);

let server: Server;
let port: number;

beforeAll(async () => {
  reset();
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client
      .on('authentication', (ctx) => (ctx.method === 'password' ? ctx.accept() : ctx.reject(['password'])))
      .on('ready', () =>
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (a) => a?.());
          session.on('shell', (a) => a().write('$ '));
          session.on('sftp', (a) => {
            const sftp = a();
            const handles = new Map<string, { path: string; listed?: boolean }>();
            let h = 0;
            const handle = (p: string) => {
              const id = Buffer.from(String(++h));
              handles.set(id.toString(), { path: p });
              return id;
            };
            const node = (p: string) => files.get(norm(p));
            sftp
              .on('REALPATH', (id, p) => sftp.name(id, [{ filename: norm(p), longname: '', attrs: {} as Attributes }]))
              .on('STAT', (id, p) => (node(p) ? sftp.attrs(id, attrsOf(node(p)!)) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)))
              .on('LSTAT', (id, p) => (node(p) ? sftp.attrs(id, attrsOf(node(p)!)) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)))
              .on('OPENDIR', (id, p) => (node(p)?.dir ? sftp.handle(id, handle(norm(p))) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)))
              .on('READDIR', (id, hd) => {
                const st = handles.get(hd.toString())!;
                if (st.listed) return sftp.status(id, STATUS_CODE.EOF);
                st.listed = true;
                const prefix = st.path === '/' ? '/' : `${st.path}/`;
                const names = [...files.entries()]
                  .filter(([p]) => p !== st.path && p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
                  .map(([p, n]) => ({ filename: p.slice(prefix.length), longname: '', attrs: attrsOf(n) }));
                sftp.name(id, names);
              })
              .on('OPEN', (id, p, flags) => {
                const full = norm(p);
                if (flags & OPEN_MODE.WRITE) files.set(full, { dir: false, data: Buffer.alloc(0), mtime: 1 });
                else if (!files.get(full) || files.get(full)!.dir) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
                sftp.handle(id, handle(full));
              })
              .on('READ', (id, hd, offset, len) => {
                const n = files.get(handles.get(hd.toString())!.path) as { data: Buffer };
                if (offset >= n.data.length) return sftp.status(id, STATUS_CODE.EOF);
                sftp.data(id, n.data.subarray(offset, offset + len));
              })
              .on('WRITE', (id, hd, offset, data) => {
                const n = files.get(handles.get(hd.toString())!.path) as { data: Buffer };
                const buf = Buffer.alloc(Math.max(n.data.length, offset + data.length));
                n.data.copy(buf);
                data.copy(buf, offset);
                n.data = buf;
                sftp.status(id, STATUS_CODE.OK);
              })
              .on('FSTAT', (id, hd) => sftp.attrs(id, attrsOf(files.get(handles.get(hd.toString())!.path)!)))
              .on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK))
              .on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK))
              .on('CLOSE', (id, hd) => {
                handles.delete(hd.toString());
                sftp.status(id, STATUS_CODE.OK);
              })
              .on('MKDIR', (id, p) => {
                if (files.has(norm(p))) return sftp.status(id, STATUS_CODE.FAILURE);
                files.set(norm(p), { dir: true, mtime: 1 });
                sftp.status(id, STATUS_CODE.OK);
              })
              .on('RMDIR', (id, p) => sftp.status(id, files.delete(norm(p)) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE))
              .on('REMOVE', (id, p) => sftp.status(id, files.delete(norm(p)) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE))
              .on('RENAME', (id, from, to) => {
                const n = files.get(norm(from));
                if (!n) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
                files.delete(norm(from));
                files.set(norm(to), n);
                sftp.status(id, STATUS_CODE.OK);
              });
          });
        }),
      )
      .on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connect() {
  const progress: TransferProgress[] = [];
  let connected!: () => void;
  const ready = new Promise<void>((r) => (connected = r));
  const sessions = new SessionManager({
    onData: () => undefined,
    onStatus: (_sid, status) => status === 'connected' && connected(),
    verifyHostKey: async () => true,
  });
  const sid = sessions.open(
    { id: 'c', updatedAt: 0, name: 't', host: '127.0.0.1', port, username: 'alice', password: 'pw' },
    undefined,
    80,
    24,
  );
  await ready;
  const sftp = new SftpManager((id) => sessions.getClient(id), (p) => progress.push(p));
  return { sessions, sid, sftp, progress };
}

describe('SftpManager', () => {
  it('lists, creates, renames and deletes', async () => {
    reset();
    const { sessions, sid, sftp } = await connect();
    const home = await sftp.list(sid, '.');
    expect(home.path).toBe('/home/alice');
    expect(home.entries).toEqual([
      expect.objectContaining({ name: 'notes.txt', type: 'file', size: 10, mtime: 1_700_000_000_000, mode: 0o644 }),
    ]);

    await sftp.mkdir(sid, '/home/alice/logs');
    await sftp.rename(sid, '/home/alice/notes.txt', '/home/alice/logs/notes.txt');
    const listed = await sftp.list(sid, '/home/alice');
    expect(listed.entries.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:logs']);

    await sftp.remove(sid, '/home/alice/logs'); // folder with a file in it
    expect((await sftp.list(sid, '/home/alice')).entries).toEqual([]);
    await expect(sftp.list(sid, '/nope')).rejects.toThrow(/not found/);
    sessions.closeAll();
  }, 30_000); // ssh2 without its optional native crypto add-on (like the packaged app) is slower

  it('uploads and downloads files and folders with progress', async () => {
    reset();
    const { sessions, sid, sftp, progress } = await connect();
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tt-sftp-'));
    try {
      const big = Buffer.alloc(300_000, 7);
      await fs.promises.mkdir(path.join(tmp, 'site', 'css'), { recursive: true });
      await fs.promises.writeFile(path.join(tmp, 'site', 'index.html'), '<h1>hi</h1>');
      await fs.promises.writeFile(path.join(tmp, 'site', 'css', 'big.css'), big);

      await sftp.upload(sid, [path.join(tmp, 'site')], '/home/alice');
      expect((files.get('/home/alice/site/css/big.css') as { data: Buffer }).data.equals(big)).toBe(true);
      const up = progress.filter((p) => p.direction === 'up');
      expect(up.at(-1)).toMatchObject({ name: 'site', state: 'done', done: big.length + 11, total: big.length + 11 });

      const out = path.join(tmp, 'out');
      await fs.promises.mkdir(out);
      await sftp.download(sid, ['/home/alice/site', '/home/alice/notes.txt'], out);
      expect(await fs.promises.readFile(path.join(out, 'site', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
      expect((await fs.promises.readFile(path.join(out, 'site', 'css', 'big.css'))).equals(big)).toBe(true);
      expect(await fs.promises.readFile(path.join(out, 'notes.txt'), 'utf8')).toBe('hello sftp');
    } finally {
      sessions.closeAll();
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  }, 30_000); // ssh2 without its optional native crypto add-on (like the packaged app) is slower

  it('fails cleanly when the session is gone', async () => {
    const sftp = new SftpManager(() => undefined, () => undefined);
    await expect(sftp.list('nope', '.')).rejects.toThrow(/Not connected/);
  });
});
