import { describe, expect, it } from 'vitest';
import { parseStats } from './serverStats';

describe('parseStats', () => {
  it('parses a typical Linux server', () => {
    const out = [
      'OS=Ubuntu 24.04.1 LTS',
      'LOAD=0.42',
      'CORES=4',
      'MEMTOTAL=4000000',
      'MEMAVAIL=1000000',
      'DISKTOTAL=41152736',
      'DISKUSED=10288184',
      'UPTIME=93784.12',
    ].join('\n');
    expect(parseStats(out)).toEqual({
      os: 'Ubuntu 24.04.1 LTS',
      load1: 0.42,
      cores: 4,
      memTotal: 4000000 * 1024,
      memUsed: 3000000 * 1024,
      diskTotal: 41152736 * 1024,
      diskUsed: 10288184 * 1024,
      uptimeSec: 93784.12,
    });
  });

  it('keeps what is available (e.g. macOS without /proc)', () => {
    const s = parseStats('OS=Darwin 23.1.0\r\nCORES=8\r\nDISKTOTAL=100\r\nDISKUSED=50\r\n');
    expect(s).toMatchObject({ os: 'Darwin 23.1.0', cores: 8, diskTotal: 102400, diskUsed: 51200 });
    expect(s?.memUsed).toBeUndefined();
  });

  it('returns null for empty or garbage output', () => {
    expect(parseStats('')).toBeNull();
    expect(parseStats('This account is restricted\nLOAD=\n')).toBeNull();
  });
});
