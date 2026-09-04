# Vikat_Overview.potx

The deck every generated PPT is meant to look like.

It is committed **so that it can be read, not admired**. `scripts/lib/template.js`
pulls the palette, the typefaces and the slide geometry out of it, and
`worker/test/template.test.js` asserts that `worker/src/brand.js` still agrees
with what comes back. When the template changes, those tests fail and name the
colour that moved.

That check exists because the alternative was tried and failed. `brand.js` used
to be a transcription — somebody read the deck and typed the colours in — and
the two drifted: the accents ended up close but wrong, and the ground ended up
white when the template is cream. Nothing noticed, because the renderer was
self-consistent and confidently off-brand.

## Replacing it

Drop the new file in at the same path and run `npm --prefix worker test`. Any
colour the renderer paints that the new template does not use will be named in
the failure; update `brand.js` to match the template, never the other way
round.

## What is NOT taken from it

The renderer does not copy this file's master, layouts or theme into generated
decks. The design here lives in the slides; the theme is stock Office, and
inheriting it would make generated decks worse rather than better. What travels
is the design system — colour, type, geometry — rebuilt by `documents/pptx.js`.

No content is read from it either. The template's words are its own.

## Note on this repository

This repository is public. This file carries "Confidential" in its own
copyright line, and was committed at the explicit request of its owner.
