import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const linuxOptions = {
  name: 'terminaltab',
  productName: 'TerminalTab',
  genericName: 'SSH Terminal',
  description: 'Tabbed SSH terminal manager with an encrypted key vault',
  bin: 'TerminalTab',
  icon: 'assets/icon.png',
  categories: ['Network', 'System', 'Development'] as ('Network' | 'System' | 'Development')[],
  homepage: 'https://github.com/wouter075/TerminalTab',
};

/**
 * node-pty (local shells) is a native module that Vite can't bundle. Copy just what it needs at
 * runtime next to app.asar (resources/node-pty), outside the archive, so its .node files,
 * conpty.dll / OpenConsole.exe and worker script load from real paths. main loads it from there.
 */
function copyNodePty(buildPath: string, platform: string, arch: string) {
  const src = path.resolve('node_modules/node-pty');
  const dest = path.join(buildPath, '..', 'node-pty');
  const copy = (rel: string, filter?: (file: string) => boolean) => {
    const from = path.join(src, rel);
    if (!existsSync(from)) return;
    cpSync(from, path.join(dest, rel), { recursive: true, filter: filter && ((f) => filter(f)) });
  };
  mkdirSync(dest, { recursive: true });
  copy('package.json');
  copy('lib', (f) => !/\.(test\.js|map)$/.test(f));
  copy(`prebuilds/${platform}-${arch}`, (f) => !f.endsWith('.pdb'));
  // Built from source where there's no prebuild (Linux).
  const release = path.join(src, 'build', 'Release');
  if (existsSync(release)) {
    for (const f of readdirSync(release)) {
      if (f.endsWith('.node') || f === 'spawn-helper') copy(`build/Release/${f}`);
    }
  }
  const hasNative =
    existsSync(path.join(dest, 'build', 'Release', 'pty.node')) ||
    existsSync(path.join(dest, 'prebuilds', `${platform}-${arch}`, platform === 'win32' ? 'conpty.node' : 'pty.node'));
  if (!hasNative) throw new Error(`node-pty has no native binary for ${platform}-${arch}; run npm ci with a C++ toolchain`);
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'TerminalTab',
    executableName: 'TerminalTab',
    icon: 'assets/icon', // .ico on Windows
    extraResource: ['assets/icon.png'], // window icon on Linux
  },
  // node-pty is N-API (no rebuild per Electron version needed) and ships outside app.asar.
  rebuildConfig: { onlyModules: [] },
  hooks: {
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => copyNodePty(buildPath, platform, arch),
  },
  makers: [
    new MakerSquirrel({
      name: 'TerminalTab',
      setupExe: 'TerminalTab-Setup.exe',
      setupIcon: 'assets/icon.ico',
      loadingGif: 'assets/installer.gif',
    }),
    new MakerZIP({}, ['win32', 'darwin']),
    new MakerDeb({
      options: {
        ...linuxOptions,
        maintainer: 'Wouter <694692+wouter075@users.noreply.github.com>',
        section: 'net',
        // Ubuntu 24.04+ only allows Electron's sandbox with a setuid chrome-sandbox.
        scripts: { postinst: 'packaging/linux/postinst' },
      },
    }),
    new MakerRpm({
      options: {
        ...linuxOptions,
        license: 'MIT',
        // electron-installer-redhat options missing from Forge's types. The own spec template
        // works with rpmbuild >= 4.20.
        ...({
          specTemplate: path.resolve('packaging/linux/rpm.spec.ejs'),
          scripts: { post: 'packaging/linux/postinst' },
        } as object),
      },
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
