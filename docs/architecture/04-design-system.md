# 04 — Design System

> **Status:** implementable spec. Subordinate to `00-product-brief.md` §7. Where
> this document adds tokens or rules, it extends the brief; it contradicts
> nothing in it. Anything marked **[LEAD]** is a question for the lead engineer.

**Target versions:** Tailwind CSS **v4** (4.1.x, CSS-first — no `tailwind.config.ts`),
Next.js App Router, React 19, `next/font`. All CSS below is Tailwind v4 syntax.

---

## 0. The aesthetic in one paragraph

Warm off-white paper, deep navy ink, hairline warm rules doing the separation
work that borders and shadows usually fight over. One high-contrast serif
(Instrument Serif) reserved for page titles and hero numbers — everything
operational is Inter. Technical values are mono because they are data, not
prose. Space is the primary design element: if a screen looks empty, it is
probably right. Only two things are pill-shaped: the primary action and filter
chips. Nothing glows, nothing bounces, nothing gradients.

The failure mode we are designing against is not ugliness — it is genericness.
A screen that could belong to any Series-A dashboard has failed even if every
token is correct.

---

## 1. File inventory (who owns what)

```
src/app/globals.css          # §2 tokens, §3 @theme, §4 base layer, §5 utilities
src/app/fonts.ts             # §7 next/font declarations
src/app/layout.tsx           # applies font variables to <html>
src/components/ui/*.tsx      # §9 primitives — vendored from shadcn, then OURS
src/components/patterns/*.tsx# composites (DataTable, StatCard, EmptyState hosts)
src/lib/cn.ts                # clsx + tailwind-merge wrapper
docs/architecture/04-design-system.md
```

`globals.css` is imported exactly once, from `src/app/layout.tsx`. No component
ships a `.css` file. No CSS-in-JS. No inline `style` attributes except for
genuinely dynamic values (chart geometry, progress width, virtualised offsets).

---

## 2. Tokens — paste into `globals.css`

Two-layer indirection on purpose: **raw semantic tokens live in `:root`**,
**Tailwind utilities point at them via `@theme inline`** (§3). That is what makes
a future `[data-theme="dark"]` block work without touching a single component —
`inline` makes `bg-bg` compile to `background-color: var(--bg)` rather than
freezing the value at build time.

```css
/* globals.css — part 1 of 4 */
@import "tailwindcss";

:root {
  /* ---------- colour: ground & surfaces ---------- */
  --bg:              #FBFAF8; /* warm off-white ground — never pure #FFF */
  --bg-subtle:       #F5F3EF; /* recessed areas, table header fills */
  --bg-hover:        #F1EEE8; /* row / menu-item hover on the ground */
  --bg-active:       #EAE6DE; /* pressed, or selected row */
  --surface:         #FFFFFF; /* raised cards/panels ON the off-white ground */
  --surface-hover:   #FAF9F7; /* hover on a raised surface */

  /* ---------- colour: ink ---------- */
  --ink:             #0F1E37; /* deep navy — primary text */
  --ink-secondary:   #43526B; /* secondary text, body copy at small sizes */
  --ink-meta:        #64708A; /* information-bearing meta: timestamps, counts   */
                              /* 4.7:1 on --bg. See §6 contrast ruling.         */
  --ink-muted:       #7A879B; /* placeholders, disabled, decorative only (3.4:1)*/
  --ink-inverse:     #FBFAF8; /* text on --accent / --danger fills */

  /* ---------- colour: accent ---------- */
  --accent:          #1B3A6B; /* navy accent — primary actions */
  --accent-hover:    #16305A;
  --accent-active:   #122649;
  --accent-subtle:   #EDF1F7; /* selected nav item, info fill, focus wash */
  --accent-border:   #C6D2E4; /* border on an accent-subtle fill */

  /* ---------- colour: borders ---------- */
  --border:          #E6E2DA; /* hairline, warm — the default separator */
  --border-strong:   #D2CCC1; /* emphasised structural divider */
  --border-control:  #8F887C; /* form-control outlines ONLY — 3.4:1, WCAG 1.4.11 */

  /* ---------- colour: status (muted, editorial, never neon) ---------- */
  --success:         #2F6F4F;
  --success-subtle:  #ECF2EE;
  --success-border:  #C8DBCF;
  --warning:         #9A6B1F;
  --warning-subtle:  #F8F1E3;
  --warning-border:  #E6D5B4;
  --danger:          #A03A32;
  --danger-hover:    #8A322B;
  --danger-active:   #762A24;
  --danger-subtle:   #F9EDEC;
  --danger-border:   #E8CBC8;
  --info:            #2C5A8A;
  --info-subtle:     #EDF2F8;
  --info-border:     #C9D8E8;

  /* ---------- colour: focus & overlay ---------- */
  --ring:            #1B3A6B;                 /* 11:1 on --bg */
  --ring-danger:     #A03A32;                 /* focus ring inside destructive fills */
  --overlay:         rgb(15 30 55 / 0.28);    /* modal / drawer scrim */

  /* ---------- colour: charts (muted editorial, max 6 series) ---------- */
  --chart-1: #1B3A6B; /* navy    */
  --chart-2: #2F6F4F; /* pine    */
  --chart-3: #9A6B1F; /* ochre   */
  --chart-4: #6E7F99; /* slate   */
  --chart-5: #A03A32; /* clay    */
  --chart-6: #8C6E4F; /* umber   */
  --chart-grid:  #EDE9E1;  /* horizontal gridlines only */
  --chart-axis:  #7A879B;  /* tick labels */
  --chart-muted: #C9C3B8;  /* previous period / benchmark line */

  /* ---------- typography families (values come from next/font, §7) ---------- */
  --font-sans:  var(--font-inter),             ui-sans-serif, system-ui, sans-serif;
  --font-serif: var(--font-instrument-serif),  ui-serif, Georgia, serif;
  --font-mono:  var(--font-jetbrains-mono),    ui-monospace, SFMono-Regular, monospace;

  /* ---------- radii ---------- */
  --radius-xs:   4px;  /* checkbox, tiny chips */
  --radius-sm:   6px;  /* inputs, buttons (non-pill), menu items */
  --radius-md:  10px;  /* cards, panels, popovers */
  --radius-lg:  14px;  /* modals, drawers, hero panels */
  --radius-pill: 999px;/* primary actions + filter chips ONLY */

  /* ---------- shadows (barely there; no glow, no colour) ---------- */
  --shadow-xs: 0 1px 2px rgb(15 30 55 / 0.04);
  --shadow-sm: 0 1px 3px rgb(15 30 55 / 0.06);
  --shadow-md: 0 4px 16px rgb(15 30 55 / 0.08);  /* overlays */
  --shadow-lg: 0 12px 32px rgb(15 30 55 / 0.10); /* modal only */

  /* ---------- layout ---------- */
  --sidebar-w:           248px;
  --sidebar-w-collapsed:  64px;
  --header-h:             60px;
  --page-max:           1280px; /* app content column cap */
  --prose-max:            68ch; /* long-form text (help, AI summaries) */
  --form-max:            560px; /* single-column form column */
  --gutter:               20px; /* overridden per breakpoint in §11 */

  /* ---------- z-index (the complete ladder; nothing outside it) ---------- */
  --z-base:      0;
  --z-sticky:  100; /* sticky table header, page header */
  --z-dropdown:200;
  --z-overlay: 300; /* scrim */
  --z-modal:   400; /* dialog, drawer */
  --z-popover: 500; /* popover/menu opened FROM a modal */
  --z-toast:   600;
  --z-tooltip: 700;

  /* ---------- motion ---------- */
  --duration-fast: 120ms; /* hover, colour change, tooltip */
  --duration:      160ms; /* default: menus, tabs, toasts */
  --duration-slow: 200ms; /* dialogs, drawers — the ceiling */
  --ease-out:    cubic-bezier(0.22, 1, 0.36, 1); /* entrances, expansion */
  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);   /* moves between two states */
}
```

Rules on tokens, enforced in review:

1. A component may reference **only** the names above. A raw hex in
   `src/components/**` or `src/app/**` is a review blocker. Charts read
   `--chart-*` through `getComputedStyle` or the Tailwind utility, never literals.
2. No token is added without a second consumer. One-off values are a smell.
3. No `--*-foreground` / `--background` shadcn vocabulary. One naming system.
4. Dark mode is out of scope for v1, but no component may hardcode a light
   assumption (e.g. `text-white`, `bg-white`, `shadow-black/10`).

---

## 3. Tailwind v4 theme mapping

```css
/* globals.css — part 2 of 4 */
@theme inline {
  /* colours → bg-*, text-*, border-*, ring-*, fill-*, stroke-* */
  --color-bg:             var(--bg);
  --color-bg-subtle:      var(--bg-subtle);
  --color-bg-hover:       var(--bg-hover);
  --color-bg-active:      var(--bg-active);
  --color-surface:        var(--surface);
  --color-surface-hover:  var(--surface-hover);

  --color-ink:            var(--ink);
  --color-ink-secondary:  var(--ink-secondary);
  --color-ink-meta:       var(--ink-meta);
  --color-ink-muted:      var(--ink-muted);
  --color-ink-inverse:    var(--ink-inverse);

  --color-accent:         var(--accent);
  --color-accent-hover:   var(--accent-hover);
  --color-accent-active:  var(--accent-active);
  --color-accent-subtle:  var(--accent-subtle);
  --color-accent-border:  var(--accent-border);

  --color-border:         var(--border);
  --color-border-strong:  var(--border-strong);
  --color-border-control: var(--border-control);

  --color-success:        var(--success);
  --color-success-subtle: var(--success-subtle);
  --color-success-border: var(--success-border);
  --color-warning:        var(--warning);
  --color-warning-subtle: var(--warning-subtle);
  --color-warning-border: var(--warning-border);
  --color-danger:         var(--danger);
  --color-danger-hover:   var(--danger-hover);
  --color-danger-active:  var(--danger-active);
  --color-danger-subtle:  var(--danger-subtle);
  --color-danger-border:  var(--danger-border);
  --color-info:           var(--info);
  --color-info-subtle:    var(--info-subtle);
  --color-info-border:    var(--info-border);

  --color-ring:           var(--ring);
  --color-overlay:        var(--overlay);

  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-chart-6: var(--chart-6);
  --color-chart-grid:  var(--chart-grid);
  --color-chart-axis:  var(--chart-axis);
  --color-chart-muted: var(--chart-muted);

  /* families → font-sans, font-serif, font-mono */
  --font-sans:  var(--font-sans);
  --font-serif: var(--font-serif);
  --font-mono:  var(--font-mono);

  /* spacing: 4px base. Utilities p-1..p-24 etc. resolve to calc(n * 0.25rem). */
  --spacing: 0.25rem;

  /* radii → rounded-xs|sm|md|lg|pill. Tailwind's defaults are replaced. */
  --radius-xs:   var(--radius-xs);
  --radius-sm:   var(--radius-sm);
  --radius-md:   var(--radius-md);
  --radius-lg:   var(--radius-lg);
  --radius-pill: var(--radius-pill);

  /* shadows → shadow-xs|sm|md|lg */
  --shadow-xs: var(--shadow-xs);
  --shadow-sm: var(--shadow-sm);
  --shadow-md: var(--shadow-md);
  --shadow-lg: var(--shadow-lg);

  /* easing → ease-out (overridden), ease-in-out (overridden) */
  --ease-out:    var(--ease-out);
  --ease-in-out: var(--ease-in-out);

  /* type scale → text-display-xl … text-mono, each carrying lh/tracking/weight */
  --text-display-xl: 3.5rem;
  --text-display-xl--line-height: 1.04;
  --text-display-xl--letter-spacing: -0.02em;
  --text-display-xl--font-weight: 400;

  --text-display-lg: 2.5rem;
  --text-display-lg--line-height: 1.08;
  --text-display-lg--letter-spacing: -0.015em;
  --text-display-lg--font-weight: 400;

  --text-display-md: 1.875rem;
  --text-display-md--line-height: 1.15;
  --text-display-md--letter-spacing: -0.01em;
  --text-display-md--font-weight: 400;

  --text-heading: 1.125rem;
  --text-heading--line-height: 1.4;
  --text-heading--letter-spacing: -0.01em;
  --text-heading--font-weight: 600;

  --text-subheading: 1rem;
  --text-subheading--line-height: 1.5;
  --text-subheading--letter-spacing: -0.005em;
  --text-subheading--font-weight: 500;

  --text-body: 0.9375rem;
  --text-body--line-height: 1.6;
  --text-body--letter-spacing: 0em;
  --text-body--font-weight: 400;

  --text-body-sm: 0.875rem;
  --text-body-sm--line-height: 1.55;
  --text-body-sm--letter-spacing: 0em;
  --text-body-sm--font-weight: 400;

  --text-label: 0.8125rem;
  --text-label--line-height: 1.4;
  --text-label--letter-spacing: 0em;
  --text-label--font-weight: 500;

  --text-micro: 0.6875rem;
  --text-micro--line-height: 1.3;
  --text-micro--letter-spacing: 0.08em;
  --text-micro--font-weight: 500;

  --text-caption: 0.75rem;
  --text-caption--line-height: 1.45;
  --text-caption--letter-spacing: 0.01em;
  --text-caption--font-weight: 400;

  --text-mono: 0.8125rem;
  --text-mono--line-height: 1.5;
  --text-mono--letter-spacing: 0em;
  --text-mono--font-weight: 400;

  /* keyframes we own — replaces tailwindcss-animate / tw-animate-css */
  --animate-fade-in:     fade-in     var(--duration) var(--ease-out);
  --animate-fade-out:    fade-out    var(--duration-fast) ease-in;
  --animate-scale-in:    scale-in    var(--duration-slow) var(--ease-out);
  --animate-slide-up:    slide-up    var(--duration) var(--ease-out);
  --animate-slide-right: slide-right var(--duration-slow) var(--ease-out);
  --animate-shimmer:     shimmer     1.4s linear infinite;
}
```

`@theme` must stay top-level (not inside `@layer`), and appears once.

---

## 4. Base layer

```css
/* globals.css — part 3 of 4 */
@layer base {
  *, *::before, *::after { border-color: var(--border); }

  html {
    -webkit-text-size-adjust: 100%;
    scroll-behavior: smooth;
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
  }

  body {
    background-color: var(--bg);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: var(--text-body);
    line-height: var(--text-body--line-height);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    /* Inter: contextual alternates + disambiguated shapes. No stylistic ss0x
       beyond this — we are not designing a typeface. */
    font-feature-settings: "cv05" 1, "cv08" 1, "calt" 1;
  }

  /* Numbers must not jitter between renders in tables and metrics. */
  table, [data-tabular] { font-variant-numeric: tabular-nums; }

  h1, h2, h3, h4 { font-weight: inherit; text-wrap: balance; }
  p { text-wrap: pretty; }

  /* Focus: one ruling for the whole app. Never remove without replacing. */
  :focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
    border-radius: inherit;
  }
  :focus:not(:focus-visible) { outline: none; }

  ::selection { background: var(--accent-subtle); color: var(--ink); }

  ::placeholder { color: var(--ink-muted); opacity: 1; }

  /* Scrollbars: thin and warm, not chrome-default grey. */
  * { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border-radius: var(--radius-pill);
    border: 3px solid transparent;
    background-clip: content-box;
  }

  [hidden] { display: none !important; }
}

@keyframes fade-in     { from { opacity: 0 } to { opacity: 1 } }
@keyframes fade-out    { from { opacity: 1 } to { opacity: 0 } }
@keyframes scale-in    { from { opacity: 0; transform: scale(0.98) translateY(4px) }
                         to   { opacity: 1; transform: none } }
@keyframes slide-up    { from { opacity: 0; transform: translateY(6px) }
                         to   { opacity: 1; transform: none } }
@keyframes slide-right { from { transform: translateX(100%) }
                         to   { transform: none } }
@keyframes shimmer     { from { background-position: -200% 0 }
                         to   { background-position: 200% 0 } }

/* The global motion kill-switch. Nothing overrides this. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
}
```

Note `1ms` rather than `0s`: it keeps `animationend`/`transitionend` listeners
(used by Radix presence for exit animations) firing, so panels still unmount.

---

## 5. Custom utilities

```css
/* globals.css — part 4 of 4 */
@utility z-sticky   { z-index: var(--z-sticky); }
@utility z-dropdown { z-index: var(--z-dropdown); }
@utility z-overlay  { z-index: var(--z-overlay); }
@utility z-modal    { z-index: var(--z-modal); }
@utility z-popover  { z-index: var(--z-popover); }
@utility z-toast    { z-index: var(--z-toast); }
@utility z-tooltip  { z-index: var(--z-tooltip); }

/* The three text-family shorthands, so no component re-states fallbacks. */
@utility font-display { font-family: var(--font-serif); font-weight: 400; }

/* Page gutter — one utility, responsive inside, used by shell + full-bleed rows */
@utility gutter-x {
  padding-inline: 20px;
  @media (width >= 768px)  { padding-inline: 32px; }
  @media (width >= 1024px) { padding-inline: 40px; }
  @media (width >= 1280px) { padding-inline: 56px; }
}

/* Skeleton sheen. Only place a gradient is legal, and it is motion, not decor. */
@utility skeleton {
  background-color: var(--bg-subtle);
  background-image: linear-gradient(90deg,
    transparent 0%, rgb(255 255 255 / 0.6) 50%, transparent 100%);
  background-size: 200% 100%;
  animation: var(--animate-shimmer);
  border-radius: var(--radius-sm);
}
@media (prefers-reduced-motion: reduce) {
  .skeleton { background-image: none; }
}

/* Truncation at N lines — used by email previews and AI summaries. */
@utility clamp-* {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: --value(integer);
  overflow: hidden;
}
```

---

## 6. Colour contrast rulings (real constraints, stated plainly)

Measured against `--bg` `#FBFAF8`:

| Token | Ratio | Verdict |
|---|---|---|
| `--ink` #0F1E37 | ~15.4:1 | anything |
| `--ink-secondary` #43526B | ~7.1:1 | anything |
| `--ink-meta` #64708A | ~4.7:1 | passes AA at any size |
| `--ink-muted` #7A879B | **~3.4:1** | **fails AA for text** |
| `--border` #E6E2DA | ~1.15:1 | decorative separation only |
| `--border-strong` #D2CCC1 | ~1.5:1 | decorative separation only |
| `--border-control` #8F887C | ~3.4:1 | passes 1.4.11 for control boundaries |
| `--ink-inverse` on `--accent` | ~10.8:1 | button labels |

Two consequences, and neither is optional:

1. **`--ink-muted` may not carry information.** It is for placeholder text
   (exempt), disabled text (exempt), and decorative glyphs. Timestamps, counts,
   "3 of 40 sent", secondary table columns, helper text — all of that is
   `--ink-meta`. This is why `--ink-meta` exists: the brief assigns
   `--ink-muted` to "meta, timestamps, placeholders", but at 12–13px that
   combination fails the brief's own ≥4.5:1 gate. **[LEAD]** Ratify
   `--ink-meta` as the information-bearing meta colour and demote
   `--ink-muted` to placeholder/disabled, or darken `--ink-muted` itself to
   `#64708A` and drop the extra token. Either is fine; picking neither is not.

2. **Hairline borders cannot identify a control.** WCAG 1.4.11 wants 3:1 for
   the visual boundary of a form control when the boundary is what identifies
   it. `--border` at 1.15:1 does not get there, and darkening the global border
   to 3:1 would turn the whole product grey. So: structural hairlines stay
   `--border` (they separate content, they do not identify controls, and they
   are exempt), while **input / textarea / select / checkbox / radio / switch
   outlines use `--border-control`** — one hairline weight, still warm, but
   actually visible. This is the single place where a11y outvotes the
   hairline aesthetic. **[LEAD]** If you'd rather take the documented 1.4.11
   exception for the softer look, say so and we swap to `--border-strong`
   app-wide; the change is one token reference in six components.

Also: never encode state in colour alone. Every status colour is paired with a
text label or a Lucide glyph — see StatusBadge (§9.8).

---

## 7. Type scale

Every role, and the **only** places it may appear. The Tailwind utility name is
authoritative — a component that sets `font-size` directly is a review blocker.

| Role | Utility | Family | Size | LH | Weight | Tracking | Where it may be used |
|---|---|---|---|---|---|---|---|
| Display XL | `text-display-xl font-display` | Instrument Serif | 3.5rem / 56px | 1.04 | 400 | −0.02em | Marketing hero only. Not in `(app)`. |
| Display LG | `text-display-lg font-display` | Instrument Serif | 2.5rem / 40px | 1.08 | 400 | −0.015em | Auth screen titles; marketing section titles; the single hero metric on Dashboard/Analytics. |
| Display MD | `text-display-md font-display` | Instrument Serif | 1.875rem / 30px | 1.15 | 400 | −0.01em | The `<h1>` of every app page (PageHeader title). StatCard values. Empty-state headline. |
| Heading | `text-heading` | Inter | 1.125rem / 18px | 1.4 | 600 | −0.01em | Card/Panel titles, Modal titles, Drawer titles, section `<h2>`. |
| Subheading | `text-subheading` | Inter | 1rem / 16px | 1.5 | 500 | −0.005em | Sub-section `<h3>`, list-item primary line (lead name, thread subject). |
| Body | `text-body` | Inter | 0.9375rem / 15px | 1.6 | 400 | 0 | Default. Paragraphs, email bodies, table cells, input values. |
| Body SM | `text-body-sm` | Inter | 0.875rem / 14px | 1.55 | 400 | 0 | Dense contexts: table cells in wide tables, menu items, tooltips, secondary lines. |
| Label | `text-label` | Inter | 0.8125rem / 13px | 1.4 | 500 | 0 | Form labels, button text (sm/md), tab labels, badge text, table `<th>`. |
| Micro | `text-micro uppercase` | Inter | 0.6875rem / 11px | 1.3 | 500 | 0.08em | Section eyebrows / overline labels above a heading. **Max one per section.** |
| Caption | `text-caption` | Inter | 0.75rem / 12px | 1.45 | 400 | 0.01em | Helper text under inputs, field errors, timestamps, chart axis labels, footnotes. |
| Mono | `text-mono font-mono` | JetBrains Mono | 0.8125rem / 13px | 1.5 | 400 | 0 | Technical values only: DNS records, SPF/DKIM strings, IDs, API keys, job ids, merge tags `{{first_name}}`, code, JSON. |

### Hard rules

1. **Serif appears in exactly four places:** marketing hero, auth title, the
   app page `<h1>`, and a hero metric number. Never a label, button, table
   header, badge, tab, menu item, input, tooltip, or any text under 18px.
   Instrument Serif at small sizes turns to mush and reads as a template.
2. **No weight ≥ 700 anywhere in the app shell.** Emphasis is 600, or a size
   step, or space. `font-bold` is banned in `src/app/(app)/**` and
   `src/components/**`; use `font-medium` (500) / `font-semibold` (600).
   Marketing may not exceed 600 either.
3. **Display weight is 400 only.** Instrument Serif ships one weight; a
   synthetic bold (`font-semibold` on a serif) is a review blocker.
4. **Uppercase is only `text-micro`.** No uppercase buttons, no uppercase
   table headers. Table `<th>` is sentence-case `text-label` in `--ink-meta`.
5. **One `<h1>` per page**, always the PageHeader title.
6. **Mono is for values, not for looking technical.** A campaign name is not
   mono. A lead's email address is `text-body` (it is prose to the user); a
   DKIM record is mono (it is a string to be copied exactly).
7. Numeric columns and metrics get `tabular-nums` (already global on `table`;
   add `data-tabular` on metric containers).

### 7.1 `next/font` setup

```ts
// src/app/fonts.ts
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";

/**
 * next/font/google downloads and self-hosts at build time — no runtime request
 * to Google, no layout shift. `display: "swap"` plus size-adjust metrics are
 * applied automatically from the fallback we name.
 */
export const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  // Variable font: one file covers 400/500/600. Do not list weights.
  adjustFontFallback: true,
});

export const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument-serif",
  weight: "400",          // the only weight the family ships
  style: ["normal"],      // italic exists; we do not use it
  adjustFontFallback: true,
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
  weight: ["400", "500"], // 500 for emphasised code spans only
  adjustFontFallback: true,
});

export const fontVariables = [
  inter.variable,
  instrumentSerif.variable,
  jetbrainsMono.variable,
].join(" ");
```

```tsx
// src/app/layout.tsx (excerpt — this file is owned by the shell/foundation slice)
import "./globals.css";
import { fontVariables } from "./fonts";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <body className="min-h-dvh bg-bg text-ink antialiased">{children}</body>
    </html>
  );
}
```

Notes: `suppressHydrationWarning` is there for the future `data-theme`
attribute, not for anything in v1. If a build-time font fetch is ever a
problem in CI (offline runner), the fallback is `next/font/local` with the
three `.woff2` files committed under `src/app/fonts/` — same variable names, so
nothing else changes. **[LEAD]** confirm the CI runner has network egress at
build time; if not, we vendor the woff2 files now rather than discovering it in
phase 1.

Preload only Inter (`preload: true` is the default). Instrument Serif and
JetBrains Mono are `preload: false`-equivalent in practice because they are
used below the fold on most screens — but Next handles this per-route; do not
hand-tune it unless Lighthouse complains.

---

## 8. How we vendor and own shadcn/ui

shadcn/ui is not a dependency — it is a **one-time code drop we then own**. The
brief locks "vendored + owned, not a black box". Concretely:

### 8.1 What we take

Run once per primitive, into `src/components/ui/`:

```bash
bunx --bun shadcn@latest add button input textarea select checkbox radio-group \
  switch badge card table tabs dialog sheet dropdown-menu tooltip popover \
  separator skeleton progress avatar label sonner
```

After the drop, **delete the generator's config awareness** — we do not keep
using `shadcn add` to update these files. They are ours; upstream changes are
read as reference, never applied automatically.

The real runtime dependencies this pulls (all justified, all headless):

| Package | Why we cannot hand-roll it |
|---|---|
| `@radix-ui/react-*` (dialog, dropdown-menu, select, tabs, tooltip, popover, checkbox, radio-group, switch, avatar, separator, progress, slot) | Focus trapping, focus restoration, typeahead, collision-aware positioning, `aria-*` wiring, scroll locking, RTL. Re-implementing this accessibly is thousands of lines and the a11y gate is non-negotiable. |
| `class-variance-authority` | Variant → class mapping with types. |
| `clsx` + `tailwind-merge` | Conflict-safe class merging for `className` overrides. |
| `lucide-react` | Locked in the brief. |
| `sonner` | Toasts with stacking, swipe-dismiss, and an `aria-live` region done right. |

**[LEAD]** These five (Radix, cva, clsx, tailwind-merge, sonner) are transitive
consequences of "use shadcn/ui" but are not named in the brief's justified-
additions list. Ratify them explicitly so the dependency audit stays clean.
`lucide-react` and Radix are already implied by the locked stack. If sonner is
rejected, the fallback is a ~120-line toast built on `aria-live="polite"` plus a
React context — worse ergonomics, acceptable.

### 8.2 What we override, immediately and completely

Every generated file gets these edits before it is committed. A file still
containing shadcn defaults is an unfinished file.

1. **Rip out the shadcn colour vocabulary.** `bg-background`,
   `text-foreground`, `bg-primary`, `text-primary-foreground`, `bg-muted`,
   `border-input`, `ring-offset-background`, `bg-destructive` — all deleted and
   replaced with our tokens (§2/§3). We do **not** define compatibility aliases
   for them; aliasing would let the two vocabularies coexist and drift.
2. **Rip out `dark:` variants.** Dark mode arrives via `[data-theme]` on the
   token block, not via per-class `dark:` pairs. Leaving them creates a second,
   unmaintained theme path.
3. **Rip out the default ring pattern.** shadcn emits
   `focus-visible:ring-2 focus-visible:ring-offset-2 ring-offset-background`.
   We use the single global `:focus-visible` outline from §4 and only add
   explicit `focus-visible:` classes where the outline needs a different colour
   (destructive fills → `--ring-danger`) or an inset treatment (table rows).
4. **Re-scale every size.** shadcn's `h-9`/`h-10` controls and `text-sm`
   defaults are replaced by our §9 dimensions. Table rows in particular go from
   shadcn's cramped default to 44–52px.
5. **Re-radius.** shadcn rounds everything with one `--radius`. We apply §2's
   five-step scale, and `rounded-pill` appears on exactly two components.
6. **Replace `tailwindcss-animate` / `tw-animate-css` classes**
   (`animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`) with our
   `--animate-*` keyframes from §3, driven off Radix's
   `data-[state=open]` / `data-[state=closed]`. Those libraries' defaults are
   too long and too springy for a 120–200ms system, and `zoom-in-95` on a
   dialog reads as a startup app.
7. **Delete unused variants.** If a component ships six variants and we spec
   four, the other two are removed. Dead variants become drift vectors.

### 8.3 What we do not take

`form` (we wire react-hook-form ourselves, §9.2), `chart` (Recharts wrapper —
see §12 before adding any chart at all), `carousel`, `accordion` (only if a
real need appears), `command`/`combobox` (defer to phase 4 when lead search
needs it), `calendar`/`date-picker` (defer to phase 6 scheduling; the shadcn
one pulls `react-day-picker` and needs its own restyle pass), `sidebar` (ours
is 40 lines and bespoke — see §11.2), and anything with a decorative gradient.

### 8.4 The `cn` helper

```ts
// src/lib/cn.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

Every primitive accepts `className` and merges last, so call sites can adjust
layout (margin, width, grid placement) without forking the component. Call
sites may **not** use `className` to change colour, radius, or type role — that
is a variant request, and variants live in the component.

### 8.5 Component file contract

```tsx
// shape every file in src/components/ui/ follows
"use client"; // ONLY if the component has state, refs, or event handlers

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const buttonVariants = cva("<base classes>", {
  variants: { variant: {/* … */}, size: {/* … */} },
  defaultVariants: { variant: "secondary", size: "md" },
});

export interface ButtonProps
  extends React.ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  /* … */
}
export { buttonVariants };
```

Rules: named exports; `React.ComponentPropsWithoutRef<T>` so every native
attribute passes through; `ref` as a plain prop (React 19 — no `forwardRef`);
no data fetching, no `modules/*` import, no `server-only` import (brief §3
import rule 3). Button/Badge/Card are **not** `"use client"` — a Server
Component must be able to render them.

---

## 9. Component specs

Conventions used below: `h-*` values are exact pixel heights; "ring" always means
the global `:focus-visible` outline from §4 unless a different colour is named.
Every interactive element has a **minimum 32px** hit target in dense contexts
and **36px+** elsewhere; icon-only controls smaller than 32px get an invisible
expanded hit area via `before:absolute before:-inset-1`.

### 9.1 Button — `src/components/ui/button.tsx`

**Anatomy:** `[leading icon?] label [trailing icon?]`, `inline-flex items-center
justify-center gap-2 whitespace-nowrap select-none`. Icons are Lucide at
`size-4` (16px), `stroke-width={1.75}` — Lucide's 2 is too heavy next to Inter
500. `shrink-0` on icons so a long label never squashes them.

**Variants**

| Variant | Radius | Rest | Hover | Active | Notes |
|---|---|---|---|---|---|
| `primary` | `rounded-pill` | `bg-accent text-ink-inverse shadow-xs` | `bg-accent-hover` | `bg-accent-active` | The pill. Max **one per page region**. |
| `secondary` | `rounded-sm` | `bg-surface text-ink border border-border-strong shadow-xs` | `bg-surface-hover border-ink-muted` | `bg-bg-active` | The default. `defaultVariants.variant = "secondary"`. |
| `ghost` | `rounded-sm` | `text-ink-secondary` (no border, no bg) | `bg-bg-hover text-ink` | `bg-bg-active` | Toolbars, table row actions, menu triggers. |
| `destructive` | `rounded-sm` | `bg-danger text-ink-inverse shadow-xs` | `bg-danger-hover` | `bg-danger-active` | Confirmation dialogs only, never a bare list action. Focus ring → `--ring-danger` at `outline-offset-2` (the navy ring on a clay fill is muddy). |
| `destructive-ghost` | `rounded-sm` | `text-danger` | `bg-danger-subtle` | `bg-danger-subtle` | The row-level "Delete" that opens the confirm dialog. |
| `link` | none | `text-accent underline underline-offset-4 decoration-border-strong` | `decoration-accent` | — | Inline in prose. No padding, no height. |

**Sizes**

| Size | Height | Padding X | Type | Icon gap |
|---|---|---|---|---|
| `sm` | 32px | 12px (10px if leading icon) | `text-label` (13/500) | 6px |
| `md` | 36px | 16px (14px w/ icon) | `text-label` (13/500) | 8px |
| `lg` | 44px | 24px | `text-body` 15/500 | 8px |
| `icon-sm` | 28×28 | — | — | — |
| `icon` | 32×32 | — | — | — |
| `icon-lg` | 36×36 | — | — | — |

`lg` is for the single primary action on an auth screen or an empty state. It is
not a page-header size.

**States**

- **default / hover / active** — per table. Transition:
  `transition-[background-color,border-color,color] duration-fast ease-out`.
  Never transition `box-shadow` on a button (it draws the eye to nothing).
- **focus-visible** — global outline. On `primary`/`destructive` the fill and
  ring can touch, so `outline-offset: 2px` is mandatory (it already is, globally).
- **disabled** — `disabled:opacity-45 disabled:pointer-events-none`. Keep the
  real `disabled` attribute (screen readers need it); do not fake it with
  `aria-disabled` + a click guard unless the button must stay focusable to host
  a tooltip explaining why — in that case use `aria-disabled="true"`, keep it
  focusable, and no-op the handler.
- **loading** — `loading` prop. Replaces the leading icon (or prepends) with
  `<Loader2 className="size-4 animate-spin" />`, sets `disabled`, sets
  `aria-busy="true"`, and **keeps the label text** so width does not collapse.
  The spinner is the one exception to "nothing spins" — a determinate progress
  bar for a 300ms action is worse.
- **error** — buttons do not have an error state. Errors render adjacent
  (form summary, toast, field message).

**A11y:** `type` is always explicit (`"button"` unless it submits). Icon-only
variants require `aria-label` — enforce it in types:

```ts
type IconOnly = { size: "icon-sm" | "icon" | "icon-lg"; "aria-label": string };
type WithLabel = { size?: "sm" | "md" | "lg"; "aria-label"?: string };
export type ButtonProps = React.ComponentPropsWithoutRef<"button"> &
  Omit<VariantProps<typeof buttonVariants>, "size"> &
  (IconOnly | WithLabel) & { asChild?: boolean; loading?: boolean };
```

`asChild` (Radix `Slot`) for links: `<Button asChild><Link href="…">…</Link></Button>`.
Never nest an `<a>` inside a `<button>`.

### 9.2 Input — `src/components/ui/input.tsx`

**Anatomy:** `Label` → `[prefix?] <input> [suffix?]` → `HelpText | ErrorText`.
The wrapper composite lives in `src/components/patterns/field.tsx`:

```tsx
// src/components/patterns/field.tsx
interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;          // rendered as help text; becomes aria-describedby
  error?: string;         // rendered instead of hint; sets aria-invalid
  required?: boolean;
  children: React.ReactNode;
}
```

`Field` owns the `id`/`aria-describedby`/`aria-invalid` wiring so no form has to
remember it. With react-hook-form, `error` comes from
`formState.errors[name]?.message`.

**Dimensions:** `sm` 32px · `md` 36px (default) · `lg` 40px. Padding-inline 12px
(10px with an icon prefix, plus `pl-9` for the icon). `rounded-sm`.
`text-body` (15px — 16px would be safer on iOS but this is a desktop tool and
15px does not trigger zoom on modern iOS; if a mobile zoom bug appears, bump to
16px, do not add a viewport `maximum-scale`).

**States**

| State | Classes |
|---|---|
| default | `bg-surface text-ink border border-border-control` |
| hover | `hover:border-ink-muted` |
| focus | global ring; plus `border-accent` so the field reads as active even with the ring suppressed by a browser |
| disabled | `bg-bg-subtle text-ink-muted border-border cursor-not-allowed` |
| readonly | `bg-bg-subtle text-ink border-border` (readable, not greyed) |
| error | `border-danger` + help slot renders `text-caption text-danger` with `<AlertCircle className="size-3.5" />`, `aria-invalid="true"` |
| loading | inputs do not load. If validating async, a `Loader2` suffix icon + `aria-busy` on the wrapper. |

Label: `text-label text-ink`, 6px gap to the control. Required marker is the
word "Required" in `text-caption text-ink-meta` beside the label — **not** a red
asterisk (asterisks are unlabelled to screen readers and, more practically,
users do not know what they mean). Optional fields in a mostly-required form get
"Optional" instead; pick one direction per form, never both.

Help text `text-caption text-ink-meta`, 6px below. Error replaces help text at
the same position so layout does not shift. Autofill: override Chrome's yellow
with `[&:-webkit-autofill]:shadow-[inset_0_0_0_100px_var(--surface)]` and
`[&:-webkit-autofill]:[-webkit-text-fill-color:var(--ink)]`.

**A11y:** never a placeholder as the label. `autocomplete` on every real-world
field (`email`, `current-password`, `new-password`, `organization`). Error text
is in the `aria-describedby` chain, so it is announced on focus.

### 9.3 Textarea — `src/components/ui/textarea.tsx`

Same tokens and states as Input. `min-h-20` (80px), `py-2.5`,
`field-sizing-content` for auto-grow with `max-h-64` then scroll — that CSS
property is Chrome/Edge/Safari 17.4+; Firefox falls back to a fixed
`min-h`, which is acceptable degradation, so **no JS auto-resize hook**.
`resize-y` allowed on the sequence-step body editor, `resize-none` elsewhere.

Character counter (used on subject lines and LinkedIn-style limits):
`text-caption text-ink-meta tabular-nums` bottom-right of the field footer row,
turning `text-danger` at 100%+ and `text-warning` at 90%+. The counter is
`aria-live="polite"` **only** within 20 characters of the limit — announcing
every keystroke is hostile.

### 9.4 Select — `src/components/ui/select.tsx`

Radix Select (not native `<select>`) so the menu can be styled and support
grouping/icons. Trigger matches Input dimensions exactly, plus
`<ChevronDown className="size-4 text-ink-meta" />` trailing.

- **Content:** `bg-surface border border-border rounded-md shadow-md p-1
  min-w-[--radix-select-trigger-width] max-h-72 overflow-y-auto z-dropdown`.
- **Item:** `h-8 px-2 rounded-xs text-body-sm text-ink cursor-default`,
  `data-[highlighted]:bg-bg-hover`, `data-[state=checked]` shows a
  `<Check className="size-3.5 text-accent" />` in a fixed 20px leading slot so
  labels align whether checked or not.
- **Group label:** `text-micro uppercase text-ink-meta px-2 pt-2 pb-1`.
- **Animation:** `data-[state=open]:animate-scale-in
  data-[state=closed]:animate-fade-out`, with
  `data-[side=bottom]:origin-top data-[side=top]:origin-bottom`.
- **Placeholder:** `text-ink-muted`.
- **Disabled item:** `data-[disabled]:opacity-45`.

Use a **native `<select>`** in exactly one case: inside a table cell where 200
rows would each mount a Radix portal. Nowhere else has that pressure yet.
For >12 options add a search field inside the content (Radix Select does not do
this — that is the point where we switch to Popover + Command, deferred to
phase 4).

### 9.5 Checkbox — `src/components/ui/checkbox.tsx`

16×16, `rounded-xs`, `border border-border-control bg-surface`. Checked:
`bg-accent border-accent` with `<Check className="size-3 text-ink-inverse"
stroke-width={2.5} />`. Indeterminate (the "select all" header state when a
subset is chosen): `bg-accent` with a 8×1.5px `--ink-inverse` bar, driven by
`data-[state=indeterminate]`.

- hover: `border-ink-muted` (unchecked) / `bg-accent-hover` (checked)
- focus-visible: global ring, `outline-offset-2`
- disabled: `opacity-45`, `bg-bg-subtle` when unchecked
- error: `border-danger` (used by "accept terms"-style required checkboxes)

**Hit target:** the 16px box sits inside a 32px clickable `<label>` row —
`flex items-start gap-2.5 py-1.5` with the label text `text-body-sm text-ink`.
Never a bare 16px target. Table-header and table-cell checkboxes get
`before:absolute before:-inset-2.5` on the box instead, since a label row would
break cell alignment.

Multi-select in tables: the header checkbox is `aria-label="Select all rows on
this page"` — say *this page*, because our tables are server-paginated and
"select all" cannot mean 40,000 leads. Cross-page bulk selection is an explicit
"Select all N matching this filter" affordance in the bulk-action bar, not a
checkbox state. **This matters:** conflating the two is how outreach tools
accidentally email an entire database.

### 9.6 Radio — `src/components/ui/radio-group.tsx`

16×16, `rounded-pill` (the one legitimate non-action pill — a radio is a circle
by convention and breaking it costs recognisability). `border border-border-control
bg-surface`; checked shows a 6px `--accent` centre dot with
`border-accent`. States mirror Checkbox.

Two layouts:
- **List** (default): stacked `<label>` rows, 32px min height.
- **Card** (`variant="card"`): used for the sequence-step type picker and plan
  selection. `border border-border rounded-md p-4 bg-surface`, checked →
  `border-accent bg-accent-subtle shadow-xs`, hover → `border-border-strong`.
  The radio dot stays visible in the card's top-left; **do not** hide the
  control and rely on the card border alone — that removes the a11y anchor and
  the "which one is selected" affordance for colour-blind users.

`RadioGroup` renders `role="radiogroup"` with an `aria-labelledby` pointing at
the group's legend. Arrow keys move and select (Radix default, correct).

### 9.7 Switch — `src/components/ui/switch.tsx`

Track 36×20, `rounded-pill`, `bg-border-strong` off / `bg-accent` on. Thumb
16×16 `bg-surface rounded-pill shadow-xs`, `translate-x-0` → `translate-x-4`,
`transition-transform duration-fast ease-out`.

**When to use a Switch vs a Checkbox — this is a real rule, not taste:** a
Switch takes effect *immediately* and represents an ongoing on/off state
(campaign active, open tracking enabled, mailbox in warmup). A Checkbox is a
form value submitted later. Never put a Switch in a form with a Save button.

Because switches fire immediately, each one needs:
- optimistic UI via `useOptimistic`, reverting on action failure,
- a `disabled` + `aria-busy` window while in flight,
- an error toast naming what failed to change,
- `aria-label` or an associated label; state is conveyed by `role="switch"` +
  `aria-checked`, so **no "On"/"Off" text is needed** — but if the consequence is
  destructive (pausing a live campaign), the label must say so and the switch
  opens a confirm dialog instead of firing directly.

### 9.8 Badge & StatusBadge — `src/components/ui/badge.tsx`

**Badge** (neutral count/tag): `inline-flex items-center h-5 px-2 rounded-xs
text-caption font-medium bg-bg-subtle text-ink-secondary border border-border`.
`rounded-xs`, not pill — pills are reserved. Tag variant for lead tags adds a
1px dot in `--ink-muted` before the text.

**StatusBadge** is a distinct component, because status must never be colour
alone. Anatomy: `[8px dot | 12px icon] label`, `h-6 px-2 gap-1.5 rounded-xs
text-caption font-medium`, tinted fill + hairline border in the family colour.

| Domain status | Token family | Dot/icon | Label |
|---|---|---|---|
| Campaign `DRAFT` | neutral (`bg-subtle`/`ink-secondary`/`border`) | `Circle` outline | Draft |
| Campaign `ACTIVE` | success | filled dot | Active |
| Campaign `PAUSED` | warning | `Pause` | Paused |
| Campaign `COMPLETED` | info | `Check` | Completed |
| Campaign `ARCHIVED` | neutral | `Archive` | Archived |
| Email `QUEUED` | neutral | `Clock` | Queued |
| Email `SENT` | info | `Send` | Sent |
| Email `DELIVERED` | success | `Check` | Delivered |
| Email `OPENED` | info | `Eye` | Opened¹ |
| Email `CLICKED` | info | `MousePointerClick` | Clicked |
| Email `REPLIED` | success | `Reply` | Replied |
| Email `BOUNCED` | danger | `AlertTriangle` | Bounced |
| Email `COMPLAINED` | danger | `Flag` | Spam complaint |
| Email `UNSUBSCRIBED` | warning | `UserMinus` | Unsubscribed |
| Email `FAILED` | danger | `X` | Failed |
| Mailbox `CONNECTED` | success | filled dot | Connected |
| Mailbox `WARMING` | warning | `Thermometer` | Warming up |
| Mailbox `TOKEN_EXPIRED` | danger | `KeyRound` | Reconnect needed |
| Mailbox `RATE_LIMITED` | warning | `Gauge` | Rate limited |
| Mailbox `DISCONNECTED` | neutral | `Unplug` | Disconnected |
| Job `PENDING`/`RUNNING`/`DONE`/`RETRY`/`DEAD` | neutral / info / success / warning / danger | `Clock`/`Loader`/`Check`/`RotateCw`/`Skull`→ use `Ban` | Pending / Running / Done / Retrying / Dead-lettered |
| Reply intent `POSITIVE`/`NEUTRAL`/`NEGATIVE`/`OOO`/`UNSUBSCRIBE` | success / neutral / danger / warning / warning | `ThumbsUp`/`Minus`/`ThumbsDown`/`Plane`/`UserMinus` | Interested / Neutral / Not interested / Out of office / Opt-out |

¹ **Open tracking is unreliable.** Apple Mail Privacy Protection and Gmail image
proxying pre-fetch pixels, and many clients block them outright, so `OPENED` is
both over- and under-counted. The `OPENED` StatusBadge carries a
`<Tooltip>`: "Open tracking is indicative only — many mail clients block or
pre-fetch tracking pixels." Analytics labels the metric "Opens (indicative)".
This is a product-honesty requirement from brief §10, implemented in the
component so nobody can forget it.

Prop shape — a lookup map, not conditionals at call sites:

```ts
// src/components/ui/badge.tsx
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";
export interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
  icon?: LucideIcon;   // omit → filled dot in the tone colour
  hint?: string;       // renders the tooltip; required for OPENED
}
```

The domain→(tone, icon, label) mapping lives in
`src/components/patterns/status-map.ts` — **not** in `ui/`, because `ui/` must
stay free of domain knowledge (brief §3 rule 3). AI-generated values additionally
carry a `<Sparkles className="size-3" />` prefix and the tooltip "Generated by
AI — review before sending" (brief §10 attribution requirement).

Never render more than **two** StatusBadges in one table row. Three colours in a
row is noise; move the rest into the row detail.

### 9.9 Card — `src/components/ui/card.tsx`

The raised container on the off-white ground. `bg-surface border border-border
rounded-md shadow-xs`. Sub-parts: `CardHeader` (`p-5 pb-0`, or `p-5 border-b
border-border` when the body is a table/list), `CardTitle` (`text-heading`),
`CardDescription` (`text-body-sm text-ink-secondary`, 4px below title),
`CardContent` (`p-5`), `CardFooter` (`p-5 pt-0`, or `px-5 py-3 border-t
border-border bg-bg-subtle` for an action bar).

- **Interactive card** (`asChild` around a `Link` — campaign cards, mailbox
  cards): `hover:border-border-strong hover:shadow-sm transition-[box-shadow,
  border-color] duration-fast`. **No lift** (`hover:-translate-y-1` is the
  single most template-y hover in SaaS). The whole card is one link; internal
  actions use a `Dropdown` with `e.stopPropagation()`.
- **Selected:** `border-accent ring-1 ring-accent-border`.
- **No shadow on nested cards.** A card inside a card gets
  `bg-bg-subtle border-border shadow-none` — depth stacking reads as clutter.
- Cards do not carry decorative icons in a tinted rounded square. That is the
  generic-dashboard tell.

**StatCard** (`src/components/patterns/stat-card.tsx`) is the one place a metric
gets display type:

```
┌─────────────────────────────┐
│ REPLY RATE            ⓘ     │  text-micro uppercase ink-meta + optional tooltip
│                             │
│ 4.2%                        │  text-display-md font-display ink, tabular-nums
│ 12 replies from 284 sent    │  text-caption ink-meta — the denominator, always
│ ▁▂▃▅▃▆  +0.8pt vs prev 7d   │  optional sparkline + delta
└─────────────────────────────┘
```

Rules: **always show the denominator.** "4.2%" alone is a lie waiting to happen.
The delta is `text-caption` with `--success`/`--danger` text and an arrow glyph,
and is **suppressed entirely** when either period's sample is below the module's
minimum (brief §10) — replaced by `text-caption text-ink-meta` "Not enough data
yet". No coloured background on the whole card, no big circular icon.

### 9.10 Panel — `src/components/ui/panel.tsx`

Distinct from Card: a Panel is a **structural region of a page**, not a raised
object. Used for the inbox thread pane, the sequence builder canvas, settings
sections. `bg-surface border border-border rounded-lg` with **no shadow**, and it
typically fills its grid area (`flex flex-col min-h-0 overflow-hidden`).

`PanelHeader`: `h-12 px-4 flex items-center justify-between border-b
border-border shrink-0`, title `text-subheading`. `PanelBody`:
`flex-1 min-h-0 overflow-y-auto p-4`. `PanelFooter`: `px-4 py-3 border-t
border-border bg-bg-subtle shrink-0`.

`min-h-0` on the flex child is load-bearing — without it the body will not
scroll inside a flex column. Note it in a comment in the file; it gets deleted
by well-meaning cleanups otherwise.

### 9.11 Table — `src/components/ui/table.tsx` + `patterns/data-table.tsx`

The table is where this design system either reads as editorial or collapses into
a spreadsheet. Spec is strict.

```
┌────────────────────────────────────────────────────────────────┐
│ ☐  Lead              Company        Status      Last activity ⌄ │ ← sticky, 40px
├────────────────────────────────────────────────────────────────┤
│ ☐  Dana Whitfield    Northwind      ● Active    2 days ago   ⋯ │ ← 48px
│ ☐  Marcus Reed       Copperline     ● Replied   4 hours ago  ⋯ │
│ ☐  Priya Raman       Ashgrove Ltd   ○ Queued    —            ⋯ │
└────────────────────────────────────────────────────────────────┘
  Showing 1–25 of 1,284                          ‹ 1 2 3 … 52 ›
```

**Structure:** real `<table>` with `<caption class="sr-only">`, `<thead>`,
`<tbody>`, `<th scope="col">`. `w-full border-collapse
text-body-sm`, `table-layout: auto` with explicit `w-*` on the columns that must
not collapse (checkbox 40px, actions 48px). Never a `div` grid pretending to be
a table — screen-reader table navigation is the whole point.

**Header row:** height 40px. `bg-bg-subtle` fill, `border-b border-border-strong`
(the one place we use the stronger border — it anchors the sticky header).
`th`: `text-label text-ink-meta text-left px-4 font-medium`, **sentence case, not
uppercase**. Sticky: `sticky top-0 z-sticky` on the `<th>` elements (not
`<thead>` — Safari ignores it there), and the container is
`overflow-auto` with the header's `bg-bg-subtle` opaque so rows do not bleed
through.

**Body rows:** **48px** default (`h-12`), `44px` in `density="compact"`, `52px`
in `density="comfortable"` (used when a row carries an avatar + two text lines).
`border-b border-border` on every row; the last row's border is removed and the
container's own border closes the shape. **Zebra striping is banned** — the
hairline plus the row height does the work, and stripes are the spreadsheet tell.

- **hover:** `hover:bg-bg-hover` — the entire row, `transition-colors
  duration-fast`.
- **selected:** `bg-accent-subtle` (checkbox checked), and it survives hover
  (`data-[state=selected]:bg-accent-subtle`).
- **clickable row:** the primary cell contains the `<Link>`, and the row gets
  `cursor-pointer` with an `onClick` that forwards to that link only when the
  event target is not an interactive descendant. Keyboard users tab to the link,
  which is why the link must exist. Focus inside a row draws an **inset** ring
  (`focus-visible:outline-offset-[-2px]`) so it is not clipped by
  `overflow-hidden`.
- **row actions:** trailing cell, a single `ghost` `icon-sm` `MoreHorizontal`
  dropdown trigger. It is `opacity-0 group-hover/row:opacity-100
  focus-visible:opacity-100` — but **only** on pointer devices:
  wrap in `@media (hover: hover)`, otherwise it is invisible and unusable on
  touch. Never a row of three visible icon buttons per row.
- **numeric cells:** `text-right tabular-nums`, and the `<th>` is right-aligned
  to match.
- **empty cell:** an em-dash `—` in `text-ink-muted`, never blank, never "N/A".
- **truncation:** `truncate max-w-0` on the flexible cell with `title` attribute
  for the full value. Two-line wrap only in `comfortable` density.

**Sort:** `<th>` becomes a `<button>` with `aria-sort="ascending|descending|none"`
and a `ChevronUp`/`ChevronDown` at `size-3.5 text-ink-meta`, visible only on the
active column and on hover elsewhere. Sort state lives in the URL (brief §8).

**Sticky first column** (leads table on narrow viewports):
`sticky left-0 bg-surface` with `after:absolute after:inset-y-0 after:right-0
after:w-px after:bg-border`. Sticky-column + sticky-header intersections need the
header cell at `z-sticky` and a slightly higher z on the corner cell; keep both
inside the §2 ladder.

**`DataTable` pattern** (`src/components/patterns/data-table.tsx`) is a thin,
**non-generic** wrapper: it renders the shell, the sticky header, the five states,
and the pagination footer, and takes an explicit column spec. We are **not**
adopting TanStack Table — our tables are server-paginated, server-sorted, and
server-filtered (brief §8), so a client table engine would be dead weight. Call
this out if someone proposes it.

```ts
// src/components/patterns/data-table.tsx
export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  width?: string;                    // tailwind class, e.g. "w-40"
  align?: "left" | "right";
  sortable?: boolean;                // maps to ?sort=<id>&dir=asc|desc
  hideBelow?: "md" | "lg" | "xl";    // responsive column dropping
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  density?: "compact" | "default" | "comfortable";
  state: "loading" | "empty" | "ready" | "error";
  emptyState: React.ReactNode;       // required — brief §8, no blank screens
  errorState?: React.ReactNode;
  selection?: {
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
    totalMatching: number;           // for the "select all N matching" bar
  };
  pagination: { page: number; pageSize: number; total: number };
  rowHref?: (row: T) => string;
}
```

**Loading:** render exactly `pageSize` skeleton rows at the real row height with
per-column skeleton widths (`w-32`, `w-20`, …) — a table that keeps its geometry
while loading feels twice as fast as one that pops in. Never a centred spinner
over an empty table.

**Bulk action bar:** when `selected.size > 0`, a bar replaces the table header
row (does not float over the page): `h-10 px-4 bg-accent-subtle border-b
border-accent-border flex items-center gap-3`, showing "N selected", the
cross-page "Select all 1,284 matching" link, then `sm` buttons. Destructive bulk
actions are `destructive-ghost` and always open a confirm dialog that **states
the count** ("Delete 1,284 leads?").

### 9.12 Tabs — `src/components/ui/tabs.tsx`

One visual style: **underline**. No pill tabs, no boxed tabs, no segmented
control look. Underline reads editorial and does not compete with the pill button.

`TabsList`: `flex items-center gap-6 border-b border-border h-10` (the border
spans the full width of the content area, not just the tabs).
`TabsTrigger`: `relative h-10 text-label text-ink-secondary
hover:text-ink transition-colors duration-fast`, active →
`text-ink` plus `after:absolute after:inset-x-0 after:-bottom-px after:h-[2px]
after:bg-accent`. Focus-visible: global ring with `outline-offset-[-2px]` so it
sits inside the 40px strip. Disabled: `opacity-45 pointer-events-none`.
An optional count renders as a `Badge` after the label at `ml-1.5`.

No sliding indicator animation — a 160ms slide between tabs is exactly the kind
of motion that ages badly. The underline snaps.

**Route tabs vs state tabs:** if switching tabs changes what data is loaded
(Campaign → Overview / Leads / Sequence / Analytics), they are **links** rendered
as tabs (`asChild` + `Link`, `aria-current="page"`), not Radix Tabs, because URL
is state (brief §8) and each panel is its own RSC segment. Radix Tabs is only for
genuinely client-side, same-payload switching. Getting this wrong is the most
common Next.js design-system mistake — it forces client-side data fetching that
the brief rejects.

### 9.13 Modal / Dialog — `src/components/ui/dialog.tsx`

Radix Dialog. **Overlay:** `fixed inset-0 z-overlay bg-overlay
backdrop-blur-[1px]` — 1px, barely perceptible, just enough to separate;
`data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out`.

**Content:** `fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-modal
w-full bg-surface border border-border rounded-lg shadow-lg
max-h-[calc(100dvh-4rem)] flex flex-col`, entering with `animate-scale-in`
(0.98→1 + 4px rise, 200ms) and leaving with `animate-fade-out` (120ms — exits are
always faster than entrances).

Widths: `sm` 400px · `md` 520px (default) · `lg` 680px. Anything wider is a
Drawer or a page. **A modal never contains a table, a multi-step wizard, or a
scrollable form longer than ~6 fields** — those are pages or drawers.

Layout: `DialogHeader` `p-6 pb-0` with `DialogTitle` `text-heading` and
`DialogDescription` `text-body-sm text-ink-secondary mt-1.5`;
body `p-6 overflow-y-auto`; `DialogFooter` `px-6 py-4 border-t border-border
flex justify-end gap-2` — **cancel left, confirm right** (macOS order; we are
desktop-first and this is the platform users are on). Close button: `ghost
icon-sm` `X` at `absolute right-4 top-4`, `aria-label="Close"`.

**Confirm dialog** (`patterns/confirm-dialog.tsx`) is a preset, used for every
destructive action. It requires a `consequence` string that names the object and
count, and for irreversible bulk operations (delete a campaign with sent history,
disconnect a mailbox) a **typed confirmation** input matching the resource name.
Do not use typed confirmation for reversible actions — it trains users to type
past warnings.

**A11y:** Radix handles focus trap, `aria-modal`, `Escape`, scroll lock, and
focus restoration. What Radix does *not* do for us: set initial focus somewhere
sensible. Set it on the first input, or on Cancel for a destructive confirm
(**never** on the destructive button — a stray Enter must not delete anything).
Nested dialogs are banned; a dialog that needs a picker uses a Popover at
`z-popover`.

### 9.14 Drawer / Sheet — `src/components/ui/sheet.tsx`

Radix Dialog with side positioning. Right-side by default:
`fixed inset-y-0 right-0 z-modal w-full sm:max-w-[520px] bg-surface border-l
border-border shadow-lg flex flex-col`, entering `animate-slide-right`
(200ms `ease-out`), leaving the reverse at 160ms. Same overlay as Dialog.

Sizes: `sm` 400px · `md` 520px · `lg` 720px · `xl` 880px (lead detail with
activity timeline).

**Drawer vs Modal vs Page:**
- **Modal** — one decision, ≤6 fields, blocking. "Rename campaign", "Confirm delete".
- **Drawer** — inspecting or editing a record *in the context of a list* without
  losing scroll position: lead detail, mailbox settings, sequence-step editor,
  reply detail from the inbox list.
- **Page** — anything with its own URL worth sharing, anything multi-step, anything
  containing a table.

A drawer that holds a record **must** be URL-addressable
(`?lead=<id>`) so it survives refresh and is linkable — brief §8. Bottom sheet
variant (`side="bottom"`, `rounded-t-lg max-h-[85dvh]`) exists only for the
tablet/mobile degradation of the inbox.

Internal layout mirrors Panel: sticky header, scrolling body, sticky footer for
actions. Header carries the record identity (`text-heading` name + StatusBadge)
and the close button; the body's first block is a definition list:

```
DL rows: dt text-caption text-ink-meta w-28 shrink-0 · dd text-body-sm text-ink
```

### 9.15 Dropdown / Menu — `src/components/ui/dropdown-menu.tsx`

`Content`: `min-w-44 max-w-72 bg-surface border border-border rounded-md
shadow-md p-1 z-dropdown` (or `z-popover` when opened from within a dialog),
`animate-scale-in` with `origin-[--radix-dropdown-menu-content-transform-origin]`,
`sideOffset={6}`, `collisionPadding={8}`.

`Item`: `flex items-center gap-2.5 h-8 px-2 rounded-xs text-body-sm text-ink
cursor-default outline-none`, `data-[highlighted]:bg-bg-hover`. Leading Lucide
icon `size-4 text-ink-meta` (inherits `text-danger` in the destructive item).
Trailing `KeyboardHint` (§9.27) pushed right with `ml-auto`.
`Label`: `text-micro uppercase text-ink-meta px-2 pt-2 pb-1`.
`Separator`: `-mx-1 my-1 h-px bg-border`.
`CheckboxItem`/`RadioItem`: 20px leading indicator slot, `Check` / filled dot,
labels stay aligned with plain items.
Destructive item: `text-danger data-[highlighted]:bg-danger-subtle`, always last,
always after a separator.
Sub-menus: `ChevronRight size-3.5 ml-auto text-ink-meta`; **max one level deep**.

Menus are for *actions*, never for navigation-only lists (that is a nav) and
never for form input (that is a Select). Radix gives us typeahead, arrow keys,
`Escape`, and focus return — do not re-implement any of it.

### 9.16 Tooltip — `src/components/ui/tooltip.tsx`

`bg-ink text-ink-inverse text-caption px-2 py-1 rounded-xs shadow-md
max-w-64 z-tooltip`, `animate-fade-in` at `duration-fast`.
`delayDuration={250}`, `skipDelayDuration={200}`. No arrow — an arrow at this
size is fussy; `sideOffset={6}` reads cleanly.
Dark fill is deliberate: it is the only inverted surface in the app, which is
what makes a tooltip read as transient rather than as content.

**Rules that actually matter:** a tooltip may never contain the only copy of
essential information, an interactive element, or more than ~120 characters
(longer → Popover). It is not available on touch, so **every tooltip's content
must be non-essential or duplicated elsewhere.** Icon-only buttons carry both an
`aria-label` and a tooltip with the same words. Disabled buttons cannot host a
tooltip (no pointer events) — use `aria-disabled` + focusable, or wrap in a span
that owns the trigger. A single `TooltipProvider` sits in the app shell.

### 9.17 Toast — `src/components/ui/toast.tsx` (sonner wrapper)

Bottom-right, `z-toast`, `gap-2`, max 3 visible then stacked, 16px from the
viewport edges, `offset={16}`. Each toast:
`bg-surface border border-border rounded-md shadow-md p-4 pr-10 w-[380px]
flex gap-3 animate-slide-up`. Leading icon `size-4` in the tone colour; title
`text-body-sm font-medium text-ink`; description `text-caption text-ink-meta
mt-0.5`; optional action as a `link`-variant button; close `ghost icon-sm`.
Left edge tone marker: `before:absolute before:inset-y-0 before:left-0
before:w-[3px] before:bg-<tone> before:rounded-l-md` — a hairline stripe rather
than a tinted background, so the toast still reads as paper.

Durations: success 4s, info 5s, error **never auto-dismisses** (it holds an
action or a reason the user must read), loading indefinite until resolved.

**What a toast is for:** confirming a completed background-ish action ("Campaign
launched", "342 leads imported"). **What it is not for:** form validation errors
(inline), permission errors (inline or a page state), or anything the user must
act on within the current task. `sonner` renders an `aria-live` region for us;
still write titles that make sense read aloud out of context ("Campaign
launched", not "Done!").

Server Actions return a typed `Result` (brief §9); a small
`useActionToast(result)` hook in `patterns/` maps it to a toast so no two call
sites word the same outcome differently.

### 9.18 Avatar — `src/components/ui/avatar.tsx`

Sizes: `xs` 20 · `sm` 24 · `md` 32 (default) · `lg` 40 · `xl` 56.
`rounded-pill` (circular is the universal convention for people; overriding it
costs recognition for nothing). Fallback: initials, `text-caption font-medium`,
`bg-bg-subtle text-ink-secondary border border-border`.

**Initials only — no generated colour per user.** Deterministic hash-to-hue
avatars would inject arbitrary saturated colour into a strictly limited palette,
and that single decision is enough to make the product look generic. If visual
differentiation is needed later, vary the neutral fill across three
tokens (`bg-subtle`, `accent-subtle`, `bg-active`) by hash.

Cold-outreach reality: we almost never have a lead's photo. So the avatar is
**mostly initials by default**, and the design must look right in that state —
which it does, because initials in warm grey on off-white is the editorial look.
Do not fetch third-party enrichment images to fill it.

`AvatarGroup`: overlapping at `-ml-2` with `ring-2 ring-bg` on each,
max 4 shown then `+N` in a fallback avatar. `aria-label` names the full set.
`alt=""` on decorative avatars beside a name (the name is the label); real `alt`
only when the avatar stands alone.

### 9.19 Skeleton — `src/components/ui/skeleton.tsx`

`<div className={cn("skeleton", className)} aria-hidden="true" />` using the
`skeleton` utility from §5. The container that holds skeletons carries
`role="status" aria-busy="true"` and an `sr-only` "Loading <thing>" so screen
readers are told once, not per shape.

**Skeletons mirror real geometry.** Same heights, same column widths, same row
counts as the loaded state. Vary text-line widths (`w-full w-4/5 w-2/3`) so it
does not read as a barcode. Never skeleton a whole page as one grey block; never
mix a skeleton with a spinner on the same screen.

Presets in `patterns/skeletons.tsx`: `TableSkeleton({rows, columns})`,
`CardGridSkeleton({count})`, `ThreadListSkeleton`, `StatRowSkeleton`,
`DetailPanelSkeleton`. These are what `loading.tsx` files render — one per route
segment, so Suspense boundaries land where the brief's five-states rule expects.

### 9.20 Progress — `src/components/ui/progress.tsx`

**Determinate bar:** track `h-1.5 bg-bg-active rounded-pill overflow-hidden`
(pill on a 6px bar is a rounded line, not a pill button — allowed), fill
`bg-accent rounded-pill transition-[width] duration-slow ease-out`. Height `sm`
4px / `md` 6px. Tone variants: `accent` (default), `success`, `warning`, `danger`
for cap/quota bars. `role="progressbar"` with `aria-valuenow/min/max` and
`aria-valuetext` when a raw number is unhelpful ("142 of 200 daily sends").

**Segmented bar** (`variant="segments"`) for sequence progress — 5 steps as 5
gapped segments, filled/current/pending in `accent`/`accent-subtle`/`bg-active`.
This is a better fit than a percentage for discrete sequence steps.

**Quota / send-cap bar** is where this earns its keep. Gmail's real limits bite
here (see §12.4): the bar shows `sent / dailyCap` per mailbox, turns `warning`
at 80% and `danger` at 100%, and the caption states the reset time **in the
mailbox's timezone with the zone named** ("Resets 00:00 America/New_York") —
never "resets in 4h", which is ambiguous across DST transitions.

**No circular/ring progress anywhere.** No indeterminate bars — an indeterminate
bar is a spinner that takes more space; use a skeleton.

### 9.21 EmptyState — `src/components/patterns/empty-state.tsx`

```
        ┌──────────────┐
        │   ╭──────╮   │   optional 40px Lucide glyph, ink-muted, stroke 1.5
        │   │  ✉   │   │   inside a 72px rounded-md bg-bg-subtle square
        └──────────────┘
      No campaigns yet              text-display-md font-display ink
   Create a campaign to start        text-body-sm ink-secondary, max-w-sm
   sending sequences from your
   connected mailboxes.
        [ Create campaign ]          primary lg  +  optional link "Learn more"
```

Centred, `py-16` in a Card or Panel, `max-w-md mx-auto text-center`.
This is one of the four legal serif placements — the empty state is the most-seen
screen in a new workspace and deserves the editorial voice.

Five distinct kinds, and **using the wrong one is a bug** (brief §8):

| Kind | When | Body says | Action |
|---|---|---|---|
| `first-run` | No records ever created | what this feature does, in one sentence | primary create action |
| `no-results` | Filters/search returned nothing | "No leads match these filters." | `secondary` "Clear filters" — **never** a create action |
| `blocked` | A prerequisite is missing | "Connect a mailbox before creating a campaign." | primary link to the prerequisite |
| `not-built` | Feature is genuinely unbuilt | plainly: "Deliverability monitoring is not available yet." | none, and no fake controls anywhere near it |
| `error` | Load failed | what failed + `Retry` | `secondary` Retry, plus the error id in `text-mono text-caption` for support |

The `not-built` variant exists because brief §8 forbids fake functionality.
It is honest, and it is the correct thing to ship for an unfinished slice.

Icon rules: one Lucide glyph, `--ink-muted`, `stroke-width 1.5`, never an
illustration, never an emoji, never a coloured icon.

### 9.22 Pagination — `src/components/patterns/pagination.tsx`

Table footer: `flex items-center justify-between px-4 h-12 border-t
border-border`. Left: `text-caption text-ink-meta tabular-nums` "Showing
1–25 of 1,284". Right: page-size `Select` (`sm`, 25/50/100) then the pager.

Pager buttons are `ghost` `icon-sm` `ChevronLeft`/`ChevronRight` plus numbered
`ghost sm` buttons; current page is `bg-accent-subtle text-accent font-medium`
with `aria-current="page"`. Window: first, last, current ±1, `…` for gaps
(`text-ink-muted px-1`, `aria-hidden`). Disabled ends keep their space so the
control does not shift.

Rendered as `<nav aria-label="Pagination">` with real `<Link>`s carrying
`?page=` so it works without JS and is crawlable/back-buttonable (brief §8).

**Keyset vs offset:** offset (`LIMIT/OFFSET`) is fine for leads/campaigns lists.
For the inbox and `EmailEvent`, offset pagination degrades badly past a few
thousand rows and shifts under concurrent inserts (a new reply arrives, page 2
now repeats a row). Those two use **keyset pagination** on
`(createdAt, id)` with `?before=<cursor>` — which means their footer shows
`Newer`/`Older` buttons and a count, not numbered pages. **[LEAD]** Confirm the
inbox is cursor-paginated; the jobs/analytics docs should agree.

### 9.23 Breadcrumb — `src/components/ui/breadcrumb.tsx`

`<nav aria-label="Breadcrumb"><ol>` with `flex items-center gap-1.5
text-caption text-ink-meta`. Links `hover:text-ink transition-colors`; current
page is a plain `<span aria-current="page" className="text-ink-secondary">`.
Separator: `<ChevronRight className="size-3 text-ink-muted" aria-hidden />`
inside an `<li role="presentation">`.

Used **only** at depth ≥ 3 (`Campaigns / Q3 Outbound / Step 2`). At depth 2 the
sidebar already tells you where you are and a breadcrumb is redundant chrome.
Sits above the PageHeader title with an 8px gap. Long middle segments truncate at
`max-w-40 truncate`; the first and last never truncate. Collapse to
`Campaigns / … / Step 2` with a dropdown below `md`.

### 9.24 SearchInput — `src/components/patterns/search-input.tsx`

Input with `<Search className="size-4 text-ink-meta" />` at `left-3`
(`pl-9`), and a `ghost icon-sm` `X` clear button at `right-1.5` shown only when
non-empty. `type="search"` with `[&::-webkit-search-cancel-button]:hidden` so we
own the clear affordance. Width: `w-64` in a toolbar, `w-full` in a drawer.
A trailing `KeyboardHint` showing `/` when the field is empty and unfocused.

Behaviour, non-negotiable because it is where search UIs usually go wrong:
- `"use client"`, debounce **300ms**, then `router.replace()` with the updated
  `?q=` — `replace`, not `push`, or every keystroke lands in browser history.
- `useTransition` for the pending state; while pending, show a `Loader2` in place
  of the search glyph, and keep the previous results visible with
  `aria-busy="true"` on the results container. Do **not** flip to a skeleton on
  every keystroke — that flicker is worse than stale results.
- The input is uncontrolled with `defaultValue={searchParams.q}` so RSC
  re-renders never fight the user's typing.
- Results count in an `aria-live="polite"` region: "24 results".
- Empty query removes the param entirely rather than setting `?q=`.
- Minimum 2 characters before hitting the server.
- `/` focuses it globally (skipped when focus is already in a text field);
  `Escape` clears and blurs.

### 9.25 FilterChip — `src/components/patterns/filter-chip.tsx`

The second legitimate pill. `inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5
rounded-pill text-caption font-medium border transition-colors duration-fast`.

- **inactive** (a filter you can add): `bg-surface text-ink-secondary
  border-border-strong hover:border-ink-muted`, trailing `ChevronDown size-3`.
- **active** (a filter applied): `bg-accent-subtle text-accent
  border-accent-border`, label reads `Status: Active` — **key and value**, never
  the value alone — with a trailing `X size-3` remove button
  (`aria-label="Remove Status filter"`, its own focusable button, `rounded-pill`
  hover `bg-accent-border/60`).
- **count** (multi-value): `Tags: 3` with the full list in a tooltip.

The filter row is `flex flex-wrap items-center gap-2` above the table, ending in
a `link`-variant "Clear all" when ≥2 filters are active. Every chip reads and
writes a search param (brief §8): adding a chip is a `router.push` (this one *is*
history-worthy), removing is a `push` too, so back-button undoes a filter.
The filter row is wrapped in `<div role="group" aria-label="Filters">`.

### 9.26 Separator — `src/components/ui/separator.tsx`

Radix Separator. `bg-border` at exactly `1px` (`h-px w-full` /
`w-px h-full`), `decorative` by default (so it is `aria-hidden`; pass
`decorative={false}` only when it separates two genuinely distinct regions).

**Space before rules.** A separator gets `my-6`/`my-8` around it, never `my-2` —
a hairline crammed between two blocks reads as a border artefact. And most
sections need **no** separator at all: 40–56px of vertical space separates better
than a line. Rule of thumb: use space between related sections, a hairline
between unrelated ones, and never two hairlines within 80px of each other.
Never a vertical separator between buttons in a toolbar; use `gap-2`.

### 9.27 KeyboardHint — `src/components/ui/keyboard-hint.tsx`

`<kbd>` styled: `inline-flex items-center justify-center h-5 min-w-5 px-1.5
rounded-xs border border-border bg-bg-subtle text-ink-meta font-mono
text-[0.6875rem] leading-none`. Multi-key renders separate `<kbd>`s with a
`gap-0.5` and no "+" glyph (`⌘ K`, not `⌘+K`).

Platform: render `⌘` on Apple, `Ctrl` elsewhere, detected client-side from
`navigator.platform`; SSR renders `Ctrl` and corrects on hydration — the flash is
one frame on a decorative element and is not worth a client-only wrapper.
Keys use `⏎ ⇧ ⌥ ␣ ↑ ↓ ← →` glyphs and spelled words for `Esc`, `Tab`.

`aria-hidden="true"` — the shortcut must also be stated in the accessible name of
whatever it triggers ("Search leads, keyboard shortcut slash"). Appears in
dropdown items (`ml-auto`), the search input, and a `?` shortcuts dialog.
**Only shown for shortcuts that actually exist.** A decorative `⌘K` next to a
search box that does not respond to `⌘K` is fake functionality.

---

## 10. Layout primitives

### 10.1 App shell

```
┌──────────┬──────────────────────────────────────────────────────┐
│          │  Header  60px · sticky · bg-bg/85 backdrop-blur       │
│ Sidebar  ├──────────────────────────────────────────────────────┤
│  248px   │                                                      │
│  fixed   │   PageHeader   (title + description + actions)       │
│  bg-bg   │   ─────────────────────────────────────────────      │
│  border  │   Page content · max-w-[1280px] · gutter-x           │
│  -r      │                                                      │
│          │                                                      │
└──────────┴──────────────────────────────────────────────────────┘
```

```tsx
// src/app/(app)/layout.tsx — structure only; owned by the foundation slice
<div className="min-h-dvh bg-bg">
  <Sidebar />                                    {/* fixed, hidden below lg */}
  <div className="lg:pl-[--sidebar-w] flex min-h-dvh flex-col">
    <AppHeader />                                {/* sticky top-0 z-sticky */}
    <main id="main" className="flex-1 pb-16">{children}</main>
  </div>
</div>
```

A "Skip to main content" link is the first focusable element in the shell:
`sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-toast`
styled as a `secondary sm` button.

### 10.2 Sidebar — `src/components/patterns/sidebar.tsx`

- Width `248px` (`--sidebar-w`), collapsed `64px` (`--sidebar-w-collapsed`).
- `bg-bg` — **the sidebar is the same warm ground as the page**, separated only by
  `border-r border-border`. A darker or white sidebar creates the two-tone
  dashboard look we are avoiding. This is deliberate and should not be "fixed".
- Brand row: `h-[60px] px-5 flex items-center` matching header height so the
  horizontal rules align across the shell. Wordmark in `font-display text-heading`
  — the one place the serif appears in chrome, because it is a logotype, not UI text.
- Workspace switcher directly below: full-width `ghost` trigger, 40px,
  avatar + name + `ChevronsUpDown size-3.5`, opening a dropdown.
- Nav items: `h-9 px-2.5 rounded-sm flex items-center gap-2.5 text-body-sm
  text-ink-secondary`, icon `size-4 text-ink-meta`, hover
  `bg-bg-hover text-ink`, active `bg-accent-subtle text-accent font-medium` with
  the icon at `text-accent`. `aria-current="page"`. No left-edge active bar and
  no active icon swap — the tinted fill is enough.
- Groups separated by `mt-6` with an optional `text-micro uppercase text-ink-meta
  px-2.5 mb-1.5` label. Section order follows brief §3.
- Counts (unread inbox, dead-lettered jobs) as a right-aligned `Badge`; a
  danger-tone count is the only place colour enters the nav.
- Footer pinned bottom: user row (avatar + name + `MoreVertical`), then
  Settings. `mt-auto` inside a `flex flex-col h-dvh`.
- Below `lg` the sidebar becomes a left `Sheet` opened by a `Menu` icon-button in
  the header; the nav markup is shared, not duplicated.
- Collapsed mode is **deferred** — it costs tooltips on every item, a persisted
  preference, and an icon-only visual pass, and 248px of a 1440px screen is not a
  problem worth solving in v1. Token exists so it can land later.

### 10.3 Header — `src/components/patterns/app-header.tsx`

`h-[60px]` (`--header-h`), `sticky top-0 z-sticky`,
`bg-bg/85 backdrop-blur-md border-b border-border`, `gutter-x`,
`flex items-center gap-4`. Contents: mobile menu button (below `lg`), optional
Breadcrumb, `flex-1` spacer, global SearchInput (`w-64`, hidden below `md`),
notification bell with a dot, help `?`.

The translucent-plus-blur header is the one glassmorphism-adjacent effect we
allow, because content scrolling under a hard-edged opaque bar looks cheap and a
fully opaque bar hides the scroll cue. `bg-bg/85` keeps it warm — never white,
never a gradient. Provide `supports-[not(backdrop-filter:blur(0))]:bg-bg` as the
opaque fallback.

The page title does **not** live in the header. It lives in PageHeader, so it can
be display type at 30px.

### 10.4 PageHeader — `src/components/patterns/page-header.tsx`

```tsx
interface PageHeaderProps {
  title: string;                    // renders the page's single <h1>
  description?: string;             // one sentence, max ~90 chars
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;        // right-aligned; max ONE primary
  tabs?: React.ReactNode;           // route tabs, flush to the bottom border
  meta?: React.ReactNode;           // StatusBadge + timestamps under the title
}
```

`pt-10 pb-6` (`pt-8 pb-5` below `md`), `gutter-x`, `max-w-[--page-max]`.
Title `text-display-md font-display text-ink`; description `text-body
text-ink-secondary mt-2 max-w-[60ch]`; actions in a `flex items-center gap-2
shrink-0` on a `flex items-start justify-between gap-6` row that wraps to a new
line below `sm`.

When `tabs` is present the PageHeader owns the bottom `border-b border-border`
and `pb-0` — the tab strip's border *is* the page header's rule. Without tabs
there is **no bottom border**: whitespace separates the header from content.
That contrast is much of what makes the layout feel editorial.

### 10.5 Section — `src/components/patterns/section.tsx`

```tsx
interface SectionProps {
  title?: string;                   // text-heading, renders <h2>
  description?: string;             // text-body-sm ink-secondary
  actions?: React.ReactNode;        // secondary/ghost only — never a pill here
  children: React.ReactNode;
}
```

`<section>` with `space-y-4` internally and `mt-10` between sections (`mt-8`
below `md`). Header row is `flex items-baseline justify-between gap-4`.
Sections are separated by **space first**; a `Separator` only where the content
types are genuinely unrelated (§9.26).

### 10.6 Gutters, breakpoints, widths

Tailwind v4 defaults, no custom breakpoints:

| BP | Min width | Gutter | Notes |
|---|---|---|---|
| base | 0 | 20px | tablet-portrait floor; the app is not phone-designed |
| `sm` | 640 | 20px | |
| `md` | 768 | 32px | inbox becomes list→detail push |
| `lg` | 1024 | 40px | sidebar becomes permanent |
| `xl` | 1280 | 56px | |
| `2xl` | 1536 | 56px | gutter stops growing; the max-width takes over |

Content widths: `--page-max` 1280px for app pages (centred with `mx-auto` once
the viewport exceeds `1280 + sidebar + gutters`); `--prose-max` 68ch for
long-form text and AI summaries; `--form-max` 560px for single-column forms —
a 1200px-wide two-column form is unreadable, and settings pages must stay in one
column at 560px even on a 27" display. Full-bleed (no max-width) is allowed for
exactly two surfaces: the wide leads/analytics tables and the three-pane inbox.

Inbox grid, the only complex layout:

```
lg+ : grid-cols-[320px_minmax(0,1fr)]  or  [320px_minmax(0,1fr)_360px]
md  : grid-cols-[280px_minmax(0,1fr)]
base: single column; list, then detail pushes over it (URL-driven, back works)
```

`minmax(0,1fr)` not `1fr` — without the `0` minimum, a long unbroken email
subject blows the grid wider than the viewport. This is the single most common
layout bug in mail UIs.

Vertical rhythm: 4px scale, and in practice use **only** 4/8/12/16/20/24/32/40/
56/64/80. Arbitrary values like `p-[14px]` are a review blocker; `gap-7` is
allowed but suspicious.

---

## 11. Data visualisation

### 11.1 A chart must earn its place

The brief's phrase is "never a template with random charts", so the bar is:
**a chart ships only when it answers a question a user actually asks, and only
when it beats a number or a table at answering it.**

Decision order, applied before writing any chart code:

1. **One value** → a StatCard with its denominator. Not a gauge, not a donut.
2. **A handful of labelled values** (steps in a sequence, statuses) → a table
   with a numeric column, or a single stacked bar. A pie chart of 5 statuses is
   less readable than 5 rows of numbers.
3. **A value over time, where the shape matters** → a line or area chart. This
   is the main legitimate case: sends/replies per day over 30 days.
4. **Comparison across a small set** (mailbox performance, A/B variants) → a
   horizontal bar chart, sorted by value, labels on the left.
5. **A funnel** (sent → delivered → opened → replied) → a horizontal stepped bar
   list with counts and step-to-step conversion as text. Not a 3D funnel, not a
   trapezoid graphic.

Banned outright: pie and donut charts, radar, 3D anything, gauges/speedometers,
treemaps, bubble charts, dual y-axes (they can be made to show any correlation you
like), and word clouds.

**Sample-size honesty is part of the chart, not a footnote** (brief §10). A
series with fewer than the module's minimum observations renders as a dotted
`--chart-muted` line with the point count stated in the caption, and any
comparative annotation ("step 2 underperforms") is suppressed entirely rather
than shown small.

### 11.2 Palette

Series order is fixed: `--chart-1` … `--chart-6`. **A sixth series means the
chart is wrong** — aggregate into "Other" at five.

Semantic overrides take precedence over series order: a "bounced" series is
always `--danger`, "replied" always `--success`, "sent" always `--chart-1`. A
reader must never learn a new colour meaning per chart. This mapping lives in
`src/components/patterns/chart-tokens.ts` and every chart imports it.

Never distinguish series by colour alone: lines get distinct shapes at data
points (only when ≤ 40 points) or direct end-of-line labels; stacked bars get a
legend *and* a tooltip with names; the `--chart-1`/`--chart-4` pair (navy/slate)
is the one that fails for deuteranopia, so if only two series exist use
`--chart-1` + `--chart-3` (navy/ochre).

### 11.3 Treatment

- **Gridlines:** horizontal only, `--chart-grid`, `1px`, no dashes. No vertical
  gridlines, no border box around the plot, no background fill.
- **Axes:** no axis lines at all. The y-axis is 3–5 tick labels in
  `text-caption text-chart-axis`; the x-axis shows first, last, and ~3 interior
  labels, rotated 0° always (rotate the chart, never the labels).
- **Line:** `2px`, `stroke-linecap: round`, no point markers unless ≤ 20 points
  (then `r=3` filled). Curve is **monotone**, not natural cardinal — cardinal
  overshoots and invents values that were never in the data.
- **Area:** a flat 8% alpha of the series colour. **Not a gradient.** The only
  legal gradient in the product is the skeleton sheen (§5).
- **Bars:** `--radius-xs` on the outer end only, 60–70% category width, gap
  `4px` within a group.
- **Sparkline:** 1.5px line, no axes, no labels, ~48×20, in StatCards only.
- **Tooltip:** the §9.16 dark tooltip, showing the x label, then each series as
  `swatch · name · value` with `tabular-nums`, sorted by value descending. Follows
  the cursor along x with a `--border-strong` 1px vertical guide.
- **Legend:** above the plot, left-aligned, `text-caption text-ink-meta`, 8px
  square swatches with `--radius-xs`. Omit the legend for single-series charts.
- **Empty / low data:** the plot area renders the axis skeleton plus a centred
  `text-body-sm text-ink-meta` line ("No sends in this period"). Never a chart
  drawn from zeros — a flat line at zero looks like a broken chart.
- **Height:** 240px default, 180px compact, 320px for the primary analytics
  chart. Never taller than 320px; a tall chart exaggerates variance.

### 11.4 Implementation

Charts are **Recharts** in a client component, one wrapper per chart type in
`src/components/patterns/charts/` (`line-chart.tsx`, `bar-chart.tsx`,
`funnel-list.tsx`, `sparkline.tsx`). No generic `<Chart config={…}>`
abstraction — four concrete components are less code and far more legible than a
config-driven one, and the shadcn `chart` component's `config` layer is
exactly the over-engineering we should skip.

**[LEAD]** Recharts is not in the brief's dependency list. It is needed only in
phase 8. Two options: (a) approve Recharts then, or (b) hand-author the two
charts we actually need as inline SVG — for a monotone line and a horizontal bar
that is ~150 lines total, has no dependency, and gives exact control over the
axis treatment above. **Recommendation: (b).** Our chart needs are genuinely
small, and Recharts' defaults fight every rule in §11.3.

Colours are read from CSS variables at render (`var(--chart-1)` in `stroke`),
never hardcoded, so a theme swap is free. Accessibility: every chart is preceded
by an `sr-only` `<table>` (or followed by a "View as table" toggle) carrying the
same data — a chart alone is not accessible, and a table view is also what power
users want.

---

## 12. Motion & focus

### 12.1 Motion

| Interaction | Duration | Easing | Properties |
|---|---|---|---|
| Hover / colour change | 120ms (`--duration-fast`) | `ease-out` | `background-color`, `border-color`, `color` |
| Tooltip in | 120ms | `ease-out` | `opacity` |
| Dropdown / Select / Popover in | 160ms (`--duration`) | `ease-out` | `opacity`, `transform` (scale 0.98→1) |
| Tab underline | 0ms | — | snaps |
| Toast in | 160ms | `ease-out` | `opacity`, `translateY(6px→0)` |
| Dialog in | 200ms (`--duration-slow`) | `ease-out` | `opacity`, `scale 0.98→1`, `translateY(4px→0)` |
| Drawer in | 200ms | `ease-out` | `translateX(100%→0)` |
| Any exit | 120ms | `ease-in` | `opacity` (+ transform for drawer) |
| Accordion / disclosure | 160ms | `ease-out` | `height` via Radix's `--radix-*-content-height` |
| Progress fill | 200ms | `ease-out` | `width` |

Hard rules:

1. **200ms is the ceiling.** Anything slower is felt as lag in a tool people use
   all day.
2. **Only `opacity` and `transform`** are animated, with two named exceptions:
   `height` on Radix disclosures (unavoidable, and it is a compositor-cheap
   single element) and `width` on progress bars.
3. **No spring, no bounce, no overshoot.** `--ease-out` is
   `cubic-bezier(0.22,1,0.36,1)` — decelerating, no back-swing.
4. **Exits are faster than entrances.** Waiting for a UI to leave is worse than
   waiting for it to arrive.
5. **Nothing loops** except the loading spinner and the skeleton sheen.
6. **Nothing animates on page load.** No staggered card entrances, no
   scroll-triggered reveals, no `IntersectionObserver` fade-ins. In marketing,
   at most one `animate-fade-in` on the hero.
7. **Layout is never animated.** No FLIP row reordering, no height-animated
   tables, no animated list insertion.
8. `prefers-reduced-motion` is handled globally in §4 (transitions clamped to
   1ms). Components need no per-component media query — but **never** put
   meaning in motion, because for those users the motion is gone.

### 12.2 Focus ring

One specification, defined once globally (§4), and every component inherits it:

```css
outline: 2px solid var(--ring);   /* --accent, ~11:1 on --bg */
outline-offset: 2px;
border-radius: inherit;           /* follows the element's own shape */
```

Rules:

1. `outline: none` is banned unless the same rule sets a replacement. Add an
   ESLint/stylelint check for the literal string in `src/**`.
2. `:focus-visible`, not `:focus` — clicking a button should not leave a ring.
   Keyboard, `/`-shortcut, and programmatic-focus cases all still show it
   (`.focus()` on a non-pointer interaction triggers `:focus-visible`).
3. **Offset exceptions:** inside `overflow-hidden` containers (table rows, tab
   strips, list items) use `outline-offset: -2px` so the ring is not clipped.
4. **Colour exceptions:** on `--danger` fills use `--ring-danger`; on the dark
   tooltip surface use `--ink-inverse`.
5. **Focus is always visible on scroll.** Any container that can scroll must
   have `scroll-margin` on focusable children (`scroll-mt-16` under sticky
   headers) so `Tab` does not focus something hidden behind the header.
6. **Focus order follows DOM order.** No positive `tabindex` anywhere.
   `tabindex="-1"` only for programmatic focus targets (dialog containers, the
   `<main>` landmark after route change).
7. After a mutation that removes the focused element (deleting a row), focus
   moves to a deterministic place — the next row, else the table's toolbar —
   never to `<body>`. This is the a11y bug most often shipped; treat it as part
   of every delete action's spec.

---

## 13. Where reality bites the UI

These are constraints the design must show honestly, not design around.

### 13.1 Open tracking is not fact

Apple Mail Privacy Protection proxies and pre-fetches images; Gmail proxies
images through `googleusercontent`; corporate gateways strip them; many clients
block them by default. The result is simultaneously inflated (bot pre-fetches)
and deflated (blocked pixels). **UI consequence:** the metric is always labelled
"Opens (indicative)", the `OPENED` StatusBadge carries the §9.8 tooltip, and open
rate is **never** the headline metric on the Dashboard — reply rate is, because
it is the only signal we actually observe. Any UI that ranks campaigns by open
rate is a design bug.

Click tracking is more reliable but rewrites URLs, which can hurt
deliverability. If the tracking toggle is off, the analytics view must show
"Tracking disabled for this campaign" rather than a zero — a zero looks like
failure.

### 13.2 Daily caps and sending windows are timezone-real

Gmail's per-account send limits (roughly 500/day for consumer, 2,000/day for
Workspace, with lower per-minute API ceilings and quota-unit budgets) plus
deliverability practice (a new mailbox should ramp from tens per day, not
hundreds) mean the UI must always show **remaining capacity**, not just a total.

Every cap/window display: state the timezone explicitly and by name. "Sends
resume at 09:00 (America/New_York)" — never "resumes in 3 hours" as the only
information, because DST transitions make relative times wrong twice a year, and
a user in a different timezone reading a shared screenshot needs the anchor. A
relative time may appear *alongside* the absolute one.

Timestamp component rules (`patterns/timestamp.tsx`): render the ISO value in a
`<time dateTime>`, display relative for < 24h ("4 hours ago") and absolute
after, always with the full absolute value in a tooltip and the timezone
abbreviation for anything scheduled. Server-rendered relative times will be
stale — so relative rendering happens in a small client component, and the
server always emits the absolute form to avoid a hydration mismatch.

Sequence step delays are in **days from the previous step**, and the UI must show
the resolved send date per lead, not just "Day 3", because a 3-day delay landing
on a Saturday with weekend-skip enabled is actually Monday. Showing "Day 3" alone
is the kind of half-truth that makes users distrust the scheduler.

### 13.3 Rate-limited and disconnected are first-class UI states

Brief §8 requires it. Concretely: a mailbox whose OAuth refresh token has been
revoked (user changed their Google password, admin revoked app access — this
happens often) must surface a persistent, dismissable-per-session banner on
Dashboard, Campaigns, and Mailboxes with a direct "Reconnect" action, plus the
`TOKEN_EXPIRED` StatusBadge on the mailbox row. A campaign silently not sending
is the worst failure this product can have, so it gets the loudest honest
treatment available within the palette: `--danger-subtle` fill, `--danger-border`
hairline, `AlertTriangle`, no red flood.

Banner component (`patterns/banner.tsx`): `tone` of `info|warning|danger`,
`rounded-md border p-4 flex gap-3` in the matching subtle/border pair, a title in
`text-body-sm font-medium`, body in `text-caption`, and at most one inline
action. Banners live directly under the PageHeader, never floating, never more
than **two** at once — beyond two, collapse into one "3 issues need attention"
banner linking to a list, or users learn to ignore all of them.

### 13.4 Long content breaks layouts

Real data in this product: 78-character email subjects, company names like
"Müller & Söhne Präzisionswerkzeuge GmbH & Co. KG", email addresses longer than
some columns, and pasted email bodies containing 400-character unbroken URLs.
Every text container in a table or card gets `min-w-0` on the flex child and
`truncate` or `break-words` explicitly. Email body renderers get
`overflow-wrap: anywhere` on links. Any grid track holding user content uses
`minmax(0, …)`. This is a spec item, not a bug to fix later.

### 13.5 Server-rendered email HTML

Inbound email HTML cannot be styled with our tokens and must not be allowed to
style our app. It renders sanitised, inside a container that resets inherited
typography (`[&_*]:!font-[inherit]` is *wrong* — it fights the sender's intent).
Correct approach: sanitise, then render in a bordered `--surface` region with a
`.email-body` scope and only these house rules — `max-width: 100%` on images and
tables, `overflow-wrap: anywhere` on links, a `--prose-max` measure for plain
text. Do not attempt to restyle marketing email into our design system; do not
use an iframe unless a sanitiser bypass forces it. **[LEAD]** the inbox doc owns
the sanitiser choice; this doc only fixes the container.

---

## 14. Anti-patterns — the specific things that break this aesthetic

Each of these is a review blocker, not a preference. They are listed because each
one is the *default* of some tool or tutorial, so they arrive by accident.

**Colour**

1. **Pure white surfaces on a pure white page.** `bg-white` on the page ground.
   The ground is `--bg` #FBFAF8; `--surface` #FFFFFF only exists to sit *on* it.
   If a screen has no warm tone left in it, the design is gone.
2. **The purple/indigo/blue AI gradient.** `from-violet-500 to-indigo-600`, or
   any gradient on a hero, button, card, badge, icon container, or heading text.
   There is exactly one gradient in the product: the skeleton sheen.
3. **Neon or Tailwind-default status colours.** `text-green-500`,
   `bg-red-500`, `#10B981`, `#EF4444`. Our status colours are muted and
   desaturated on purpose. A saturated green pill destroys the palette.
4. **Any raw hex or Tailwind palette colour** (`slate-`, `zinc-`, `gray-`,
   `blue-`) in `src/components/**` or `src/app/**`. Semantic tokens only.
5. **Coloured or glowing shadows.** `shadow-blue-500/50`, `ring-4 ring-accent/20`
   as decoration. Shadows are `rgb(15 30 55 / 0.04–0.10)`, nothing else.
6. **Tinted card backgrounds to signal category.** A pastel palette of card
   fills is a dashboard template tell.

**Type**

7. **Serif in dense UI.** Instrument Serif on a button, label, table header,
   badge, tab, menu item, input, tooltip, or anything under 18px.
8. **`font-bold` / weight 700+ anywhere in the app.** Emphasis is 500/600.
9. **Synthetic bold on the serif.** Instrument Serif ships weight 400 only.
10. **A fourth font family.** Three is the ceiling. This includes "just for the
    logo" and any icon font.
11. **Uppercase buttons or uppercase table headers.** Uppercase is `text-micro`
    eyebrows only.
12. **All-caps or spaced-out tracking on body copy.** Tracking is only negative
    on display sizes and positive on `text-micro`.

**Shape & depth**

13. **Over-rounding.** `rounded-full` on cards, `rounded-2xl`/`rounded-3xl`
    anywhere, `rounded-xl` on inputs. Pill is primary buttons and filter chips.
    Tables, inputs, and panels stay architectural.
14. **Heavy shadows.** `shadow-lg`/`shadow-xl`/`shadow-2xl` from Tailwind's
    defaults, or any shadow on a table row, input, badge, nav item, or table.
    Cards get `shadow-xs`; only overlays go past that.
15. **Nested elevation.** Cards inside cards inside panels, each with a shadow.
16. **Borders and shadows both doing separation** on the same element edge. Pick
    the hairline.
17. **Glassmorphism.** One exception: the sticky header's `bg-bg/85 backdrop-blur-md`.

**Layout & content**

18. **Zebra-striped, cramped tables.** Alternating row fills, rows under 40px,
    or 8 columns of dense numbers. Rows are 44–52px with hairlines.
19. **Whitespace treated as waste.** Reducing padding to fit more in. Generous
    gutters and 40–56px section gaps are the design, not slack.
20. **A wall of StatCards.** Six identical metric tiles across the top of every
    page. The Dashboard gets ≤4, chosen because someone asked for them.
21. **Random charts.** A chart that exists because the page looked empty. See §11.1.
22. **Icons in tinted rounded squares** beside every card title. This single
    pattern is the strongest generic-dashboard signal there is.
23. **Emoji as icons.** 🚀 ✨ 📊 in UI, empty states, toasts, or headings. Lucide
    only. (Emoji inside user-authored email content is the user's business.)
24. **Illustrations / spot art in empty states.** One Lucide glyph, or nothing.
25. **A dark or white sidebar** against the warm ground. The sidebar is `--bg`.

**Behaviour**

26. **Fake functionality.** A control that does nothing, a `⌘K` hint with no
    command palette, a hardcoded metric, a filter that does not filter,
    placeholder chart data. Brief §8. Render an honest `not-built` state instead.
27. **Blank screens.** Any async surface missing loading, empty, error, or
    unauthorized states.
28. **Spinner-only loading.** A centred spinner where a shaped skeleton belongs.
29. **Animated page entrances.** Staggered card fade-ins, scroll reveals,
    `animate-in` on route change.
30. **Hover lift.** `hover:-translate-y-1 hover:shadow-xl` on cards.
31. **A `⌘K` command palette shipped before the features it would search.**
32. **Toasts for validation errors.** Field errors are inline, next to the field.
33. **`outline: none` without a replacement.** Also: removing the ring "because
    it looks bad on that button" — fix the offset, keep the ring.
34. **Colour as the only carrier of meaning.** A status dot with no label, a red
    border with no message, a chart legend distinguished only by hue.

---

## 15. How to review a screen

Paste this into the PR description for any UI change. A reviewer should be able
to run it in under three minutes.

**Look at it (10 seconds, squinting)**

- [ ] Is the ground warm off-white, not white? Is there visible breathing room?
- [ ] Exactly one serif element (the `<h1>`), or a hero metric — nothing else?
- [ ] At most **one** pill-shaped primary button in view?
- [ ] Could this screen belong to any generic SaaS dashboard? If yes, say why in
      the review and fix it before merging.

**Tokens**

- [ ] `git grep -nE '#[0-9a-fA-F]{3,8}' src/components src/app` → only `globals.css`.
- [ ] `git grep -nE '\b(bg|text|border|ring)-(slate|gray|zinc|neutral|stone|blue|indigo|violet|purple|red|green|emerald|amber|yellow)-[0-9]' src` → empty.
- [ ] `git grep -n 'font-bold\|font-extrabold\|font-black' src` → empty.
- [ ] `git grep -n 'rounded-xl\|rounded-2xl\|rounded-3xl\|shadow-xl\|shadow-2xl' src` → empty.
- [ ] `git grep -n 'outline-none\|outline: none' src` → each hit sets a replacement.
- [ ] `git grep -nE 'dark:|bg-background|text-foreground|text-primary-foreground|bg-muted' src/components/ui` → empty (shadcn leftovers).
- [ ] `git grep -nE '\b(p|m|gap|w|h)-\[[0-9]+px\]' src` → each arbitrary value justified.
- [ ] No `<Sparkles>` / gradient / emoji introduced.

**Type**

- [ ] Every text node uses a `text-<role>` utility from §7; no raw `text-[15px]`.
- [ ] `font-display` appears at most once per screen, and never under 18px.
- [ ] Mono is on technical values only, and every technical value is mono.
- [ ] One `<h1>`; heading levels do not skip.

**States (brief §8 — all five)**

- [ ] Loading is a shaped skeleton matching real geometry, not a spinner.
- [ ] Empty uses the right one of the five kinds (§9.21) and offers a next action.
- [ ] Error states name what failed and offer retry.
- [ ] Unauthorized renders a real state, not a redirect loop or a blank page.
- [ ] Rate-limited / disconnected covered where the surface can hit them.
- [ ] Nothing on screen is fake: every control does what it appears to do.

**Keyboard & a11y (do this by hand, it takes 60 seconds)**

- [ ] Tab through the whole screen: every interactive element is reachable, in
      DOM order, with a visible ring, and nothing is hidden under the sticky header.
- [ ] Operate the primary flow with the keyboard only.
- [ ] `Escape` closes every overlay; focus returns to the trigger.
- [ ] Icon-only buttons have `aria-label`; the tooltip text matches it.
- [ ] Every input has a real `<label>`; errors are in `aria-describedby`.
- [ ] Async results announce via `aria-live`; loading regions set `aria-busy`.
- [ ] Delete/remove actions move focus somewhere deterministic afterwards.
- [ ] No meaning carried by colour alone.
- [ ] Body text uses `--ink`/`--ink-secondary`/`--ink-meta`; `--ink-muted` only
      for placeholder/disabled/decorative.

**Data & honesty**

- [ ] Every rate shows its denominator.
- [ ] Open-rate anything is labelled indicative.
- [ ] Any comparative claim states its sample size, or is suppressed.
- [ ] Times are absolute with a named timezone (relative may accompany it).
- [ ] Counts in destructive confirmations are real, and "select all" says
      whether it means this page or all matching rows.
- [ ] Any chart passes §11.1 — it answers a real question better than a number.

**Responsive & content**

- [ ] Works at 1440, 1280, 1024, 768. (Not phone-designed; must not be broken.)
- [ ] Paste a 78-character subject and a 60-character company name: nothing
      overflows, nothing pushes the layout wide.
- [ ] Tables scroll horizontally within their container, not the page.

**Motion**

- [ ] Nothing exceeds 200ms; nothing bounces; nothing animates on load.
- [ ] With "reduce motion" enabled in OS settings, everything still works and
      overlays still unmount.

---

## 16. Build order for this slice (phase 1)

Implement in this order; each step is usable before the next starts.

1. `globals.css` (§2–§5) + `fonts.ts` + `layout.tsx` wiring + `lib/cn.ts`.
2. A `/dev/tokens` route (dev-only, excluded from prod nav) rendering every token
   swatch, every type role, and every component variant/state on one page. This
   is the design system's test surface and the fastest way to catch drift; it
   costs an afternoon and pays for itself in phase 1.
3. Primitives in dependency order: Button, Label/Field, Input, Textarea,
   Badge/StatusBadge, Separator, Skeleton, Card, Panel, Tooltip.
4. Radix-backed: Dialog, Sheet, DropdownMenu, Select, Checkbox, RadioGroup,
   Switch, Tabs, Progress, Avatar, Toast.
5. Layout: Sidebar, AppHeader, PageHeader, Section, shell layout.
6. Patterns: EmptyState, Banner, Timestamp, Pagination, SearchInput, FilterChip,
   Breadcrumb, KeyboardHint, DataTable, StatCard, skeleton presets.
7. Charts are **not** built in phase 1. They land in phase 8 with real data.

### Deliberately deferred (and why)

- Dark mode — tokens support it; no component work needed now.
- Sidebar collapse — costs tooltips + persistence for little gain.
- Command palette — nothing to search yet; shipping it early makes it fake.
- Combobox / date picker — arrive with phases 4 and 6, which define their needs.
- A generic chart abstraction — see §11.4.
- Any theming beyond one theme.

---

## 17. Open questions for the lead engineer

1. **§6.1 — `--ink-meta`.** Ratify the new token as the information-bearing meta
   colour (demoting `--ink-muted` to placeholder/disabled), or darken
   `--ink-muted` to `#64708A` and drop the extra token. The brief's assignment of
   `--ink-muted` to timestamps fails its own 4.5:1 gate as written.
2. **§6.2 — `--border-control`.** Approve `#8F887C` for form-control outlines
   (WCAG 1.4.11), or take the documented exception and use `--border-strong` for
   a softer look.
3. **§8.1 — dependencies.** Ratify Radix primitives, `class-variance-authority`,
   `clsx`, `tailwind-merge`, and `sonner` as consequences of the locked
   shadcn/ui choice. Reject sonner if you want the ~120-line in-house toast.
4. **§7.1 — CI network egress at build time.** `next/font/google` fetches at
   build. If the runner is offline, we vendor three `.woff2` files now.
5. **§11.4 — charts.** Recharts in phase 8, or ~150 lines of hand-authored SVG
   for the two charts we need. Recommendation: hand-authored.
6. **§9.22 — pagination strategy.** Confirm the inbox and `EmailEvent` views are
   cursor/keyset-paginated (offset drifts under concurrent inserts) so this doc,
   the inbox doc, and the analytics doc agree on the footer UI.
7. **§13.5 — email HTML sanitiser.** Owned by the inbox doc; this doc fixes only
   the container. Confirm which doc specifies it so it does not fall between us.
