# Notion MCP Server — DeFlorance

Custom MCP (Model Context Protocol) server for Notion, built for multi-workspace operations. Deployed on Railway, consumed by Claude.ai and any MCP-compatible client.

**Version:** 2.1.0  
**Transport:** StreamableHTTP (`/mcp` endpoint)  
**Runtime:** Node.js 18+ / Express  
**API:** Notion Public API via `@notionhq/client`

## Workspaces

This server supports multiple Notion workspaces through a single deployment. Every tool accepts an optional `workspace` parameter.

| Alias | Purpose | Env Var | Default |
|-------|---------|---------|---------|
| `deflorance` | **Business** — DeFlorance e-commerce operations (NextGen Elite LLC). Product catalog, order management, SOPs, finance, customer service, ad tracking, supplier coordination. | `NOTION_TOKEN` | Yes |
| `paolo` | **Personal** — Paolo's personal Notion workspace. Notes, projects, personal knowledge base, non-business content. | `NOTION_TOKEN_PAOLO` | No |

**How workspace routing works:**
- Omit the `workspace` parameter entirely → defaults to `deflorance` (business)
- Pass `"workspace": "deflorance"` → explicit business workspace
- Pass `"workspace": "paolo"` → personal workspace
- Pass any unknown alias → error with list of available workspaces

Each workspace gets its own lazily-initialized Notion SDK client instance, cached after first use. Workspace tokens are completely isolated — a search in `paolo` never touches `deflorance` data and vice versa.

### Adding a New Workspace

1. Create a Notion integration at https://www.notion.so/profile/integrations for the target workspace
2. Add the alias and env var name to `WORKSPACE_REGISTRY` in `src/notion-client.js`:
   ```javascript
   const WORKSPACE_REGISTRY = {
     deflorance: 'NOTION_TOKEN',
     paolo: 'NOTION_TOKEN_PAOLO',
     newworkspace: 'NOTION_TOKEN_NEWWORKSPACE',  // add this
   };
   ```
3. Update the Zod enum in `src/server.js`:
   ```javascript
   const WORKSPACE_ENUM = z.enum(['deflorance', 'paolo', 'newworkspace']).optional()
   ```
4. Add the env var on Railway (Variables tab → New Variable)
5. Push to GitHub — Railway auto-deploys

## Tools (27)

All tools accept an optional `workspace` parameter unless noted.

### Search & Read

| # | Tool | Description |
|---|------|-------------|
| 1 | `search` | Search workspace for pages and databases by title/keyword. Supports `filter_type` (page/database), sort direction, pagination. |
| 2 | `fetch_page` | Retrieve a page with full content as Markdown. Handles headings, lists, tables, code blocks, images, toggles, callouts, nested content (3 levels). Accepts page ID or full Notion URL. |
| 3 | `fetch_database` | Get database schema and metadata: column names, types, select options, formula expressions, relation targets, rollup configs. |
| 4 | `query_database` | Query database rows with Notion API filters and sorts. Returns properties as formatted key-value pairs. Supports JSON string or object filters. |
| 5 | `fetch_block_children` | List child blocks of a page/block with pagination. Returns block type, content, and `has_children` flag. |
| 6 | `get_page_property` | Retrieve a specific property value with pagination. For large values: rich_text, relation, rollup, people. |

### Create

| # | Tool | Description |
|---|------|-------------|
| 7 | `create_page` | Create page in database or under parent page. Supports Markdown content (auto-converted to Notion blocks), properties, icon (emoji/URL), cover image. Chunks >100 blocks automatically. |
| 8 | `create_database` | Create database as child of a page. Define schema with property definitions. Default: `{"Name": {"title": {}}}`. |
| 9 | `create_comment` | Add comment to page or reply to discussion thread via `discussion_id`. |
| 10 | `create_two_way_relation` | Create bidirectional relation between two databases with synced properties. |

### Update

| # | Tool | Description |
|---|------|-------------|
| 11 | `update_page_properties` | Update any property on a page: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone, relation, people, files. |
| 12 | `update_page_content` | **Diff-based content editing.** Uses `oldStr`/`newStr` replacement on the page's Markdown representation. Supports multiple sequential updates, full replacement (omit `oldStr`), and `replaceAllMatches`. This is unique to our server — Anthropic's MCP doesn't have it. |
| 13 | `update_database` | Modify database title, description, or schema. Add/rename/change properties. |
| 14 | `update_block` | Update a specific block's content or properties. |

### Delete & Archive

| # | Tool | Description |
|---|------|-------------|
| 15 | `archive_pages` | Soft-delete pages (batch). Recoverable from Notion trash. |
| 16 | `unarchive_pages` | Restore archived pages (batch). |
| 17 | `delete_block` | Soft-delete a specific block. |
| 18 | `delete_databases` | Archive databases (batch). Databases are pages internally. |

### Move & Duplicate

| # | Tool | Description |
|---|------|-------------|
| 19 | `move_page` | Move page to new parent (page or database). |
| 20 | `duplicate_page` | Deep copy a page with content, icon, cover. Can target different parent. Content is round-tripped through Markdown. |

### Users & Comments

| # | Tool | Description |
|---|------|-------------|
| 21 | `get_users` | List all workspace users with IDs, names, emails, types, avatars. |
| 22 | `get_user` | Get details for a specific user by ID. |
| 23 | `get_comments` | List all comments on a page/block with discussion thread IDs. |

### Batch Operations

| # | Tool | Description |
|---|------|-------------|
| 24 | `batch_get_pages` | Fetch multiple pages in one call with full Markdown content. |
| 25 | `batch_get_databases` | Fetch multiple database schemas in one call. |

### Helpers

| # | Tool | Description |
|---|------|-------------|
| 26 | `build_property_value` | Convert simple values to Notion API property format. Maps `{type, value}` pairs to the nested structures Notion requires. Workspace-agnostic (pure transformation). |
| 27 | `append_content` | Append Markdown content to end of page without replacing existing content. Auto-chunks >100 blocks. |

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
│  27 MCP tool definitions (Zod schemas)       │
│  Routes workspace param to notion-client     │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│  notion-client.js                            │
│  WORKSPACE_REGISTRY → _getClient(workspace)  │
│  Lazy client instantiation + caching         │
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
│  richTextToMarkdown() — rich_text → inline MD│
└──────────────────────────────────────────────┘
```

### Session Management

Each MCP client gets a unique session (UUID). Sessions are stored in-memory and cleaned up on disconnect. The StreamableHTTP transport handles:

- `POST /mcp` — initialize, tool calls, notifications
- `GET /mcp` — SSE stream for server-initiated messages
- `DELETE /mcp` — explicit session teardown
- `GET /health` — health check (no session required)

### Content Conversion Pipeline

The server converts between Notion's block-based format and Markdown:

**Notion → Markdown** (`blocksToMarkdown`): Handles paragraph, heading_1/2/3, bulleted_list_item, numbered_list_item, to_do, toggle, quote, callout, code, divider, image, bookmark, embed, table, column_list, synced_block, link_to_page, child_page, child_database. Nested content up to 3 levels with indentation.

**Markdown → Notion** (`markdownToBlocks`): Parses `# headings`, `- lists`, `1. numbered`, `- [x] todos`, `> quotes`, `` ```code``` ``, `---`, `**bold**`, `*italic*`, `~~strikethrough~~`, `` `inline code` ``, `[links](url)`. Tables via pipe syntax.

## Comparison with Anthropic's Official Notion MCP

| Feature | Anthropic Official | This Server |
|---------|-------------------|-------------|
| API | Internal Notion API (private) | Public Notion API |
| Multi-workspace | No (single workspace per connector) | Yes — route by `workspace` param |
| Content format | Enhanced Notion Markdown (proprietary) | Standard Markdown (universal) |
| Content diffing | No — full replace only | Yes — `oldStr`/`newStr` targeted edits |
| Semantic search | Yes (AI search + connected sources) | No — title/keyword search only |
| Database views | Yes (create, update, query views with DSL) | No — schema + query only |
| Connected sources | Yes (Slack, Drive, GitHub, Jira, etc.) | No — Notion-only |
| Teamspace support | Yes | No |
| Meeting notes | Yes (dedicated tool) | No |
| Batch operations | No | Yes (batch_get_pages, batch_get_databases) |
| Block-level updates | Limited | Yes (update_block, delete_block) |
| Two-way relations | Unknown | Yes (create_two_way_relation) |
| Move/duplicate pages | Unknown | Yes |
| Build property values | No helper | Yes (build_property_value) |
| Self-hosted | No (Anthropic-managed) | Yes (Railway, any Node.js host) |
| Open source | No | Yes |

**When to use which:**
- Use **Anthropic's MCP** when you need semantic search, connected sources, or view management
- Use **this server** when you need multi-workspace routing, content diffing, batch operations, or full control over the deployment

## Deployment

### Railway (current)

- **Project:** Notion MCP (production environment)
- **Domain:** `notion-mcp-server-railway-production.up.railway.app`
- **Auto-deploy:** Pushes to `main` branch trigger automatic builds
- **Env vars:** NOTION_TOKEN, NOTION_TOKEN_PAOLO, PORT (auto-set by Railway)

### Manual / Other Hosts

```bash
git clone https://github.com/paolostf/notion-mcp-deflor.git
cd notion-mcp-deflor
npm install

# Set env vars
export NOTION_TOKEN="ntn_..."       # DeFlorance workspace
export NOTION_TOKEN_PAOLO="ntn_..." # Paolo personal workspace
export PORT=8080                    # Optional, defaults to 8080

npm start
```

### Connecting to Claude.ai

1. Go to Claude.ai Settings → Connected Apps → MCP Servers
2. Add custom connector with URL: `https://your-domain.up.railway.app/mcp`
3. Name it (e.g., "Notion (DeFlorance)")
4. If updating from a previous version: disconnect and reconnect to refresh the tool list

## API Reference

### MCP Protocol

All requests use JSON-RPC 2.0 over HTTP.

**Required headers:**
```
Content-Type: application/json
Accept: application/json, text/event-stream
Mcp-Session-Id: <session-uuid>  (after initialize)
```

**Initialize:**
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-03-26",
  "capabilities":{},
  "clientInfo":{"name":"my-client","version":"1.0"}
}}
```

**Call a tool:**
```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
  "name":"search",
  "arguments":{"query":"meeting notes","workspace":"paolo"}
}}
```

## File Structure

```
notion-mcp-deflor/
├── package.json          # Dependencies, start script
├── README.md             # This file
└── src/
    ├── http-server.js    # Express server, session management, health check
    ├── server.js         # 27 MCP tool definitions with Zod schemas
    ├── notion-client.js  # Multi-workspace Notion API client
    └── blocks.js         # Markdown ↔ Notion blocks conversion
```

## Changelog

- **2.1.0** — Multi-workspace support (deflorance + paolo), workspace param on all tools, update_block tool added
- **2.0.0** — Initial custom server with 26 tools, deployed on Railway, replaced Anthropic official connector
- **1.0.0** — Scaffolding
