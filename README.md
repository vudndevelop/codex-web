# codex-web

a browser frontend for codex desktop, running on a machine you control.

This is the [vudndevelop fork](https://github.com/vudndevelop/codex-web) of
[maolei1024/codex-web](https://github.com/maolei1024/codex-web), based on
[0xcaff/codex-web](https://github.com/0xcaff/codex-web). It includes token and
cookie authentication, bounded uploads, browser downloads, mobile layout and
reconnection improvements, and compressed, versioned assets. The Desktop bundle
is pinned to `26.930.21537`; the host supplies the Codex CLI.

Experimental writer recovery attempts native owner discovery and waits up to
five seconds for that owner's follower snapshot. Authentication and single-writer
locks remain. Live native-owned task access has not passed acceptance testing;
missing or incompatible owners retain the original resume error.
`scripts/patch-thread-writer-recovery.mjs` patches compatible extracted bundles,
without modifying or re-signing an installed app. New web tasks are not
automatically routed to the native desktop.

## Updating this fork

`origin` points to `vudndevelop/codex-web`; `upstream` points to
`maolei1024/codex-web`. Keep local changes committed before merging updates:

```sh
git switch main
git fetch upstream
git merge upstream/main
npm test
git push origin main
```

Resolve any merge conflicts while preserving local behavior, then commit the
resolution and run tests before pushing. Source sync does not restart or upgrade
the running service. Updates are merged on demand, not deployed automatically.

Use one source checkout. User projects belong in `~/ChatGPT`, and credentials
belong in the service environment outside Git. `CODEX_WEB_DOCUMENTS_DIR` can
override the parent of the `ChatGPT` project directory. Build output under
`scratch/` and `src/server/` is generated and ignored. Keep historical versions
in Git instead of copying the checkout to dated directories.

For local development, run `npm ci` with Node 22 or later, `unzip`, `patch`, and
the native build tools required by the dependencies installed. The prepare
lifecycle downloads and patches the pinned Desktop bundle. `npm test` builds
the server and browser and runs the regression tests. A source update does not
change an existing service deployment.

`local-build.json` is the tracked asset-version manifest. Change its ID when
shipping changed browser assets, then rebuild; the server checks that this ID
matches the generated `asset-version.json` before serving them.

Versioned assets, including the browser preload, are immutable for one year.
Reverse proxies must preserve their `Cache-Control` header without appending
`no-cache`; unversioned preload URLs still revalidate. HTML stays revalidatable
so a new release selects the new asset namespace. Authentication is checked
before serving assets; conversation data is not part of the static asset cache.

Feature configuration uses an identity-scoped snapshot when available. On a
cache miss, the Statsig SDK waits at most one second for remote configuration,
then starts with its existing cached values/defaults and refreshes in the
background. Remote configuration failures must not hold the Web shell behind
network retries. This does not change account authorization or model requests.
Failed background refreshes retry with delays of 2, 5, 15 and 30 seconds, with
a 15-second SDK deadline per attempt. Retries stop after success, account changes,
shutdown or budget exhaustion; Desktop's periodic refresh remains active.
Recovery requires values applied to the SDK evaluation store, rather than only
a completed HTTP request or a Ready status. Diagnostics expose refresh start,
success, failure and exhaustion as `codex-web:statsig-*` performance marks.
Native Statsig initialization uses authenticated `/__backend/feature-config`
HTTP requests, keeping large responses off AppHost's conversation and settings
message stream. The endpoint only posts to `https://ab.chatgpt.com/v1/initialize`,
forwards SDK headers and query parameters, and never forwards Web cookies or
account authorization. It preserves upstream values and denials, rejects redirects,
uses no-store responses with gzip, and bounds time, payload size and concurrency.
Other Desktop HTTP requests keep their native transport.
The Electron request adapter supports response streams, manual redirects and
idempotent cancellation; canceling a website preview cannot terminate the host.
React tracks a shared initialization Promise per SDK client, rather than a render's
local loading flag. Interrupted initial renders therefore wake when the SDK finishes;
initialization failures remain errors and cannot fabricate a ready client.
The browser publishes its SDK evaluations without subscribing to a full snapshot
from other renderers. Shared-object updates go only to subscribing WebSocket
clients; disconnects release Desktop subscription references, so refreshes do
not accumulate subscriptions or queue unused configuration ahead of history.
The browser restores active subscriptions on reconnect before flushing pending
subscription changes, including after failed connection attempts.
New Desktop consumers also subscribe to evaluations. For negotiated clients,
`statsig_evaluations` publication and readback use authenticated, gzip-capable
`/__backend/shared-object/statsig-evaluations` HTTP requests. The WebSocket carries
only revision notifications, so a slow transfer cannot block configuration or
model reads. The route is limited to the current 8 MiB snapshot and four concurrent
requests, requires a live connection (and subscription for reads), and never caches
responses. Revision and connection guards discard late snapshots; writes retain
their order and are never replayed on reconnect. Older tabs keep the original
WebSocket protocol until refreshed. Reverse proxies using HTTP/2 must also allow
enough requests per connection for the Desktop's several hundred startup assets;
a request limit below the advertised concurrent-stream limit can refuse imports.

The Web bridge tracks app-server requests through their actual replies, separately
from IPC acknowledgements. Disconnects reject pending requests so the composer can
release its submission lock and retain the draft. Startup/configuration reads are bounded
to 15 seconds (or an existing shorter deadline); this does not impose a timeout on
long-running commands or model work. Failed configuration preparation cancels the
pending send instead of submitting it later. Requests that may already have reached
the server report an unknown outcome and are never automatically replayed.
Returning to the foreground checks the existing WebSocket with a five-second
liveness probe. Reconnection restores subscriptions and refreshes local and remote
conversation state. Existing tabs need one refresh after a Web release to load its
new bridge; the application does not force reloads while users are editing.

Each authenticated WebSocket owns its native IPC sender targets, message queues
and chunk acknowledgements while retaining Desktop's primary-window identity.
Native replies go only to their requesting connection. Global notifications are
prepared intact and independently chunked for each eligible recipient. Closing a
connection releases its queues, ACK timers, subscriptions and pending read callers;
late replies and acknowledgements cannot affect a replacement connection.
Each delivered chunk waits at most 30 seconds for its matching transfer and sequence
acknowledgement. Unrelated acknowledgements do not extend that deadline. A timeout
closes only the affected connection, and the existing browser recovery reconnects
it without restarting the Web service or interrupting other tabs. This deadline
does not time out model work or replay writes.

AppHost recovery replaces the native RPC session, service references and subscriptions
for each connection generation. A closed channel sends the native termination signal,
settles callers and ignores late replies. Initialization and explicitly listed reads
have at most two retries, after one and three seconds, within a shared 60-second
deadline; foreground recovery checks wall-clock deadlines. Ordinary writes are not
replayed. Required configuration errors remain errors, with a retry notice outside
the React tree. Recovery retains the route, rendered history, editor and attachments;
it does not remount the app or simulate a page refresh. Each browser channel owns its
callback lifetime, so closing one tab cannot unregister another tab's callbacks.
During initial startup, idle gaps between read batches waiting for lazy UI assets
pause the remaining budget, including gaps after configuration has loaded. Any
startup read resumes that same budget; outstanding RPCs and retries remain bounded.
Recovery of an already ready page retains its wall-clock deadline. Cancelling an
obsolete browser fetch rejects its caller without exhausting recovery for the page.
Desktop's optional 500 ms configuration hint before conversation resume keeps its
original null fallback. Its lifecycle is separate from required configuration,
so a slow hint cannot exhaust page recovery or clear a real configuration failure.
An internal AppHost disconnect also rejects pending native app-server requests,
even while its WebSocket is open. Conversation resume reads have the same bounded
wait; an old zero-timeout resume cannot trap later recovery behind its Promise.
An RPC timeout on a healthy WebSocket also schedules the full settings and native
configuration recovery, so a caller reconnect cannot leave startup waiting forever.
WebSocket-backed SSH hosts also replay their real connected snapshot. The pinned
Desktop restores their conversation streams on that event; initialization alone
only refreshes metadata. Failed or disconnected hosts are never marked connected.
The native startup gate also reacquires readiness after recovery. An expired startup
Promise must not trap React on its error page after a slow module download. A healthy
root retains its editor; only a failed transport error boundary is reset.
Unrelated background HTTP and user writes do not hold the startup readiness gate;
required reads remain bounded and diagnostic counts distinguish the two.
During startup and recovery, those reads use Desktop's reserved critical request
capacity so long background work cannot starve configuration and history. Native
queue expiration/full errors use the same bounded read retries; writes keep their
original priority and are never replayed.
After readiness, routine reads and subscriptions do not start another recovery
deadline. Background application errors return to their callers; a real transport
failure starts recovery. This prevents an idle tab from disconnecting itself one
minute after an otherwise successful background read.
Remote conversation URLs preserve the native `hostId` query parameter through
navigation, refresh and browser history. Other parameters, including sign-in tokens,
are not copied into thread URLs.
Old bookmarks without a host are upgraded only when the native catalog identifies
one matching host; explicit host choices are preserved and ambiguous matches are
not guessed.
Before first render, authenticated IPC loads the native shared-state snapshot.
Remote routes wait for their AppServer manager to register before mounting, so
route suspension and layout callbacks cannot block the bootstrap that creates it.
The wait does not replace an already mounted editor during reconnection.

The display-only conversation-detail setting waits at most one second for identity
and feature assignments, then uses Desktop's existing unavailable-value semantics.
The outstanding backend read is shared; late updates still check the identity epoch
and publication. Authentication, permissions and model availability use their actual
results. Settings reads are traced through receipt, dependency completion and reply.
Browser diagnostics are available via `window.__ELECTRON_SHIM__.diagnostics()`;
authenticated `/__backend/diagnostics` reports server channel counts and bounded
startup events. Its `chunkedIpc` counters include sender targets, ordinary and critical
queued messages, pending transfers, the longest current ACK wait and total ACK
timeouts. Events contain methods, phases, durations and counts, never request
arguments, messages, drafts, credentials or feature-assignment payloads.

Tests exercise the pinned extracted RPC transports and request client, including
timeouts, late replies, subscription restoration and concurrent tabs. The image smoke
test performs a real AppHost handshake and settings read, plus ordinary native global
state reads from concurrent connections and after a disconnect. Browser acceptance must
check actual history text, projects and required configuration; an input box or open
WebSocket alone does not establish readiness. Cold asset transfer and large histories
are measured separately from warm small-history reloads.

Browser completion reminders use the existing task event for local and SSH hosts.
Successful task completions can play the built-in sound even while the page is
focused. In **General → Notifications**, the completion notification mode controls
browser popups independently of the sound selection; choose **None** to mute.
Popups show the conversation title and a completion message, without reply text,
and open the corresponding conversation, including its remote host.
Request browser notification permission explicitly in settings and click the
sound preview to enable playback. Volume starts at 30% and stays on this browser
and origin. Tabs on the same origin coordinate sound and popup delivery; denied
permissions do not disable audio. Pages must stay open: Web Push after closing a
page is not implemented, and suspended browsers may not deliver immediately.

Unsent image attachments are saved in this browser's IndexedDB alongside the
existing text draft behavior. Refreshing restores the images to the same task's
composer (including the new-task composer). Original image data is retained, so
restored images remain sendable after temporary server uploads expire. Removing
an image or sending the draft clears its saved attachment; saving does not run
on every text keystroke. If browser storage is unavailable or full, an alert
appears. Draft images stay on this browser and origin: they are not synced across
devices and are removed when site data is cleared. Files still being read or
uploaded when the page is interrupted may not yet have a saved draft.
Draft saves expose a success/failure result, including incomplete attachments, and
IndexedDB operations have a bounded wait. Storage failure never causes recovery to
unmount the editor. After a subsequent release, a reconnect can show an update notice;
the user retains control over when to save attachments and refresh.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## usage

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

it will use `codex` from `PATH` if available, or `CODEX_CLI_PATH` if you set
it.

run it with `npx`:

```bash
npx --yes github:maolei1024/codex-web
```

or with nix:

```bash
nix run github:maolei1024/codex-web
```

then open <http://127.0.0.1:8214> in a browser.

### sign in

ensure the codex cli on the host machine is signed in before starting the
server.

```bash
codex login --device-auth
```

### proxying to app-server (advanced usage)

it’s often useful to run the app server separately, so a crash or restart of
codex-web doesn’t interrupt the codex process executing commands.

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

`codex app-server proxy --sock ...` is a raw stdio protocol bridge for another
program to use; when run directly in a terminal it will wait for protocol input
rather than opening an interactive prompt.

## Container and cluster deployment

The container pins Node 22.22.0, Codex CLI 0.160.0 and the Desktop version above.
Its native amd64 and arm64 builds run `npm test` and a packaged runtime smoke
check before publication. Woodpecker builds on `main` push/manual, publishes
`docker.nexus.ixuni.win/codex/web:build-N`, and applies `k8s/codex-web.yaml`.
Both architectures must pass before the combined image and `latest` are published.
CI applies the `Recreate` update directly without querying the old instance for idle
tasks; this can interrupt active cluster tasks. It retains the TCP startup, readiness
and liveness probes and waits up to ten minutes for the Deployment rollout.
The deployment uses a single replica on ml256 with a hostPath at
`/srv/k3s-local/project-codex-web/codex-web`, mounted at `/data`. Before the first
deployment, create this directory on ml256 with UID/GID 1000 and mode 0700:

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /srv/k3s-local/project-codex-web/codex-web
```

The manifest requires the directory to exist and keeps `Recreate` updates and
the ml256 node selector. Storage uses the host filesystem's available capacity;
there is no PVC or 10 GiB volume quota. Back up this directory with the application
stopped before moving the deployment to another host.

The ml-vubuntu local user service activates a prepared runtime release only after a
manual restart. Preparing artifacts or pushing source does not restart that service.
After saving local work, activate the prepared release on ml-vubuntu with:

```sh
systemctl --user restart codex-web.service
```

The cluster deployment enables Node's `--use-env-proxy` and sends public HTTPS
through the existing node-local `cluster-proxy-local.project-mihomo:27890` service.
This lets the proxy resolve upstream feature-configuration domains instead of
using the cluster's external DNS answers. Localhost, service names and the private
`ixuni.win` / Tailnet domains bypass the proxy. TLS verification remains enabled;
model capabilities and feature gates still come from their actual backends.

Mount persistent storage at `/data`. The container keeps its home in `/data/home`,
Codex state in `/data/codex`, Electron state in `/data/app`, documents in
`/data/documents/ChatGPT`, and bounded temporary uploads in `/data/uploads`.
Outside containers, `CODEX_WEB_DATA_DIR` optionally relocates Electron userData,
sessionData, cache, logs and temp; unset preserves the existing defaults.
`CODEX_WEB_DEBUG_IPC=1` enables verbose IPC logging, including potentially sensitive
arguments. It is off by default.

Provision `project-codex-web/codex-web-auth` with a `token` key and
`project-codex-web/codex-web-seed` before the first CI deployment. The seed Secret
accepts `config.toml`, `auth.json`, `remote-connections.json`, `ssh-config`,
`ssh-known-hosts`, and `ssh-private-key`. Initial config/auth/remote connections
are copied only when absent; SSH material is refreshed on container startup.
Keep credentials, real project inventories and these Secret values outside Git.
The connection seed follows the Desktop schema:

```json
{"version":1,"remoteConnections":[{"sshAlias":"development-host","projects":[{"remotePath":"/srv/projects/example","label":"Example"}]}]}
```

For an independent backend on the project host, install the user unit from
`deploy/codex-web-remote.service` and copy `scripts/remote-start` and
`scripts/remote-ssh-command` to `/srv/services/codex-web-remote/bin/start` and
`bin/ssh-command`. Create a private `env` file in that service directory defining
`CODEX_HOME`, `CODEX_CLI_PATH`, `CODEX_INSTALL_DIR` and `PATH`, using an independent
state directory and the installed CLI. Seed required model/MCP/skill configuration
without copying conversations. Use a dedicated SSH key with the authorized_keys
option `restrict,command="/srv/services/codex-web-remote/bin/ssh-command"`, pin the
host key, and enable the user service with lingering. The wrapper selects that
backend's state and disables Desktop's automatic server bootstrap; it still
allows commands as the project owner. It is not a sandbox or command allowlist.

The Web instance uses native SSH/app-server transport. Project files, task
commands and MCP processes remain on the remote host. Existing services and
conversation stores can continue running independently.

## Security

run `codex-web` only on trusted networks. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

This fork requires `CODEX_WEB_TOKEN` when listening outside loopback. Visit
`?token=<token>` once to establish an HttpOnly cookie; the redirect removes the
token from the URL. Serve the application over trusted HTTPS and protect access
to the host. Keep tokens out of Git, proxy logs, and shared URLs.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

- The saved language setting loads the Desktop translations, including Chinese.
- Project and chat context menus use Desktop's browser menu components.
- The sidebar's **View activity** button is available even when the upstream
  feature configuration cannot be fetched; Desktop's access checks still apply.
- Settings → Connections exposes native SSH hosts. Here “this computer” means
  the Web server: SSH configuration and keys must be available to that server.
  New remote projects use **Remote**, not **Cloud**.
- **Cloud** creates ChatGPT-hosted projects and requires a ChatGPT account with
  project access. A custom API-key provider supplies model inference, not those
  account APIs; this option remains disabled when that capability is unavailable.
- hostable on macOS, Linux (and anything codex cli + node will run on)
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription
  - integrated terminal and local agent input/output ([setup](docs/shared-terminal.md))

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

* [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels fell off. i needed subagents
  and an inline image viewer. this didn't have them and was having a hard time
  keeping up with upstream codex updates.
* the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
* upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.
