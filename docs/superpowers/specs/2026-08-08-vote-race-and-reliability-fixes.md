# Post-incident fixes: dropped votes, stuck claims, and unresponsive tabs

Date: 2026-08-08

## Context

During a live run of the event, three things went wrong:

1. Many participants' votes silently "didn't register," requiring repeated taps of Submit before it appeared to work.
2. In a second round of voting, several participants got "that name is already claimed on another phone" even though nobody had voted with their name yet that round.
3. Partway through the day, production's Run and Record tabs stopped responding to clicks, while Players/Vote/Timer kept working.

## Root causes

**1. Dropped votes — non-atomic shared-state write.** `worker.js`'s `/vote` handler read the entire state blob, mutated it in memory, and wrote the whole thing back. When multiple participants voted within the same second (the common case, right after production says "go vote"), their requests raced: two people's writes could each be based on a state snapshot read *before* the other's write landed, so whichever request wrote last silently erased the other's vote and claim. This is a classic read-modify-write race, unrelated to browser choice — it depended on how many people happened to submit close together.

**2. Stuck claims — event-scoped instead of poll-scoped.** The device "claim" (`state.claims[voter] = device`) that locks a name to a phone was permanent for the entire event, not reset between polls. If a participant's browser lost its stored device ID between rounds (Safari's storage eviction under memory/tab pressure over a multi-hour event is a plausible trigger, though not the only one — switching devices, private browsing, etc. would too), the next poll's vote attempt would look like "a different device," and get flatly rejected — regardless of whether anyone had actually voted in the *current* poll.

**3. Run/Record tab freeze — no confirmed root cause, but a real adjacent bug found and fixed.** Reading through every function those two tabs call didn't turn up a definitive crash given normal state. However, production's own save function (`push()`) had no protection against out-of-order network responses: if two save-triggering actions fired close together, a slow response from the *earlier* one arriving *after* a newer one could silently revert `state` to an older version — including schedule/log edits already made and already confirmed to the user. This is a strong candidate and is fixed regardless; a defensive on-screen error banner was also added so a future occurrence is immediately diagnosable (visible error message) instead of a silent dead tab.

## Fixes

### `worker.js` (needs manual paste-deploy per this project's setup)

- **Votes no longer live in the shared state blob.** Each vote is now its own KV key: `vote:{pollId}:{voterName}` → `{choice, device, ts}`. Two different people voting at the same instant now touch completely different KV keys — there is no longer a shared read-modify-write to race. The tiny remaining race window (the same *name* voted from two devices in the same instant) only affects that one person's own vote, never anyone else's.
- **Claims are now poll-scoped, not event-scoped.** Since the "claim" is just whatever `device` is recorded on that poll's vote key, a new poll (new `pollId`) naturally starts with no claims at all — nobody can ever be locked out across rounds again.
- **New `POST /release`** (production-only): deletes one voter's key for the currently open poll, letting them vote again (e.g. from a different phone) without needing the old permanent-unlock semantics.
- **`/update` now sanitizes incoming state** (`players`/`schedule`/`log` coerced to arrays, `settings` coerced to an object) before persisting, so a malformed write from any client can't get stored and propagate to every other device.
- Removed the now-unnecessary poll-votes merge special-case in `/update` (dead weight now that votes don't live in the blob during an open poll).

### `index.html` (participant view)

- **Optimistic, durable vote confirmation.** After a successful `POST /vote`, the UI shows "Vote in ✓" immediately from the response we already have, instead of waiting on a follow-up `/state` read that could return a stale pre-write snapshot (KV writes aren't instantly visible to reads) and make a successful vote look like it failed. A new `votedPollId` variable remembers this durably so a background refresh that also hasn't caught up yet can't flip the confirmation back to the voting form.
- **Submit button disables itself while a request is in flight** (text changes to "Submitting…"), preventing accidental double-submits from a slow network.

### `production.html`

- **`releaseName()` now calls `POST /release`** instead of mutating the removed `state.claims`. The Board tab's release button now shows for anyone who has voted in the currently open poll (was: anyone with a stale permanent claim).
- **`push()` now guards against out-of-order responses**: each call gets a sequence number; if a newer push has been issued by the time an older one's response arrives, the older response is discarded instead of reverting `state`.
- **Defensive state coercion** (`sanitizeState`) applied on every load (`boot()`, periodic refresh, `push()`'s response) — `players`/`schedule`/`log` are guaranteed arrays and `settings` a guaranteed object, so a corrupted or partial state can never wedge every tab that iterates them.
- **On-screen crash banner**: `render()`'s tab dispatch is now wrapped in try/catch. Any exception shows a visible red banner with the error message instead of leaving a silently dead tab — makes a recurrence of symptom #3 immediately actionable instead of a mystery.
- **`closePoll()` now re-pulls fresh votes right before closing**, so a vote that landed in the last few seconds (since the last periodic pull) isn't missed in the archived tally.

## Deploy note

`worker.js` changed — per this project's setup (no wrangler/node locally), paste the updated file into the Cloudflare dashboard and deploy as a new version. `index.html` and `production.html` deploy automatically via GitHub Pages on push.

## Testing

No automated tests (single-file vanilla JS/Worker, no build step). Recommended manual check before the next event: open the participant page on two different devices/browsers, open a vote from production, submit from both at close to the same moment, and confirm both votes land. Then close that poll, open a new one, and confirm a name that voted in round 1 is *not* blocked in round 2 even from a different browser/device.
