# Pixel Wayfarers on NEAR: interface system (`/near`)

## Direction
A pixel-art tavern town at night. Wood panels on a night-blue street, gold for what matters, parchment for things
you hold (cards, toasts, inputs). The NFT is a character with a purse and a room; the UI is its counter and shelf.

## Tokens (worker/public/styles.css)
`--night` page · `--wood-dark` / `--wood` / `--wood-mid` / `--wood-light` panels, from deepest to lightest ·
`--ink` outlines · `--gold` focus, actions, headings · `--parchment` / `--cream` held things and text ·
`--muted` metadata · rarity: `--common` `--uncommon` (also "money" green) `--rare` `--epic` `--legendary`.
Type: `--display` Pixelify Sans (headings, buttons, big figures) · `--body` Geist · `--mono` Geist Mono (labels, money).

## Layout
- `main` spans the navbar width: max 1240px, 28px gutters (16px under 860px), 20px gaps between panels.
- Two panes, never one centred column. Each collapses to `minmax(0, 1fr)` under 860px.
  - Wayfarer page: `.token-layout` 280–380px **purse** column (sticky top 96px when the window is tall) + main column.
  - Market: `.market-layout` 250px **filter rail** (sticky) + results.
  - Home: `.hero-split` story 1.5fr + mint card 1fr. Tavern: 300px table card + board; the entrance is mascot + steps.
- Panels: `--wood`, 4px ink frame, inset `--wood-mid` ring, 22px padding, 6px radius.

## Signature elements
- **The purse figure:** `.purse-label` (12px mono, uppercase, tracked, muted) over `.purse-figure`
  (52px display, `--uncommon` green, tabular numbers, 3px ink shadow). One per Wayfarer page: the focal point.
- **The shelf:** `.room` grid with 200px rows; the wooden plank is painted by a repeating background, so every
  row is a full-width shelf. Items are 144px sprites standing on it, with a rarity tag at the top and a price
  tag at the bottom right; Rare and Epic glow in the tier colour, Legendary pulses gold.
- **Rarity:** `.t0`–`.t4` set `--tier`; tags, dots and glows all read it.

## Feedback
- Every page draws `LOADER` (a spinning pixel coin, "Reading NEAR…") first.
- Transactions: `body.busy` dims and locks `main`, a `wait` toast stays up, then "Done ✓" or a readable error.
  Toasts sit bottom-right in parchment with an ink border (`.toast.ok` green edge, `.bad` red).
- Money is checked before signing (`wayfarerPays`, KEEP 0.005 NEAR) and after (`REFUSABLE` calls answer null/false).

## Controls
- Buttons: `.btn` gold with a 3px ink border; `.ghost` transparent with a muted border; `.big` 19px.
  Pressed segment buttons: gold.
- Inputs and selects: parchment fill, 3px ink border.
- Action cards (`.commission`): `--wood-dark`, 14px padding, in `.actions-grid` (auto-fit, min 280px).
