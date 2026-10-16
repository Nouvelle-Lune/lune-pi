"""Offline Pi PTY smoke checks. Requires Python's pexpect package."""
import json
import os
from pathlib import Path
import tempfile
import time
import uuid
import pexpect

repo = Path(__file__).resolve().parents[2]


def iso(milliseconds):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(milliseconds / 1000)) + f".{milliseconds % 1000:03d}Z"


def seed_session(root):
    old = int((time.time() - 240) * 1000)
    # Automatic recap needs the latest completed round to be substantial, so
    # the final round takes 90 seconds (the threshold is 60) from prompt to reply.
    # The final reply is still four minutes old, so the three-minute delay has elapsed.
    elapsed = 90_000
    records = [{"type": "session", "version": 3, "id": str(uuid.uuid4()), "timestamp": iso(old - elapsed - 2000), "cwd": str(root)}]
    parent = None
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
             "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
    for index in range(3):
        # Earlier rounds are instantaneous and precede the final round in time.
        started = old - elapsed if index == 2 else old - elapsed - 1000 * (2 - index)
        finished = old if index == 2 else started
        messages = [
            ({"role": "user", "content": f"Implement recap step {index}", "timestamp": started}, started),
            ({"role": "assistant", "content": [{"type": "text", "text": "Settings step completed"}],
              "api": "offline-recap-api", "provider": "offline-recap", "model": "fixture", "stopReason": "stop", "usage": usage, "timestamp": finished}, finished),
        ]
        for message, at in messages:
            entry_id = uuid.uuid4().hex[:8]
            records.append({"type": "message", "id": entry_id, "parentId": parent, "timestamp": iso(at), "message": message})
            parent = entry_id
    target = root / "session.jsonl"
    target.write_text("\n".join(json.dumps(record) for record in records) + "\n")
    return target


def command(child, text):
    child.send(text)
    child.send("\r")


for mode in ("regular", "fullscreen"):
    with tempfile.TemporaryDirectory(prefix="pi-recap-pty-") as directory:
        root = Path(directory)
        agent = root / "agent"
        agent.mkdir()
        probe = root / "probe.log"
        settings_file = agent / "lune-settings" / "pi-recap.json"
        settings_file.parent.mkdir()
        settings_file.write_text(json.dumps({"enabled": True}))
        environment = {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_RECAP_PROBE_PATH": str(probe), "TERM": "xterm-256color"}
        args = ["--no-extensions", "-e", str(repo / "node_modules/@lune_99/pi-lune-extensions-core/dist/extension.js"),
                "-e", str(repo / "test/tui/recap-fixture.ts"), "-e", str(repo / "src/extension.ts"),
                "--session", str(seed_session(root)), "--offline", "-nc", "-np", "-ns", "--no-tools", "--no-mcp",
                "--model", "offline-recap/fixture", "--models", "offline-recap/fixture", "--tui-mode", mode]
        print(f"[{mode}] 1/4 Starting isolated offline Pi PTY", flush=True)
        child = pexpect.spawn("pi", args, cwd=str(root), env=environment, encoding="utf-8", timeout=20, dimensions=(32, 100))
        child.delaybeforesend = 0
        with (root / "terminal.log").open("w") as log:
            child.logfile_read = log
            try:
                child.expect("Offline recap fixture ready")
                if mode == "fullscreen":
                    log.flush()
                    assert "\x1b[?1004h" in (root / "terminal.log").read_text(), "Host did not enable focus reporting"
                    print(f"[{mode}] 2/4 Delivering focus reports through the PTY", flush=True)
                    child.send("\x1b[O")
                    child.expect("Offline provider requested")
                    child.send("\x1b[I")
                else:
                    print(f"[{mode}] 2/4 Running manual /recap", flush=True)
                    command(child, "/recap")
                child.expect("Offline recap: settings completed")
                assert probe.read_text().count("request\n") == 1
                print(f"[{mode}] 3/4 Opening scoped selector and saving a searched model", flush=True)
                command(child, "/lune-core-settings recap")
                child.expect("Automatic recap")
                child.send("\x1b[B\r")
                child.expect("Type to search")
                child.send("\t")
                child.send("offline-recap/codex/gpt-6.1-sol")
                child.expect(r"codex/gpt-6\.1-sol.*?\[offline-recap\]")
                child.send("\r")
                child.expect_exact("Ctrl+G scope")
                settings = json.loads(settings_file.read_text())
                assert settings["model"] == {"provider": "offline-recap", "id": "codex/gpt-6.1-sol"}
                child.send("\x1b")
                child.expect("Offline settings closed")
                command(child, "/recap")
                child.expect("Offline recap: settings completed")
                child.setwinsize(24, 40)
                print(f"[{mode}] 4/4 Narrow resize and clean shutdown", flush=True)
                command(child, "/quit")
                child.expect(pexpect.EOF)
                child.close()
                assert child.exitstatus == 0, child.exitstatus
                if mode == "fullscreen":
                    reports = probe.read_text()
                    assert "focus-out\n" in reports and "focus-in\n" in reports
            except Exception:
                log.flush()
                print((root / "terminal.log").read_text()[-10000:], flush=True)
                raise
            finally:
                if child.isalive():
                    child.terminate(force=True)
        print(f"[{mode}] Passed", flush=True)
print("PTY smoke passed; OS window focus switching still requires manual terminal verification.", flush=True)
