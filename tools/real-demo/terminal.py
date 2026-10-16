"""Run Pi in a real terminal, with a socket for replaying keyboard input."""
import errno
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import sys
import termios
import time
import tty

manifest = json.loads(Path(sys.argv[1]).read_text())
original = termios.tcgetattr(0)
dimensions = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
server = socket.socket(socket.AF_UNIX)
server.bind(manifest["socket"])
server.listen(4)
started = time.monotonic()

pid, master = pty.fork()
if pid == 0:
    server.close()
    fcntl.ioctl(0, termios.TIOCSWINSZ, dimensions)
    os.chdir(manifest["cwd"])
    os.execvpe(manifest["argv"][0], manifest["argv"], manifest["env"])


def resize(_signum, _frame):
    size = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
    fcntl.ioctl(master, termios.TIOCSWINSZ, size)


signal.signal(signal.SIGWINCH, resize)
size = os.get_terminal_size(0)
Path(manifest["ready"]).write_text(json.dumps({"pid": pid, "parent": os.getppid(), "columns": size.columns, "rows": size.lines}))
exit_code = 1
decoder = codecs.getincrementaldecoder("utf8")("strict")
try:
    tty.setraw(0)
    with open(manifest["rawLog"], "wb", buffering=0) as raw, open(manifest["cast"], "w", buffering=1) as cast:
        rows, cols = os.get_terminal_size(0).lines, os.get_terminal_size(0).columns
        cast.write(json.dumps({"version": 2, "width": cols, "height": rows, "timestamp": int(time.time()), "env": {"TERM": "xterm-256color"}}) + "\n")
        while True:
            readable, _, _ = select.select([master, 0, server], [], [])
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    # PTYs report EIO when their child closes the terminal on macOS.
                    if error.errno != errno.EIO:
                        raise
                    break
                if not data:
                    break
                raw.write(data)
                decoded = decoder.decode(data)
                if decoded:
                    cast.write(json.dumps([round(time.monotonic() - started, 6), "o", decoded]) + "\n")
                offset = 0
                while offset < len(data):
                    offset += os.write(1, data[offset:])
            if 0 in readable:
                data = os.read(0, 65536)
                if data:
                    os.write(master, data)
            if server in readable:
                connection, _ = server.accept()
                with connection:
                    payload = b""
                    while not payload.endswith(b"\n"):
                        chunk = connection.recv(65536)
                        if not chunk:
                            raise RuntimeError("Incomplete terminal control request")
                        payload += chunk
                    command = json.loads(payload)
                    if "send" in command:
                        os.write(master, command["send"].encode("utf8"))
                        cast.write(json.dumps([round(time.monotonic() - started, 6), "i", command["send"]]) + "\n")
                    elif command.get("syncSize"):
                        # Ghostty lays out its window after spawning the command. Propagate that
                        # settled size even if the initial SIGWINCH arrived before this relay.
                        resize(None, None)
                        os.kill(pid, signal.SIGWINCH)
                        size = os.get_terminal_size(0)
                        connection.sendall(json.dumps({"ok": True, "columns": size.columns, "rows": size.lines}).encode() + b"\n")
                        continue
                    elif command.get("terminate"):
                        os.kill(pid, signal.SIGTERM)
                    else:
                        raise ValueError("Unknown terminal control request")
                    connection.sendall(b'{"ok":true}\n')
        _, status = os.waitpid(pid, 0)
        exit_code = os.waitstatus_to_exitcode(status)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, original)
    server.close()
    os.close(master)
    os.unlink(manifest["socket"])
    Path(manifest["exit"]).write_text(json.dumps({"code": exit_code}))

sys.exit(exit_code)
