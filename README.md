# Notion Unlocked

> **What Notion's API was supposed to be.**

Standard Notion MCP connectors — including Anthropic's official one — are handcuffed to a single workspace, can't do targeted edits (full page replace only), have zero batch capability, and give you no block-level control. They treat Notion as a read-mostly toy.

Notion Unlocked breaks through every one of those walls. Multi-workspace routing in a single deployment. Diff-based content editing that surgically replaces exactly what you specify. Batch operations that fetch 10 pages in one call instead of 10. Block-level CRUD. Two-way relation creation. Page duplication with deep copy. Property value builders that handle Notion's insane nested format for you.

This isn't a wrapper. It's what a Notion MCP server looks like when built by someone who actually uses Notion at scale.

**Version:** 2.4.0
**Transport:** StreamableHTTP (`/mcp` endpoint)
**Runtime:** Node.js 18+ / Express
**API:** Notion Public API via `@notionhq/client`

---

## Vision

The goal is a single MCP endpoint that gives any AI — Claude, GPT, Gemini, any agent — **complete programmatic mastery over Notion** across multiple workspaces, with zero friction and zero ambiguity. Every tool description is engineered so the AI knows exactly what to pass, what to expect back, and what to do when something goes wrong.

Standard connectors stop at "you can search and read pages." We stop when there's nothing left that requires opening the Notion app manually.

**Roadmap (beyond standard):**
- Database view creation and management (currently Anthropic-only via internal API)
- Webhook-based real-time sync (page change → trigger agent action)
- Cross-workspace page mirroring (duplicate + auto-sync)
- Template instantiation (create pre-configured page structures)
- Bulk property updates across database rows

---

## What This Does vs Standard

| Capability | Anthropic Official | Notion Unlocked |
|-----------|-------------------|-----------------|
| **Workspaces** | 1 per connector | **N workspaces, 1 deployment** — route with a param |
| **Content editing** | Full page replace only | **Diff-based** — `oldStr`/`newStr` surgical edits |
| **Batch ops** | None | **batch_get_pages, batch_get_databases** |
| **Block-level CRUD** | Limited | **update_block, delete_block** with full control |
| **Two-way relations** | Unknown | **create_two_way_relation** with synced properties |
| **Page operations** | Basic | **move_page, duplicate_page** (deep copy) |
| **Property helpers** | None | **build_property_value** — handles all 13 types |
| **Content append** | No | **append_content** — add without replacing |
| **Error handling** | Crashes session | **Clean JSON errors** with status codes |
| **Self-hosted** | Anthropic-managed | **Your infra, your rules** |
| **Open source** | No | **Yes** |
| Semantic search | Yes (internal API) | No — title/keyword only |
| Connected sources | Yes (Slack, Drive, GitHub) | No — Notion-only |
| Database views | Yes (internal DSL) | No — schema + query only |
| Teamspace support | Yes | No |

**Bottom line:** Anthropic's connector has semantic search and connected sources (powered by Notion's private internal API that third parties can't access). Everything else — multi-workspace, diffing, batch, block control, property helpers — is us.

---

## Workspaces

Single deployment, multiple completely isolated Notion workspaces. Every tool accepts an optional `workspace` parameter.

| Alias | Purpose | Env Var | Default |
|-------|---------|---------|---------|
| `deflorance` | **Business** — DeFlorance e-commerce (NextGen Elite LLC). Products, orders, SOPs, finance, customer service, ads, supplier, inventory, marketing. | `NOTION_TOKEN` | Yes |
| `paolo` | **Personal** — Paolo's personal workspace. Journals, Sentiment Tracker, biohacking, habit trackers, Routine Tracker, projects, knowledge base, Dubai Villa Tracker. | `NOTION_TOKEN_PAOLO` | No |

**Routing rules:**
- Omit `workspace` → defaults to `deflorance` (business)
- Pass `"workspace": "paolo"` → personal workspace
- Unknown alias → error with available list
- If search returns nothing → try the other workspace before giving up

Each workspace gets its own lazily-initialized Notion SDK client, cached after first use. Tokens are completely isolated — searches never cross workspace boundaries.

### Adding a New Workspace

1. Create a Notion integration at https://www.notion.so/profile/integrations
2. Add alias + env var to `WORKSPACE_REGISTRY` in `src/notion-client.js`:
   ```javascript
   newworkspace: 'NOTION_TOKEN_NEWWORKSPACE',
   ```
3. Add alias to the Zod enum in `src/server.js`
4. Add env var on Railway (Variables tab)
5. Push to GitHub — Railway auto-deploys

---

## Tools (27)

All tools accept an optional `workspace` parameter. Every handler is wrapped in `safeHandler()` — errors return clean JSON with `isError: true` instead of crashing the session.

### Search & Read

| # | Tool | What it does |
|---|------|-------------|
| 1 | `search` | Search workspace by title/keyword. Workspace routing rules, filter by type (page/database), sort, paginate. |
| 2 | `fetch_page` | Get full page content as Markdown. Handles all block types, 3-level nesting, properties, metadata. Accepts ID or URL. |
| 3 | `fetch_database` | Get database schema: column names, types, select options, formula expressions, relation targets, rollup configs. |
| 4 | `query_database` | Query database with Notion filters + sorts. Full filter format docs: select, text, number, checkbox, date, compound AND/OR. |
| 5 | `fetch_block_children` | List child blocks with pagination. Returns type, content, `has_children` flag. |
| 6 | `get_page_property` | Get a specific property value with pagination. For large: rich_text, relation, rollup, people. |

### Create

| # | Tool | What it does |
|---|------|-------------|
| 7 | `create_page` | Create page in database or under parent. Markdown content auto-converted, properties, icon, cover. Auto-chunks >100 blocks. |
| 8 | `create_database` | Create database as child of page. Full property type definitions for schema. |
| 9 | `create_comment` | Comment on page or reply to discussion thread. |
| 10 | `create_two_way_relation` | Bidirectional relation between two databases with synced property names. |

### Update

| # | Tool | What it does |
|---|------|-------------|
| 11 | `update_page_properties` | Update any property type: title, text, number, select, multi_select, status, date, checkbox, url, email, phone, relation, people, files. |
| 12 | `update_page_content` | **Diff-based editing.** `oldStr`/`newStr` on Markdown representation. Multiple sequential updates, full replace, `replaceAllMatches`. Not available in any standard connector. |
| 13 | `update_database` | Modify database title, description, or schema. Add/rename/change properties. |
| 14 | `update_block` | Update a specific block's content or properties directly. |

### Delete & Archive

| # | Tool | What it does |
|---|------|-------------|
| 15 | `archive_pages` | Batch soft-delete (recoverable from trash). |
| 16 | `unarchive_pages` | Batch restore archived pages. |
| 17 | `delete_block` | Soft-delete a specific block. |
| 18 | `delete_databases` | Batch archive databases. |

### Move & Duplicate

| # | Tool | What it does |
|---|------|-------------|
| 19 | `move_page` | Move page to new parent (page or database). |
| 20 | `duplicate_page` | Deep copy with content, icon, cover. Can target different parent. Content round-tripped through Markdown. |

### Users & Comments

| # | Tool | What it does |
|---|------|-------------|
| 21 | `get_users` | List all workspace users: IDs, names, emails, types, avatars. |
| 22 | `get_user` | Get specific user by ID. |
| 23 | `get_comments` | List comments on page/block with discussion thread IDs. |

### Batch Operations

| # | Tool | What it does |
|---|------|-------------|
| 24 | `batch_get_pages` | Fetch N pages in one call with full Markdown content. |
| 25 | `batch_get_databases` | Fetch N database schemas in one call. |

### Helpers

| # | Tool | What it does |
|---|------|-------------|
| 26 | `build_property_value` | Convert simple values to Notion's nested API format. Handles all 13 property types. |
| 27 | `append_content` | Append Markdown to end of page without replacing existing content. Auto-chunks >100 blocks. |

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Claude.ai / Any MCP Client                  │
│  (sends workspace param per tool call)       │
└──────────────┬───────────────────────────────┘
               │ HTTP POST /mcp
               │ StreamableHTTP transport
┌──────────────▼───────────────────────────────┐
│  http-server.js                              │
│  Express + session management                │
│  POST /mcp  GET /mcp (SSE)  DELETE /mcp      │
│  GET /health                                 │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│  server.js                                   │
│  27 tool definitions (Zod schemas)           │
│  safeHandler() error wrapping                │
│  Routes workspace param to notion-client     │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│  notion-client.js                            │
│  WORKSPACE_REGISTRY → _getClient(workspace)  │
│  Lazy client init + caching per workspace    │
│  27 public methods + _getAllBlocks helper     │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│  blocks.js                                   │
│  blocksToMarkdown() — Notion blocks → MD     │
│  markdownToBlocks() — MD → Notion blocks     │
│  formatProperties() — props → key-value      │
│  formatDatabaseSchema() — schema → readable  │
│  buildPropertyValue() — simple → Notion API  │
│  richTextToMarkdown() — rich_text → inline   │
└──────────────────────────────────────────────┘
```

### Session Management

Each MCP client gets a UUID session stored in-memory. Cleaned up on disconnect. StreamableHTTP transport handles: `POST /mcp` (initialize, tool calls), `GET /mcp` (SSE stream), `DELETE /mcp` (session teardown), `GET /health` (no session).

### Content Conversion

**Read (Notion → Markdown):** paragraph, headings, lists, todos, toggles, quotes, callouts, code, dividers, images, bookmarks, embeds, tables, columns, synced blocks, child pages/databases. Nested content up to 3 levels.

**Write (Markdown → Notion):** `# headings`, `- lists`, `1. numbered`, `- [x] todos`, `> quotes`, ` ```code``` `, `---`, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[links](url)`, pipe tables.

---

## Deployment

### Railway (current)

- **Domain:** `notion-mcp-server-railway-production.up.railway.app`
- **Auto-deploy:** Push to `main` → Railway builds and deploys
- **Env vars:** `NOTION_TOKEN`, `NOTION_TOKEN_PAOLO`, `PORT` (auto-set)

### Manual

```bash
git clone https://github.com/paolostf/notion-mcp-deflor.git
cd notion-mcp-deflor
npm install

export NOTION_TOKEN="ntn_..."
export NOTION_TOKEN_PAOLO="ntn_..."
npm start
```

### Connect to Claude.ai

1. Settings → Connected Apps → MCP Servers
2. Add custom connector: `https://your-domain.up.railway.app/mcp`
3. Name: "Notion Unlocked"
4. To refresh tool descriptions after update: disconnect and reconnect

---

## API

JSON-RPC 2.0 over HTTP.

```
Content-Type: application/json
Accept: application/json, text/event-stream
Mcp-Session-Id: <uuid>  (after initialize)
```

**Initialize:** `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"client","version":"1.0"}}}`

**Call tool:** `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"Sentiment Tracker","workspace":"paolo"}}}`

---

## File Structure

```
notion-mcp-deflor/
├── package.json          # Dependencies, start script
├── README.md             # This file
└── src/
    ├── http-server.js    # Express, sessions, health check
    ├── server.js         # 27 MCP tools with Zod schemas + safeHandler
    ├── notion-client.js  # Multi-workspace Notion API client
    └── blocks.js         # Markdown ↔ Notion blocks conversion
```

## Changelog

- **2.4.0** — Rebrand to Notion Unlocked. Vision statement, enhanced health endpoint with capabilities.
- **2.3.0** — Production-grade tool descriptions matching Anthropic MCP quality. `<example>` blocks, behavioral routing, cross-tool workflows, full property/filter documentation on all 27 tools.
- **2.2.0** — `safeHandler()` try/catch on all handlers, WORKSPACE_ENUM rewrite with routing rules and content listings.
- **2.1.0** — Multi-workspace support (deflorance + paolo), workspace param on all tools, update_block tool.
- **2.0.0** — Initial custom server, 26 tools, Railway deploy, replaced Anthropic connector.
- **1.0.0** — Scaffolding.
