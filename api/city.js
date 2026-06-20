// /api/city.js — builds a user's city from the Snapchain node once, caches it in Upstash Redis.
// No npm deps: uses Node 18+ global fetch + Upstash REST API. Caching is optional —
// if the UPSTASH_* env vars aren't set, it still works (just fetches every time).

const NODE = "https://hypersnap.x-3.lol";
const FC_EPOCH = 1609459200;
const TTL = 900; // seconds to cache each city (15 min — graphs change slowly; protects the node)
const BANNED_FIDS = new Set([ /* e.g. 123456 */ ]);
const BANNED_HANDLES = new Set(["casteragents"]);

const envPick = (...names) => { for (const n of names) if (process.env[n]) return process.env[n]; return undefined; };
const U = envPick("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "STORAGE_REST_API_URL", "STORAGE_KV_REST_API_URL", "REDIS_REST_API_URL");
const T = envPick("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "STORAGE_REST_API_TOKEN", "STORAGE_KV_REST_API_TOKEN", "REDIS_REST_API_TOKEN");
async function redis(cmd) {
  if (!U || !T) return null;
  try {
    const r = await fetch(U, { method: "POST",
      headers: { Authorization: `Bearer ${T}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd) });
    const j = await r.json();
    return j ? j.result : null;
  } catch (e) { return null; }
}

function fetchT(url, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 10000);
  return fetch(url, { signal: c.signal }).finally(() => clearTimeout(t));
}
async function pages(path, cap) {
  let out = [], tok = "", n = 0;
  do {
    const u = `${NODE}${path}&pageSize=200${tok ? `&pageToken=${tok}` : ""}`;
    const r = await fetchT(u); if (!r.ok) throw new Error(String(r.status));
    const j = await r.json(); out = out.concat(j.messages || []); tok = j.nextPageToken || ""; n++;
  } while (tok && out.length < cap && n < 6);
  return out;
}
async function tryPages(p, c) { try { return await pages(p, c); } catch (e) { return []; } }
const RTYPES = [["likes", ["REACTION_TYPE_LIKE", "1", "Like"]], ["recasts", ["REACTION_TYPE_RECAST", "2", "Recast"]]];
let rtIdx = -1;
async function reactPages(base, variants, cap) {
  const order = rtIdx >= 0 ? [rtIdx, ...[0, 1, 2].filter(i => i !== rtIdx)] : [0, 1, 2];
  for (const i of order) { try { const r = await pages(`${base}&reaction_type=${variants[i]}`, cap); rtIdx = i; return r; } catch (e) {} }
  return [];
}
async function mapLimit(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) {} } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

async function resolveUser(fid) {
  const me = { fid, handle: "fid:" + fid, pfp: null };
  try {
    const r = await fetchT(`${NODE}/v1/userDataByFid?fid=${fid}`);
    if (r.ok) { const j = await r.json();
      for (const m of (j.messages || [])) { const u = m.data && m.data.userDataBody; if (!u) continue;
        if ((u.type === "USER_DATA_TYPE_USERNAME" || u.type === 6) && u.value) me.handle = u.value;
        if ((u.type === "USER_DATA_TYPE_PFP" || u.type === 1) && u.value) me.pfp = u.value;
      } }
  } catch (e) {}
  return me;
}

async function build(MY_FID) {
  const nowS = Date.now() / 1000;
  const map = new Map();
  const ent = f => { if (!map.has(f)) map.set(f, { inbound: { replies: 0, likes: 0, recasts: 0, mentions: 0 }, outbound: { replies: 0, likes: 0, recasts: 0, mentions: 0 }, last: 0 }); return map.get(f); };
  const touch = (e, t) => { const s = t ? t + FC_EPOCH : 0; if (s > e.last) e.last = s; };

  // OUTBOUND: your casts (replies + mentions); also collect recent hashes for inbound
  const myHashes = [];
  for (const m of await tryPages(`/v1/castsByFid?fid=${MY_FID}&reverse=true`, 300)) {
    const b = m.data && m.data.castAddBody; if (!b) continue;
    if (m.hash) myHashes.push(m.hash);
    if (b.parentCastId && b.parentCastId.fid && b.parentCastId.fid !== MY_FID) { const e = ent(b.parentCastId.fid); e.outbound.replies++; touch(e, m.data.timestamp); }
    for (const mt of (b.mentions || [])) if (mt !== MY_FID) { const e = ent(mt); e.outbound.mentions++; touch(e, m.data.timestamp); }
  }
  // OUTBOUND reactions
  for (const [key, variants] of RTYPES)
    for (const m of await reactPages(`/v1/reactionsByFid?fid=${MY_FID}&reverse=true`, variants, 300)) {
      const tf = m.data && m.data.reactionBody && m.data.reactionBody.targetCastId && m.data.reactionBody.targetCastId.fid;
      if (!tf || tf === MY_FID) continue; const e = ent(tf); e.outbound[key]++; touch(e, m.data.timestamp);
    }
  // INBOUND: who engages your recent casts + mentions of you
  const recent = myHashes.slice(0, 10);
  await mapLimit(recent, 4, async (hash) => {
    for (const m of await tryPages(`/v1/castsByParent?fid=${MY_FID}&hash=${hash}`, 200)) {
      const af = m.data && m.data.fid; if (!af || af === MY_FID) continue; const e = ent(af); e.inbound.replies++; touch(e, m.data.timestamp);
    }
    for (const [key, variants] of RTYPES)
      for (const m of await reactPages(`/v1/reactionsByCast?target_fid=${MY_FID}&target_hash=${hash}`, variants, 300)) {
        const rf = m.data && m.data.fid; if (!rf || rf === MY_FID) continue; const e = ent(rf); e.inbound[key]++; touch(e, m.data.timestamp);
      }
  });
  for (const m of await tryPages(`/v1/castsByMention?fid=${MY_FID}&reverse=true`, 400)) {
    const af = m.data && m.data.fid; if (!af || af === MY_FID) continue; const e = ent(af); e.inbound.mentions++; touch(e, m.data.timestamp);
  }

  const sc = b => b.replies * 3 + b.recasts * 2 + b.mentions * 2 + b.likes, wt = v => sc(v.inbound) + sc(v.outbound);
  let arr = [...map.entries()].map(([f, v]) => ({ fid: f, handle: "fid:" + f, inbound: v.inbound, outbound: v.outbound,
      lastActiveMinutes: v.last ? Math.max(0, Math.round((nowS - v.last) / 60)) : 9999 }))
    .filter(p => wt(map.get(p.fid)) > 0 && !BANNED_FIDS.has(p.fid))
    .sort((a, b) => wt(map.get(b.fid)) - wt(map.get(a.fid))).slice(0, 34);
  if (!arr.length) throw new Error("no interactions");

  await mapLimit(arr, 6, async (p, k) => {
    try {
      const r = await fetchT(`${NODE}/v1/userDataByFid?fid=${p.fid}`);
      if (r.ok) { const j = await r.json();
        for (const m of (j.messages || [])) { const u = m.data && m.data.userDataBody; if (!u) continue;
          if ((u.type === "USER_DATA_TYPE_USERNAME" || u.type === 6) && u.value) p.handle = u.value;
          if ((u.type === "USER_DATA_TYPE_PFP" || u.type === 1) && u.value) p.pfp = u.value;
        } }
    } catch (e) {}
    // accurate last-seen for every tower (cheap now — this build is cached)
    try { const r = await fetchT(`${NODE}/v1/castsByFid?fid=${p.fid}&reverse=true&pageSize=1`);
      if (r.ok) { const j = await r.json(); const t = j.messages && j.messages[0] && j.messages[0].data && j.messages[0].data.timestamp;
        if (t) p.lastActiveMinutes = Math.max(0, Math.round((nowS - (t + FC_EPOCH)) / 60)); } } catch (e) {}
  });
  return arr.filter(p => !BANNED_HANDLES.has((p.handle || "").toLowerCase())).slice(0, 30);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const fid = Number(req.query && req.query.fid);
  if (!fid) { res.status(400).json({ error: "fid required" }); return; }
  const key = `city:${fid}`;

  const cached = await redis(["GET", key]);
  if (cached) { const p = JSON.parse(cached); res.setHeader("X-Cache", "hit"); res.status(200).json({ source: "live", people: p.people, me: p.me }); return; }

  try {
    rtIdx = -1;
    const [people, me] = await Promise.all([build(fid), resolveUser(fid)]);
    await redis(["SET", key, JSON.stringify({ people, me }), "EX", String(TTL)]);
    res.setHeader("X-Cache", "miss");
    res.status(200).json({ source: "live", people, me });
  } catch (e) {
    res.status(200).json({ source: "demo", people: [] });
  }
};