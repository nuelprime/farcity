# your farcaster city

A Farcaster mini app that renders the people you interact with as a living
isometric city. Building height = how much you interact; window lighting =
how recently they were active; reaction icons (replies, recasts, likes,
mentions) move through the streets.

## How to view it
Just open `index.html` in a browser (double-click, or drag it into Chrome).
It runs in **demo data** mode when opened directly. When it's launched
*inside* a Farcaster client, it reads the real viewer and flips to **live**.

## How it's wired
- `index.html` — the whole front end: the city renderer + the Farcaster
  mini app SDK connection. This is the only file that exists right now.
- Scoring lives in the `loadCity()` and `score()` functions near the top of
  the script. Default scope is **mutual** (inbound + outbound), with
  **inbound** / **outbound** toggles.

## Next step (the data layer)
Right now `loadCity()` returns fake people. Step 2 replaces it with real data:
- A small server route (e.g. `/api/city`) holds the Neynar key OR talks to a
  Farcaster Snapchain node, aggregates interactions per person, and returns
  them as JSON.
- The browser never sees the API key — it just calls `/api/city?fid=...`.

Expected shape per person the front end already understands:
```json
{
  "handle": "dwr",
  "fid": 3,
  "inbound":  { "replies": 22, "likes": 70, "recasts": 12, "mentions": 5 },
  "outbound": { "replies": 18, "likes": 40, "recasts": 8,  "mentions": 3 },
  "lastActiveMinutes": 8
}
```

## Deploying
This is a static site for now, so any static host works (Vercel, Netlify,
GitHub Pages). Vercel is the easy path and also supports the `/api` server
route we'll add in Step 2 — connect the repo and it auto-deploys on every push.
