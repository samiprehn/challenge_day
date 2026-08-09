// Challenge Day state API — deploy by pasting into the Cloudflare dashboard.
// Bindings required: KV namespace "STATE", environment secret "TOKEN".
// Designed for the KV FREE tier: no list() calls anywhere (free-tier lists are capped at
// 1,000/day — a single open poll's refresh traffic would exhaust that in minutes).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Token",
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const defaultState = () =>
  ({ players: [], settings: { eliminationMode: false }, schedule: [], log: [], poll: null });

// votes live in their own KV keys (vote:{pollId}:{voterName}), never inside the shared
// state blob — so two people voting at the same instant never race the same KV write and
// silently erase each other's vote, the way a shared-blob read-modify-write would.
const voteKey = (pollId, voter) => `vote:${pollId}:${voter}`;

// coerce core fields into safe shapes, and strip fields that only exist in the
// participant-facing view — their presence in stored state is the fingerprint of the
// 2026-08-08 corruption (a downgraded client saved the public view over the real data)
function sanitize(s) {
  delete s.nextType;
  delete s.claimed;
  delete s.pollVotesDirty;
  s.players = Array.isArray(s.players) ? s.players : [];
  s.schedule = Array.isArray(s.schedule) ? s.schedule : [];
  s.log = Array.isArray(s.log) ? s.log : [];
  s.settings = s.settings && typeof s.settings === "object" ? s.settings : {};
  return s;
}

// reconstruct an open poll's live votes from the per-voter keys — one get per player,
// never a list. Sets pollVotesDirty when the blob's stored copy is behind, which tells the
// production client to push a consolidated copy; participants only ever read votes from
// the blob, keeping their /state at a single KV read each.
async function withLiveVotes(state, env) {
  if (state.poll && state.poll.open) {
    const entries = await Promise.all(state.players.map(async p => {
      const raw = await env.STATE.get(voteKey(state.poll.id, p.name));
      if (!raw) return null;
      try { return [p.name, JSON.parse(raw).choice]; } catch { return null; }
    }));
    const votes = Object.fromEntries(entries.filter(Boolean));
    const old = state.poll.votes || {};
    const same = Object.keys(votes).length === Object.keys(old).length &&
      Object.keys(votes).every(k => old[k] === votes[k]);
    if (!same) state.pollVotesDirty = true;
    state.poll.votes = votes;
  }
  return state;
}

// what participants see: full history, but upcoming challenges only by type
function publicView(state) {
  const next = state.schedule.find(s => !s.done);
  const voted = state.poll && state.poll.open ? Object.keys(state.poll.votes || {}) : [];
  return {
    players: state.players,
    settings: state.settings,
    log: state.log,
    nextType: next ? next.type : null,
    timer: state.timer || null,
    claimed: voted, // poll-scoped: only names that already voted THIS round are "taken"
    poll: state.poll && state.poll.open
      ? { id: state.poll.id, question: state.poll.question, options: state.poll.options, voted }
      : null,
  };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const isProd = req.headers.get("X-Token") === env.TOKEN;
    const state = sanitize(JSON.parse((await env.STATE.get("event")) || "null") || defaultState());

    if (url.pathname === "/state") {
      // a wrong (or blank) token gets an error, not a silent downgrade to the public view —
      // .has() checks the header was sent at all, unlike a truthy check on .get(), which
      // treats an empty-but-present token the same as no token and used to let a blank
      // production login through as if it were a real (but merely low-privilege) participant
      if (req.headers.has("X-Token") && !isProd) return json({ error: "bad token" }, 403);
      if (isProd) return json(await withLiveVotes(state, env));
      return json(publicView(state));
    }

    if (req.method === "POST" && url.pathname === "/update") {
      if (!isProd) return json({ error: "bad token" }, 403);
      const body = await req.json();
      const raw = body.state;
      // refuse anything that doesn't look like a full production state — a client that
      // somehow ended up holding the participant view (no schedule/players/log arrays)
      // must never again be able to save it over the real data
      if (!raw || !Array.isArray(raw.schedule) || !Array.isArray(raw.players) || !Array.isArray(raw.log))
        return json({ error: "not a full production state — refusing to save" }, 400);
      const incoming = sanitize(raw);
      // optimistic concurrency: reject a save based on a stale revision instead of letting
      // a parked tab or a second production device silently revert newer changes
      if (typeof body.baseRev === "number" && typeof state.rev === "number" && body.baseRev !== state.rev)
        return json({ error: "conflict", state: await withLiveVotes(state, env) }, 409);
      incoming.rev = (state.rev || 0) + 1;
      // rolling one-step backup of the meaningful data before it changes — KV has no
      // version history, so this spare copy is the only undo that exists. Pushes that only
      // touch votes/timer/settings skip it, keeping writes inside the free tier's 1k/day.
      const core = s => JSON.stringify({ p: s.players, sc: s.schedule, l: s.log, pa: s.past, vh: s.voteHistory, th: s.teamHistory });
      if (core(state) !== core(incoming)) await env.STATE.put("event:prev", JSON.stringify(state));
      // when this save closes the open poll, its per-voter keys are no longer needed
      // (the tally is archived in voteHistory) — clean them up in the background
      if (state.poll && state.poll.open && incoming.poll && incoming.poll.id === state.poll.id && !incoming.poll.open)
        ctx.waitUntil(Promise.all(state.players.map(p => env.STATE.delete(voteKey(state.poll.id, p.name)).catch(() => {}))));
      await env.STATE.put("event", JSON.stringify(incoming));
      // hand back the exact state we just wrote, so the client doesn't need a
      // follow-up read that could race a not-yet-propagated KV write and show stale data
      return json({ ok: true, state: incoming });
    }

    if (req.method === "POST" && url.pathname === "/vote") {
      const { voter, choice, device } = await req.json();
      if (!state.poll || !state.poll.open) return json({ error: "voting is closed" }, 400);
      if (!state.players.some(p => p.name === voter)) return json({ error: "unknown player" }, 400);
      if (!state.poll.options.includes(choice)) return json({ error: "invalid choice" }, 400);
      const key = voteKey(state.poll.id, voter);
      // first phone to vote as a name this round claims it — but only for this round;
      // a new poll means a new key, so nobody is ever locked out across rounds.
      // Production (valid token) bypasses the claim so it can cast/override a vote for
      // someone whose phone is dead or broken; a production-cast vote stores no device,
      // so the person can still vote themselves later and take it over.
      if (!isProd) {
        const existingRaw = await env.STATE.get(key);
        if (existingRaw) {
          const existing = JSON.parse(existingRaw);
          if (existing.device && existing.device !== device)
            return json({ error: `${voter} already voted this round from a different device — ask production to release it` }, 403);
        }
      }
      await env.STATE.put(key, JSON.stringify({ choice, device: (!isProd && device) || null, ts: Date.now() }));
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/release") {
      if (!isProd) return json({ error: "bad token" }, 403);
      const { name } = await req.json();
      if (state.poll && name) await env.STATE.delete(voteKey(state.poll.id, name));
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
