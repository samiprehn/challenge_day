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

## 🚨 Emergency: restore from backup

If the board/schedule/log suddenly looks wrong or wiped, **stop clicking things in production immediately** — the backup only keeps one step of history, and any further save overwrites it.

The worker automatically copies the previous state to a KV key called **`event:prev`** right before every meaningful change (players/schedule/results/history — not votes or timer ticks). To restore:

1. Cloudflare dashboard → **Workers & Pages → KV** → open the namespace bound to this worker.
2. Open the key **`event:prev`** and copy its entire value.
3. Open the key **`event`**, paste that value over it, and save.
4. Hard-refresh `production.html` — everything should be back to the state just before the bad change.

Sanity check before pasting: the `event:prev` value should contain `"schedule":[...]` with your challenges and `"log":[...]` with your results. If it looks wrong too, don't paste — the backup has already been overwritten, and pasting would make things worse.

## Worker updates

Any change to `worker.js` requires re-pasting it into the Cloudflare dashboard and deploying a new version — pushing to GitHub does **not** deploy the worker (only the two HTML pages, via GitHub Pages).

Note: the Cloudflare account is on the KV **free tier** (100k reads/day, but only 1k each of writes/deletes/lists per day). The worker is deliberately designed to make zero `list()` calls and few writes — keep it that way when changing it.
