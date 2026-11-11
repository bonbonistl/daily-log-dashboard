# FrameTV relay

A small local server that lets the House > FrameTV tab send art to a Samsung
Frame TV whose firmware requires the newer "D2D socket" Art Mode upload
protocol — something a browser has no API to speak, so the browser-only
client falls back to this instead.

You only need this if the app told you your TV needs it (an error mentioning
"local-network relay"). Browsing, pairing, and selecting existing art on the
TV all work without it.

## Setup

Requires [Node.js](https://nodejs.org/) 18 or newer.

```bash
cd frametv-relay
npm install
npm start
```

You should see:

```
FrameTV relay listening on http://localhost:8787
```

Leave that terminal window running. In the app, go to House > FrameTV >
settings, and set **Local relay URL** to `http://localhost:8787`.

By default the relay only answers requests from this same computer. If you
want to run it on a different machine on your network — like a Mac mini or
Raspberry Pi that stays on — start it with `RELAY_LISTEN_HOST=0.0.0.0 npm start`
and use that machine's IP in the app instead, e.g. `http://192.168.1.42:8787`.
(Browsers may block a public https page from calling a plain-http LAN IP, so
the same-computer setup is the most reliable.)

## Auto-start at login (recommended)

So you don't have to keep a Terminal window open, install it as a macOS
LaunchAgent. It starts when you log in and restarts if it crashes:

```bash
cd frametv-relay
./install-autostart.sh
```

- Log file: `~/Library/Logs/frametv-relay.log`
- Turn it off: `./uninstall-autostart.sh`
- If the log shows `Operation not permitted`, macOS is blocking background
  access to this folder (common if it's under `~/Documents` or `~/Desktop`; the
  project lives in `~/Developer/LifeOS` to avoid that and iCloud). Fix it in System Settings → Privacy & Security →
  Full Disk Access by adding `node` (`which node`).
- If you move this folder or upgrade Node to a different path, run
  `./install-autostart.sh` again. The LaunchAgent stores absolute paths.

## First-time pairing

The first time you hit "Send to TV" after setting the relay URL, the TV will
show its own "Allow this device to connect?" prompt, separate from the one
you already accepted in the browser (the relay pairs with the TV
independently). Confirm it with your remote. The relay saves its token to
`tokens.json` in this folder so it won't need to pair again for that TV.

## Notes

- This only needs to run when you actually want to send something — it
  doesn't need to be always-on, though it's fine to leave it running.
- `tokens.json` holds your TV's pairing token. It's gitignored; don't commit
  it or share it.
- Access is limited: the relay listens on this computer only (not the
  Wi-Fi), browser requests are accepted only from the LifeOS app
  (`https://bonbonistl.github.io`) or a localhost preview, the TV address must
  be a home-network IP, and images must be public `https://` URLs. Add other
  app addresses with `RELAY_ALLOWED_ORIGINS=https://example.com` if you ever
  host the app elsewhere. Programs already running on your Mac can still
  call it; it has no password of its own.
