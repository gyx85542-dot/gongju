# Gallery Hide / Archive Design

Date: 2026-08-09  
Status: draft for review

## Goal

Right-side board (`gallery.html`) needs a soft-hide / archive for items the user does not want in the main feed, without deleting files. Hidden items must remain recoverable via a dedicated filter tab.

## Decisions (approved)

- Storage model: **user-meta ID list** (same pattern as favorites), not a special folder and not a history-row DB column.
- Filter entry: **media filter tab** next to Favorites (`all | image | video | audio | favorite | hidden`).
- Actions: **card hover hide/unhide** and **bulk hide/unhide**.

## Behavior

### Visibility rules

- Default tabs (`all`, `image`, `video`, `audio`, `favorite`): **exclude** items whose history key is in `hidden`.
- `hidden` tab: show **only** hidden items.
- Project/folder dropdown still applies in every tab, including `hidden`.
- Pending placeholders are never treated as hidden and stay out of the `hidden` tab (same as favorites).

### Card actions

- Hover actions gain a hide control (icon: `eye-off`).
- Outside the `hidden` tab: action = hide (add key to `hidden`).
- Inside the `hidden` tab: action = unhide (remove key from `hidden`).
- Hide does not remove pin/favorite/folder membership; those flags remain, but the item is filtered out of non-hidden tabs until unhidden.
- Real delete remains available and permanently removes the item (and should also drop its key from `hidden`).

### Bulk actions

- Bulk toolbar gains hide / unhide:
  - In non-hidden tabs: **Hide selected**
  - In `hidden` tab: **Unhide selected**
- Operates on the currently filtered/selected set only.

### Persistence

- Scope: gallery board `studio` (same as folders / board-wide pin-fav).
- Server field: `hidden: string[]` inside `history_user_meta.meta_json`.
- Client mirror: `hiddenIds` + localStorage key `studio_hidden` (same sync style as favorites).
- API: extend existing `GET/PUT /api/history/user-meta` to accept/return `hidden`.
- Sanitize keys with the same history-key rules used for pin/favorite/order.

## UI copy (i18n)

| Key | zh | en |
|---|---|---|
| `gallery.filterHidden` | 已隐藏 | Hidden |
| `gallery.hide` | 隐藏 | Hide |
| `gallery.unhide` | 取消隐藏 | Unhide |
| `gallery.hideSelected` | 隐藏选中 | Hide selected |
| `gallery.unhideSelected` | 取消隐藏选中 | Unhide selected |

## Non-goals

- No file move / rename on disk.
- No separate “Archive” project folder.
- No automatic purge of hidden items.
- No change to left panel local output grids (`online.html` etc.); board gallery only for v1.

## Files to touch

- `database.py` — default meta + sanitize/merge `hidden`
- `main.py` — `HistoryUserMetaPayload` + PUT merge whitelist
- `static/studio-history-meta.js` — load/save/merge `hidden` ↔ `hiddenIds`
- `static/gallery.html` — tab, filter, hover action, bulk action, meta wiring
- `static/i18n.js` — strings above
- Cache-bump gallery iframe / related assets in `static/index.html` if needed

## Success criteria

1. Hiding an item removes it from All/Images/…/Favorites immediately.
2. Switching to Hidden shows that item; Unhide restores it to normal tabs.
3. Bulk hide/unhide works for multi-select.
4. Reload / restart preserves hidden state via user-meta.
5. Folder filter still works inside Hidden.
6. Deleting a hidden item removes file + cleans its hidden key.
