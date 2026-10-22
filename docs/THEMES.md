# Themes

Every colour in the dashboard comes from a small set of CSS variables. A theme only sets those
variables; lines, glows, tints, charts and even the JARVIS orb are mixed from them. So a theme is
a few lines of CSS, and any palette you like (Dracula, Catppuccin, Nord, your company colours) fits.

## Built in

JARVIS (default) · Dracula · Catppuccin Mocha · Catppuccin Latte · Nord · Tokyo Night · Gruvbox ·
Rosé Pine · One Dark · Solarized Light · GitHub Light · Ember

Pick one in **Settings → Appearance**, or type `theme nord` in the terminal (<kbd>`</kbd>).

## The variables

| Variable | Used for |
| --- | --- |
| `--bg` | the board behind everything |
| `--card`, `--card-2` | cards, and tiles inside cards |
| `--term` | terminal background |
| `--text`, `--text-2`, `--muted` | primary, secondary and quiet text |
| `--ink` | the tone lines and glass are mixed from: light on dark themes, dark on light ones |
| `--shadow` | shadow colour |
| `--accent`, `--on-accent` | highlights, links, the orb; text drawn on top of the accent |
| `--warm` | the Harness and other "warm" highlights |
| `--good`, `--warn`, `--crit` | status colours |
| `--s1` … `--s4` | chart series |

Optional: `--r` (card radius, default `16px`) and `--font` (default `"Space Grotesk"`).

## Write your own

```css
[data-theme="midnight-pink"] {
  /* @name Midnight Pink  @scheme dark */
  color-scheme: dark;
  --bg: #0b0a10; --card: #14121c; --card-2: #1b1825; --term: #09080d;
  --text: #f1eef7; --text-2: #b9b2c9; --muted: #77708a;
  --ink: #ffffff; --shadow: #000000;
  --accent: #ff7ac6; --on-accent: #0b0a10; --warm: #ffb36b;
  --good: #6fdcaa; --warn: #f2c66d; --crit: #ff6b81;
  --s1: #7aa8ff; --s2: #ff7ac6; --s3: #6fdcaa; --s4: #f2c66d;
}
```

The `@name` and `@scheme` comment on the first line is what the theme picker shows. Save the block
as a `.css` file and use **Settings → Appearance → Import theme…**. It is stored with your
settings and shows up next to the built-in themes.

## Import from elsewhere

**Import theme…** also reads:

- **VS Code colour themes** (`.json`): editor, sidebar, terminal and status colours are mapped onto
  the variables above. Most popular themes ship one.
- **jarvis-hermes themes** (`.json`): the same palette as your JARVIS web app.

**Export current as CSS** writes the active theme, including your accent override, as a CSS file you
can edit and import again.

## Custom CSS

**Settings → Appearance → Custom CSS** runs after every theme, so it can override anything:

```css
:root { --r: 10px; }                      /* squarer cards */
.card { backdrop-filter: blur(8px); }     /* frosted cards */
#space, #space2 { display: none; }        /* no dotted background */
```

## Adding a theme to the project

Built-in themes live in [`src/themes.css`](../src/themes.css). Add a block there and run
`npm run check`; pull requests with well-known palettes are welcome.
