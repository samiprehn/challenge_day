// Challenge Day state API — deploy by pasting into the Cloudflare dashboard.
// Bindings required: KV namespace "STATE", environment secret "TOKEN".

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

// coerce anything the client sends into shapes we can safely iterate, so a bad write
// (stale tab, partial state, etc.) can never wedge every reader that touches these fields
function sanitizeIncoming(incoming) {
  incoming.players = Array.isArray(incoming.players) ? incoming.players : [];
  incoming.schedule = Array.isArray(incoming.schedule) ? incoming.schedule : [];
  incoming.log = Array.isArray(incoming.log) ? incoming.log : [];
  incoming.settings = incoming.settings && typeof incoming.settings === "object" ? incoming.settings : {};
  return incoming;
}

// what participants see: full history, but upcoming challenges only by type
async function publicView(state, env) {
  const next = (state.schedule || []).find(s => !s.done);
  let voted = [];
  if (state.poll && state.poll.open) {
    const list = await env.STATE.list({ prefix: voteKey(state.poll.id, "") });
    voted = list.keys.map(k => k.name.slice(voteKey(state.poll.id, "").length));
  }
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

// production's own view of an OPEN poll needs live per-voter choices for the tally —
// reconstruct them from the individual vote keys (a closed poll's votes already live in
// state.poll.votes, frozen at close time, so this only runs while a poll is open)
async function withLiveVotes(state, env) {
  if (state.poll && state.poll.open) {
    const prefix = voteKey(state.poll.id, "");
    const list = await env.STATE.list({ prefix });
    const votes = {};
    await Promise.all(list.keys.map(async k => {
      const raw = await env.STATE.get(k.name);
      if (raw) { try { votes[k.name.slice(prefix.length)] = JSON.parse(raw).choice; } catch {} }
    }));
    state.poll.votes = votes;
  }
  return state;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const isProd = req.headers.get("X-Token") === env.TOKEN;
    const state = JSON.parse((await env.STATE.get("event")) || "null") || defaultState();

    if (url.pathname === "/state") {
      // a wrong token gets an error, not a silent downgrade to the public view
      if (req.headers.get("X-Token") && !isProd) return json({ error: "bad token" }, 403);
      if (isProd) return json(await withLiveVotes(state, env));
      return json(await publicView(state, env));
    }

    if (req.method === "POST" && url.pathname === "/update") {
      if (!isProd) return json({ error: "bad token" }, 403);
      const incoming = sanitizeIncoming((await req.json()).state);
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
      // a new poll means a new key, so nobody is ever locked out across rounds
      if (device) {
        const existingRaw = await env.STATE.get(key);
        if (existingRaw) {
          const existing = JSON.parse(existingRaw);
          if (existing.device && existing.device !== device)
            return json({ error: `${voter} already voted this round from a different device — ask production to release it` }, 403);
        }
      }
      await env.STATE.put(key, JSON.stringify({ choice, device: device || null, ts: Date.now() }));
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
