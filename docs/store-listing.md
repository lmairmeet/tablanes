# Chrome Web Store submission

Everything needed for the listing, ready to paste into the Developer Dashboard.

## 1. Build the package

```bash
./scripts/package.sh
```

Produces `dist/tablanes-<version>.zip` from an explicit allowlist of shipped
files — no `.git`, no `docs/`, no `store/`, no dev config. It fails loudly if a
listed file is missing or if `newtab.html` references something unpackaged.

Upload that zip at
<https://chrome.google.com/webstore/devconsole> → **Add new item**.

A one-time $5 developer registration fee applies to a new publisher account.

## 2. Store listing fields

**Name**

```
TabLanes
```

**Summary** (132 char limit; this is 112)

```
A fast kanban board on every new tab. Lanes, cards, files and images — stored locally in SQLite, never uploaded.
```

**Description**

```
TabLanes turns your new tab page into a single, fast kanban board.

Open a tab, see your work. No accounts, no sync, no loading spinner — the board
is already there.

WHAT YOU CAN DO
• Create lanes and rename them with a click
• Add cards to any lane, with a composer that stays open for rapid entry
• Drag cards between lanes, and drag lanes into a new order
• Give a card a description, links, and file or image attachments
• Images become the card's cover, and open full size in a lightbox
• Search every card by title or description, with matches highlighted
• Delete a card or a lane, with one-click undo
• Light and dark themes, following your system setting

WHERE YOUR DATA LIVES
On your computer, and nowhere else. TabLanes stores the board in a real SQLite
database (SQLite compiled to WebAssembly and bundled with the extension) held
inside your browser profile. Attachments are stored alongside it.

TabLanes makes no network requests at all. There is no account, no server, no
analytics, and no remote code — every file it runs ships inside the package.
Removing the extension deletes the board with it.

Open source: https://github.com/lmairmeet/tablanes
```

**Category**: Workflow & Planning
**Language**: English

## 3. Graphic assets

| Asset | Requirement | File |
| --- | --- | --- |
| Store icon | 128×128 PNG | `icons/icon128.png` |
| Screenshot | 1280×800 PNG, 1–5 of them | `store/screenshots/*.png` |
| Small promo tile | 440×280 PNG, optional | not produced — only needed to be considered for featuring |

Regenerate the screenshots after any UI change:

```bash
node scripts/screenshots.mjs
```

## 4. Privacy tab

**Single purpose**

```
TabLanes replaces the new tab page with a kanban board for the user's own
tasks, stored locally on their device.
```

**Permission justification — `unlimitedStorage`**

```
The board, including any files and images the user attaches to a card, is kept
in a local SQLite database in the browser profile. unlimitedStorage prevents the
default quota from truncating that database once a user attaches large files.
It grants no access to browsing data.
```

**Permission justification — new tab override**

```
The extension's entire purpose is the board, which is presented as the new tab
page. It overrides no other page.
```

**Data usage disclosures** — check nothing. TabLanes collects no user data of
any category. Then affirm all three certifications:

- not being sold to third parties
- not used or transferred for purposes unrelated to the single purpose
- not used or transferred to determine creditworthiness or for lending

**Privacy policy URL** — `PRIVACY.md` in this repo holds the text. Publish it at
a stable URL and paste that; the raw GitHub link works:

```
https://github.com/lmairmeet/tablanes/blob/main/PRIVACY.md
```

## 5. Before submitting

- [ ] Version in `manifest.json` bumped past the last published one (the store
      rejects a re-upload at the same version)
- [ ] `./scripts/package.sh` run after the bump, and the fresh zip uploaded
- [ ] Zip loads clean via **Load unpacked** on an extracted copy
- [ ] Screenshots reflect the current UI

Review for a new-tab-override extension typically takes a few days; overrides of
the new tab page get extra scrutiny, and the single-purpose statement above is
what that review checks against.
