import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, utils } from 'ssh2';
import type { Connection, EndReason, KeyEntry, SessionInfo, SessionStatus } from '../shared/types';
import { keyFingerprint, SessionManager } from './sessions';

const hostKey = utils.generateKeyPairSync('ed25519');
const userKey = utils.generateKeyPairSync('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr', rounds: 4 });
const authorizedKey = utils.parseKey(userKey.public);

let server: Server;
let port: number;

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client
      .on('authentication', (ctx) => {
        if (ctx.method === 'publickey' && ctx.username === 'alice' && !(authorizedKey instanceof Error)) {
          const k = Array.isArray(authorizedKey) ? authorizedKey[0] : authorizedKey;
          if (ctx.key.algo === k.type && ctx.key.data.equals(k.getPublicSSH())) {
            if (!ctx.signature) return ctx.accept(); // key probe
            if (ctx.blob && k.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
          }
        }
        if (ctx.method === 'password' && ctx.username === 'bob' && ctx.password === 'hunter22') return ctx.accept();
        ctx.reject(['publickey', 'password']);
      })
      .on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('pty', (acc) => acc?.());
          session.on('window-change', (acc) => acc?.());
          session.on('exec', (acc, _rej, info) => {
            const stream = acc();
            if (info.command !== 'sh -s') {
              stream.exit(127);
              return stream.end();
            }
            stream.on('data', () => undefined);
            stream.on('end', () => {
              stream.write('OS=Test Linux\nLOAD=0.50\nCORES=2\nMEMTOTAL=2048\nMEMAVAIL=1024\n');
              stream.exit(0);
              stream.end();
            });
          });
          session.on('shell', (acc) => {
            const stream = acc();
            stream.write('welcome\r\n');
            // Echo input upper-cased; "exit" closes.
            stream.on('data', (d: Buffer) => {
              const s = d.toString();
              if (s.trim() === 'exit') {
                stream.exit(0);
                stream.end();
              } else if (s.trim() === 'drop') {
                client.end(); // the server goes away without the shell exiting
              } else stream.write(s.toUpperCase());
            });
          });
        });
      })
      .on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function harness(trust = true) {
  const events: { sid: string; status: SessionStatus; message?: string; reason?: EndReason }[] = [];
  const output = new Map<string, string>();
  const fingerprints: string[] = [];
  const infos: SessionInfo[] = [];
  const mgr = new SessionManager({
    onInfo: (_sid, info) => infos.push(info),
    onData: (sid, d) => output.set(sid, (output.get(sid) ?? '') + Buffer.from(d).toString()),
    onStatus: (sid, status, message, reason) => events.push({ sid, status, message, reason }),
    verifyHostKey: async (_hp, fp) => {
      fingerprints.push(fp);
      return trust;
    },
  });
  const waitFor = (pred: () => boolean, ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => (pred() ? resolve() : Date.now() - t0 > ms ? reject(new Error('timeout')) : setTimeout(tick, 20));
      tick();
    });
  return { mgr, events, output, fingerprints, infos, waitFor };
}

const conn = (over: Partial<Connection>): Connection => ({
  id: 'c',
  updatedAt: 0,
  name: 'test',
  host: '127.0.0.1',
  port,
  username: 'alice',
  ...over,
});
const key: KeyEntry = { id: 'k', updatedAt: 0, name: 'k', pem: userKey.private, passphrase: 'secret' };

describe('SessionManager', () => {
  it('logs in with an encrypted private key and relays shell I/O', async () => {
    const h = harness();
    const sid = h.mgr.open(conn({}), key, 80, 24);
    await h.waitFor(() => (h.output.get(sid) ?? '').includes('welcome'));
    expect(h.fingerprints[0]).toMatch(/^SHA256:/);
    h.mgr.write(sid, 'hello');
    await h.waitFor(() => (h.output.get(sid) ?? '').includes('HELLO'));
    h.mgr.resize(sid, 120, 40);
    h.mgr.write(sid, 'exit');
    await h.waitFor(() => h.events.some((e) => e.sid === sid && e.status === 'closed'));
    expect(h.events.filter((e) => e.sid === sid).map((e) => e.status)).toEqual(['connecting', 'connected', 'closed']);
    expect(h.events.at(-1)).toMatchObject({ reason: 'exit', message: 'Session ended' });
  });

  it('tells a lost connection apart from closing the tab', async () => {
    const h = harness();
    const lost = h.mgr.open(conn({}), key, 80, 24);
    await h.waitFor(() => (h.output.get(lost) ?? '').includes('welcome'));
    expect(h.mgr.getClient(lost)).toBeDefined();
    h.mgr.write(lost, 'drop');
    await h.waitFor(() => h.events.some((e) => e.sid === lost && (e.status === 'closed' || e.status === 'error')));
    expect(h.events.find((e) => e.sid === lost && e.reason)!.reason).toBe('lost');
    expect(h.mgr.getClient(lost)).toBeUndefined();

    const user = h.mgr.open(conn({}), key, 80, 24);
    await h.waitFor(() => (h.output.get(user) ?? '').includes('welcome'));
    h.mgr.close(user);
    await h.waitFor(() => h.events.some((e) => e.sid === user && e.status === 'closed'));
    expect(h.events.find((e) => e.sid === user && e.reason)!.reason).toBe('user');
  });

  it('logs in with a password', async () => {
    const h = harness();
    const sid = h.mgr.open(conn({ username: 'bob', password: 'hunter22' }), undefined, 80, 24);
    await h.waitFor(() => (h.output.get(sid) ?? '').includes('welcome'));
    h.mgr.close(sid);
  });

  it('aborts when the host key is not trusted', async () => {
    const h = harness(false);
    const sid = h.mgr.open(conn({}), key, 80, 24);
    await h.waitFor(() => h.events.some((e) => e.sid === sid && e.status === 'error'));
    expect(h.output.get(sid)).toBeUndefined();
    expect(h.events.find((e) => e.status === 'error')!.reason).toBe('hostkey');
  });

  it('reports a wrong key passphrase as an error', async () => {
    const h = harness();
    const sid = h.mgr.open(conn({}), { ...key, passphrase: 'wrong' }, 80, 24);
    await h.waitFor(() => h.events.some((e) => e.sid === sid && e.status === 'error'));
  });

  it('explains which key was rejected', async () => {
    const h = harness();
    const other = utils.generateKeyPairSync('ed25519');
    const sid = h.mgr.open(conn({}), { id: 'x', updatedAt: 0, name: 'laptop', pem: other.private }, 80, 24);
    await h.waitFor(() => h.events.some((e) => e.sid === sid && e.status === 'error'));
    const msg = h.events.find((e) => e.status === 'error')!.message!;
    expect(msg).toContain('alice@127.0.0.1 rejected key "laptop"');
    expect(msg).toContain(keyFingerprint(other.private)!.fingerprint);
    expect(h.events.find((e) => e.status === 'error')!.reason).toBe('auth');
  });

  it('explains when no key is selected', async () => {
    const h = harness();
    const sid = h.mgr.open(conn({}), undefined, 80, 24);
    await h.waitFor(() => h.events.some((e) => e.sid === sid && e.status === 'error'));
    expect(h.events.find((e) => e.status === 'error')!.message).toMatch(/No private key or password is set/);
  });

  it('reports latency, server stats and traffic for the watched session', async () => {
    const h = harness();
    const sid = h.mgr.open(conn({}), key, 80, 24);
    await h.waitFor(() => (h.output.get(sid) ?? '').includes('welcome'));
    h.mgr.write(sid, 'abc');
    await h.waitFor(() => (h.output.get(sid) ?? '').includes('ABC'));
    h.mgr.watch(sid);
    await h.waitFor(() => h.infos.some((i) => i.latencyMs !== undefined && !!i.server));
    const last = h.infos[h.infos.length - 1];
    expect(last.server).toMatchObject({ os: 'Test Linux', load1: 0.5, cores: 2, memTotal: 2048 * 1024, memUsed: 1024 * 1024 });
    expect(last.bytesOut).toBe(3);
    expect(last.bytesIn).toBeGreaterThan(0);
    expect(last.latencyMs).toBeGreaterThanOrEqual(0);
    // The shell still works after the stats command ran on its own channel.
    h.mgr.write(sid, 'xyz');
    await h.waitFor(() => (h.output.get(sid) ?? '').includes('XYZ'));
    h.mgr.watch(null);
    h.mgr.close(sid);
  });
});
