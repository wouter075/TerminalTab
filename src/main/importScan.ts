import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utils } from 'ssh2';
import type { Connection, ImportCandidate, KeyEntry, VaultData } from '../shared/types';
import { DEFAULT_IDENTITY_FILES, parsePuttyRegistry, parseSshConfig, type FoundHost } from './importers';
import { keyFingerprint } from './sessions';

const MAX_KEY_BYTES = 64 * 1024;

interface KeyFile {
  pem?: string;
  problem?: string;
  encrypted?: boolean;
  /** Fingerprint, when readable without a passphrase. */
  fingerprint?: string;
}

export interface ScanResult {
  candidates: ImportCandidate[];
  /** Key file contents by path, kept in the main process only. */
  keyFiles: Map<string, KeyFile>;
}

const fsReader = {
  readFile(file: string): string | null {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  listDir(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
};

function readPutty(localUser: string): Promise<FoundHost[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions', '/s'],
      { windowsHide: true, timeout: 10_000 },
      (err, stdout) => resolve(err ? [] : parsePuttyRegistry(stdout, localUser)),
    );
  });
}

function readKeyFile(file: string): KeyFile {
  let pem: string;
  try {
    if (fs.statSync(file).size > MAX_KEY_BYTES) return { problem: 'Key file is too large' };
    pem = fs.readFileSync(file, 'utf8');
  } catch {
    return { problem: `Key file not found: ${file}` };
  }
  const parsed = utils.parseKey(pem);
  if (parsed instanceof Error) {
    if (/encrypted|passphrase/i.test(parsed.message)) return { pem, encrypted: true };
    return { problem: `Unsupported key format (${parsed.message})` };
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key.isPrivateKey()) return { problem: 'That is a public key, not a private key' };
  const fp = keyFingerprint(pem);
  return { pem, fingerprint: fp?.fingerprint };
}

/** Find servers in ~/.ssh/config and PuTTY, and check their key files. */
export async function scanImports(vault: VaultData): Promise<ScanResult> {
  const home = os.homedir();
  const localUser = os.userInfo().username;
  const sshDir = path.join(home, '.ssh');
  const found: FoundHost[] = [
    ...parseSshConfig(path.join(sshDir, 'config'), home, localUser, fsReader),
    ...(await readPutty(localUser)),
  ];

  // Without an IdentityFile, ssh tries its default keys; offer the first one that exists.
  const defaultKey = DEFAULT_IDENTITY_FILES.map((f) => path.join(sshDir, f)).find((f) => fs.existsSync(f));

  const existingFps = new Map<string, string>();
  for (const k of vault.keys) {
    const fp = keyFingerprint(k.pem, k.passphrase);
    if (fp) existingFps.set(fp.fingerprint, k.name);
  }

  const keyFiles = new Map<string, KeyFile>();
  const candidates: ImportCandidate[] = found.map((h) => {
    const keyPath = h.identityFile ?? (h.source === 'ssh-config' ? defaultKey : undefined);
    let kf: KeyFile | undefined;
    if (keyPath) {
      kf = keyFiles.get(keyPath) ?? readKeyFile(keyPath);
      keyFiles.set(keyPath, kf);
    }
    return {
      id: `${h.source}:${h.name}`,
      source: h.source,
      name: h.name,
      host: h.host,
      port: h.port,
      username: h.username,
      keyPath,
      keyProblem: kf?.problem,
      keyEncrypted: kf?.encrypted,
      keyExisting: kf?.fingerprint ? existingFps.get(kf.fingerprint) : undefined,
      exists: vault.connections.some(
        (c) => c.host.toLowerCase() === h.host.toLowerCase() && c.port === h.port && c.username === h.username,
      ),
      note: h.note,
    };
  });
  return { candidates, keyFiles };
}

const GROUP: Record<ImportCandidate['source'], string> = { 'ssh-config': 'SSH config', putty: 'PuTTY' };

/**
 * Turn the chosen candidates into connections (and keys) inside `d`.
 * `passphrases` is keyed by key path. Throws if a passphrase is missing or wrong.
 */
export function applyImports(
  d: VaultData,
  scan: ScanResult,
  ids: string[],
  passphrases: Record<string, string>,
): { connections: number; keys: number } {
  const chosen = scan.candidates.filter((c) => ids.includes(c.id));
  const now = Date.now();

  // Map fingerprint -> existing key id, so identical keys are reused.
  const byFp = new Map<string, string>();
  for (const k of d.keys) {
    const fp = keyFingerprint(k.pem, k.passphrase);
    if (fp) byFp.set(fp.fingerprint, k.id);
  }

  const keyIdByPath = new Map<string, string>();
  const newKeys: KeyEntry[] = [];
  const resolveKey = (keyPath: string): string | undefined => {
    if (keyIdByPath.has(keyPath)) return keyIdByPath.get(keyPath);
    const kf = scan.keyFiles.get(keyPath);
    if (!kf?.pem) return undefined;
    const passphrase = kf.encrypted ? passphrases[keyPath] : undefined;
    if (kf.encrypted && !passphrase) throw new Error(`Enter the passphrase for ${path.basename(keyPath)}`);
    const fp = keyFingerprint(kf.pem, passphrase);
    if (!fp) throw new Error(`Wrong passphrase for ${path.basename(keyPath)}`);
    let id = byFp.get(fp.fingerprint);
    if (!id) {
      id = randomUUID();
      newKeys.push({ id, updatedAt: now, name: path.basename(keyPath), pem: kf.pem, passphrase });
      byFp.set(fp.fingerprint, id);
    }
    keyIdByPath.set(keyPath, id);
    return id;
  };

  const conns: Connection[] = chosen.map((c) => ({
    id: randomUUID(),
    updatedAt: now,
    name: c.name,
    host: c.host,
    port: c.port,
    username: c.username,
    keyId: c.keyPath && !c.keyProblem ? resolveKey(c.keyPath) : undefined,
    group: GROUP[c.source],
  }));

  d.keys.push(...newKeys);
  d.connections.push(...conns);
  return { connections: conns.length, keys: newKeys.length };
}
