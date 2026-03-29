#!/usr/bin/env python3
"""PTY wrapper for Obsidian embedded terminals.

Spawns a command inside a real pseudo-terminal using Python's pty.spawn().
This gives the child process a real TTY (isatty() returns True) while
the parent proxies I/O through stdin/stdout pipes to xterm.js.

Usage: python3 pty-wrapper.py [cols] [rows] [--] <command> [args...]
"""
import sys
import os
import pty
import signal
import struct
import fcntl
import termios
import shlex


def set_winsize(fd, rows, cols):
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def main():
    args = sys.argv[1:]

    cols = 80
    rows = 24
    if len(args) >= 2 and args[0].isdigit() and args[1].isdigit():
        cols = int(args[0])
        rows = int(args[1])
        args = args[2:]

    if args and args[0] == "--":
        args = args[1:]

    if not args:
        args = [os.environ.get("SHELL", "/bin/zsh"), "-i"]

    pid, master_fd = pty.fork()

    if pid == 0:
        # Child process - set window size and exec
        try:
            set_winsize(1, rows, cols)
        except Exception:
            pass

        # If the command is already a shell, exec directly (e.g. /bin/zsh -i).
        # If the command is an absolute path, exec directly to avoid shell
        # quoting issues with arguments (e.g. multi-line context prompts).
        # The caller (ClaudeLauncher.ts) resolves commands to absolute paths.
        # Otherwise, wrap in a login shell for the full user environment.
        shells = {"/bin/zsh", "/bin/bash", "/bin/sh", "/usr/bin/zsh", "/usr/bin/bash",
                  "zsh", "bash", "sh"}
        if args[0] in shells or args[0].startswith("/"):
            os.execvp(args[0], args)
        else:
            shell = os.environ.get("SHELL", "/bin/zsh")
            cmd_str = " ".join(shlex.quote(a) for a in args)
            os.execvp(shell, [shell, "-l", "-i", "-c", cmd_str])
    else:
        # Parent process - proxy I/O with resize support
        import select
        import re

        # Buffer for detecting resize escape sequences in stdin
        stdin_buf = b""
        # Pattern: ESC ] 777 ; resize ; COLS ; ROWS BEL
        resize_pattern = re.compile(rb"\x1b\]777;resize;(\d+);(\d+)\x07")

        # The resize sequence is: ESC ] 7 7 7 ; r e s i z e ; <digits> ; <digits> BEL
        resize_prefix = b"\x1b]777;resize;"

        def process_stdin(data, mfd):
            """Filter resize commands from stdin, forward the rest to PTY."""
            nonlocal stdin_buf
            stdin_buf += data

            while True:
                m = resize_pattern.search(stdin_buf)
                if not m:
                    break

                # Send any data before the resize command to PTY
                before = stdin_buf[:m.start()]
                if before:
                    os.write(mfd, before)

                # Apply resize
                new_cols = int(m.group(1))
                new_rows = int(m.group(2))
                try:
                    set_winsize(mfd, new_rows, new_cols)
                    # Send SIGWINCH to child process group
                    os.kill(pid, signal.SIGWINCH)
                except (OSError, ProcessLookupError):
                    pass

                stdin_buf = stdin_buf[m.end():]

            # Only hold back data if the tail of the buffer could be the
            # start of our resize escape sequence (ESC ] 7 7 7 ; ...).
            # Regular terminal escapes (CSI = ESC [) are NOT held.
            flush_up_to = len(stdin_buf)
            for i in range(max(0, len(stdin_buf) - len(resize_prefix)), len(stdin_buf)):
                if stdin_buf[i:i+1] == b"\x1b":
                    tail = stdin_buf[i:]
                    if resize_prefix[:len(tail)] == tail:
                        flush_up_to = i
                        break

            if flush_up_to > 0:
                os.write(mfd, stdin_buf[:flush_up_to])
                stdin_buf = stdin_buf[flush_up_to:]

        try:
            while True:
                try:
                    rfds, _, _ = select.select([master_fd, 0], [], [], 0.05)
                except (ValueError, OSError):
                    break

                if master_fd in rfds:
                    try:
                        data = os.read(master_fd, 4096)
                        if not data:
                            break
                        os.write(1, data)
                    except OSError:
                        break

                if 0 in rfds:
                    try:
                        data = os.read(0, 4096)
                        if not data:
                            break  # stdin EOF - parent closed pipe
                        else:
                            process_stdin(data, master_fd)
                    except OSError:
                        break

                # Check child status
                try:
                    wpid, status = os.waitpid(pid, os.WNOHANG)
                    if wpid != 0:
                        while True:
                            try:
                                r, _, _ = select.select([master_fd], [], [], 0.05)
                                if not r:
                                    break
                                data = os.read(master_fd, 4096)
                                if not data:
                                    break
                                os.write(1, data)
                            except OSError:
                                break
                        break
                except ChildProcessError:
                    break

        except KeyboardInterrupt:
            pass
        finally:
            try:
                os.close(master_fd)
            except OSError:
                pass
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass


if __name__ == "__main__":
    main()
