# Log tab: unify completed challenges, votes, and team assignments

Date: 2026-07-30
File affected: `production.html`

## Context

The Schedule tab's "Results so far" card duplicated info already visible inline (struck-through) in "Run of show", and there was no history at all for closed votes or team/pair assignments (the Board tab's "Assign teams / pairs" tool silently mutated `p.team` with no record). This adds a dedicated Log tab: a single reverse-chronological feed merging all three kinds of past events.

## Data model

Two new lazily-initialized arrays alongside existing `state.log`:

```js
state.voteHistory // [{ id, ts, question, options, votes }]
state.teamHistory  // [{ id, ts, team, members }]
```

`state.log` (challenge results) is unchanged.

## Changes

- **`closePoll()`**: archives a snapshot of the closed poll (question/options/votes) into `state.voteHistory` before pushing.
- **`assignTeamGroup()`**: after assigning, pushes `{ id, ts, team: label, members }` to `state.teamHistory`.
- **`sched()`**: the "Results so far" card and its `past` list are removed. "Run of show" is unchanged (still shows done items struck through inline).
- **New `log()`** render function: merges `state.log` + `state.voteHistory` + `state.teamHistory` into one array tagged by `kind`, sorted by `ts` descending. Renders:
  - 🏆 challenge — name/type/summary, with the existing `editLog()`/`deleteLog()` controls (moved here, unchanged behavior).
  - 🗳️ vote — question + per-option tally + voter names (same shape as the existing `renderClosedPoll()` view), with a new `deleteVoteLog(id)`.
  - 🤝 team — team label + members, with a new `deleteTeamLog(id)`.
- New tab button `Log` (`data-t="log"`) added to the tab bar; `render()`'s dispatch table includes `log`.

## Testing

Single-file vanilla HTML/JS, no build step. Test by opening `production.html` locally:
1. Record a challenge result, assign a team, open+close a vote — confirm all three show up in the Log tab, newest first.
2. Confirm Schedule tab no longer shows "Results so far" but still shows done items struck through in "Run of show".
3. Confirm edit/delete still work for challenge entries from the Log tab; delete works for vote/team entries.
