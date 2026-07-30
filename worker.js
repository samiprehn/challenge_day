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

// what participants see: full history, but upcoming challenges only by type
function publicView(state) {
  const next = (state.schedule || []).find(s => !s.done);
  return {
    players: state.players,
    settings: state.settings,
    log: state.log,
    nextType: next ? next.type : null,
    timer: state.timer || null,
    claimed: Object.keys(state.claims || {}),
    poll: state.poll && state.poll.open
      ? { id: state.poll.id, question: state.poll.question, options: state.poll.options,
          voted: Object.keys(state.poll.votes || {}) }
      : null,
  };
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
      return json(isProd ? state : publicView(state));
    }

    if (req.method === "POST" && url.pathname === "/update") {
      if (!isProd) return json({ error: "bad token" }, 403);
      const incoming = (await req.json()).state;
      // don't lose votes that arrived while production was editing the same poll
      if (incoming.poll && state.poll && incoming.poll.id === state.poll.id) {
        incoming.poll.votes = { ...(incoming.poll.votes || {}), ...(state.poll.votes || {}) };
      }
      await env.STATE.put("event", JSON.stringify(incoming));
      // hand back the exact (merged) state we just wrote, so the client doesn't need a
      // follow-up read that could race a not-yet-propagated KV write and show stale data
      return json({ ok: true, state: incoming });
    }

    if (req.method === "POST" && url.pathname === "/vote") {
      const { voter, choice, device } = await req.json();
      if (!state.poll || !state.poll.open) return json({ error: "voting is closed" }, 400);
      if (!state.players.some(p => p.name === voter)) return json({ error: "unknown player" }, 400);
      if (!state.poll.options.includes(choice)) return json({ error: "invalid choice" }, 400);
      // first phone to vote as a name claims it
      state.claims = state.claims || {};
      if (device) {
        if (state.claims[voter] && state.claims[voter] !== device)
          return json({ error: "that name is already claimed on another phone — ask production to release it" }, 403);
        state.claims[voter] = device;
      }
      state.poll.votes = state.poll.votes || {};
      state.poll.votes[voter] = choice;
      await env.STATE.put("event", JSON.stringify(state));
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
