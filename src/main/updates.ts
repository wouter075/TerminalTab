import { app, autoUpdater, net } from 'electron';
import type { UpdateInfo } from '../shared/types';
import { compareVersions } from './version';

const REPO = 'wouter075/TerminalTab';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 30_000;

/**
 * Windows: Squirrel downloads new releases in the background via update.electronjs.org (which
 * reads this repo's GitHub Releases) and installs them on restart.
 * Linux (.deb / .rpm): packages can't replace themselves, so we only tell the user.
 */
export class Updater {
  private info: UpdateInfo = { state: 'none' };
  private timer: NodeJS.Timeout | null = null;
  private squirrelReady = false;

  constructor(
    private readonly enabled: () => boolean,
    private readonly onChange: (info: UpdateInfo) => void,
  ) {}

  get current(): UpdateInfo {
    return this.info;
  }

  start(): void {
    if (!app.isPackaged || this.timer) return;
    // During Squirrel's first run the update folder is still locked.
    if (process.argv.includes('--squirrel-firstrun')) return;
    if (process.platform === 'win32') this.setupSquirrel();
    setTimeout(() => this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Restart into the downloaded version (Windows). */
  restart(): void {
    if (this.info.state === 'downloaded') autoUpdater.quitAndInstall();
  }

  private set(info: UpdateInfo) {
    this.info = info;
    this.onChange(info);
  }

  private setupSquirrel() {
    try {
      autoUpdater.setFeedURL({
        url: `https://update.electronjs.org/${REPO}/${process.platform}-${process.arch}/${app.getVersion()}`,
      });
      autoUpdater.on('error', () => undefined); // offline, proxy, etc.: try again next time
      autoUpdater.on('update-downloaded', (_e, _notes, releaseName) => {
        this.set({ state: 'downloaded', version: String(releaseName || '').replace(/^(TerminalTab\s*)?v(?=\d)/i, '').replace(/^TerminalTab\s*/i, '') || undefined, url: RELEASES_URL });
      });
      this.squirrelReady = true;
    } catch {
      this.squirrelReady = false;
    }
  }

  private async check(): Promise<void> {
    if (!this.enabled() || this.info.state === 'downloaded') return;
    if (process.platform === 'win32') {
      if (this.squirrelReady) autoUpdater.checkForUpdates();
      return;
    }
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return;
      const rel = (await res.json()) as { tag_name?: string; html_url?: string };
      if (rel.tag_name && compareVersions(rel.tag_name, app.getVersion()) > 0) {
        this.set({ state: 'available', version: rel.tag_name.replace(/^v/i, ''), url: rel.html_url ?? RELEASES_URL });
      }
    } catch {
      // offline: try again later
    }
  }
}
