import path from 'node:path';

/** A host as found in ~/.ssh/config or PuTTY, before key files are checked. */
export interface FoundHost {
  source: 'ssh-config' | 'putty';
  /** Alias (ssh config) or session name (PuTTY). */
  name: string;
  host: string;
  port: number;
  username: string;
  /** Configured key file (absolute), if any. */
  identityFile?: string;
  note?: string;
}

export interface ConfigReader {
  /** Contents of a file, or null if it can't be read. */
  readFile(file: string): string | null;
  /** File names in a directory (for Include with wildcards). */
  listDir(dir: string): string[];
}

interface Block {
  patterns: string[];
  /** Match blocks are not evaluated (they depend on runtime state); they never apply. */
  isMatch: boolean;
  options: [string, string][];
}

const WILDCARD = /[*?!]/;

/** OpenSSH-style glob: `*` and `?`. */
function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** Whether a Host line's patterns match `alias` (supports `!negation`). */
export function hostMatches(patterns: string[], alias: string): boolean {
  let matched = false;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    const re = globToRegExp(negated ? p.slice(1) : p);
    if (re.test(alias)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

/** Split a config line into keyword and arguments (handles `Key=value` and "quoted values"). */
function splitLine(line: string): [string, string[]] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (!m) return null;
  const args: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(m[2]))) {
    const v = a[1] ?? a[2];
    if (v.startsWith('#')) break;
    args.push(v);
  }
  return [m[1].toLowerCase(), args];
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** Read a config file into blocks, following Include. */
function readBlocks(file: string, home: string, reader: ConfigReader, depth = 0, into: Block[] = []): Block[] {
  if (depth > 8) return into;
  const text = reader.readFile(file);
  if (text === null) return into;
  // Lines before the first Host/Match apply to every host.
  let cur: Block = { patterns: ['*'], isMatch: false, options: [] };
  into.push(cur);
  for (const line of text.split(/\r?\n/)) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    const [key, args] = parsed;
    if (key === 'host') {
      cur = { patterns: args, isMatch: false, options: [] };
      into.push(cur);
    } else if (key === 'match') {
      cur = { patterns: [], isMatch: true, options: [] };
      into.push(cur);
    } else if (key === 'include') {
      for (const arg of args) {
        let target = expandHome(arg, home);
        if (!path.isAbsolute(target)) target = path.join(home, '.ssh', target);
        const dir = path.dirname(target);
        const base = path.basename(target);
        const files = WILDCARD.test(base)
          ? reader
              .listDir(dir)
              .filter((f) => globToRegExp(base).test(f))
              .sort()
              .map((f) => path.join(dir, f))
          : [target];
        // An Include inside a Host block only applies to that block; we keep it simple and
        // splice the included blocks in, then continue the current block.
        const before = into.length;
        for (const f of files) readBlocks(f, home, reader, depth + 1, into);
        if (into.length > before) {
          cur = { patterns: cur.patterns, isMatch: cur.isMatch, options: [] };
          into.push(cur);
        }
      }
    } else {
      cur.options.push([key, args.join(' ')]);
    }
  }
  return into;
}

/** Expand %h %r %u %d %% tokens used in HostName and IdentityFile. */
function expandTokens(v: string, t: { h: string; r: string; u: string; d: string; n: string }): string {
  return v.replace(/%([hrudn%])/g, (_m, c: string) => (c === '%' ? '%' : t[c as keyof typeof t]));
}

/**
 * Parse ~/.ssh/config (with Includes) into concrete hosts. Wildcard-only Host entries become
 * defaults, exactly like ssh: for each option, the first value found for that host wins.
 */
export function parseSshConfig(configFile: string, home: string, localUser: string, reader: ConfigReader): FoundHost[] {
  const blocks = readBlocks(configFile, home, reader);
  const aliases: string[] = [];
  for (const b of blocks) {
    if (b.isMatch) continue;
    for (const p of b.patterns) if (!WILDCARD.test(p) && !aliases.includes(p)) aliases.push(p);
  }

  const result: FoundHost[] = [];
  for (const alias of aliases) {
    const opts = new Map<string, string>();
    for (const b of blocks) {
      if (b.isMatch || !hostMatches(b.patterns, alias)) continue;
      for (const [k, v] of b.options) if (!opts.has(k)) opts.set(k, v);
    }
    const user = opts.get('user') ?? localUser;
    const tokens = { h: alias, r: user, u: localUser, d: home, n: alias };
    const host = expandTokens(opts.get('hostname') ?? alias, tokens);
    tokens.h = host;
    const port = Number(opts.get('port')) || 22;
    let identityFile: string | undefined;
    const idf = opts.get('identityfile');
    if (idf && idf.toLowerCase() !== 'none') {
      identityFile = expandHome(expandTokens(idf, tokens), home);
      identityFile = path.isAbsolute(identityFile) ? path.normalize(identityFile) : path.join(home, identityFile);
    }
    const jump = opts.get('proxyjump') ?? (opts.has('proxycommand') ? 'ProxyCommand' : undefined);
    result.push({
      source: 'ssh-config',
      name: alias,
      host,
      port,
      username: user,
      identityFile,
      note: jump && jump.toLowerCase() !== 'none' ? `Uses a jump host (${jump}), which TerminalTab doesn't support yet` : undefined,
    });
  }
  return result;
}

/** Parse `reg query HKCU\Software\SimonTatham\PuTTY\Sessions /s` output. */
export function parsePuttyRegistry(output: string, localUser: string): FoundHost[] {
  const sessions: { name: string; values: Map<string, string> }[] = [];
  let cur: { name: string; values: Map<string, string> } | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const head = /^HKEY_[^\\]+\\.*\\Sessions\\(.+)$/i.exec(line);
    if (head) {
      cur = { name: decodeURIComponent(head[1]), values: new Map() };
      sessions.push(cur);
      continue;
    }
    const val = /^\s+(\S+)\s+REG_(\w+)\s+(.*)$/.exec(line);
    if (cur && val) {
      const v = val[2] === 'DWORD' ? String(parseInt(val[3], 16)) : val[3];
      cur.values.set(val[1].toLowerCase(), v);
    }
  }

  const result: FoundHost[] = [];
  for (const s of sessions) {
    if (s.name === 'Default Settings') continue;
    const proto = (s.values.get('protocol') ?? 'ssh').toLowerCase();
    let host = s.values.get('hostname')?.trim();
    if (proto !== 'ssh' || !host) continue;
    let username = s.values.get('username')?.trim() || '';
    const at = host.lastIndexOf('@');
    if (at > 0) {
      username ||= host.slice(0, at);
      host = host.slice(at + 1);
    }
    const keyFile = s.values.get('publickeyfile')?.trim();
    result.push({
      source: 'putty',
      name: s.name,
      host,
      port: Number(s.values.get('portnumber')) || 22,
      username: username || localUser,
      identityFile: keyFile || undefined,
    });
  }
  return result;
}

/** Default key files ssh tries when no IdentityFile is set. */
export const DEFAULT_IDENTITY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
