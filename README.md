# @pipeworx/igdb

IGDB (Internet Game Database, Twitch/Amazon) — the reference catalogue for
~300,000 video games: release dates per platform, genres, ratings, developers,
publishers, franchises and cover art.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `igdb_search_games(query)` — search games by title, optionally scoped to a platform or a release window.
- `igdb_game(id | slug)` — one game in full, with per-platform release dates, DLC, expansions and similar titles.
- `igdb_companies(query)` — developers and publishers, with what they shipped.
- `igdb_platforms(query)` — the ~200 platforms, whose ids scope a game search.

## Auth

Platform key (`PLATFORM_TWITCH_KEY`) with BYO override via `_apiKey`.

**The credential is the same Twitch app the `twitch` pack uses** — IGDB is
gated by Twitch OAuth, so `_apiKey` is `"CLIENT_ID:CLIENT_SECRET"` and the pack
exchanges it for an app access token per call. No new gateway binding was added
for this pack; it declares the existing `PLATFORM_TWITCH_KEY`.

Callers who want their own rate budget get credentials free at
<https://dev.twitch.tv/console>.

## Data sources

- <https://id.twitch.tv/oauth2/token> — client-credentials grant.
- <https://api.igdb.com/v4/games>, `/companies`, `/platforms` — POST, Apicalypse body.

Notes the next person would otherwise rediscover:

- **The API is POST-only and the body is a DSL, not JSON.** `fields name,summary;
  search "zelda"; limit 10;` — every clause ends in a semicolon.
- **`fields` is mandatory and omitting it returns empty objects, not an error.**
  That is the silent-zero trap here; this pack always sends an explicit list.
- **`search` and `sort` cannot appear in the same query.** `search "x"` is
  relevance-ranked; `where name ~ *"x"*` is a sortable substring filter. The
  game and company tools use the first, `igdb_platforms` the second.
- `first_release_date` and `start_date` are **unix seconds**, not strings. Every
  date is also returned as an ISO day.
- Cover/logo `image_id` values become URLs as
  `https://images.igdb.com/igdb/image/upload/<size>/<image_id>.jpg`.
- IGDB game ids and Twitch game ids are the same id space, which is what makes
  this pack pair with `twitch`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "igdb": {
      "url": "https://gateway.pipeworx.io/igdb/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/igdb/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/igdb_search_games \
  -H 'Content-Type: application/json' \
  -d '{"query":"Breath of the Wild","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/igdb_search_games`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "igdb": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-igdb"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-igdb
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Igdb data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
