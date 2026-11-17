import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Client, SFTPWrapper, Stats } from 'ssh2';
import type { RemoteEntry, TransferProgress } from '../shared/types';

const rpath = path.posix;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const PROGRESS_MS = 150;

function typeOf(mode: number): RemoteEntry['type'] {
  const t = mode & S_IFMT;
  if (t === S_IFDIR) return 'dir';
  if (t === S_IFLNK) return 'link';
  if (t === S_IFREG) return 'file';
  return 'other';
}

const promisify =
  <T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void) =>
  () =>
    new Promise<T>((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

/** SFTP's numeric error codes as readable text. */
function sftpError(err: unknown, what: string): Error {
  const e = err as Error & { code?: number };
  const reason =
    e.code === 2 ? 'not found' : e.code === 3 ? 'permission denied' : e.code === 4 ? 'failed' : e.message || 'failed';
  return new Error(`${what}: ${reason}`);
}

interface Transfer {
  progress: TransferProgress;
  cancel(): void;
}

/** SFTP over the SSH connection of an open tab (one SFTP channel per session, opened on first use). */
export class SftpManager {
  private channels = new Map<string, Promise<SFTPWrapper>>();
  private transfers = new Map<string, Transfer>();

  constructor(
    private readonly getClient: (sessionId: string) => Client | undefined,
    private readonly onProgress: (p: TransferProgress) => void,
  ) {}

  private sftp(sessionId: string): Promise<SFTPWrapper> {
    let ch = this.channels.get(sessionId);
    if (!ch) {
      const client = this.getClient(sessionId);
      if (!client) return Promise.reject(new Error('Not connected'));
      ch = new Promise<SFTPWrapper>((resolve, reject) =>
        client.sftp((err, sftp) => {
          if (err) return reject(new Error(`SFTP is not available on this server (${err.message})`));
          sftp.on('close', () => this.channels.delete(sessionId));
          resolve(sftp);
        }),
      );
      ch.catch(() => this.channels.delete(sessionId));
      this.channels.set(sessionId, ch);
    }
    return ch;
  }

  /** Forget the session's channel and cancel its transfers (the session ended). */
  drop(sessionId: string): void {
    this.channels.get(sessionId)?.then((s) => s.end(), () => undefined);
    this.channels.delete(sessionId);
    for (const t of this.transfers.values()) if (t.progress.sessionId === sessionId) t.cancel();
  }

  async realpath(sessionId: string, p: string): Promise<string> {
    const sftp = await this.sftp(sessionId);
    try {
      return await promisify<string>((cb) => sftp.realpath(p, cb))();
    } catch (err) {
      throw sftpError(err, p);
    }
  }

  /** List a directory; folders first, then by name. */
  async list(sessionId: string, dir: string): Promise<{ path: string; entries: RemoteEntry[] }> {
    const sftp = await this.sftp(sessionId);
    const real = await this.realpath(sessionId, dir || '.');
    let raw: { filename: string; attrs: Stats }[];
    try {
      raw = await promisify<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(real, cb))();
    } catch (err) {
      throw sftpError(err, real);
    }
    const entries = raw
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map(
        (e): RemoteEntry => ({
          name: e.filename,
          type: typeOf(e.attrs.mode),
          size: e.attrs.size,
          mtime: e.attrs.mtime * 1000,
          mode: e.attrs.mode & 0o7777,
        }),
      );
    // Show symlinks to folders as folders.
    await Promise.all(
      entries
        .filter((e) => e.type === 'link')
        .map(async (e) => {
          try {
            const st = await promisify<Stats>((cb) => sftp.stat(rpath.join(real, e.name), cb))();
            if (typeOf(st.mode) === 'dir') e.type = 'dir';
            else e.size = st.size;
          } catch {
            /* dangling link */
          }
        }),
    );
    entries.sort((a, b) =>
      a.type === 'dir' && b.type !== 'dir' ? -1 : b.type === 'dir' && a.type !== 'dir' ? 1 : a.name.localeCompare(b.name),
    );
    return { path: real, entries };
  }

  async mkdir(sessionId: string, p: string): Promise<void> {
    const sftp = await this.sftp(sessionId);
    await promisify<void>((cb) => sftp.mkdir(p, (err) => cb(err, undefined)))().catch((err) => {
      throw sftpError(err, `Create ${rpath.basename(p)}`);
    });
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.sftp(sessionId);
    await promisify<void>((cb) => sftp.rename(from, to, (err) => cb(err, undefined)))().catch((err) => {
      throw sftpError(err, `Rename ${rpath.basename(from)}`);
    });
  }

  /** Delete a file, or a folder with everything in it. */
  async remove(sessionId: string, p: string): Promise<void> {
    const sftp = await this.sftp(sessionId);
    const st = await promisify<Stats>((cb) => sftp.lstat(p, cb))().catch((err) => {
      throw sftpError(err, p);
    });
    if (typeOf(st.mode) === 'dir') {
      const { entries } = await this.list(sessionId, p);
      for (const e of entries) await this.remove(sessionId, rpath.join(p, e.name));
      await promisify<void>((cb) => sftp.rmdir(p, (err) => cb(err, undefined)))().catch((err) => {
        throw sftpError(err, `Delete ${rpath.basename(p)}`);
      });
    } else {
      await promisify<void>((cb) => sftp.unlink(p, (err) => cb(err, undefined)))().catch((err) => {
        throw sftpError(err, `Delete ${rpath.basename(p)}`);
      });
    }
  }

  cancel(id: string): void {
    this.transfers.get(id)?.cancel();
  }

  /** Upload local files/folders into `remoteDir`. Resolves when all are done; progress is reported as it goes. */
  async upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<void> {
    const sftp = await this.sftp(sessionId);
    for (const local of localPaths) {
      const name = path.basename(local);
      const files = await walkLocal(local);
      const total = files.reduce((n, f) => n + f.size, 0);
      await this.run(sessionId, 'up', name, total, async (count, signal) => {
        for (const f of files) {
          const target = rpath.join(remoteDir, name, ...f.rel.split(path.sep).filter(Boolean));
          if (f.dir) {
            await promisify<void>((cb) => sftp.mkdir(target, () => cb(null, undefined)))();
            continue;
          }
          await pipeline(fs.createReadStream(f.abs), count(), sftp.createWriteStream(target), { signal });
        }
      });
    }
  }

  /** Download remote files/folders into the local folder `localDir` (`saveAs` renames a single item). */
  async download(sessionId: string, remotePaths: string[], localDir: string, saveAs?: string): Promise<void> {
    const sftp = await this.sftp(sessionId);
    for (const remote of remotePaths) {
      const name = saveAs && remotePaths.length === 1 ? saveAs : rpath.basename(remote);
      const files = await this.walkRemote(sftp, remote);
      const total = files.reduce((n, f) => n + f.size, 0);
      await this.run(sessionId, 'down', name, total, async (count, signal) => {
        for (const f of files) {
          const target = path.join(localDir, name, ...f.rel.split('/').filter(Boolean));
          if (f.dir) {
            await fs.promises.mkdir(target, { recursive: true });
            continue;
          }
          await pipeline(sftp.createReadStream(f.abs), count(), fs.createWriteStream(target), { signal });
        }
      });
    }
  }

  private async run(
    sessionId: string,
    direction: 'up' | 'down',
    name: string,
    total: number,
    body: (count: () => Transform, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const abort = new AbortController();
    const progress: TransferProgress = { id: randomUUID(), sessionId, direction, name, done: 0, total, state: 'running' };
    this.transfers.set(progress.id, { progress, cancel: () => abort.abort() });
    let last = 0;
    const emit = (force = false) => {
      const now = Date.now();
      if (force || now - last >= PROGRESS_MS) {
        last = now;
        this.onProgress({ ...progress });
      }
    };
    emit(true);
    const count = () =>
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          progress.done += chunk.length;
          emit();
          cb(null, chunk);
        },
      });
    try {
      await body(count, abort.signal);
      progress.state = 'done';
    } catch (err) {
      progress.state = abort.signal.aborted ? 'cancelled' : 'error';
      progress.error = abort.signal.aborted ? undefined : (err as Error).message;
      if (!abort.signal.aborted) throw err;
    } finally {
      emit(true);
      this.transfers.delete(progress.id);
    }
  }

  private async walkRemote(sftp: SFTPWrapper, root: string): Promise<WalkEntry[]> {
    const st = await promisify<Stats>((cb) => sftp.stat(root, cb))().catch((err) => {
      throw sftpError(err, root);
    });
    if (typeOf(st.mode) !== 'dir') return [{ abs: root, rel: '', dir: false, size: st.size }];
    const out: WalkEntry[] = [{ abs: root, rel: '', dir: true, size: 0 }];
    const walk = async (abs: string, rel: string) => {
      const list = await promisify<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(abs, cb))();
      for (const e of list) {
        if (e.filename === '.' || e.filename === '..') continue;
        const t = typeOf(e.attrs.mode);
        const childAbs = rpath.join(abs, e.filename);
        const childRel = rel ? `${rel}/${e.filename}` : e.filename;
        if (t === 'dir') {
          out.push({ abs: childAbs, rel: childRel, dir: true, size: 0 });
          await walk(childAbs, childRel);
        } else if (t === 'file') out.push({ abs: childAbs, rel: childRel, dir: false, size: e.attrs.size });
      }
    };
    await walk(root, '');
    return out;
  }
}

interface WalkEntry {
  abs: string;
  /** Path relative to the top item ('' for the item itself). */
  rel: string;
  dir: boolean;
  size: number;
}

async function walkLocal(root: string): Promise<WalkEntry[]> {
  const st = await fs.promises.stat(root);
  if (!st.isDirectory()) return [{ abs: root, rel: '', dir: false, size: st.size }];
  const out: WalkEntry[] = [{ abs: root, rel: '', dir: true, size: 0 }];
  const walk = async (abs: string, rel: string) => {
    for (const e of await fs.promises.readdir(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        out.push({ abs: childAbs, rel: childRel, dir: true, size: 0 });
        await walk(childAbs, childRel);
      } else if (e.isFile()) {
        out.push({ abs: childAbs, rel: childRel, dir: false, size: (await fs.promises.stat(childAbs)).size });
      }
    }
  };
  await walk(root, '');
  return out;
}
