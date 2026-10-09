#!/usr/bin/env node

declare global {
  var __CODEX_SHIM_VALUES__: {
    version: string;
  };
}

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { parseArgs as parseCliArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { installModuleAliasHook } from "./module";
import { startupRecovery } from "./startup-recovery";
import { glob } from "glob";
import { startTerminalBridge, type TerminalManager } from "./terminal-bridge";
import {
  assertTokenRequirement,
  installAuthHook,
  isAuthorizedRequest,
  isSafeRequestTarget,
} from "./auth";
import { sanitizeMcpRequestPaths } from "./mcp-request-path-sanitizer";
import { readAssetVersion } from "./asset-version";
import { installDownloadHooks } from "./downloads";
import { installFeatureConfigRoute } from "./feature-config";
import { SharedObjectHttp } from "./shared-object-http";
import { BinaryReadHttp } from "./binary-read-http";
import { getRendererParent } from "./electron/index";
import {
  rendererConnections,
  type NativeRendererMessage,
  type RendererConnection,
} from "./renderer-connection";
import {
  parsePositiveInteger,
  UploadLimitError,
  UploadStore,
} from "./upload-store";

export type ServerOptions = {
  host: string;
  port: number;
  token: string | null;
  maxUploadBytes: number;
  maxUploadRequestBytes: number;
  maxUploadFiles: number;
  maxUploadDiskBytes: number;
  uploadTtlMs: number;
  maxConcurrentUploads: number;
  uploadRootDir: string;
};

const MEBIBYTE = 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 100 * MEBIBYTE;
const DEFAULT_MAX_UPLOAD_REQUEST_BYTES = 500 * MEBIBYTE;
const DEFAULT_MAX_UPLOAD_FILES = 20;
const DEFAULT_MAX_UPLOAD_DISK_BYTES = 2 * 1024 * MEBIBYTE;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const SOCKET_PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 2;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 64 * MEBIBYTE;

type RendererToMainMessage =
  | { type: "bridge-ping"; requestId: string }
  | {
      type: "ipc-renderer-invoke";
      requestId: string;
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-send";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-post-message";
      channel: string;
      message: unknown;
      portIds: string[];
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    }
  | {
      type: "workspace-directory-entries-request";
      requestId: string;
      directoryPath: string | null;
      directoriesOnly: boolean;
    };

type MainToRendererMessage =
  | { type: "bridge-pong"; requestId: string }
  | { type: "shared-object-http-update"; revision: number }
  | {
      type: "ipc-main-event";
      channel: string;
      args: unknown[];
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "ipc-renderer-invoke-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: true;
      result: WorkspaceDirectoryEntries;
    }
  | {
      type: "workspace-directory-entries-result";
      requestId: string;
      ok: false;
      errorMessage: string;
    }
  | {
      type: "message-port-message";
      portId: string;
      data: unknown;
    }
  | {
      type: "message-port-close";
      portId: string;
    };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
};

type WorkspaceDirectoryEntries = {
  directoryPath: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
};

type MessagePortListener = (...args: unknown[]) => void;

type BridgedMessagePort = {
  close: () => void;
  on: (event: string, listener: MessagePortListener) => unknown;
  postMessage: (message: unknown) => void;
  start: () => void;
};

class WebSocketMessagePort implements BridgedMessagePort {
  private closed = false;
  private readonly listeners = new Map<string, Set<MessagePortListener>>();

  constructor(
    private readonly portId: string,
    private readonly sendToRenderer: (message: MainToRendererMessage) => void,
    private readonly onClosed: () => void,
  ) {}

  on(event: string, listener: MessagePortListener): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);

    return this;
  }

  off(event: string, listener: MessagePortListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  postMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-message",
      portId: this.portId,
      data,
    });
  }

  start(): void {}
  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (!this.markClosed()) {
      return;
    }
    this.sendToRenderer({
      type: "message-port-close",
      portId: this.portId,
    });
    this.emit("close");
    this.listeners.clear();
  }

  receiveMessage(data: unknown): void {
    if (this.closed) {
      return;
    }
    const listeners = this.listeners.get("message");
    if (!listeners || listeners.size === 0) {
      return;
    }
    for (const listener of listeners) {
      listener({ data });
    }
  }

  disconnect(): void {
    if (!this.markClosed()) {
      return;
    }
    this.emit("close");
    this.listeners.clear();
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  private markClosed(): boolean {
    if (this.closed) {
      return false;
    }
    this.closed = true;
    this.onClosed();
    return true;
  }
}

function workspaceDirectoryEntryTypeRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.type === "directory" ? 0 : 1;
}

function workspaceDirectoryEntryHiddenRank(
  entry: WorkspaceDirectoryEntry,
): number {
  return entry.name.startsWith(".") ? 1 : 0;
}

function compareWorkspaceDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  return (
    workspaceDirectoryEntryTypeRank(left) -
      workspaceDirectoryEntryTypeRank(right) ||
    workspaceDirectoryEntryHiddenRank(left) -
      workspaceDirectoryEntryHiddenRank(right) ||
    left.name.localeCompare(right.name)
  );
}

type IpcMainBridgeState = {
  broadcastToRenderer?: (message: MainToRendererMessage) => void;
  handleRendererInvoke?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
    connection?: RendererConnection,
  ) => Promise<unknown>;
  handleRendererPostMessage?: (
    channel: string,
    message: unknown,
    ports: BridgedMessagePort[],
    sourceUrl?: string,
    connection?: RendererConnection,
  ) => void;
  handleRendererSend?: (
    channel: string,
    args: unknown[],
    sourceUrl?: string,
    connection?: RendererConnection,
  ) => void;
};

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  server [--host <host>] [--port <port>] [--token <token>] [upload limits]",
      "",
      "Defaults:",
      "  --host 127.0.0.1",
      "  --port 8214",
      "  --token unset (or CODEX_WEB_TOKEN); required for non-loopback hosts",
      `  --max-upload-bytes ${DEFAULT_MAX_UPLOAD_BYTES}`,
      `  --max-upload-request-bytes ${DEFAULT_MAX_UPLOAD_REQUEST_BYTES}`,
      `  --max-upload-files ${DEFAULT_MAX_UPLOAD_FILES}`,
      `  --max-upload-disk-bytes ${DEFAULT_MAX_UPLOAD_DISK_BYTES}`,
      `  --upload-ttl-ms ${DEFAULT_UPLOAD_TTL_MS}`,
      `  --max-concurrent-uploads ${DEFAULT_MAX_CONCURRENT_UPLOADS}`,
      `  --upload-root ${os.tmpdir()} (or CODEX_WEB_UPLOAD_ROOT)`,
      "",
      "Examples:",
      "  yarn server",
      "  yarn server --port 9000",
      "  yarn server --host 100.64.0.10 --token my-secret-token",
    ].join("\n"),
  );
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

function parseLimit(
  cliValue: string | undefined,
  envValue: string | undefined,
  fallback: number,
  label: string,
): number {
  const raw = cliValue ?? envValue;
  return raw === undefined ? fallback : parsePositiveInteger(raw, label);
}

export function parseServerArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ServerOptions {
  const parsed = parseCliArgs({
    args,
    allowPositionals: false,
    options: {
      help: {
        short: "h",
        type: "boolean",
      },
      host: {
        type: "string",
      },
      port: {
        type: "string",
      },
      token: {
        type: "string",
      },
      "max-upload-bytes": {
        type: "string",
      },
      "max-upload-request-bytes": {
        type: "string",
      },
      "max-upload-files": {
        type: "string",
      },
      "max-upload-disk-bytes": {
        type: "string",
      },
      "upload-ttl-ms": {
        type: "string",
      },
      "max-concurrent-uploads": {
        type: "string",
      },
      "upload-root": {
        type: "string",
      },
    },
    strict: true,
  });

  if (parsed.values.help) {
    printUsage();
    process.exit(0);
  }

  const token = parsed.values.token ?? env.CODEX_WEB_TOKEN ?? null;
  if (token !== null && token.length === 0) {
    throw new Error("auth token must not be empty");
  }
  const uploadRootDir =
    parsed.values["upload-root"] ?? env.CODEX_WEB_UPLOAD_ROOT ?? os.tmpdir();
  if (!path.isAbsolute(uploadRootDir)) {
    throw new Error(`upload root must be absolute: ${uploadRootDir}`);
  }

  return {
    host: parsed.values.host ?? "127.0.0.1",
    port: parsed.values.port ? parsePort(parsed.values.port) : 8214,
    token,
    maxUploadBytes: parseLimit(
      parsed.values["max-upload-bytes"],
      env.CODEX_WEB_MAX_UPLOAD_BYTES,
      DEFAULT_MAX_UPLOAD_BYTES,
      "max upload bytes",
    ),
    maxUploadRequestBytes: parseLimit(
      parsed.values["max-upload-request-bytes"],
      env.CODEX_WEB_MAX_UPLOAD_REQUEST_BYTES,
      DEFAULT_MAX_UPLOAD_REQUEST_BYTES,
      "max upload request bytes",
    ),
    maxUploadFiles: parseLimit(
      parsed.values["max-upload-files"],
      env.CODEX_WEB_MAX_UPLOAD_FILES,
      DEFAULT_MAX_UPLOAD_FILES,
      "max upload files",
    ),
    maxUploadDiskBytes: parseLimit(
      parsed.values["max-upload-disk-bytes"],
      env.CODEX_WEB_MAX_UPLOAD_DISK_BYTES,
      DEFAULT_MAX_UPLOAD_DISK_BYTES,
      "max upload disk bytes",
    ),
    uploadTtlMs: parseLimit(
      parsed.values["upload-ttl-ms"],
      env.CODEX_WEB_UPLOAD_TTL_MS,
      DEFAULT_UPLOAD_TTL_MS,
      "upload TTL milliseconds",
    ),
    maxConcurrentUploads: parseLimit(
      parsed.values["max-concurrent-uploads"],
      env.CODEX_WEB_MAX_CONCURRENT_UPLOADS,
      DEFAULT_MAX_CONCURRENT_UPLOADS,
      "max concurrent uploads",
    ),
    uploadRootDir,
  };
}

function getIpcMainBridgeState(): IpcMainBridgeState {
  const globals = globalThis as typeof globalThis & {
    __codexElectronIpcBridge?: IpcMainBridgeState;
  };
  if (!globals.__codexElectronIpcBridge) {
    globals.__codexElectronIpcBridge = {};
  }
  return globals.__codexElectronIpcBridge;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function sanitizeOutboundMcpRequest(value: unknown): void {
  const result = sanitizeMcpRequestPaths(value, os.homedir());
  if (!result) {
    return;
  }

  const changedKeys = [...new Set(result.changes.map((change) => change.key))];
  console.log(
    `[mcp-request-sanitizer] ${result.method}: normalized ${result.changes.length} path value(s) in ${changedKeys.join(", ")}`,
  );
}

function sanitizeOutboundMcpRequestArgs(args: unknown[]): void {
  for (const argument of args) {
    sanitizeOutboundMcpRequest(argument);
  }
}

function uploadErrorStatus(error: unknown): number | null {
  if (error instanceof UploadLimitError) {
    return error.statusCode;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (
    code === "FST_REQ_FILE_TOO_LARGE" ||
    code === "FST_FILES_LIMIT" ||
    code === "FST_PARTS_LIMIT" ||
    code === "FST_FIELDS_LIMIT"
  ) {
    return 413;
  }
  return null;
}

function writeRawHttpError(
  socket: Duplex,
  statusCode: number,
  statusText: string,
  body: { error: string },
): void {
  const payload = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      "Cache-Control: no-store\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      "Connection: close\r\n" +
      "\r\n" +
      payload,
  );
}

async function getWorkspaceDirectoryEntries({
  directoryPath,
  directoriesOnly,
}: {
  directoryPath: string | null;
  directoriesOnly: boolean;
}): Promise<WorkspaceDirectoryEntries> {
  const requestedPath = directoryPath?.trim() || os.homedir();
  const resolvedPath = path.resolve(requestedPath);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Directory not found: ${requestedPath}`);
  }

  const entries = (await fs.readdir(resolvedPath, { withFileTypes: true }))
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const type = entry.isDirectory() ? "directory" : "file";
      if (directoriesOnly && type !== "directory") {
        return [];
      }

      return [
        {
          name: entry.name,
          path: path.join(resolvedPath, entry.name),
          type,
        },
      ];
    })
    .sort(compareWorkspaceDirectoryEntries);

  const rootPath = path.parse(resolvedPath).root;
  const parentPath =
    resolvedPath === rootPath ? null : path.dirname(resolvedPath);

  return {
    directoryPath: resolvedPath,
    parentPath,
    entries,
  };
}

function ensureElectronLikeProcessContext(): void {
  process.env.BUILD_FLAVOR = "prod";

  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  if (!versions.electron) {
    Object.defineProperty(versions, "electron", {
      value: "41.2.0",
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }

  const processWithElectronFields = process as NodeJS.Process & {
    getSystemVersion?: () => string;
    resourcesPath?: string;
    type?: string;
  };
  const systemVersion =
    process.platform === "darwin"
      ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
          encoding: "utf8",
        }).trim()
      : os.release();
  processWithElectronFields.getSystemVersion ??= () => systemVersion;
  processWithElectronFields.resourcesPath ??= path.resolve(
    __dirname,
    "../../scratch/asar",
  );
  processWithElectronFields.type ??= "browser";
}

export async function startIpcBridgeServer(
  options: ServerOptions,
  { launchDesktopApp = true }: { launchDesktopApp?: boolean } = {},
): Promise<FastifyInstance> {
  const bridgeState = getIpcMainBridgeState();
  const app = Fastify({ logger: false });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    perMessageDeflate: {
      threshold: 2 * 1024,
      concurrencyLimit: 4,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 3 },
    },
  });
  const sockets = new Set<WebSocket>();
  const portCounts = new Map<WebSocket, Map<string, WebSocketMessagePort>>();
  const missedPings = new Map<WebSocket, number>();
  // Desktop sees a single renderer. Balance its reference-counted subscriptions
  // across browser sockets, including sockets lost during refresh/reconnect.
  const sharedObjectSubscriptions = new Map<WebSocket, Map<string, number>>();
  const sharedObjectHttp = new SharedObjectHttp();
  const binaryReadHttp = new BinaryReadHttp();
  const httpClients = new Map<WebSocket, string>();
  const rendererClients = new Map<string, RendererConnection>();
  const rendererSockets = new WeakMap<RendererConnection, WebSocket>();
  const socketRenderers = new Map<WebSocket, RendererConnection>();
  const viewMessageChannel = "codex_desktop:message-from-view";
  const snapshotRevision = Symbol("shared-object-revision");
  type PreparedMessage = NativeRendererMessage & {
    [snapshotRevision]?: number;
  };
  const invokeForClient = (
    event: unknown,
    clientId: string,
    owner?: object,
  ) => {
    const connection =
      (owner as RendererConnection | undefined) ??
      rendererClients.get(clientId);
    if (!connection || connection.closed)
      throw new Error("Renderer connection closed");
    if (!bridgeState.handleRendererInvoke)
      throw new Error("Desktop bridge unavailable");
    return bridgeState.handleRendererInvoke(
      viewMessageChannel,
      [event],
      undefined,
      connection,
    );
  };

  if (options.token !== null) {
    installAuthHook(app, options.token);
  }
  await installFeatureConfigRoute(app);
  await sharedObjectHttp.install(app, invokeForClient);
  await binaryReadHttp.install(app, invokeForClient);

  await app.register(fastifyMultipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: options.maxUploadBytes,
      files: options.maxUploadFiles,
      fields: 0,
      parts: options.maxUploadFiles,
    },
  });

  const uploadStore = await UploadStore.create(
    {
      maxFileBytes: options.maxUploadBytes,
      maxRequestBytes: options.maxUploadRequestBytes,
      maxFiles: options.maxUploadFiles,
      maxDiskBytes: options.maxUploadDiskBytes,
      ttlMs: options.uploadTtlMs,
      maxConcurrentRequests: options.maxConcurrentUploads,
    },
    options.uploadRootDir,
  );

  app.post("/__backend/upload", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart upload body" });
    }

    try {
      const files = await uploadStore.saveParts(request.files());
      return reply.send({ files });
    } catch (error) {
      const statusCode = uploadErrorStatus(error);
      if (statusCode !== null) {
        return reply.code(statusCode).send({
          error:
            error instanceof UploadLimitError
              ? error.message
              : "upload exceeds configured limits",
        });
      }
      throw error;
    }
  });

  await app.register(async (fileApp) => {
    installDownloadHooks(fileApp);
    // Keep the file sender separate from precompressed webview assets.
    await fileApp.register(fastifyStatic, {
      root: "/",
      prefix: "/@fs/",
    });
  });

  const webviewRoot = path.resolve(__dirname, "../../scratch/asar/webview");
  const assetVersion = await readAssetVersion(webviewRoot);
  const versionedAssetPrefix = `/assets/__build/${assetVersion}/`;

  app.addHook("onSend", async (request, reply) => {
    const pathname = (request.raw.url ?? request.url).split("?", 1)[0];
    if (
      (reply.statusCode === 200 || reply.statusCode === 304) &&
      (pathname === "/assets/preload.js" ||
        pathname === "/assets/preload.js.map")
    ) {
      reply.header("cache-control", "no-cache");
    }
  });

  await app.register(fastifyStatic, {
    root: path.join(webviewRoot, "assets"),
    prefix: versionedAssetPrefix,
    decorateReply: false,
    preCompressed: true,
    maxAge: "1y",
    immutable: true,
  });

  await app.register(fastifyStatic, {
    root: path.join(webviewRoot, "assets"),
    prefix: "/assets/",
    decorateReply: false,
    preCompressed: true,
    maxAge: "1y",
    immutable: true,
  });

  await app.register(fastifyStatic, {
    root: webviewRoot,
    prefix: "/",
    preCompressed: true,
  });

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });
  app.get("/__backend/diagnostics", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      buildId: assetVersion,
      connections: sockets.size,
      ports: [...portCounts.values()].reduce(
        (sum, ports) => sum + ports.size,
        0,
      ),
      bufferedBytes: [...sockets].reduce(
        (sum, socket) => sum + socket.bufferedAmount,
        0,
      ),
      chunkedIpc: rendererConnections.diagnostics(),
      startup: startupRecovery.diagnostics(),
    };
  });
  app.get("/__backend/version", async (_request, reply) => {
    return reply
      .header("Cache-Control", "no-store")
      .send({ buildId: assetVersion });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/@fs/") || request.url.startsWith("/assets/")) {
      return reply.code(404).send({ error: "Not Found" });
    }

    if (request.method === "GET") {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const requestUrl = request.url ?? "/";
    if (!isSafeRequestTarget(requestUrl)) {
      writeRawHttpError(socket, 400, "Bad Request", {
        error: "invalid request path",
      });
      return;
    }

    let url: URL;
    try {
      url = new URL(requestUrl, "http://localhost");
    } catch {
      writeRawHttpError(socket, 400, "Bad Request", {
        error: "invalid request URL",
      });
      return;
    }
    if (url.pathname !== "/__backend/ipc") {
      writeRawHttpError(socket, 404, "Not Found", { error: "not found" });
      return;
    }

    if (
      options.token !== null &&
      !isAuthorizedRequest(
        options.token,
        request.headers.cookie,
        url.searchParams.get("token"),
      )
    ) {
      writeRawHttpError(socket, 401, "Unauthorized", {
        error: "unauthorized",
      });
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (upgradedSocket) => {
      websocketServer.emit("connection", upgradedSocket, request);
    });
  });

  const prepareGlobal = (
    message: NativeRendererMessage,
    owner?: RendererConnection,
  ): PreparedMessage | null => {
    const envelope = {
      type: "ipc-main-event",
      channel: message.channel,
      args: [message.payload],
    };
    if (binaryReadHttp.capture(envelope, owner)) return null;
    const event =
      message.channel === "codex_desktop:message-for-view"
        ? (message.payload as { type?: string; key?: unknown } | undefined)
        : undefined;
    if (
      event?.type === "shared-object-updated" &&
      event.key === "statsig_evaluations"
    )
      return {
        ...message,
        [snapshotRevision]: sharedObjectHttp.capture(envelope),
      };
    return message;
  };
  const prepareConnection = (
    connection: RendererConnection,
    message: PreparedMessage,
  ): NativeRendererMessage | null => {
    const socket = rendererSockets.get(connection);
    if (!socket || socket.readyState !== WebSocket.OPEN || connection.closed)
      return null;
    const event =
      message.channel === "codex_desktop:message-for-view"
        ? (message.payload as { type?: string; key?: unknown } | undefined)
        : undefined;
    const sharedKey =
      event?.type === "shared-object-updated" && typeof event.key === "string"
        ? event.key
        : null;
    if (
      sharedKey !== null &&
      !sharedObjectSubscriptions.get(socket)?.has(sharedKey)
    )
      return null;
    const revision = message[snapshotRevision];
    if (revision !== undefined && httpClients.has(socket)) {
      socket.send(
        JSON.stringify({ type: "shared-object-http-update", revision }),
      );
      return null;
    }
    return message;
  };
  rendererConnections.configure({ prepareGlobal, prepareConnection });
  const deliverScoped = (
    connection: RendererConnection,
    channel: string,
    args: unknown[],
    prepared = false,
  ) => {
    const socket = rendererSockets.get(connection);
    if (!socket || socket.readyState !== WebSocket.OPEN || connection.closed)
      return;
    // Native sender messages were prepared intact before encoding. Raw sender
    // replies still pass through the HTTP bypass and subscription filters.
    if (!prepared) {
      const message = prepareGlobal({ channel, payload: args[0] }, connection);
      if (!message || !prepareConnection(connection, message)) return;
    }
    socket.send(JSON.stringify({ type: "ipc-main-event", channel, args }));
  };
  bridgeState.broadcastToRenderer = (message: MainToRendererMessage): void => {
    if (message.type !== "ipc-main-event") return;
    const prepared = prepareGlobal({
      channel: message.channel,
      payload: message.args[0],
    });
    if (!prepared) return;
    for (const [socket, connection] of socketRenderers) {
      if (!prepareConnection(connection, prepared)) continue;
      socket.send(JSON.stringify(message));
    }
  };

  websocketServer.on("connection", (socket, request) => {
    // Also consume protocol errors on a rejected capability handshake.
    socket.on("error", () => {});
    sockets.add(socket);
    missedPings.set(socket, 0);
    const subscriptions = new Map<string, number>();
    sharedObjectSubscriptions.set(socket, subscriptions);
    const parameters = new URL(request.url ?? "/", "http://localhost")
      .searchParams;
    if (parameters.get("sharedObjectHttp") === "1") {
      const clientId = parameters.get("clientId") ?? "";
      if (
        !/^[0-9a-f-]{36}$/.test(clientId) ||
        !sharedObjectHttp.connect(clientId, () =>
          subscriptions.has("statsig_evaluations"),
        )
      ) {
        sockets.delete(socket);
        missedPings.delete(socket);
        sharedObjectSubscriptions.delete(socket);
        socket.close(1008, "invalid shared object client");
        return;
      }
      httpClients.set(socket, clientId);
    }

    // ws already closes protocol/size/decompression failures with the correct
    // close code. Consume its error event so a rejected frame cannot terminate
    // the Node process, and never log frame data or authentication material.
    const messagePorts = new Map<string, WebSocketMessagePort>();
    portCounts.set(socket, messagePorts);
    let connection!: RendererConnection;
    connection = rendererConnections.createConnection({
      parent: getRendererParent,
      deliver: (channel, args, prepared) =>
        deliverScoped(connection, channel, args, prepared),
      fail: () => {
        if (socket.readyState === WebSocket.OPEN)
          socket.close(1011, "Message acknowledgement timed out");
      },
      beforeClose: () => {
        const clientId = httpClients.get(socket);
        if (clientId) binaryReadHttp.disconnect(clientId);
        if (clientId) sharedObjectHttp.disconnect(clientId);
        if (clientId) rendererClients.delete(clientId);
        httpClients.delete(socket);
        for (const port of messagePorts.values()) port.disconnect();
        messagePorts.clear();
        subscriptions.clear();
        socketRenderers.delete(socket);
      },
    });
    socketRenderers.set(socket, connection);
    rendererSockets.set(connection, socket);
    const clientId = httpClients.get(socket);
    if (clientId) {
      rendererClients.set(clientId, connection);
      if (parameters.get("binaryReadHttp") === "1")
        binaryReadHttp.connect(clientId, connection);
    }
    const dispatchPostMessage = (
      channel: string,
      message: unknown,
      ports: WebSocketMessagePort[],
    ): void => {
      const handler = bridgeState.handleRendererPostMessage;
      if (handler) {
        handler(channel, message, ports, undefined, connection);
        return;
      }

      console.error(
        `[ipc-bridge] no ipcMain postMessage handler for channel ${channel}`,
      );
      for (const port of ports) {
        port.close();
      }
    };

    socket.on("pong", () => {
      missedPings.set(socket, 0);
    });

    socket.on("close", () => {
      connection.close();
      sockets.delete(socket);
      portCounts.delete(socket);
      missedPings.delete(socket);
      sharedObjectSubscriptions.delete(socket);
    });

    socket.on("message", (rawData) => {
      if (connection.closed) return;
      let message: RendererToMainMessage;
      try {
        message = JSON.parse(String(rawData)) as RendererToMainMessage;
      } catch (error) {
        console.error("[ipc-bridge] invalid JSON payload", error);
        return;
      }

      if (message.type === "bridge-ping") {
        if (
          typeof message.requestId === "string" &&
          message.requestId.length <= 128
        ) {
          socket.send(
            JSON.stringify({
              type: "bridge-pong",
              requestId: message.requestId,
            }),
          );
        }
        return;
      }

      if (message.type === "ipc-renderer-send") {
        if (!Array.isArray(message.args)) {
          return;
        }
        sanitizeOutboundMcpRequestArgs(message.args);
        bridgeState.handleRendererSend?.(
          message.channel,
          message.args,
          undefined,
          connection,
        );
        return;
      }

      if (message.type === "ipc-renderer-post-message") {
        if (!Array.isArray(message.portIds)) {
          return;
        }
        sanitizeOutboundMcpRequest(message.message);
        if (new Set(message.portIds).size !== message.portIds.length) {
          console.error("[ipc-bridge] duplicate transferred MessagePort id");
          return;
        }

        const ports = message.portIds.map((portId) => {
          const existingPort = messagePorts.get(portId);
          if (existingPort) {
            existingPort.disconnect();
          }
          const port = new WebSocketMessagePort(
            portId,
            (message) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(message));
              }
            },
            () => messagePorts.delete(portId),
          );
          messagePorts.set(portId, port);
          return port;
        });

        dispatchPostMessage(message.channel, message.message, ports);
        return;
      }

      if (message.type === "message-port-message") {
        sanitizeOutboundMcpRequest(message.data);
        messagePorts.get(message.portId)?.receiveMessage(message.data);
        return;
      }

      if (message.type === "message-port-close") {
        messagePorts.get(message.portId)?.disconnect();
        return;
      }

      if (message.type === "workspace-directory-entries-request") {
        const { requestId } = message;
        getWorkspaceDirectoryEntries(message)
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: true,
              result,
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "workspace-directory-entries-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          });
        return;
      }

      if (message.type === "ipc-renderer-invoke") {
        if (!Array.isArray(message.args)) {
          return;
        }
        const { channel, requestId, args } = message;
        sanitizeOutboundMcpRequestArgs(args);
        const event =
          channel === viewMessageChannel
            ? (args[0] as { type?: string; key?: unknown } | undefined)
            : undefined;
        let forward = true;
        if (typeof event?.key === "string") {
          const count = subscriptions.get(event.key) ?? 0;
          if (event.type === "shared-object-subscribe") {
            subscriptions.set(event.key, count + 1);
          } else if (event.type === "shared-object-unsubscribe") {
            // An unbalanced client must not release another tab's subscription.
            forward = count > 0;
            if (count > 1) subscriptions.set(event.key, count - 1);
            else subscriptions.delete(event.key);
          }
        }
        Promise.resolve(
          !forward
            ? null
            : (bridgeState.handleRendererInvoke?.(
                channel,
                args,
                undefined,
                connection,
              ) ??
                Promise.reject(
                  new Error(
                    `[ipc-bridge] no ipcMain.handle for channel ${channel}`,
                  ),
                )),
        )
          .then((result) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: true,
              result,
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          })
          .catch((error) => {
            const payload: MainToRendererMessage = {
              type: "ipc-renderer-invoke-result",
              requestId,
              ok: false,
              errorMessage: errorMessage(error),
            };
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify(payload));
            }
          });
      }
    });
  });

  const pingInterval = setInterval(() => {
    for (const socket of sockets) {
      const missed = missedPings.get(socket) ?? 0;
      if (missed >= MAX_MISSED_PONGS) {
        socket.terminate();
        continue;
      }
      missedPings.set(socket, missed + 1);
      socket.ping();
    }
  }, SOCKET_PING_INTERVAL_MS);
  pingInterval.unref();

  app.addHook("onClose", async () => {
    clearInterval(pingInterval);
    for (const socket of sockets) {
      socketRenderers.get(socket)?.close();
      socket.terminate();
    }
    sockets.clear();
    missedPings.clear();
    websocketServer.close();
    await uploadStore.dispose();
  });

  await app.listen({ host: options.host, port: options.port });
  console.log(`IPC bridge listening at ws://${options.host}:${options.port}`);

  if (!launchDesktopApp) {
    return app;
  }

  ensureElectronLikeProcessContext();
  installModuleAliasHook();

  const packageJson = JSON.parse(
    await fs.readFile(
      path.resolve(__dirname, "../../scratch/asar/package.json"),
      "utf8",
    ),
  );

  globalThis.__CODEX_SHIM_VALUES__ = {
    version: packageJson.version,
  };

  const matches = await glob("../../scratch/asar/.vite/build/main-*.js", {
    nodir: true,
    cwd: __dirname,
  });

  if (matches.length === 0) {
    throw new Error("no main bundle found");
  }

  if (matches.length > 1) {
    throw new Error("multiple main bundles found");
  }

  const module = require(matches[0]!);
  const spawnHelper = path.resolve(__dirname, "../../scratch/asar/node_modules/node-pty/build/Release/spawn-helper");
  if (process.platform === "darwin") {
    const stat = await fs.stat(spawnHelper);
    await fs.chmod(spawnHelper, stat.mode | 0o100);
  }
  await startTerminalBridge(options.port, () => {
    const managers = (globalThis as typeof globalThis & {
      __codexWebTerminalManagers?: Set<TerminalManager>;
    }).__codexWebTerminalManagers;
    if (!managers) return undefined;
    return [...managers];
  });
  module.runMainAppStartup();
  return app;
}

async function main(args: string[]) {
  const options = parseServerArgs(args, process.env);
  assertTokenRequirement(options.host, options.token);

  await startIpcBridgeServer(options);
}

if (require.main === module) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
