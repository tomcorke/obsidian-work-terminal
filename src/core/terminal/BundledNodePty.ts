import { WindowsTerminal } from "node-pty/lib/windowsTerminal";
import type { NodePtyInstance, NodePtyModule } from "./PtyBackend";
import { ensureWindowsPtyAssets } from "./WindowsPtyAssetsLoader";

export function loadBundledNodePty(): NodePtyModule {
  ensureWindowsPtyAssets();
  return {
    spawn: (file, args, options) => {
      const pty = new WindowsTerminal(file, args, options) as unknown as NodePtyInstance & {
        on(event: "error", listener: (error: Error) => void): void;
      };
      pty.onError = (listener) => pty.on("error", listener);
      return pty;
    },
  };
}
