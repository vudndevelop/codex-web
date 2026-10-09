import fs from "node:fs/promises";
import { lstatSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type Session = {
  id: string;
  conversationId: string;
  cwd: string;
  shell: string;
  hostId?: string | null;
  attached: boolean;
  buffer: string;
  owner: { isDestroyed(): boolean };
  backend: { write(data: string): Promise<void> };
};

export type TerminalManager = { sessions: Map<string, Session> };

export async function terminalRequest(managers: TerminalManager | TerminalManager[] | undefined, input: unknown) {
  if (!managers) throw new Error("Terminal manager is not ready");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected request object");
  const request = input as Record<string, unknown>;
  const { operation, threadId, workspace, sessionId, text } = request;
  if (!["list", "read", "write", "interrupt"].includes(String(operation))) throw new Error("Invalid operation");
  if (typeof threadId !== "string" || !threadId || typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("threadId and absolute workspace are required");
  const root = await fs.realpath(workspace);
  const sessions: Session[] = [];
  const owners = new Map<Session, TerminalManager>();
  for (const manager of Array.isArray(managers) ? managers : [managers]) for (const session of manager.sessions.values()) {
    if (session.conversationId !== threadId || !session.attached || session.owner.isDestroyed() || (session.hostId != null && session.hostId !== "local")) continue;
    const cwd = await fs.realpath(session.cwd);
    const relative = path.relative(root, cwd);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { sessions.push(session); owners.set(session, manager); }
  }
  const describe = (s: Session) => ({ sessionId: s.id, threadId: s.conversationId, cwd: s.cwd, shell: s.shell });
  if (operation === "list") return sessions.map(describe);
  if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
  const matches = sessions.filter(s => s.id === sessionId);
  if (matches.length > 1) throw new Error("Ambiguous terminal session ID");
  const session = matches[0];
  if (!session) throw new Error("No attached local terminal matches threadId, sessionId and workspace");
  if (operation === "read") return { ...describe(session), output: session.buffer, truncated: session.buffer.length >= 16000 };
  if (operation === "write" && (typeof text !== "string" || !text || Buffer.byteLength(text) > 8192)) throw new Error("text must contain 1 to 8192 bytes");
  // ponytail: upstream sessions are exposed by a version-scoped patch; update patch when terminal manager changes.
  if (owners.get(session)?.sessions.get(session.id) !== session || !session.attached || session.owner.isDestroyed()) throw new Error("Terminal detached during request");
  await session.backend.write(operation === "interrupt" ? "\x03" : text as string);
  return { ...describe(session), written: true };
}

export async function startTerminalBridge(port: number, getManager: () => TerminalManager | TerminalManager[] | undefined) {
  const directory = path.join(os.homedir(), ".codex", "terminal-bridge");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Terminal bridge directory must be owned by current user with mode 0700");
  const socketPath = path.join(directory, `web-${port}.sock`);
  try {
    const existing = await fs.lstat(socketPath);
    if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error("Unexpected terminal socket owner or file type");
    const stale = await new Promise<boolean>((resolve, reject) => {
      const probe = net.createConnection(socketPath);
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("Cannot verify terminal socket owner")); });
      probe.once("connect", () => { probe.destroy(); resolve(false); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        probe.destroy();
        if (error.code === "ECONNREFUSED") resolve(true); else reject(error);
      });
    });
    if (!stale) throw new Error("Terminal bridge already running");
    const current = await fs.lstat(socketPath);
    if (current.ino !== existing.ino || current.dev !== existing.dev) throw new Error("Terminal socket changed during recovery");
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = net.createServer(socket => {
    let data = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (handled) return;
      data += chunk;
      if (Buffer.byteLength(data) > 16384) { socket.destroy(); return; }
      const end = data.indexOf("\n");
      if (end < 0) return;
      handled = true;
      Promise.resolve().then(() => terminalRequest(getManager(), JSON.parse(data.slice(0, end))))
        .then(result => socket.end(JSON.stringify({ ok: true, result }) + "\n"))
        .catch(error => socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n"));
    });
  });
  // Existing live sockets are never removed; stale sockets require owner and inode checks.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await fs.chmod(socketPath, 0o600);
  const ownedSocket = await fs.lstat(socketPath);
  const unlinkOwnedSocket = () => {
    try {
      const current = lstatSync(socketPath);
      if (current.ino === ownedSocket.ino && current.dev === ownedSocket.dev) unlinkSync(socketPath);
    } catch {}
  };
  const stop = () => { server.close(); unlinkOwnedSocket(); };
  process.once("SIGINT", () => { stop(); process.exit(0); });
  process.once("SIGTERM", () => { stop(); process.exit(0); });
  process.once("exit", unlinkOwnedSocket);
  return { server, socketPath, stop };
}
