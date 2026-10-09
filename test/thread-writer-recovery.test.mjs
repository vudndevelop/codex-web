import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as asar from "@electron/asar";
import { patchWriterRecovery } from "../scripts/patch-thread-writer-recovery.mjs";
const require = createRequire(import.meta.url);
const { recoverWriterConflict } = require("../src/server/thread-writer-recovery.cjs");

function fixture() {
  const calls = [];
  let role = null;
  const manager = {
    disposed: false,
    getHostId: () => "local",
    getStreamRole: () => role,
    getConversation: () => ({ resumeState: "resumed" }),
    ipcBridge: {
      async request(method, params) {
        calls.push({ method, params });
        return { resultType: "success", handledByClientId: "desktop-owner" };
      },
    },
    streamState: {
      followedConversationIds: new Set(["chat"]),
      params: {
        transport: {
          async sendFollowingChanged(...args) {
            calls.push(args);
            role = { role: "follower", ownerClientId: "desktop-owner" };
          },
        },
      },
    },
  };
  return { manager, calls, setRole: value => { role = value; } };
}
const conflict = new Error("thread chat already has an active writer");

test("writer conflict follows existing owner instead of issuing another resume", async () => {
  const { manager, calls } = fixture();
  assert.equal(await recoverWriterConflict(manager, "chat", conflict), true);
  assert.deepEqual(calls, [
    { method: "thread-owner-discovery", params: { hostId: "local", conversationId: "chat" } },
    ["chat", "local", true, ["desktop-owner"]],
  ]);
});

test("unrelated errors, remote hosts, inactive views and missing owners remain blocked", async () => {
  for (const modify of [
    m => { m.getHostId = () => "remote"; },
    m => { m.streamState.followedConversationIds.clear(); },
    m => { m.ipcBridge = null; },
    m => { m.ipcBridge.request = async () => ({ resultType: "error", error: "no-client-found" }); },
  ]) {
    const { manager } = fixture();
    modify(manager);
    assert.equal(await recoverWriterConflict(manager, "chat", conflict, 20), false);
  }
  const { manager, calls } = fixture();
  assert.equal(await recoverWriterConflict(manager, "chat", new Error("invalid config.toml")), false);
  assert.deepEqual(calls, []);
});

test("only snapshot from discovered owner establishes readiness; stale or unavailable owner fails", async () => {
  const { manager, setRole } = fixture();
  manager.streamState.params.transport.sendFollowingChanged = async () => {
    setRole({ role: "follower", ownerClientId: "wrong-owner" });
  };
  assert.equal(await recoverWriterConflict(manager, "chat", conflict, 20), false);
  manager.disposed = true;
  assert.equal(await recoverWriterConflict(manager, "chat", conflict, 20), false);
});

test("live local writer waits for owner snapshot and abandons a closed view", async () => {
  const { manager, setRole } = fixture();
  manager.streamState.params.transport.sendFollowingChanged = async () => {
    setTimeout(() => setRole({ role: "follower", ownerClientId: "desktop-owner" }), 10);
  };
  assert.equal(await recoverWriterConflict(manager, "chat", new Error("already has a live local writer"), 100), true);
  setRole(null);
  manager.streamState.params.transport.sendFollowingChanged = async () => {
    manager.streamState.followedConversationIds.clear();
  };
  assert.equal(await recoverWriterConflict(manager, "chat", conflict, 100), false);
});

test("patch uses real resume wrapper in pinned web and installed app; no second resume or hidden errors", async () => {
  const archive = "/Applications/ChatGPT.app/Contents/Resources/app.asar";
  const sources = [
    [await readFile("scratch/asar/.vite/build/bootstrap-yYZ8rgHq.js", "utf8"), false],
    [await readFile("scratch/asar/webview/assets/app-shared-59042e7300f7.js", "utf8"), true],
  ];
  if (existsSync(archive)) {
    const installed = asar.listPackage(archive).filter(p => /\.vite\/build\/bootstrap-.*\.js$/.test(p));
    assert.equal(installed.length, 1);
    sources.push([asar.extractFile(archive, installed[0].replace(/^\//, "")).toString(), false]);
  }
  for (const [source, browser] of sources) {
    const patched = patchWriterRecovery(source, browser);
    assert.equal(patchWriterRecovery(patched, browser), patched);
    const start = patched.search(/async\s+resumeConversation\(/);
    const end = patched.indexOf("assertThreadFollowerOwner(", start);
    assert.ok(start >= 0 && end > start);
    const methods = patched.slice(start, end);
    const Runtime = new Function("require", "$b", "iv", "L6t", "i6", `return class {
      constructor(manager, failure) { Object.assign(this, manager); this.failure = failure; this.history = {}; this.resumes = 0; }
      async #e() { this.resumes++; throw this.failure; }
      ${methods}
    }`)(() => ({ recoverWriterConflict }), () => null, () => null, () => null, { clientCoordination: { findThreadOwner: async () => "desktop-owner" } });
    const { manager } = fixture();
    const runtime = new Runtime(manager, conflict);
    assert.equal((await runtime.resumeConversation({ conversationId: "chat" })).status, "ready");
    assert.equal(runtime.resumes, 1);
    const configError = new Error("invalid config.toml");
    const failed = new Runtime(manager, configError);
    await assert.rejects(failed.resumeConversation({ conversationId: "chat" }), error => error === configError);
    assert.equal(failed.resumes, 1);
  }
  assert.throws(() => patchWriterRecovery("unknown version"), /Expected one compatible/);
});
