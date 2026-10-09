/** Browser-only replacement for Electron's native workspaceFiles.saveCopy. */
export type BrowserSaveCopyInput =
  | { hostId?: string | null; path: string; fileName?: string }
  | { bytes: Uint8Array | ArrayBuffer | number[]; fileName: string };

export type BrowserSaveCopyResult = { path: null; downloadStarted: true };

class BrowserDownloadError extends Error {}

export function downloadErrorMessage(error: unknown): string | undefined {
  return error instanceof BrowserDownloadError ? error.message : undefined;
}

export type DownloadEnvironment = {
  head: (
    url: string,
  ) => Promise<{ status: number; headers: Pick<Headers, "get"> }>;
  start: (url: string, fileName: string) => void;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  deferCleanup: (cleanup: () => void) => void;
};

function browserEnvironment(): DownloadEnvironment {
  return {
    head: (url) =>
      fetch(url, {
        method: "HEAD",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }),
    start(url, fileName) {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      anchor.hidden = true;
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    // Revoking synchronously can cancel a download before the browser consumes it.
    deferCleanup: (cleanup) => {
      window.setTimeout(cleanup, 60_000);
    },
  };
}

function validFileName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[/\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BrowserDownloadError(
      "下载文件名无效 / Invalid download filename",
    );
  }
  // Reject unpaired UTF-16 surrogates before constructing URLs/headers.
  encodeURIComponent(value);
  return value;
}

function validLocalPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("//") ||
    value.endsWith("/") ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new BrowserDownloadError(
      "需要有效的本机绝对文件路径 / Invalid local file path",
    );
  }
  return value;
}

function copyBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return new Uint8Array(value);
  }
  throw new Error("下载内容无效 / Invalid download bytes");
}

/** Write plain text in the user's browser instead of the server-side Electron host. */
async function writeBrowserClipboard(text: string): Promise<void> {
  let clipboardError: unknown;
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  const document = globalThis.document;
  if (document?.body && typeof document.execCommand === "function") {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    try {
      textarea.focus();
      textarea.select();
      if (document.execCommand("copy")) return;
    } catch (error) {
      clipboardError ??= error;
    } finally {
      textarea.remove();
    }
  }

  if (clipboardError !== undefined) throw clipboardError;
  throw new Error("Browser clipboard API unavailable");
}

export async function saveBrowserCopy(
  input: BrowserSaveCopyInput,
  environment?: DownloadEnvironment,
): Promise<BrowserSaveCopyResult> {
  if (!input || typeof input !== "object")
    throw new Error("Invalid download request");
  const env = environment ?? browserEnvironment();
  if ("bytes" in input) {
    if ("path" in input) throw new Error("Ambiguous download request");
    const fileName = validFileName(input.fileName);
    const url = env.createObjectURL(
      new Blob([copyBytes(input.bytes)], { type: "application/octet-stream" }),
    );
    try {
      env.start(url, fileName);
    } catch (error) {
      env.revokeObjectURL(url);
      throw error;
    }
    env.deferCleanup(() => env.revokeObjectURL(url));
  } else {
    if (input.hostId != null && input.hostId !== "local") {
      throw new BrowserDownloadError(
        "暂不支持远程主机文件下载 / Remote-host downloads are not supported",
      );
    }
    const filePath = validLocalPath(input.path);
    const fileName = validFileName(
      input.fileName ?? filePath.slice(filePath.lastIndexOf("/") + 1),
    );
    const query = new URLSearchParams({ download: "1" });
    if (input.fileName !== undefined) query.set("filename", fileName);
    const url = `/@fs${filePath.split("/").map(encodeURIComponent).join("/")}?${query}`;
    const response = await env.head(url);
    if (
      response.status !== 200 ||
      !response.headers.get("content-disposition")?.startsWith("attachment;")
    ) {
      const reason =
        response.status === 401
          ? "登录已失效，请刷新并重新认证"
          : response.status === 403
            ? "没有文件读取权限"
            : response.status === 404
              ? "文件不存在或不是普通文件"
              : "下载服务检查失败";
      throw new BrowserDownloadError(
        `${reason} / Download preflight failed (${response.status})`,
      );
    }
    env.start(url, fileName);
  }
  // The browser cannot report the destination or whether the user finally saves.
  return { path: null, downloadStarted: true };
}

/** Do not enumerate/spread RPC proxies; preserve lazy properties and receivers. */
export function wrapBrowserServices<T extends object>(services: T): T {
  const nestedWrappers = new WeakMap<object, object>();
  type ServiceKind = "root" | "workspace" | "clipboard";
  function wrap<S extends object>(target: S, kind: ServiceKind): S {
    const bound = new Map<
      PropertyKey,
      { original: Function; bound: Function }
    >();
    return new Proxy(target, {
      get(original, property) {
        if (kind === "workspace" && property === "saveCopy")
          return saveBrowserCopy;
        if (kind === "clipboard" && property === "writeText")
          return writeBrowserClipboard;
        const value = Reflect.get(original, property, original);
        if (
          kind === "root" &&
          property === "workspaceFiles" &&
          value != null &&
          (typeof value === "object" || typeof value === "function")
        ) {
          let wrapped = nestedWrappers.get(value);
          if (!wrapped) {
            wrapped = wrap(value, "workspace");
            nestedWrappers.set(value, wrapped);
          }
          return wrapped;
        }
        if (
          kind === "root" &&
          property === "clipboard" &&
          value != null &&
          (typeof value === "object" || typeof value === "function")
        ) {
          let wrapped = nestedWrappers.get(value);
          if (!wrapped) {
            wrapped = wrap(value, "clipboard");
            nestedWrappers.set(value, wrapped);
          }
          return wrapped;
        }
        if (typeof value !== "function") return value;
        const cached = bound.get(property);
        if (cached?.original === value) return cached.bound;
        // Some RPC services are callable proxies with lazy nested properties.
        // Function.bind() would discard those properties and break app startup.
        const method = new Proxy(value, {
          apply(callable, _receiver, args) {
            return Reflect.apply(callable, original, args);
          },
          get(callable, key) {
            return Reflect.get(callable, key, callable);
          },
        });
        bound.set(property, { original: value, bound: method });
        return method;
      },
    });
  }
  return wrap(services, "root");
}
