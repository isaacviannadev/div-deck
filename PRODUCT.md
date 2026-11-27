# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Two audiences, with the finished product first:
- **People who get a DIV Deck** (from the box's QR code, or curious visitors): developers, designers, gamers and streamers who want physical keys for the apps they use all day. Their job on the site: understand what it does, install the app, get running in minutes, solve a problem.
- **Makers** who want to build their own: print the case, solder, flash the firmware. The source and firmware are public on GitHub.

## Product Purpose
DIV Deck is a USB macro deck plus a free desktop app (macOS and Windows) that turns each key into whatever the current app needs. Success: a visitor knows what it is within seconds, downloads the app, joins the waitlist for the hardware, and gets set up without help.

## Positioning
The profile follows the app in focus: open Figma and the keys become Figma tools, go back to VS Code and they become editor shortcuts, with no manual switching. Two devices share one app and one set of profiles: **DIV Deck MX** (15 mechanical hot-swap keys with per-key RGB, optional OLED pod) and **DIV Deck Touch** (a 4" touchscreen where every key shows its icon, name and colour). Designed and built by DIV Tecnologia, open hardware/firmware on GitHub.

## Operating Context
Desk setups: monitor arms (35 mm pole clamp with magnets) or standing on the desk. The app lives in the menu bar, ships ready-made profiles (VS Code, Cursor, Figma, Discord, Steam, Dota 2, ChatGPT, Claude, Spotify), installs from GitHub Releases and updates itself. The box carries a QR code that lands on the getting-started section.

## Capabilities and Constraints
- Actions: open apps, shortcuts, media (Spotify direct), text/prompts, shell commands and links, profile switching, sequences, recorded macros with real timing, game keys (hold/repeat/exact rhythm), mouse clicks, Logitech Easy-Switch (move keyboard/mouse to another computer, per device channel).
- Several decks at once, each with its own name and profile; drag keys to reorder.
- Pro: status bar (time/date/profile), swipe-down lock screen, waiting screen until the app connects. MX: optional 0.96" OLED pod with time/date/profile.
- Hosting: static GitHub Pages (`docs/`), bundle built with esbuild from `web/` (three.js 3D model, scroll-craft). Downloads link to the latest GitHub release (macOS universal .dmg, Windows x64 setup).
- Language: Portuguese (Brazil-leaning, as the current copy).
- **Not sold yet:** waitlist only. The waitlist mechanism (form service / email) is an open decision. No prices.

## Brand Commitments
- Names: **DIV Deck MX** (the standard model, renamed from "DIV Deck") and **DIV Deck Touch**; the app is "DIV Deck"; company DIV Tecnologia.
- The DIV Deck mark: a 4 × 3 grid of dots of slightly different sizes (in `docs/index.html` and `brand/`), plus the wordmark.
- Self-signed macOS builds: first open needs right-click › Open; Accessibility and Input Monitoring permissions are part of setup.

## Evidence on Hand
- Real app screenshots: `docs/img/app-*.jpg` (light/dark, MX and Pro); they predate the 0.6 sidebar.
- 3D models of both devices rendered in the page (three.js, `web/src/main.js`).
- Ready-made profile list and brand icons (Simple Icons).
- No testimonials, customers, reviews, press, sales numbers or prices exist: do not fabricate them.

## Product Principles
1. Show the keys changing with the app: the mechanism is the pitch.
2. Minutes to start: the QR-code visitor must reach the download and the four setup steps immediately.
3. One app, two decks: MX and Pro are presented as siblings, never as a cheap and a premium tier.
4. Honest about state: free app, hardware on a waitlist, open source, unsigned-by-Apple builds explained plainly.

## Accessibility & Inclusion
Content readable without the 3D/WebGL layer; respect reduced motion; keyboard reachable downloads and FAQ.

## Lineup (Nov 2026)
- DIV Deck MX: 15 mechanical keys, RGB per key, removable face (5 designs), optional OLED pod.
- DIV Deck Touch: 4" 480×320 touchscreen (was "DIV Deck Pro"), clip-on covers (Code, Superfície; 3 colours each). Model id stays "pro" in config and firmware.
- DIV Deck Pro (coming soon): Waveshare ESP32-S3-Touch-LCD-4.3B, 4.3" 800×480, with a battery for Bluetooth (wireless) use.
