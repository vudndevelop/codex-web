# Shared in-app terminal

`shared_terminal` MCP exposes `terminal_list`, `terminal_read`, `terminal_write`, and `terminal_interrupt`. Configure the adapter in your Codex MCP settings; restart Codex to load it. Python 3 and tmux are required for desktop sessions. The Python stdlib adapter also accepts the same arguments plus `operation` as JSON on stdin in `request` mode.

## Desktop

Attach once in each chat's integrated terminal. Substitute that chat's thread ID and workspace:

```sh
python3 /absolute/path/to/codex-web/scripts/terminal-control.py attach --thread THREAD_ID --workspace /absolute/workspace
```

Agent uses `backend="desktop"` and lists the session before operating it. Pane `0.0` in the dedicated `codex-agent` tmux server is shared with the UI. `create` prepares a detached session; it does not attach the desktop UI. `Ctrl+B`, then `D`, detaches without stopping commands.

## Web

Open Terminal in that chat's side panel. Use `backend="web"`, that chat's thread ID, workspace and explicit session ID. `webPort` defaults to `8214`; it is the port of the backend being used. The private socket is `~/.codex/terminal-bridge/web-PORT.sock` (directory `0700`, socket `0600`). No terminal command HTTP endpoint is added.

Write literal text including `\n` or `\r` to execute. Read output after writing. Interrupt sends `Ctrl+C`. Missing, detached, remote, ambiguous or differently scoped sessions are rejected. Writes propagate backend failures. Web snapshots retain upstream's last 16000 characters; desktop reads the last 1000 lines.

Bridge follows workspace recorded when terminal was created. Shell commands can change its current directory; inspect output/current directory before relying on it. Same-user local processes have the same terminal access as the user. This is not an authorization boundary against other processes running as that user.

The web manager hook is version-scoped. Update `patches/app-host-terminal-bridge.patch` when upstream bundle changes. After an unclean backend exit, startup recovers a stale socket only after checking its owner, probing that no server accepts connections, and verifying its inode has not changed. Live sockets are never replaced.

## Verification

```sh
npm run build:server
node tests/terminal-pty.cjs
node tests/terminal-bridge.cjs
python3 tests/terminal-control.py
```
