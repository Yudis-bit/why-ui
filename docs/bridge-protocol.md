# Loopback bridge protocol

Version: `why-ui/bridge@1`. WebSocket text frames, bound to `127.0.0.1` only. The default
CLI port is 9876. No HTTP API, remote server, CDP endpoint, or native messaging host is
required. The MCP side is a separate stdio transport.

## Envelope

```json
{
  "protocol": "why-ui/bridge@1",
  "id": "correlation-id",
  "type": "INSPECT_REQUEST",
  "sessionToken": "<ephemeral 32-byte hex token>",
  "sequence": 2,
  "sessionId": "<armed BrowserSession id>",
  "payload": { "options": { "maxSamples": 64 } }
}
```

IDs are 1–128 characters. Session tokens are 64 lowercase hex characters. Privileged
messages carry an increasing nonnegative integer sequence in each direction. Unknown
fields, unknown versions/types, binary frames, malformed payloads, and messages in the
wrong phase are rejected. Inspection/verification results receive an additional strict
canonical schema validation in the daemon. Request IDs, type, socket, and armed session
must match the pending request; late/unrelated replies cannot settle another request.

## Bootstrap and authentication

```text
Extension                       Daemon
PAIR(pairingToken, extensionId) → validate one-time token and Origin
                              ← PAIR_OK(deviceSecret)
HELLO(extensionVersion, id)    →
                              ← CHALLENGE(nonce)
AUTH(hmac)                    → timingSafeEqual(expected, received)
                              ← AUTH_OK(sessionToken)
ARMED(session)                →
```

The daemon owns a persistent 32-random-byte secret and a 128-bit one-time pairing token.
The token expires within 120 seconds and is destroyed on consumption. A valid PAIR binds
`chrome-extension://<id>` in the auth file before delivering the secret. The extension
stores it in `chrome.storage.local`, restricted to trusted extension contexts. Re-pairing
an already paired daemon is rejected. `why-ui pair --reset` explicitly rotates local
auth state; it is not a bridge operation.

Subsequent connections omit PAIR. Each CHALLENGE is 32 fresh random bytes, encoded as
lowercase hex. HMAC-SHA256 uses the decoded secret bytes as key and decoded nonce bytes
as message. Node crypto signs/verifies in the daemon; Web Crypto signs in the extension.
Successful AUTH creates a fresh 32-byte session token. Credentials are never included
in page MAIN-world arguments or MCP output.

Origin is checked on connection and during every handshake, including sockets opened
before initial pairing. Unauthenticated sockets cannot supersede the active client.
Only a successfully authenticated replacement can invalidate the previous session.

## Messages

| Concept | Payload / purpose |
| --- | --- |
| `PAIR`, `PAIR_OK` | One-time token and optional extension ID / device secret |
| `HELLO`, `CHALLENGE`, `AUTH`, `AUTH_OK` | Version/ID / nonce / HMAC / session token |
| `ARMED` | BrowserSession: sessionId, tabId, frameId=0, sanitized URL, armedAt |
| `DISARMED` | Empty payload; reject outstanding tab requests |
| `INSPECT_REQUEST` | Optional bounded sampling/React options and explicit targetSelector |
| `INSPECT_RESULT` | Canonical `{ok,result}` or `{ok:false,error}` sensor envelope |
| `VERIFY_REQUEST` | Validated baseline identity, prior pointer anchor, sampling options |
| `VERIFY_RESULT` | Reconciliation plus a fresh canonical inspection when identity resolves |
| `ERROR` | Known machine code and bounded safe message |
| `PING`, `PONG` | Timestamp and correlated response |

`targetSelector` is internal bridge/sensor syntax. The public MCP input is
`target: { selector: "#known-target" }`. Both operations are observational; VERIFY does
not synthesize movement to recover pointer state after a reload.

## Lifecycle and failures

Heartbeat runs every 20 seconds. The extension closes a silent connection after about
45 seconds; the daemon checks for 50-second staleness. Authentication has a 10-second
deadline. Reconnect waits 250 ms, 500 ms, 1 s, 2 s, then at most 5 s between attempts.
The backoff resets only after authentication. Authentication errors require user repair
rather than a tight retry loop.

The armed session survives service-worker restart in `chrome.storage.session` and is
announced after reauthentication. It does not survive browser-session loss. A stopped
worker can be awakened from extension Options/action; a browser restart requires arming
again. Cross-origin navigation revokes the session.

Pending requests are capped at 16 and normally expire after 10 seconds (hard cap 15 s).
Disconnect, disarm, tab changes, replacement authentication, and daemon shutdown settle
pending requests immediately. Verification uses its remaining readiness deadline.
The extension separately caps unresolved `executeScript` calls because Chrome cannot
cancel a frozen MAIN-world execution. [Security model](security.md).
