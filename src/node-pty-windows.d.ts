declare module "node-pty/lib/windowsTerminal" {
  import type { IWindowsPtyForkOptions } from "node-pty";

  export class WindowsTerminal {
    constructor(file: string, args: string[] | string, options: IWindowsPtyForkOptions);
    readonly pid: number;
    readonly onData: (listener: (data: string) => void) => { dispose(): void };
    readonly onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      dispose(): void;
    };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
  }
}
