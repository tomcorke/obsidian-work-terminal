export interface WindowsPtyAsset {
  path: string;
  base64: string;
}

// The production esbuild plugin replaces this with node-pty's Windows assets.
// Keeping the source fallback empty keeps unit tests independent of native files.
export const WINDOWS_PTY_ASSETS: readonly WindowsPtyAsset[] = [];
