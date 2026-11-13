import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, emptyVault, type VaultData } from '../shared/types';

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

/** On-disk format. This blob is also what a sync server will store (it never sees plaintext). */
export interface EncryptedVault {
  version: 1;
  kdf: 'scrypt';
  kdfParams: KdfParams;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong master password');
  }
}

/** A blob was encrypted with a different master password (changed on another device). */
export class PasswordChangedError extends Error {
  constructor() {
    super('The master password was changed on another device');
  }
}

/** Rough check: long passphrases or mixed character classes. Kept in memory only. */
export function isWeakPassword(pw: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  return !(pw.length >= 16 || (pw.length >= 12 && classes >= 3));
}

interface KeyMaterial {
  key: Buffer;
  salt: Buffer;
  kdfParams: KdfParams;
}

const sameKdf = (a: KdfParams, b: KdfParams) => a.N === b.N && a.r === b.r && a.p === b.p;

function deriveKey(password: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      32,
      { ...params, maxmem: 256 * params.N * params.r },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function encryptWithKey(data: VaultData, key: Buffer, salt: Buffer, kdfParams: KdfParams): EncryptedVault {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return {
    version: 1,
    kdf: 'scrypt',
    kdfParams,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptWithKey(blob: EncryptedVault, key: Buffer): VaultData {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw new WrongPasswordError();
  }
  const data = JSON.parse(plain.toString('utf8')) as Partial<VaultData>;
  // Fill in fields added in later versions.
  return {
    ...emptyVault(),
    ...data,
    settings: { ...DEFAULT_SETTINGS, ...data.settings },
  };
}

export async function encryptVault(data: VaultData, password: string, kdfParams = DEFAULT_KDF): Promise<EncryptedVault> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, kdfParams);
  return encryptWithKey(data, key, salt, kdfParams);
}

export async function decryptVault(blob: EncryptedVault, password: string): Promise<VaultData> {
  if (blob.version !== 1 || blob.kdf !== 'scrypt') throw new Error('Unsupported vault format');
  const key = await deriveKey(password, Buffer.from(blob.salt, 'base64'), blob.kdfParams);
  return decryptWithKey(blob, key);
}

/**
 * Holds the decrypted vault in memory while unlocked. The derived key is kept
 * (not the password) so saves don't need to re-run scrypt.
 */
export class Vault {
  private data: VaultData | null = null;
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  private kdfParams: KdfParams = DEFAULT_KDF;
  /** Keys replaced during this session (password change), so older remote copies can still be read. */
  private retired: KeyMaterial[] = [];
  /** Called after every non-silent update (used to trigger sync). */
  onChange: (() => void) | null = null;
  passwordWeak = false;

  constructor(
    private readonly filePath: string,
    private readonly newKdfParams: KdfParams = DEFAULT_KDF,
  ) {}

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  get isUnlocked(): boolean {
    return this.data !== null;
  }

  get(): VaultData {
    if (!this.data) throw new Error('Vault is locked');
    return this.data;
  }

  async create(password: string): Promise<void> {
    if (await this.exists()) throw new Error('Vault already exists');
    if (password.length < 8) throw new Error('Master password must be at least 8 characters');
    this.salt = randomBytes(16);
    this.kdfParams = this.newKdfParams;
    this.key = await deriveKey(password, this.salt, this.kdfParams);
    this.data = emptyVault();
    this.passwordWeak = isWeakPassword(password);
    await this.save();
  }

  /** Create the local vault from a downloaded blob (restore on a new device). */
  async restore(blob: EncryptedVault, password: string, patch?: (d: VaultData) => void): Promise<void> {
    if (await this.exists()) throw new Error('A vault already exists on this device');
    const salt = Buffer.from(blob.salt, 'base64');
    const key = await deriveKey(password, salt, blob.kdfParams);
    const data = decryptWithKey(blob, key);
    patch?.(data);
    this.data = data;
    this.key = key;
    this.salt = salt;
    this.kdfParams = blob.kdfParams;
    this.passwordWeak = isWeakPassword(password);
    await this.save();
  }

  async unlock(password: string): Promise<void> {
    const blob = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as EncryptedVault;
    const salt = Buffer.from(blob.salt, 'base64');
    const key = await deriveKey(password, salt, blob.kdfParams);
    this.data = decryptWithKey(blob, key);
    this.key = key;
    this.salt = salt;
    this.kdfParams = blob.kdfParams;
    this.passwordWeak = isWeakPassword(password);
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (!this.key || !this.salt) return false;
    const key = await deriveKey(password, this.salt, this.kdfParams);
    return timingSafeEqual(key, this.key);
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!(await this.verifyPassword(oldPassword))) throw new WrongPasswordError();
    if (newPassword.length < 8) throw new Error('Master password must be at least 8 characters');
    if (this.key && this.salt) this.retired.push({ key: this.key, salt: this.salt, kdfParams: this.kdfParams });
    this.salt = randomBytes(16);
    this.kdfParams = this.newKdfParams;
    this.key = await deriveKey(newPassword, this.salt, this.kdfParams);
    this.passwordWeak = isWeakPassword(newPassword);
    await this.save();
    this.onChange?.();
  }

  /** Encrypted copy of the current data (for uploading). */
  exportBlob(): EncryptedVault {
    if (!this.data || !this.key || !this.salt) throw new Error('Vault is locked');
    return encryptWithKey(this.data, this.key, this.salt, this.kdfParams);
  }

  /** True if the blob was encrypted with the current master password. */
  usesCurrentKey(blob: EncryptedVault): boolean {
    return !!this.salt && blob.salt === this.salt.toString('base64') && sameKdf(blob.kdfParams, this.kdfParams);
  }

  /** Decrypt a blob with the current (or a retired) key; throws PasswordChangedError if neither fits. */
  decryptBlob(blob: EncryptedVault): VaultData {
    const candidates = [
      ...(this.key && this.salt ? [{ key: this.key, salt: this.salt, kdfParams: this.kdfParams }] : []),
      ...this.retired,
    ];
    for (const c of candidates) {
      if (blob.salt === c.salt.toString('base64') && sameKdf(blob.kdfParams, c.kdfParams)) {
        return decryptWithKey(blob, c.key);
      }
    }
    throw new PasswordChangedError();
  }

  /**
   * Switch to the master password of a blob from another device: verifies `password` against it,
   * adopts its key, and returns its data. The caller saves afterwards.
   */
  async adoptKeyOf(blob: EncryptedVault, password: string): Promise<VaultData> {
    const salt = Buffer.from(blob.salt, 'base64');
    const key = await deriveKey(password, salt, blob.kdfParams);
    const data = decryptWithKey(blob, key);
    if (this.key && this.salt) this.retired.push({ key: this.key, salt: this.salt, kdfParams: this.kdfParams });
    this.key = key;
    this.salt = salt;
    this.kdfParams = blob.kdfParams;
    this.passwordWeak = isWeakPassword(password);
    return data;
  }

  lock(): void {
    this.key?.fill(0);
    for (const r of this.retired) r.key.fill(0);
    this.retired = [];
    this.data = null;
    this.key = null;
    this.salt = null;
  }

  /** Apply a mutation and persist atomically. `silent` skips onChange (used by sync itself). */
  async update(mutate: (data: VaultData) => void, opts: { silent?: boolean } = {}): Promise<void> {
    const data = this.get();
    mutate(data);
    data.updatedAt = Date.now();
    await this.save();
    if (!opts.silent) this.onChange?.();
  }

  private async save(): Promise<void> {
    if (!this.data || !this.key || !this.salt) throw new Error('Vault is locked');
    const blob = encryptWithKey(this.data, this.key, this.salt, this.kdfParams);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(blob, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}
