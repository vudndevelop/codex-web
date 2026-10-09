import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { importTypescriptModule } from "./import-typescript-module.mjs";

const { saveBrowserCopy, wrapBrowserServices } = await importTypescriptModule(
  "src/browser/downloads.ts",
);
function environment(status = 200) {
  const events = [];
  return {
    events,
    async head(url) {
      events.push(["HEAD", url]);
      return {
        status,
        headers: new Headers({
          "content-disposition": "attachment; filename=example",
        }),
      };
    },
    start(url, name) {
      events.push(["start", url, name]);
    },
    createObjectURL(blob) {
      events.push(["blob", blob]);
      return "blob:test";
    },
    revokeObjectURL(url) {
      events.push(["revoke", url]);
    },
    deferCleanup(callback) {
      events.push(["cleanup", callback]);
    },
  };
}

test("local downloads preflight then start same-origin streaming with encoded filenames", async () => {
  for (const hostId of [undefined, null, "local"]) {
    const env = environment();
    assert.deepEqual(
      await saveBrowserCopy({ hostId, path: '/home/ml/中文 & #?".docx' }, env),
      { path: null, downloadStarted: true },
    );
    assert.equal(env.events.length, 2);
    assert.equal(env.events[0][0], "HEAD");
    const url = new URL(env.events[0][1], "https://codex.example");
    assert.equal(
      decodeURIComponent(url.pathname.slice(4)),
      '/home/ml/中文 & #?".docx',
    );
    assert.equal(url.searchParams.get("download"), "1");
    assert.equal(url.searchParams.has("token"), false);
    assert.deepEqual(env.events[1], [
      "start",
      env.events[0][1],
      '中文 & #?".docx',
    ]);
  }
});

test("optional filename is preserved without interpreting it as a path", async () => {
  const env = environment();
  await saveBrowserCopy(
    { path: "/tmp/source", fileName: "报告 ' (1).pdf" },
    env,
  );
  assert.equal(
    new URL(env.events[0][1], "http://test").searchParams.get("filename"),
    "报告 ' (1).pdf",
  );
  assert.equal(env.events[1][2], "报告 ' (1).pdf");
});

test("remote hosts and invalid paths never perform network or download work", async () => {
  for (const input of [
    { hostId: "ssh:other", path: "/tmp/file" },
    { hostId: "", path: "/tmp/file" },
    ...[
      "relative",
      "//other/file",
      "/tmp/../file",
      "/tmp/./file",
      "/tmp/",
      "/tmp/a\\b",
      "/tmp/a\n",
    ].map((path) => ({ path })),
    ...["", "../x", "a/b", "a\\b", "a\r\nb"].map((fileName) => ({
      path: "/tmp/file",
      fileName,
    })),
  ]) {
    const env = environment();
    await assert.rejects(saveBrowserCopy(input, env));
    assert.deepEqual(env.events, []);
  }
});

test("preflight failures do not claim initiation or trigger downloads", async () => {
  for (const status of [401, 403, 404, 500, 302]) {
    const env = environment(status);
    await assert.rejects(
      saveBrowserCopy({ path: "/tmp/file" }, env),
      new RegExp(String(status)),
    );
    assert.equal(env.events.length, 1);
  }
  const env = environment();
  env.head = async () => {
    throw new Error("network unavailable");
  };
  await assert.rejects(
    saveBrowserCopy({ path: "/tmp/file" }, env),
    /network unavailable/,
  );
  assert.deepEqual(env.events, []);
  env.head = async () => ({ status: 200, headers: new Headers() });
  await assert.rejects(
    saveBrowserCopy({ path: "/tmp/file" }, env),
    /preflight/,
  );
});

test("bytes, array buffers, views and empty contents stay in the browser", async () => {
  for (const bytes of [
    new Uint8Array(),
    [],
    new Uint8Array([0, 255, 42]),
    [0, 255, 42],
    new Uint8Array([0, 255, 42]).buffer,
    new Uint8Array([9, 0, 255, 42, 9]).subarray(1, 4),
  ]) {
    const env = environment();
    assert.deepEqual(
      await saveBrowserCopy({ bytes, fileName: "内容.zip" }, env),
      { path: null, downloadStarted: true },
    );
    assert.equal(env.events[0][0], "blob");
    const actual = new Uint8Array(await env.events[0][1].arrayBuffer());
    const expected =
      bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes);
    assert.deepEqual(actual, expected);
    assert.deepEqual(env.events[1], ["start", "blob:test", "内容.zip"]);
    assert.equal(env.events[2][0], "cleanup");
    env.events[2][1]();
    assert.deepEqual(env.events[3], ["revoke", "blob:test"]);
  }
});

test("invalid bytes are rejected and a failed click revokes its object URL immediately", async () => {
  for (const bytes of [[256], [-1], [0.5], ["1"], null, "base64"]) {
    const env = environment();
    await assert.rejects(saveBrowserCopy({ bytes, fileName: "file" }, env));
    assert.deepEqual(env.events, []);
  }
  const env = environment();
  env.start = () => {
    throw new Error("click failed");
  };
  await assert.rejects(
    saveBrowserCopy({ bytes: [], fileName: "file" }, env),
    /click failed/,
  );
  assert.deepEqual(env.events[1], ["revoke", "blob:test"]);
});

test("service wrapper does not enumerate RPC proxies and retains other receivers and identity", () => {
  const workspace = {
    value: 42,
    saveCopy() {
      throw new Error("native dialog must not run");
    },
    read() {
      assert.equal(this, workspace);
      return this.value;
    },
  };
  const statsig = { sentinel: true };
  const callableService = new Proxy(() => 7, {
    get(target, key) {
      if (key === "read") return () => 99;
      return Reflect.get(target, key);
    },
  });
  let rpc;
  rpc = new Proxy(
    {
      workspaceFiles: workspace,
      statsig,
      callableService,
      ping() {
        assert.equal(this, rpc);
        return 7;
      },
    },
    {
      ownKeys() {
        throw new Error("RPC must not be enumerated");
      },
    },
  );
  const wrapped = wrapBrowserServices(rpc);
  assert.equal(wrapped.workspaceFiles, wrapped.workspaceFiles);
  assert.equal(wrapped.workspaceFiles.saveCopy, saveBrowserCopy);
  assert.equal(wrapped.workspaceFiles.read(), 42);
  assert.equal(wrapped.workspaceFiles.read, wrapped.workspaceFiles.read);
  assert.equal(wrapped.statsig, statsig);
  assert.equal(wrapped.callableService.read(), 99);
  assert.equal(wrapped.callableService(), 7);
  assert.equal(wrapped.ping(), 7);
  assert.equal(
    wrapBrowserServices({ workspaceFiles: null }).workspaceFiles,
    null,
  );
});

async function withBrowserGlobals({ navigator, document }, callback) {
  const hadNavigator = Object.hasOwn(globalThis, "navigator");
  const hadDocument = Object.hasOwn(globalThis, "document");
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigator,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: document,
  });
  try {
    return await callback();
  } finally {
    if (hadNavigator) {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
    } else {
      delete globalThis.navigator;
    }
    if (hadDocument) {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    } else {
      delete globalThis.document;
    }
  }
}

function fakeDocument(execCommand) {
  const events = [];
  let textarea;
  const document = {
    body: {
      append(node) {
        textarea = node;
        events.push(["append", node]);
      },
    },
    createElement(tag) {
      assert.equal(tag, "textarea");
      return {
        style: {},
        value: "",
        focus() {
          events.push(["focus"]);
        },
        select() {
          events.push(["select"]);
        },
        remove() {
          events.push(["remove"]);
        },
      };
    },
    execCommand(command) {
      return execCommand(command, textarea, events);
    },
  };
  return { document, events };
}

test("clipboard service writes through the browser and preserves other methods", async () => {
  const writes = [];
  let nativeWriteCalled = false;
  const clipboard = {
    writeText() {
      nativeWriteCalled = true;
    },
    marker: 42,
    readMarker() {
      assert.equal(this, clipboard);
      return this.marker;
    },
  };
  const wrapped = wrapBrowserServices({ clipboard });
  await withBrowserGlobals(
    { navigator: { clipboard: { writeText: async (text) => writes.push(text) } }, document: undefined },
    async () => {
      assert.equal(wrapped.clipboard, wrapped.clipboard);
      assert.equal(wrapped.clipboard.marker, 42);
      assert.equal(wrapped.clipboard.readMarker(), 42);
      assert.equal(wrapped.clipboard.readMarker, wrapped.clipboard.readMarker);
      await wrapped.clipboard.writeText("浏览器剪贴板");
    },
  );
  assert.deepEqual(writes, ["浏览器剪贴板"]);
  assert.equal(nativeWriteCalled, false);
});

test("clipboard service falls back to a selected textarea when the Clipboard API fails", async () => {
  const { document, events } = fakeDocument((command, textarea) => {
    assert.equal(command, "copy");
    assert.equal(textarea.value, "fallback text");
    return true;
  });
  const wrapped = wrapBrowserServices({ clipboard: {} });
  await withBrowserGlobals(
    {
      navigator: {
        clipboard: {
          writeText: async () => {
            throw new Error("permission denied");
          },
        },
      },
      document,
    },
    () => wrapped.clipboard.writeText("fallback text"),
  );
  assert.deepEqual(events.map(([type]) => type), [
    "append",
    "focus",
    "select",
    "remove",
  ]);
});

test("clipboard service rejects when both browser copy paths fail", async () => {
  const { document } = fakeDocument(() => false);
  const wrapped = wrapBrowserServices({ clipboard: {} });
  await withBrowserGlobals(
    {
      navigator: {
        clipboard: {
          writeText: async () => {
            throw new Error("permission denied");
          },
        },
      },
      document,
    },
    async () => {
      await assert.rejects(
        wrapped.clipboard.writeText("cannot copy"),
        /permission denied/,
      );
    },
  );
});

test("built Desktop service initialization and artifact analytics use browser adapter", async () => {
  const initial = await readFile(
    "scratch/asar/webview/assets/app-shared-59042e7300f7.js",
    "utf8",
  );
  const header = await readFile(
    "scratch/asar/webview/assets/artifact-preview-header-a8f8d70ab2c5.js",
    "utf8",
  );
  const preload = await readFile(
    "scratch/asar/webview/assets/preload.js",
    "utf8",
  );
  assert.match(
    initial,
    /i6\s*=\s*window\.__ELECTRON_SHIM__\??\.wrapBrowserServices/,
  );
  assert.match(header, /downloadStarted/);
  assert.match(
    preload,
    /electronShim.wrapBrowserServices\s*=\s*\(services\)\s*=>/,
  );
  assert.match(preload, /wrapBrowserServices\(services\)/);
  assert.match(preload, /setPreviewSound/);
});
