import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostMatches, parsePuttyRegistry, parseSshConfig, type ConfigReader } from './importers';

const HOME = path.join(path.sep, 'home', 'me');
const p = (...parts: string[]) => path.join(HOME, ...parts);

function reader(files: Record<string, string>): ConfigReader {
  return {
    readFile: (f) => files[f] ?? null,
    listDir: (dir) =>
      Object.keys(files)
        .filter((f) => path.dirname(f) === dir)
        .map((f) => path.basename(f)),
  };
}

describe('hostMatches', () => {
  it('supports globs and negation', () => {
    expect(hostMatches(['*.example.com'], 'web.example.com')).toBe(true);
    expect(hostMatches(['web?'], 'web1')).toBe(true);
    expect(hostMatches(['*', '!bastion'], 'bastion')).toBe(false);
    expect(hostMatches(['db'], 'web')).toBe(false);
  });
});

describe('parseSshConfig', () => {
  it('reads concrete hosts and applies Host * defaults like ssh does', () => {
    const cfg = `
# my servers
Host web
    HostName web.example.com
    User deploy
    Port 2222
    IdentityFile ~/.ssh/web_key

Host db db-alias
  hostname=10.0.0.5

Host *.internal
  User admin

Host *
  User root
  IdentityFile ~/.ssh/id_ed25519
`;
    const hosts = parseSshConfig(p('.ssh', 'config'), HOME, 'me', reader({ [p('.ssh', 'config')]: cfg }));
    expect(hosts.map((h) => h.name)).toEqual(['web', 'db', 'db-alias']);
    expect(hosts[0]).toMatchObject({ host: 'web.example.com', username: 'deploy', port: 2222, identityFile: p('.ssh', 'web_key') });
    // First value wins: `User root` from Host * only fills in what's missing.
    expect(hosts[1]).toMatchObject({ host: '10.0.0.5', username: 'root', port: 22, identityFile: p('.ssh', 'id_ed25519') });
  });

  it('follows Include with wildcards and expands tokens', () => {
    const files = {
      [p('.ssh', 'config')]: 'Include config.d/*\nHost *\n  User fallback\n',
      [p('.ssh', 'config.d', 'a.conf')]: 'Host alpha\n  HostName %h.lan\n  IdentityFile %d/.ssh/%r_key\n  User bob\n',
      [p('.ssh', 'config.d', 'b.conf')]: 'Host beta\n  ProxyJump bastion\n',
    };
    const hosts = parseSshConfig(p('.ssh', 'config'), HOME, 'me', reader(files));
    expect(hosts.map((h) => h.name)).toEqual(['alpha', 'beta']);
    expect(hosts[0]).toMatchObject({ host: 'alpha.lan', username: 'bob', identityFile: p('.ssh', 'bob_key') });
    expect(hosts[1].username).toBe('fallback');
    expect(hosts[1].note).toMatch(/jump host/);
  });

  it('uses the local user name when none is set and ignores Match blocks', () => {
    const cfg = 'Host plain\nMatch host plain\n  User other\n';
    const hosts = parseSshConfig(p('.ssh', 'config'), HOME, 'me', reader({ [p('.ssh', 'config')]: cfg }));
    expect(hosts).toEqual([expect.objectContaining({ name: 'plain', host: 'plain', username: 'me', identityFile: undefined })]);
  });

  it('returns nothing when the file does not exist', () => {
    expect(parseSshConfig(p('.ssh', 'config'), HOME, 'me', reader({}))).toEqual([]);
  });
});

describe('parsePuttyRegistry', () => {
  it('reads SSH sessions and skips the rest', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings',
      '    HostName    REG_SZ    ',
      '',
      'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\My%20web',
      '    HostName    REG_SZ    deploy@web.example.com',
      '    PortNumber    REG_DWORD    0x8ae',
      '    Protocol    REG_SZ    ssh',
      '    PublicKeyFile    REG_SZ    C:\\keys\\web.ppk',
      '',
      'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\router',
      '    HostName    REG_SZ    192.168.1.1',
      '    Protocol    REG_SZ    telnet',
      '',
    ].join('\r\n');
    expect(parsePuttyRegistry(out, 'me')).toEqual([
      {
        source: 'putty',
        name: 'My web',
        host: 'web.example.com',
        port: 2222,
        username: 'deploy',
        identityFile: 'C:\\keys\\web.ppk',
      },
    ]);
  });
});
