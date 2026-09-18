# Recorded browser demo

[Watch the recording](media/demo.gif) · [Actual MCP evidence](media/demo-evidence.json)

This is a sequence of captured Chromium frames from the production unpacked extension
and actual MCP responses. The right-hand panel renders the tool's returned text. The
test driver stands in for an agent's source edit; no Claude/Cursor conversation or
terminal output is fabricated. Presentation pauses make the recording readable.

The payment target is fully covered, so inspection supplies its known `#payment`
selector. The browser identifies the backdrop and the daemon resolves its source.
The script rewrites the fixture JSX/CSS, rebuilds and reloads, then calls `verify_fix`.
The button moves and resizes. Fresh browser assertions establish VERIFIED_PASS.
No click/focus/blur event proves the result. Ratios remain sampled estimates.

To reproduce after installing development dependencies and Chromium:

```sh
python -m pip install Pillow==12.2.0
npm run demo:record
```

On Unix the recorder invokes `python3`; on Windows it invokes `python`. Pillow only
encodes the captured PNG frames into an optimized GIF. It does not draw a substitute UI.
The demo uses a disposable fixture and auth directory; no user browser profile is read.
Its media are intentional documentation assets, excluded from the production extension.
