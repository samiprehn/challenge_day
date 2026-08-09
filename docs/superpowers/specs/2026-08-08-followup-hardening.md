# Follow-up hardening after the 2026-08-08 incident review

Date: 2026-08-08. A full re-read of the codebase after the incident fixes turned up one
critical flaw in the fix itself, plus several remaining bugs. All addressed here.

## Critical: the vote fix relied on KV `list()`, which the free tier caps at 1,000/day

The per-voter vote keys (correct fix for the write race) were read back via
`env.STATE.list()` on **every** `/state` request while a poll was open. On the KV free
tier (confirmed: this account is on it), list operations are capped at 1,000/day — ~20
participant phones refreshing every 10s would exhaust that within minutes of the first
vote opening, erroring every poll for the rest of the day.

**New design — zero list calls:**
- `/vote` still writes to per-voter keys (the race fix stands).
- Production's `/state` reconstructs live votes with one `get` per player (reads are
  100k/day — plenty). When the reconstruction differs from the blob's stored copy, the
  response carries a transient `pollVotesDirty` flag.
- Production's client, on its 8s refresh, sees the flag and pushes the consolidated votes
  into the blob (a handful of writes per round, inside the 1k/day write budget).
- Participants' `/state` reads votes **only from the blob** — one KV read per request,
  same as before the incident. Their own "Vote in ✓" stays instant via the existing
  client-side optimistic update; the "already voted" list for *other* names lags ≤ ~10s.
- On poll close, the per-voter keys are deleted in the background (`ctx.waitUntil`);
  deletes are also 1k/day but a full event uses ~200.

## Rolling one-step backup (`event:prev`)

KV has no version history — during the incident there was nothing to restore from. Now
`/update` copies the current blob to `event:prev` before overwriting it, but **only when
the meaningful data changed** (players/schedule/log/past/voteHistory/teamHistory), so
vote-consolidation and timer pushes don't burn the write budget. Recovery is manual
(copy `event:prev`'s value back over `event` in the dashboard) but exists now.

## Revision check (optimistic concurrency) on `/update`

The blob now carries a `rev` counter. Clients send `baseRev` with each save; a save based
on a stale revision gets a 409 `conflict` (with the current state attached) instead of
silently reverting newer data — closing the "tab parked on Record/Timer for an hour
overwrites everything" hole and the two-production-devices hole. On conflict the client
adopts the server's state, re-renders, and asks the user to redo their last action.
Missing `rev`/`baseRev` (old clients, first deploy) is accepted, so the migration is safe.

## `/update` rejects non-production-shaped state

Any payload whose `schedule`/`players`/`log` aren't all arrays is refused outright — the
exact corruption signature from the incident (a public view saved over real data) can no
longer be persisted, no matter what future client bug produces it. `sanitize()` on both
ends also strips the participant-view-only fields (`nextType`, `claimed`) so the junk
left in storage by the incident scrubs itself out on the next save.

## Other fixes

- **`newEvent()` now archives and clears `voteHistory`/`teamHistory`/`poolLog`/
  `eliminationPool`** — previously these leaked into the next event's Log tab and were
  never archived for restore.
- **`closePoll()` double-fire guard** (`pollClosing` flag): it's async (re-pulls fresh
  votes first) and could previously be triggered again mid-flight by the 8s auto-close
  check or a manual click, double-archiving the vote. Also now adopts the full fresh
  state (not just votes) so its save is based on the newest revision.
- **Log↔schedule sync by id**: `saveRun()` stores `schedId` on log entries;
  `deleteLog()`/`undoRun()` match by it (name remains the fallback for old entries), so
  duplicate challenge names can't cross-wire.
- **Global error hooks**: `window.onerror`/`unhandledrejection` feed the crash banner, so
  button-handler crashes (not just render crashes) surface on screen. Banner is sticky
  with a dismiss button — the 8s refresh no longer wipes it before it can be read.
- **`releaseName()` pushes** after releasing so the participant "already voted" list
  frees the name promptly.

## Deploy

`worker.js` must be pasted into the Cloudflare dashboard (cumulative — includes the
earlier `.has()` blank-token fix, which was verified live via curl before this change).
HTML deploys via GitHub Pages on push.
