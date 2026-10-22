# center-dashboard

JARVIS — a home and infrastructure dashboard laid out as one large board. Nine panes sit on a 3×3 grid (World, Schedule, Projects / Markets, Home, Agents / Reviews, Infra, Lab), and moving between them flies a camera across the board. The JARVIS orb from [jarvis-hermes](https://github.com/schpeterzon/jarvis-hermes) lives on top as a companion: it follows you between panes, speaks in bubbles, reacts to what happens and can be dragged to any corner.

This is a **front-end demo with sample data**. Nothing is wired to a real backend yet.

## Run it

```sh
npm run preview          # builds dist/index.html and serves it on http://127.0.0.1:8080
```

No dependencies, just Node 20.11+. The build produces a single self-contained `dist/index.html` (orb, font and code inlined), which also works when opened straight from disk.

| Command | What it does |
| --- | --- |
| `npm run build` | Build `dist/index.html` from `src/index.html` and `vendor/` |
| `npm run check` | Build, then run the static checks in `tools/check.mjs` |
| `npm run preview` | Build and serve `dist/` locally |
| `npm run sync-orb` | Refresh `vendor/` from a `../jarvis-hermes` checkout, then build |

## Using the board

- **Move:** tabs, keys `1`–`9`, arrow keys, trackpad swipe, or drag any empty part of the board (or hold `Space` and drag).
- **Overview:** `Esc` zooms out to the whole board; click a tile to fly into it.
- **Terminal:** `` ` `` opens the JARVIS terminal (`help` lists the commands).
- **Orb:** click to talk, press and hold to charge, drag to move it to another corner. In its corner it dodges the cursor — touch it three times and it lets you catch it.
- **Chatty / Quiet** in the top bar mutes unprompted speech.

## Layout

```
src/index.html         the app: markup, styles and script
vendor/jarvis-orb/     orb modules copied from jarvis-hermes (see SOURCE for the commit)
vendor/fonts/          Space Grotesk (SIL Open Font License, see OFL.txt)
tools/build.mjs        inlines the orb and font into dist/index.html
tools/check.mjs        static checks: scripts parse, ids exist, no lost $$, size budget
tools/serve.mjs        local preview server
```

Every pane is laid out on a 900px-tall design canvas that is scaled to the screen; its width follows the aspect ratio (16:10 ≈ 1440, 16:9 = 1600, 21:9 ≈ 2130) and content stops widening at 2000px.

## Deploy

**GitHub Pages:** `.github/workflows/deploy.yml` builds and checks every push and pull request. To publish, open **Settings → Pages** and set **Source** to **GitHub Actions**; from then on every push to `main` deploys.

**Any static host** (Netlify, Vercel, Cloudflare Pages): build command `npm run check`, output directory `dist`.

**Self-hosted:**

```sh
docker build -t center-dashboard .
docker run -p 8080:80 center-dashboard
```

Or copy `dist/index.html` behind any web server.
