import type { ServerStats } from '../shared/types';

/**
 * Read-only script piped to `sh -s` on the server (so it works whatever the login shell is).
 * Prints KEY=value lines; anything unavailable is simply left out.
 */
export const STATS_SCRIPT = `
export LC_ALL=C
if [ -r /etc/os-release ]; then . /etc/os-release; echo "OS=$PRETTY_NAME"; else echo "OS=$(uname -sr)"; fi
[ -r /proc/loadavg ] && echo "LOAD=$(cut -d' ' -f1 /proc/loadavg)"
echo "CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
[ -r /proc/meminfo ] && awk '/^MemTotal:/{print "MEMTOTAL="$2} /^MemAvailable:/{print "MEMAVAIL="$2}' /proc/meminfo
df -Pk / 2>/dev/null | awk 'NR==2{print "DISKTOTAL="$2; print "DISKUSED="$3}'
[ -r /proc/uptime ] && echo "UPTIME=$(cut -d' ' -f1 /proc/uptime)"
exit 0
`;

export function parseStats(output: string): ServerStats | null {
  const kv = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^([A-Z]+)=(.*)$/.exec(line.trim());
    if (m && m[2] !== '') kv.set(m[1], m[2]);
  }
  const num = (k: string) => {
    const v = Number(kv.get(k));
    return kv.has(k) && Number.isFinite(v) ? v : undefined;
  };
  const kib = (k: string) => {
    const v = num(k);
    return v === undefined ? undefined : v * 1024;
  };

  const memTotal = kib('MEMTOTAL');
  const memAvail = kib('MEMAVAIL');
  const stats: ServerStats = {
    os: kv.get('OS'),
    load1: num('LOAD'),
    cores: num('CORES'),
    memTotal,
    memUsed: memTotal !== undefined && memAvail !== undefined ? memTotal - memAvail : undefined,
    diskTotal: kib('DISKTOTAL'),
    diskUsed: kib('DISKUSED'),
    uptimeSec: num('UPTIME'),
  };
  // Nothing useful came back (e.g. a restricted shell): treat as unavailable.
  const hasAny = Object.entries(stats).some(([k, v]) => k !== 'os' && v !== undefined);
  return hasAny || stats.os ? stats : null;
}
