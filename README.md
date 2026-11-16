<p align="center"><img src="assets/logo-wordmark.png" alt="TerminalTab" width="480"></p>

# TerminalTab

A Windows app for keeping many SSH sessions open side by side as tabs, with your
servers and `.pem` keys saved in an encrypted vault.

## Download

Get `TerminalTab-Setup.exe` from the
[latest release](https://github.com/wouter075/TerminalTab/releases/latest) and run it.
It installs per user (no admin needed) and adds a Start menu shortcut. The installer
is not code-signed, so Windows SmartScreen may warn the first time: choose
*More info* → *Run anyway*. A portable `.zip` is attached as well.

## Features

- SSH sessions as tabs (xterm.js + ssh2, no OpenSSH install needed)
- Saved servers with groups, colors and search (Ctrl+T, Enter to connect)
- Import `.pem` / OpenSSH private keys (passphrase-protected keys supported); the key
  is copied into the vault, so the original file can be removed
- Optional saved password per server
- Everything encrypted with your master password (scrypt + AES-256-GCM)
- Host-key verification (trust on first use, warning when a key changes)
- Auto-lock after inactivity, on Windows lock and on sleep; open tabs keep running
  behind the lock screen but cannot receive input
- Right-click menu in the terminal: Copy, Paste, Select all, Clear screen,
  Duplicate tab, Close tab (text fields get Cut / Copy / Paste)
- Status bar for the visible tab: connection, key, connected time, latency,
  server OS / CPU load / RAM / disk / uptime (Linux, can be turned off in
  Settings), terminal size and data sent/received
- Select to copy, Ctrl+Shift+C / Ctrl+Shift+V, Ctrl+W close tab,
  Ctrl+Tab / Ctrl+Shift+Tab switch tabs, middle-click a tab to close it

## Development

```sh
npm install
npm start          # run in development
npm test           # vault + SSH session tests (spins up a local test SSH server)
npm run typecheck
npm run make       # builds out/make/squirrel.windows/x64/TerminalTab-Setup.exe
```

Releases are built by GitHub Actions (`.github/workflows/release.yml`): bump
`version` in `package.json`, commit, then push a matching tag, e.g.
`git tag v1.0.1 && git push origin v1.0.1`.

The vault lives at `%APPDATA%\TerminalTab\vault.json`. Forgetting the master
password means the vault cannot be decrypted. Delete the file to start over.

## Layout

| Path | What |
| --- | --- |
| `src/main/main.ts` | Electron window and app lifecycle |
| `src/main/vault.ts` | Encrypted vault (file format, unlock, save) |
| `src/main/sessions.ts` | SSH connections (one ssh2 client per tab), latency + traffic counters |
| `src/main/serverStats.ts` | Read-only stats script and its parser |
| `src/main/sync.ts`, `merge.ts`, `github.ts` | GitHub sync: pull / merge / push of the encrypted vault |
| `src/main/ipc.ts` | IPC handlers, key import, host-key prompts, auto-lock |
| `src/preload.ts` | `window.terminalTab` bridge (the renderer has no Node access) |
| `src/shared/` | Types shared by main and renderer |
| `src/renderer/` | React UI |

Private keys and passwords stay in the main process. The renderer only gets
names and flags.

## Sync between PCs (GitHub)

TerminalTab can sync your servers, keys and trusted host keys through a **private**
GitHub repository. Only the encrypted vault file (`terminaltab-vault.json`) is
uploaded; GitHub never sees your data or your master password.

**First PC:** Settings → Sync with GitHub
1. Create a private repository, e.g. `terminaltab-vault`.
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new):
   *Only select repositories* → that repo, permission *Contents: Read and write*.
3. Enter the repo and token. The token is stored inside your encrypted vault.

**Other PCs:** on the first screen choose *Restore from GitHub* and enter the repo,
a token and your master password.

How it works:
- Syncs after unlocking, after every change, and every 5 minutes.
- Changes are merged per server/key (newest edit wins, deletions are kept), so
  edits on two PCs don't overwrite each other. Simultaneous saves are detected
  with GitHub's file version and retried.
- Every sync is a commit, so older versions can be restored from the repo history.
- If you change the master password on one PC, the others ask for the new one at
  their next sync and switch to it.
- Public repositories and read-only tokens are refused.
- Because the encrypted vault is online, use a long master password (the app
  warns if it is short).

## License

MIT, see [LICENSE](LICENSE).
