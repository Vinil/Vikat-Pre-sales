# Brand fonts

Inter and JetBrains Mono, the two typefaces the Vikat.AI brand guidelines
specify. Both are licensed under the SIL Open Font License 1.1 — see
`Inter-OFL.txt` and `JetBrainsMono-OFL.txt` — so there is no licensing cost or
restriction for web or print, and redistributing them here is permitted.

They are committed rather than fetched at build time because generated
collateral leaves the building. The guidelines prohibit system font
substitution in brand material, and a build that silently falls back to
Helvetica when a CDN is slow is exactly that substitution.

| File | Role |
|---|---|
| `Inter-Black.ttf` | Display and headings (Inter Black 900) |
| `Inter-Bold.ttf` | Sub-headings (Inter Bold 700) |
| `Inter-Regular.ttf` | Body copy (Inter Regular 400) |
| `JetBrainsMono-Bold.ttf` | Eyebrows, badges, technical labels |

`worker/src/documents/fonts.js` imports these as Wrangler `Data` modules, so
they are part of the deployed Worker rather than something fetched at runtime.
