import type { EncryptedVault } from './vault';

/** File in the repository that holds the encrypted vault. */
export const VAULT_PATH = 'terminaltab-vault.json';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Where the encrypted vault is stored remotely (GitHub in the app, a fake in tests). */
export interface RemoteStore {
  /** null when the file doesn't exist yet. */
  get(): Promise<{ blob: EncryptedVault; sha: string } | null>;
  /** Write the file; `sha` is the version being replaced. Throws ConflictError if it changed meanwhile. */
  put(blob: EncryptedVault, sha: string | undefined): Promise<string>;
}

export class ConflictError extends Error {
  constructor() {
    super('The vault on GitHub changed while saving');
  }
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Accepts "owner/name", "github.com/owner/name" or a full https/git URL. */
export function normalizeRepo(input: string): string {
  const s = input
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error('Enter the repository as owner/name, e.g. wouter075/terminaltab-vault');
  }
  return s;
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn = globalThis.fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'TerminalTab',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (err) {
      throw new GitHubError(`Can't reach GitHub: ${(err as Error).message}`, 0);
    }
    if (res.ok) return (await res.json()) as T;
    const detail = await res.json().then((j: { message?: string }) => j.message ?? '', () => '');
    throw new GitHubError(explain(res.status, detail), res.status);
  }

  /** Check the repo exists, is private, and the token may write to it. */
  async checkRepo(repo: string): Promise<void> {
    const r = await this.request<{ private: boolean; permissions?: { push?: boolean } }>('GET', `/repos/${repo}`);
    if (!r.private) {
      throw new Error(`${repo} is public. Use a private repository for your vault.`);
    }
    if (r.permissions && !r.permissions.push) {
      throw new Error('The token can read but not write this repository. Give it "Contents: Read and write".');
    }
  }

  store(repo: string, path = VAULT_PATH): RemoteStore {
    const url = `/repos/${repo}/contents/${path}`;
    return {
      get: async () => {
        try {
          const f = await this.request<{ content: string; sha: string; encoding: string }>('GET', url);
          const json = Buffer.from(f.content, 'base64').toString('utf8');
          return { blob: JSON.parse(json) as EncryptedVault, sha: f.sha };
        } catch (err) {
          if (err instanceof GitHubError && err.status === 404) return null;
          throw err;
        }
      },
      put: async (blob, sha) => {
        try {
          const r = await this.request<{ content: { sha: string } }>('PUT', url, {
            message: 'Update TerminalTab vault',
            content: Buffer.from(JSON.stringify(blob, null, 2)).toString('base64'),
            ...(sha ? { sha } : {}),
          });
          return r.content.sha;
        } catch (err) {
          // 409: sha mismatch; 422: "sha wasn't supplied" when the file was created meanwhile.
          if (err instanceof GitHubError && (err.status === 409 || err.status === 422)) throw new ConflictError();
          throw err;
        }
      },
    };
  }
}

function explain(status: number, detail: string): string {
  switch (status) {
    case 401:
      return 'GitHub rejected the token (invalid or expired).';
    case 403:
      return /rate limit/i.test(detail)
        ? 'GitHub rate limit reached, try again later.'
        : 'The token has no access to this repository. Give it "Contents: Read and write" on the repo.';
    case 404:
      return 'Repository not found. Check the name, and that the token has access to it.';
    default:
      return `GitHub error ${status}${detail ? `: ${detail}` : ''}`;
  }
}
