import { readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import recovery from "../src/server/thread-writer-recovery.cjs";

const marker = 'require("./thread-writer-recovery.cjs").recoverWriterConflict';
export function patchWriterRecovery(source, browser = false) {
  const call = browser ? `(${recovery.recoverWriterConflict.toString()})` : marker;
  const applied = browser ? "/* codex-web writer recovery */" : marker;
  if (browser && source.includes("async function recoverWriterConflict(")) {
    source = source.replace(/(async\s*#t\(e,\s*t,\s*n\)\s*\{\s*let\s+r;\s*try\s*\{\s*r\s*=\s*await\s+this\.#e\(e,\s*t,\s*n\);?\s*\})\s*catch\s*\(error\)\s*\{[\s\S]*?\}\s*finally\s*\{/, "$1 finally {");
  } else if (source.includes(applied)) return source;
  const pattern = /(async\s*#t\(e,\s*t,\s*n\)\s*\{\s*let\s+r;\s*try\s*\{\s*r\s*=\s*await\s+this\.#e\(e,\s*t,\s*n\);?\s*\})\s*finally\s*\{/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Expected one compatible native resume wrapper; found ${matches.length}`);
  return source.replace(pattern, `$1 catch (error) {
    ${browser ? applied : ""}
    if (!await ${call}(this, e.conversationId, error${browser ? ", 5000, params => i6.clientCoordination.findThreadOwner(params)" : ""})) throw error;
    r = { status: "ready" };
  } finally {`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: patch-thread-writer-recovery.mjs <bootstrap.js> <output.js>");
  const source = await readFile(input, "utf8");
  const browser = process.argv.includes("--browser");
  const patched = patchWriterRecovery(source, browser);
  if (!browser) await copyFile(new URL("../src/server/thread-writer-recovery.cjs", import.meta.url), join(dirname(output), "thread-writer-recovery.cjs"));
  await writeFile(output, patched);
}
