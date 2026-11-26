import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, autoUpdater, net } from 'electron';
import type { UpdateCheck, UpdateInfo } from '../shared/types';
import { compareVersions } from './version';

const REPO = 'wouter075/TerminalTab';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const FIRST_CHECK_MS = 30_000;
const MANUAL_TIMEOUT_MS = 60_000;

/**
 * Windows: Squirrel downloads new releases in the background via update.electronjs.org (which
 * reads this repo's GitHub Releases) and installs them on restart.
 * Linux (.deb / .rpm) and the portable Windows .zip can't replace themselves, so we only tell the user.
 */
/** Installed by TerminalTab-Setup.exe: Squirrel's Update.exe sits one folder up. */
const squirrelInstalled = () =>
  process.platform === 'win32' && existsSync(path.resolve(path.dirname(process.execPath), '..', 'Update.exe'));

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
    if (squirrelInstalled()) this.setupSquirrel();
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
      autoUpdater.on('error', () => {
        // offline, proxy, etc.: try again next time
        if (this.info.state === 'downloading') this.set({ state: 'none' });
      });
      autoUpdater.on('update-available', () => {
        if (this.info.state !== 'downloaded') this.set({ state: 'downloading', url: RELEASES_URL });
      });
      autoUpdater.on('update-downloaded', (_e, _notes, releaseName) => {
        this.set({ state: 'downloaded', version: String(releaseName || '').replace(/^(TerminalTab\s*)?v(?=\d)/i, '').replace(/^TerminalTab\s*/i, '') || undefined, url: RELEASES_URL });
      });
      this.squirrelReady = true;
    } catch {
      this.squirrelReady = false;
    }
  }

  private async check(): Promise<void> {
    if (!this.enabled() || this.info.state === 'downloaded' || this.info.state === 'downloading') return;
    if (squirrelInstalled()) {
      if (this.squirrelReady) autoUpdater.checkForUpdates();
      return;
    }
    await this.checkGitHub().catch(() => undefined); // offline: try again later
  }

  /** Linux / portable: compare the latest GitHub release with this version. */
  private async checkGitHub(): Promise<UpdateCheck> {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    if (rel.tag_name && compareVersions(rel.tag_name, app.getVersion()) > 0) {
      this.set({ state: 'available', version: rel.tag_name.replace(/^v/i, ''), url: rel.html_url ?? RELEASES_URL });
      return { result: 'available', version: this.info.version, url: this.info.url };
    }
    return { result: 'latest' };
  }

  /** "Check now" button: works even when automatic checks are turned off. */
  async checkNow(): Promise<UpdateCheck> {
    if (!app.isPackaged) return { result: 'error', message: 'Updates only work in the installed app, not in development.' };
    if (this.info.state === 'downloaded') return { result: 'downloaded', version: this.info.version };
    if (this.info.state === 'downloading') return { result: 'downloading' };
    if (!squirrelInstalled()) {
      try {
        return await this.checkGitHub();
      } catch (err) {
        return { result: 'error', message: `Could not reach GitHub (${(err as Error).message}).` };
      }
    }
    if (process.argv.includes('--squirrel-firstrun')) {
      return { result: 'error', message: 'TerminalTab was just installed. Try again after the next start.' };
    }
    if (!this.squirrelReady) this.setupSquirrel();
    if (!this.squirrelReady) return { result: 'error', message: 'The Windows updater could not start.' };

    return new Promise<UpdateCheck>((resolve) => {
      const events: [string, (...args: unknown[]) => void][] = [];
      const finish = (r: UpdateCheck) => {
        clearTimeout(timer);
        for (const [name, fn] of events) autoUpdater.removeListener(name as 'error', fn);
        resolve(r);
      };
      const on = (name: string, fn: (...args: unknown[]) => void) => {
        events.push([name, fn]);
        autoUpdater.on(name as 'error', fn);
      };
      const timer = setTimeout(() => finish({ result: 'error', message: 'The update server did not answer in time.' }), MANUAL_TIMEOUT_MS);
      on('update-not-available', () => finish({ result: 'latest' }));
      on('update-available', () => finish({ result: 'downloading' }));
      on('update-downloaded', () => finish({ result: 'downloaded', version: this.info.version }));
      on('error', (err) => finish({ result: 'error', message: `Could not check for updates (${(err as Error)?.message ?? 'unknown error'}).` }));
      try {
        autoUpdater.checkForUpdates();
      } catch (err) {
        finish({ result: 'error', message: (err as Error).message });
      }
    });
  }
}
