import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { BrowserWindow } = require("../src/server/electron/index.js");

test("macOS Desktop startup can reset the Dock icon and menu", () => {
  const { app } = require("../src/server/electron/index.js");
  assert.doesNotThrow(() => Reflect.apply(app.dock.setIcon.bind(app.dock), app.dock, [null]));
  assert.doesNotThrow(() => app.dock.setMenu(null));
});

test("only the first live BrowserWindow broadcasts renderer events", () => {
  BrowserWindow.allWindows = [];
  BrowserWindow.focusedWindow = null;
  BrowserWindow.nextId = 1;
  const broadcasts = [];
  globalThis.__codexElectronIpcBridge = {
    broadcastToRenderer(message) {
      broadcasts.push(message);
    },
  };

  const primary = new BrowserWindow();
  const secondary = new BrowserWindow();
  primary.webContents.send("codex_desktop:message-for-view", { id: 1 });
  secondary.webContents.send("codex_desktop:message-for-view", { id: 1 });
  assert.equal(broadcasts.length, 1);

  primary.destroy();
  secondary.webContents.send("codex_desktop:message-for-view", { id: 2 });
  assert.equal(broadcasts.length, 2);
});
