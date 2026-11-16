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

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'TerminalTab',
    executableName: 'TerminalTab',
    icon: 'assets/icon', // .ico on Windows
    extraResource: ['assets/icon.png'], // window icon on Linux
  },
  rebuildConfig: {},
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
