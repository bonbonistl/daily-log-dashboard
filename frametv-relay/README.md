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
settings, and set **Local relay URL** to `http://localhost:8787` (or, if
you're running this on a different machine on your network — like a Mac
mini or Raspberry Pi that stays on — use that machine's IP instead, e.g.
`http://192.168.1.42:8787`).

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
- The relay has no authentication of its own — anything running on your
  machine, or any site your browser has open, could in principle POST to
  `http://localhost:8787/send` and tell your TV to display an image. Worst
  case is unwanted art on your TV; this is a personal convenience tool, not
  hardened for a shared or untrusted network.
