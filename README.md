# Challenge Day

Run a one/two-day local version of The Challenge: live leaderboard + voting for participants, a full control room for production.

- `index.html` — **participant view**: leaderboard, results feed, "Daily Challenge next"-style teaser (never the details), and tribunal voting when production opens one. Refreshes every 10s.
- `production.html` — **production view** (token-gated): roster, record challenge results, secret run-of-show, animated draw (pairs/teams/pick-one/1v1), open/close votes with live tally, big-screen timer. Elimination mode toggle: real knockouts vs points-only.
- `worker.js` — Cloudflare Worker holding shared state.

## One-time Worker setup (dashboard paste — no wrangler)

1. Cloudflare dashboard → Workers → create worker named `challenge-day` → paste `worker.js` → deploy.
2. KV: create a namespace (e.g. `challenge_day_state`) and bind it to the worker as **STATE** (Settings → Bindings).
3. Add a secret env var **TOKEN** (Settings → Variables) — any long random string; this is the production password.
4. Open `production.html`, paste the token once (it's remembered in that browser).

Participants just get the link to the main page. State lives in KV; wipe it by deleting the `event` key in the namespace.
