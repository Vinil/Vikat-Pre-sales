# The Vikat mark

The real artwork, extracted from the official brand guidelines rather than
redrawn. That distinction is the whole reason this directory exists.

Before this, the renderer TYPESET "vikat.AI" in Inter Black on every cover and
closing slide. It looked close. It was a redrawn lockup, which both governing
documents forbid by name:

- Vikat TM3 §07: "The logotype 'vikat.AI' is a designed lockup, never retype it
  in body text."
- Semantic Suite §02: "use the same mark scaled for the favicon, never a
  redrawn version."

A good imitation of a mark is worse than an obvious one, because it survives
being forwarded.

## What is here, and where each one goes

Extracted from `Vikat_Brand_Guidelines_-_TM3.pdf`, which carries them as
embedded rasters with soft masks. Each file is the base image composited with
its own mask, so the transparency is the artwork's, not a guess.

| File | TM3 §04 says | Use |
|---|---|---|
| `vikat-lockup.png` | Full-color lockup | White and light backgrounds. **Primary.** |
| `vikat-lockup-reversed.png` | Reversed lockup | **Navy and dark surfaces only.** |
| `vikat-emblem.png` | Emblem mark | Favicons, app icons, compact use. |

466 x 232 for the lockups, which is the true resolution in the source. TM3
requires a minimum of 140px wide on screen and 32mm in print, so a cover
lockup at roughly 2in wide clears it with room. There is no larger discrete
artwork available: TM4 holds the same marks only as full-page 300dpi scans,
where they cannot be separated from the page.

## What is deliberately NOT here

The same PDF carries the **prohibited-use examples** from §04, and they extract
looking exactly like usable assets: a recoloured magenta wordmark, one with a
drop shadow, one with a glow. Shipping any of them would render the misuse
page onto every cover. They were identified by looking at the extracted set on
a grey contact sheet before anything was copied in, which is the only reason
they were caught.

The suite hexagons (SecSemantic teal, DevSemantic purple, ProSemantic amber)
are in the source too and are not here yet, because nothing renders them.

## Rules that travel with these files

- Never recolour, stretch, rotate, or add shadows, gradients or effects.
- Clear space equal to the emblem height on all four sides.
- Never place the full-colour lockup on a dark background: that is what the
  reversed file is for.
- Never scale the emblem below 16px.

## Provenance

The guidelines PDF is marked Confidential. These three files are not: they are
the public-facing mark, the same one on vikat.ai, and a logo exists to be
seen. The document itself is not committed.
