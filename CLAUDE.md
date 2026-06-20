# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`cfc-web` is a **zero-install browser receiver** for [cimbar](https://github.com/sz3/libcimbar) (animated color barcodes). A sender displays a file as animated color codes on a screen (using the official [cimbar.org](https://cimbar.org) encoder); this app uses the phone camera to scan and reconstruct the file. The file data travels **only over the optical screen→lens link** — never a network. It is a pure static site deployed to GitHub Pages.

## Commands

There is **no build step for the web app itself** — it is static HTML/JS/WASM served as-is.

```bash
# Local test (localhost is a secure context, so the camera works over http)
python3 -m http.server 8000      # then open http://localhost:8000

# Deploy: GitHub Pages serves from main /(root). Just push.
git push origin main             # remote: git@github.com:ebrx/cfc-web.git
```

Phone testing requires **HTTPS** (`getUserMedia`) — a LAN IP over http will not work; use the GitHub Pages URL (`https://ebrx.github.io/cfc-web/`).

### Regenerating the WASM

`cimbar_js.js` + `cimbar_js.wasm` are **build artifacts** committed to the repo, produced from libcimbar's `package-wasm.sh` (single-threaded build). They are not built here — build them in a libcimbar checkout and copy both files into the repo root. Single-threaded means **no COOP/COEP headers are needed**, so any plain static host works.

## Architecture

The decode pipeline is split across the main thread and a worker pool:

- **`recv.js`** — two modules. `Recv` owns the camera and frame capture; `Sink` owns fountain-decode + file reassembly.
  - Capture is **canvas-based for iOS compatibility**: it draws the `<video>` onto a canvas and reads RGBA via `getImageData`, throttled to ~16fps. (WebCodecs `VideoFrame` + `requestVideoFrameCallback` are Chromium-only and are deliberately *not* used.)
  - Each captured RGBA frame is round-robined to one of **4 Web Workers**, with `_framesInFlight` backpressure (drops frames if >20 queued).
  - `Sink.on_decode` feeds decoded chunks to `_cimbard_fountain_decode`; on completion it reassembles the file and `Zstd.decompress` (`zstd.js`) triggers the browser download.
- **`recv-worker.js`** (`RecvWorker`) — each worker `importScripts('cimbar_js.js')` and calls `_cimbard_scan_extract_decode(pixels, w, h, type, ...)`. Return codes: `0` = no data, `-3` = failed extract (very common, ignored), `>0` = decoded byte length. WASM heap buffers are malloc'd lazily and re-wrapped whenever `Module.HEAPU8.buffer` changes (heap can grow).
- **Modes**: cimbar modes are `B`(68) / `4C`(4) / `Bu`(66) / `Bm`(67) / `8C`(8). `_mode = 0` is auto-detect, which cycles modes on successive frames until one decodes, then locks onto it (`Recv.setMode`).

### Cross-cutting pieces

- **`i18n.js`** — shared zh/en language state. Choice persists in `localStorage` (`cfcLang`) across pages; first visit follows `navigator.language`. Auto-wires any `.lang-toggle button[data-lang]` pill. The landing page (`index.html`) renders copy from a `data-i18n` dictionary; the receiver's camera overlay is rendered from a **state id + current language** (`Recv.applyLang`) so switching language re-renders the card live.
- **Camera error handling** (`recv.js`) — `getUserMedia` failures are **never dumped to the page**. They map (`_errToState`) to a friendly bilingual overlay with states `starting / denied / notfound / inuse / incompatible / insecure / generic`; raw error text goes only to console + the hidden `#errorbox` debug box. A retry button re-runs `init_video`.
- **iOS camera quirks** — iOS Safari rejects the *entire* `getUserMedia` call (silently, no prompt) if it dislikes any constraint, so constraints are kept minimal; the `<video>` needs `playsinline` + `muted` for inline autoplay. A "watchman" (`watch_for_camera_pause`) restarts the camera on iOS via a 1s interval if the frame counter stalls — these restarts pass `silent=true` to `init_video` so the status overlay doesn't flash.
- **PWA** — `recv-sw.js` is a **cache-first** service worker; `pwa-recv.json` is the manifest. **When you change any cached asset, bump `_cacheName`** (e.g. `...-v2` → `-v3`) or returning visitors keep stale files. New static files must also be added to `_cacheFiles`.

### Gotchas

- All asset paths are **relative**, so the app works at a domain root or under a `/<repo>/` subpath. Keep them relative.
- Forgetting to bump the service-worker `_cacheName` after editing `recv.js` / `recv.html` / `i18n.js` is the most likely "my change didn't show up" cause for returning users.

## Related projects (separate repos, not in this tree)

- Native **iOS** port: `../libcimbar/cfc-ios` (SwiftUI + AVFoundation + ObjC++ bridge over the same libcimbar C++ core; builds against a sibling `../libcimbar` source checkout).
- Upstream: [`sz3/libcimbar`](https://github.com/sz3/libcimbar) (C++ core + WASM), [`sz3/cfc`](https://github.com/sz3/cfc) (Android app).
