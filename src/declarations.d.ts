/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';
declare module '*.png' {
  const url: string;
  export default url;
}

/** package.json version, injected by Vite (vite.renderer.config.mts). */
declare const APP_VERSION: string;
