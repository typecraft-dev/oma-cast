# omacast website

A static site with no dependencies and one small build step (`node build.mjs`, for the in-browser launcher):

```
public/index.html    the page
public/styles.css    styling and CSS animations (Catppuccin Mocha / Latte, typecraft's stripes)
public/app.js        scroll-driven effects (plain JS)
public/launcher.js   omacast in the browser: the hero demo and the "Try it" overlay
public/launcher.css  its styles
public/demo/         what the launcher runs on (see "The launcher in the browser")
public/icon.svg      the icon; favicon-32.png, apple-touch-icon.png and icon-512.png are rendered from it
public/img/          WebP copies of docs/screenshots/
public/fonts/        Cartridge (licensed; not in git, see below)
public/_headers      security and cache headers for Cloudflare
build.mjs            bundles ../core/*.js for the browser
snapshot.mjs         refreshes the Omarchy data in public/demo/
wrangler.jsonc       Cloudflare config
```

## The launcher in the browser

The hero demo and the overlay it opens are omacast itself, not a mock-up. The overlay opens only when asked:
the "Try it in your browser" buttons, "Try it yourself" under the demo, a click on the demo, or the `/` key. `build.mjs` wraps the unchanged `core/*.js` modules into `public/demo/core.js`, so search, ranking,
frecency, the calculator, emoji search, Clipboard History and the Omarchy menu tree are the launcher's own code.
`launcher.js` is the part that is QML on the desktop: a backend over `localStorage` (after `Backend.qml`) and the
window (after `ui/LauncherWindow.qml`). When either of those changes behaviour, port the change by hand.

What it runs on:

| File in `public/demo/` | What | In git |
|---|---|---|
| `core.js`, `emoji.json` | `core/*.js` bundled, and a copy of `data/emoji.json`. Written by `node build.mjs` | no |
| `snapshot.json` | Omarchy's menu, which rows are hidden or checked, and ECB exchange rates. Written by `node snapshot.mjs` | yes |
| `emoji-keywords.json` | Omarchy's emoji search keywords. Written by `node snapshot.mjs` | yes |
| `symbols.woff2` | the icon glyphs, subset from JetBrainsMono Nerd Font. Written by `node snapshot.mjs` (needs `uvx`) | yes |
| `NOTICE.md`, `OFL.txt` | licences for the three above | yes |

- **Run `node build.mjs` before previewing or deploying**, and again after changing anything in `core/`. Without
  it the page still works, with a screenshot where the demo would be and no "Try it" button.
- Run `node snapshot.mjs` on an Omarchy machine to pick up a new Omarchy menu or new icons in `launcher.js`.
  It runs the menu's real guards, then removes what is personal: Remove rows are hidden, nothing reads as
  installed, and the default browser, terminal and editor are set to Omarchy's own. Other toggles (dock
  position, clock format and the like) are the snapshot machine's. `tests/site-demo.test.js` checks the scrub.
- Apps, fonts and kernels are stand-ins (`APPS` and `PROVIDER_OUTPUT` in `launcher.js`), Clipboard History is
  seeded with a few copies, and themes are nine of Omarchy's palettes (`THEMES`).
- Nothing launches. Actions that need a desktop say what they would have done; copies go to the visitor's
  clipboard; web searches and links open in a new tab. What a visitor does is stored only in their browser
  (`localStorage` keys starting `omacast-demo:`); the overlay's Reset link clears it.
- Differences from the desktop: no typo-tolerant search helper (results are the built-in ranker's, as on an
  install without `bin/build-search`), no Super or vim bindings, no compact mode or zoom, and some shortcuts
  belong to the browser (Ctrl+T, Ctrl+N, Ctrl+Shift+C/P/K in some browsers). Every action is also in the
  action panel, which can be clicked.
- The hero demo is the same launcher with its own in-memory backend, driven by `Autoplay` in `launcher.js`.

## Fonts

Headings use **Cartridge**, which is a licensed font, so `public/fonts/` is gitignored: the repo is public and
is also what every omacast install clones. The site expects these three files there:

```
Cartridge-Regular.woff2   Cartridge-Bold.woff2   Cartridge-Black.woff2
```

Convert them from the licensed `.otf` files with `woff2_compress Cartridge-Bold.otf` (package `woff2`).
Without them the headings fall back to a system font and everything else still works. Because the fonts
aren't in git, deploy from a machine that has them (`wrangler deploy` uploads whatever is in `public/`); a
Cloudflare build connected to the GitHub repo would publish the site without Cartridge.

Body text is Inter and code is JetBrains Mono, both from Google Fonts.

## Animations

- The hero launcher types for itself (`Autoplay.loop` in `launcher.js`): a search, a calculation, the action
  panel, opening an app (which then shows up under Suggestions) and Switch Theme. It pauses while it is off
  screen, the tab is hidden or the overlay is open.
- Sections fade in as they scroll into view (`.reveal`), a dashed connector draws itself between sections
  (after typecraft.dev's landing page), counters count up, calculator rows and install commands type
  themselves, and keycaps press now and then.
- Style: Cartridge is always set in capitals (`.display`, `.label`). No pre-header labels above headings, no
  emoji tiles, no glows or gradient washes; the hero's only texture is typecraft.dev's dot grid.
- With `prefers-reduced-motion`, everything is shown at once and the hero launcher sits still at its root list.

## Preview

```sh
node site/build.mjs
cd site/public && python3 -m http.server 8765   # then open http://127.0.0.1:8765
```

## Deploy to Cloudflare

The site is the Cloudflare Pages project `omacast`, served at <https://omacast.typecraft.dev> (and
`omacast.pages.dev`). `wrangler.jsonc` points it at `public/`.

```sh
cd site
npx wrangler login                          # once
node build.mjs                              # every time: public/demo/core.js is not in git
npx wrangler pages deploy --branch main     # main is the production branch; any other name makes a preview
```

Deploy from a machine that has the Cartridge fonts in `public/fonts/`, since they are not in git either.

It is Pages and not a Worker because `typecraft.dev`'s DNS is at Squarespace: a Worker's custom domain needs
the zone on Cloudflare, while Pages takes a subdomain from any DNS host. The domain is set under the project's
Custom domains in the Cloudflare dashboard, and Squarespace has a `CNAME` from `omacast` to `omacast.pages.dev`.
The project was created with `wrangler pages project create omacast --production-branch main --force`; without
`--force`, wrangler 4.162 makes a Worker.

## Icon

`public/icon.svg` is the source: Omarchy's square maze in typecraft's stripe colours, reading as an O, a C and
a cursor. It is drawn on a 30-unit grid, so it is sharpest at multiples of 30px (the page also inlines the same
drawing so its cursor can blink). Regenerate the PNGs after editing it; the touch icon gets a full square
background because iOS fills transparent corners with black:

```sh
cd site/public
rsvg-convert -w 30 icon.svg | magick - -background none -gravity center -extent 32x32 favicon-32.png
rsvg-convert -w 510 icon.svg | magick - -background none -gravity center -extent 512x512 icon-512.png
sed 's|<path d="M1 0[^"]*"|<rect width="30" height="30"|' icon.svg | rsvg-convert -w 180 -o apple-touch-icon.png
```
