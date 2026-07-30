# Manual team assignment, schedule-edit scroll fix, vote question dropdown

Date: 2026-07-29
File affected: `production.html`

## 1. Manual team/pair assignment

Today, `state.players[].team` is only ever set by `saveTeams()` after running The Draw. Add a way to assign teams/pairs directly, without drawing.

**Location:** Board tab, in the existing Players card, directly below the "Clear teams" button (only rendered once `hasTeams` teams exist; the new assign UI renders unconditionally alongside it).

**UI:**
- A checklist of active players (reuse the existing `checklist(id, names)` helper with a new id, e.g. `"assign"`).
- A text input, "Team name (optional)".
- An "Assign" button.

**Behavior (`assignTeamGroup()`):**
1. Read `checked("assign")`. If empty, alert "Pick at least one player." and stop.
2. Read the team name input, trimmed.
3. If blank, derive a label the same way `saveTeams()` does for pairs/duel: `members.map(n => n.split(" ")[0]).join(" & ")`.
4. Set `.team = label` on each checked player in `state.players`. Players not checked are untouched — this lets the crew build up groups one at a time across multiple Assign clicks.
5. `push()` to save and re-render the Board tab (clearing the checklist/name input since the tab re-renders from state).

This coexists with the random draw: either path sets `.team`, and the existing "Clear teams" button (`clearTeams()`) wipes all assignments regardless of how they were made.

## 2. Schedule item edit scrolls to bottom

`editSched(id)` currently does:
```js
function editSched(id) { editSchedId = id; sched(); window.scrollTo({ top: 0, behavior: "smooth" }); }
```

Change the scroll target from the top to the bottom of the page:
```js
function editSched(id) { editSchedId = id; sched(); window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }
```

No other change to `sched()`'s rendering — the edit card stays where it is in the DOM (between "Run of show" and "Results so far"); only the scroll destination changes.

`editLog(id)` (Run tab) is unchanged — it keeps scrolling to top.

## 3. Vote question dropdown

In `vote()`, the "not open" branch currently renders:
```html
<label>Question</label>
<input id="pq" placeholder="Who goes into elimination?">
```

Replace with:
```html
<label>Question</label>
<select id="pq">
  <option value="Who should go into elimination?">Who should go into elimination?</option>
  <option value="other">Other…</option>
</select>
<input id="pqOther" placeholder="Type your question" style="display:none; margin-top:8px">
```

Wire a change handler after render (in `vote()`, alongside the existing `checklist`/`openPoll` wiring):
```js
$("#pq").onchange = () => $("#pqOther").style.display = $("#pq").value === "other" ? "" : "none";
```

Update `openPoll()`'s question read:
```js
const q = $("#pq").value === "other" ? $("#pqOther").value.trim() : $("#pq").value;
```

Everything else in the vote flow (player checklist for options, custom comma-separated options, tally display, closing the poll) is unchanged.

## Testing

Single-file vanilla HTML/JS, no build step. Test by opening `production.html` locally (or via a local server, since it needs `localStorage` + fetches to the Cloudflare Worker for state) and exercising each flow manually:
- Assign a group without a team name → confirm auto-generated first-name label.
- Assign a group with a custom team name.
- Assign a second group, confirm the first group's team assignment survives.
- Edit a schedule item, confirm the page scrolls to the bottom.
- Open voting with the elimination preset, and again with "Other" + custom text.
