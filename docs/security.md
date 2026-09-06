# Security and privacy

why-ui is a local developer tool. Its trust boundary separates web pages, the explicitly
paired extension, the local daemon, and the coding agent's workspace. Use it on
applications whose bounded runtime labels and source references may be shared with that
agent. It is not a sandbox against a compromised OS account or hostile MAIN-world APIs.

## Bridge authorization

The WebSocket server binds only `127.0.0.1`; its host is not configurable. The extension
uses `activeTab`, `scripting`, and `storage`, with no blanket host permissions. A real
extension action or shortcut arms the current HTTP(S) tab. Browser `activeTab` grants
and same-origin navigation rules apply. Cross-origin navigation disarms the session.

Before pairing, only syntactically valid `chrome-extension://` Origins can enter the
handshake. A 128-bit random, single-use token expires within two minutes. Successful
pairing binds the exact extension Origin and delivers a 32-byte device secret. Subsequent
connections require a fresh 32-byte nonce, HMAC-SHA256 over its decoded bytes, constant-time
comparison, and an ephemeral session token. Privileged messages also require monotonically
increasing sequence numbers. An unrelated extension, web Origin, or null Origin is rejected.
Origin is rechecked on sockets that opened before pairing completed.

A native local process can spoof an Origin header, so Origin alone is not authentication.
It still needs the secret or live pairing token. The loopback bridge uses `ws`, not TLS;
the local machine and OS user are trusted. Neither unauthenticated sockets nor stale
responses can replace a live authenticated session or settle another request.

## Secret handling

The daemon creates `~/.why-ui/auth.json` (or `--config-dir` / `WHY_UI_CONFIG_DIR`) using
secure randomness and exclusive creation. POSIX file mode is `0600`; newly created config
directories use `0700`. Windows protection relies on the user's profile/config-directory
ACLs; Node's mode bits are not a Windows ACL configuration mechanism. Existing corrupt,
nonregular, or malformed auth files fail closed with a fixed message, without printing
their contents or silently replacing the secret.

The extension keeps pairing credentials only in `chrome.storage.local` restricted to
trusted extension contexts. Armed-session metadata uses `chrome.storage.session`.
Credentials never enter injected MAIN-world arguments. MCP responses and logs never
include the device secret or session token. The deliberately displayed bootstrap token
goes to stderr, expires, and is single-use.

For recovery, stop running daemons, run `why-ui pair --reset`, choose **Forget pairing**
in extension Options, and pair with the new token. Reset rotates the secret and removes
origin binding via a private temporary file and rename. A new extension path/profile may
have another extension ID and require this recovery. Keep the unpacked extension path
stable. Auth files and local MCP configurations are excluded from git.

## Runtime data minimization

The sensor does not read cookies, page localStorage/sessionStorage values, request headers,
network response bodies, passwords, input/textarea values, full HTML, full DOM, browser
history, or Fiber props/state. It does not record screenshots or application activity.
Only trusted pointer coordinates, bounded descriptors, relevant computed styles, sampled
hit evidence, limited ancestry, and optional React/source hints are collected.

Form controls and editable subtrees suppress text/label collection. Descriptor attributes
use a fixed whitelist. CSS URL-bearing values are wholly redacted. Source URL credentials,
queries, and fragments are removed; raw exceptions and raw React stacks are not forwarded.
IDs, classes, static action labels, React keys, and source paths may themselves identify
application data. This is minimization, not a guarantee that all retained text is public.

MAIN-world code shares the application's JS environment. A page that replaces browser
APIs can influence evidence. Schema validation bounds and filters the payload; it cannot
cryptographically attest an uncompromised browser implementation. why-ui never activates
application controls or changes the DOM/CSS to probe behavior.

## Source and filesystem boundary

Resolved files must exist within the configured workspace after lexical normalization and
realpath checks. Traversal, outside paths, and symlink escapes are rejected. Runtime paths
cannot read arbitrary files elsewhere on disk. Source maps can contain relative segments;
the resolved destination still passes workspace containment. Source references are
workspace-relative and do not include whole-file contents.

Only bounded JS/TS/CSS/map assets may be read for symbolication. Network fallback accepts
only the armed page's same HTTP(S) loopback origin (`127.0.0.1`, `localhost`, or `::1`).
It strips query/fragment, rejects URL credentials and redirects, sends no browser cookies
or auth headers, and replaces localhost DNS lookup with a literal loopback address.
These development source assets are processed locally and never dumped through MCP.
Remote maps, inaccessible stylesheets, and absent or ambiguous sources become `UNMAPPED`.

Source assets are capped at 2 MiB, caches at 16 entries, maps at 32 sections/four levels/
4,096 sources, and source lookup at a three-second budget. Static scans and revision
hashing have file/count/byte bounds. Truncation cannot establish source uniqueness or
verified readiness. No background file watchers, database, telemetry, or cloud backend
are present. [Resource table](architecture.md#resource-bounds).

## Regression coverage

Tests cover loopback binding, Origin variants and pre-pair races, token expiry/reuse,
nonce mismatch, session token/sequence checks, unknown nested fields, canonical payload
rejection, pending-request capacity/timeouts/disconnects, corrupt auth privacy, file
permissions, traversal/symlink escape, credential-free source fetching, redirect rejection,
map bounds, privacy sentinels, non-activation, worker restart, and real stdio shutdown.

The release audit also searches production code and built extension output for activation
APIs, broad permissions, page-storage collection, debug hooks, embedded machine paths,
and credential literals. Test fixtures intentionally use some of those APIs to create
and validate adverse scenarios; they are not shipped in `dist/extension/`.

Report a security problem without pasting credentials, private runtime payloads, or auth
files into a public issue. If private vulnerability reporting is enabled on the repository,
use its Security tab; otherwise provide a minimal redacted reproduction for the maintainer.
