// server.js — Notion Unlocked: MCP server that breaks through Notion's standard API ceiling
// v2.4.0 — 27 tools, multi-workspace, diff-based editing, batch ops, block-level control

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notionClient } from './notion-client.js';
import { markdownToBlocks, buildPropertyValue } from './blocks.js';

// ============================================================
// WORKSPACE ROUTING — READ THIS FIRST
// ============================================================
//
// This server connects to TWO completely isolated Notion workspaces
// via separate API tokens. Every tool accepts an optional "workspace"
// parameter to select which workspace to operate on.
//
// ┌─────────────────────────────────────────────────────────────┐
// │ WORKSPACE: "deflorance" (DEFAULT — omit or pass explicitly) │
// │ Owner: NextGen Elite LLC / Paolo                            │
// │ Content: DeFlorance e-commerce business                     │
// │   • Product catalog, inventory, SKUs                        │
// │   • Orders, fulfillment, supplier coordination              │
// │   • SOPs, processes, team documentation                     │
// │   • Finance tracking, invoices, P&L                         │
// │   • Customer service (Gorgias integration)                  │
// │   • Meta Ads campaigns, creatives, analytics                │
// │   • Marketing, email sequences, landing pages               │
// ├─────────────────────────────────────────────────────────────┤
// │ WORKSPACE: "paolo"                                          │
// │ Owner: Paolo (personal)                                     │
// │ Content: Personal life management                           │
// │   • Journals, daily notes, reflections                      │
// │   • Sentiment Tracker (mood/energy/discipline tracking)     │
// │   • Biohacking protocols, health data                       │
// │   • Personal projects, goals, habit trackers                │
// │   • Knowledge base, learning notes                          │
// │   • Routine Tracker, Punishments Tracker                    │
// │   • Dubai Villa Tracker, personal finance                   │
// └─────────────────────────────────────────────────────────────┘
//
// ROUTING RULES:
// 1. Business/DeFlorance content → omit workspace (defaults to "deflorance")
// 2. Personal content (journals, trackers, habits, health) → workspace: "paolo"
// 3. If search returns empty → TRY THE OTHER WORKSPACE before giving up
// 4. When unsure → search BOTH workspaces
// ============================================================

const WORKSPACE_ENUM = z.enum(['deflorance', 'paolo']).optional().describe(
  'Which Notion workspace to operate on. REQUIRED for correct routing.\n\n' +
  'Available workspaces:\n' +
  '• "deflorance" (DEFAULT if omitted) — DeFlorance e-commerce business. ' +
  'Contains: products, orders, SOPs, finance, customer service, ads, supplier coordination, inventory, marketing.\n' +
  '• "paolo" — Paolo\'s personal workspace. ' +
  'Contains: journals, Sentiment Tracker, biohacking protocols, habit trackers, Routine Tracker, personal projects, knowledge base, Dubai Villa Tracker.\n\n' +
  'IMPORTANT: If a search returns no results, try the other workspace before reporting "not found". ' +
  'Personal content (journals, mood, habits, health, personal trackers) is ALWAYS in "paolo". ' +
  'Business content (products, orders, ads, SOPs) is ALWAYS in "deflorance".'
);

/** Wrap a tool handler with try/catch for clean error reporting */
function safeHandler(fn) {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      const msg = error?.body?.message || error?.message || String(error);
      const code = error?.status || error?.code || 'UNKNOWN';
      return {
        content: [{
          type: 'text',
          text: `Error (${code}): ${msg}`,
        }],
        isError: true,
      };
    }
  };
}

export function createServer() {
  const server = new McpServer({
    name: 'notion-unlocked',
    version: '2.4.0',
  });

  // ============================================================
  // 1. SEARCH
  // ============================================================

  server.tool(
    'search',
    `Search a Notion workspace for pages and databases by title or keyword.
Returns matching items with id, title, url, object type, last_edited timestamp, and parent info.

## Workspace Routing (CRITICAL)
This server has TWO isolated workspaces with separate content:
• "deflorance" (DEFAULT) — DeFlorance e-commerce business (products, orders, SOPs, finance, ads, supplier, inventory, marketing)
• "paolo" — Paolo's personal workspace (journals, Sentiment Tracker, biohacking, habit trackers, Routine Tracker, personal projects, knowledge base)

SET workspace PARAMETER based on what the user is looking for:
- Business content → omit workspace or use "deflorance"
- Personal content (trackers, journals, habits, health) → use "paolo"
- If ZERO results → ALWAYS retry with the OTHER workspace before telling the user "not found"
- If unsure which workspace → search BOTH (two separate calls)

## Usage
Use filter_type to narrow results to "page" or "database" only. Results are sorted by relevance by default; use sort_direction to sort by last_edited_time instead.

<example description="Search business workspace for product catalog">
{"query": "Product Catalog", "filter_type": "database"}
</example>
<example description="Search personal workspace for sentiment tracker">
{"query": "sentiment tracker", "workspace": "paolo"}
</example>
<example description="Search personal workspace for all databases">
{"query": "", "filter_type": "database", "page_size": 100, "workspace": "paolo"}
</example>
<example description="Search business workspace sorted by recent edits">
{"query": "SOP", "sort_direction": "descending"}
</example>`,
    {
      query: z.string().describe('Search query — matches against page and database titles. Use broad terms for discovery. Empty string returns recent items.'),
      filter_type: z.enum(['page', 'database']).optional().describe('Restrict results to "page" or "database" only. Omit to return both.'),
      sort_direction: z.enum(['ascending', 'descending']).optional().describe('Sort by last_edited_time. Omit for relevance-based sorting.'),
      page_size: z.number().min(1).max(100).optional().describe('Number of results to return (default: 10, max: 100). Use 100 for exhaustive listing.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ query, filter_type, sort_direction, page_size, workspace }) => {
      const result = await notionClient.search(query, { filter_type, sort_direction, page_size, workspace });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    })
  );

  // ============================================================
  // 2. FETCH PAGE
  // ============================================================

  server.tool(
    'fetch_page',
    `Retrieve a Notion page with full metadata and content converted to Markdown.
Returns: title, icon, cover, URL, timestamps, all properties (formatted as key-value pairs), and the complete page body as Markdown.

## Content Support
The Markdown output includes: headings (h1-h3), bullet lists, numbered lists, to-do lists, quotes, callouts, code blocks (with language), tables, images (as URLs), bookmarks, dividers, toggles, and nested content up to 3 levels deep.

## When to Use
- Use BEFORE update_page_content to see current content for oldStr matching
- Use BEFORE create_page in a database to understand the parent database schema
- Use to read any page's full content and properties

## Input
Accepts either a page UUID (with or without dashes) or a full Notion URL. The tool auto-extracts the ID from URLs.

<example description="Fetch by page ID">
{"page_id": "2740a71f-491a-8016-894b-c48206d0c7a8", "workspace": "paolo"}
</example>
<example description="Fetch by Notion URL">
{"page_id": "https://www.notion.so/My-Page-2740a71f491a8016894bc48206d0c7a8"}
</example>`,
    {
      page_id: z.string().describe('Notion page ID (UUID with or without dashes) or full Notion URL. The ID is auto-extracted from URLs.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_id, workspace }) => {
      const page = await notionClient.fetchPage(page_id, { workspace });
      const lines = [];
      lines.push(`# ${page.title}`);
      lines.push('');
      if (page.icon) lines.push(`Icon: ${page.icon}`);
      if (page.cover) lines.push(`Cover: ${page.cover}`);
      lines.push(`URL: ${page.url}`);
      lines.push(`Created: ${page.created_time}`);
      lines.push(`Last edited: ${page.last_edited_time}`);
      lines.push('');

      const propEntries = Object.entries(page.properties || {});
      if (propEntries.length > 0) {
        lines.push('## Properties');
        lines.push('');
        for (const [key, value] of propEntries) {
          const display = Array.isArray(value) ? value.join(', ') : String(value ?? '');
          lines.push(`- **${key}**: ${display}`);
        }
        lines.push('');
      }

      if (page.content) {
        lines.push('## Content');
        lines.push('');
        lines.push(page.content);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    })
  );

  // ============================================================
  // 3. CREATE PAGE
  // ============================================================

  server.tool(
    'create_page',
    `Create a new Notion page inside a database or under a parent page.

## Parent Types
- Database parent: set is_database=true. The page becomes a row in that database. Properties must match the database schema.
- Page parent: set is_database=false (default). The page becomes a subpage.

## Properties
Properties use Notion API format. For database rows, property names must exactly match the database schema (use fetch_database first to get the schema).
For simple cases, use the "title" shorthand instead of the full properties object.

## Content
Pass content_markdown for the page body. Supported Markdown:
# h1, ## h2, ### h3, **bold**, *italic*, [link](url), \`code\`,
- bullet list, 1. numbered list, - [ ] todo, - [x] done,
> quote, \`\`\`code block\`\`\`, --- divider

Content exceeding 100 blocks is automatically chunked into multiple API calls.

<example description="Simple page under a parent page">
{"parent_id": "abc123", "title": "Meeting Notes", "content_markdown": "# Agenda\\n- Item 1\\n- Item 2"}
</example>
<example description="Database row with properties">
{"parent_id": "db-uuid", "is_database": true, "properties": {"Name": {"title": [{"text": {"content": "New Task"}}]}, "Status": {"select": {"name": "Active"}}}}
</example>
<example description="Page with icon and cover">
{"parent_id": "abc123", "title": "Project Plan", "icon": "🚀", "cover": "https://example.com/image.jpg", "content_markdown": "# Overview\\nProject details here."}
</example>
<example description="Create in personal workspace">
{"parent_id": "page-uuid", "title": "New Journal Entry", "workspace": "paolo"}
</example>`,
    {
      parent_id: z.string().describe('Parent page ID or database ID (UUID or full Notion URL)'),
      is_database: z.boolean().optional().describe('Set true if parent_id is a database. The page will be created as a database row. Default: false (subpage).'),
      title: z.string().optional().describe('Page title shorthand — auto-sets the title property. Use this OR properties.title, not both.'),
      properties: z.record(z.any()).optional().describe(
        'Notion API properties object for database rows. Property names must match the database schema exactly. ' +
        'Example: {"Name": {"title": [{"text": {"content": "My Page"}}]}, "Status": {"select": {"name": "Active"}}, "Priority": {"number": 1}}'
      ),
      content_markdown: z.string().optional().describe('Page body in Markdown. Auto-converted to Notion blocks. Supports headings, lists, todos, quotes, code blocks, dividers, bold, italic, links.'),
      icon: z.string().optional().describe('Page icon — emoji character (e.g. "🚀") or external image URL'),
      cover: z.string().optional().describe('Cover image — external URL'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ parent_id, is_database, title, properties, content_markdown, icon, cover, workspace }) => {
      let props = properties || {};
      if (title && !properties) {
        props = { title: { title: [{ type: 'text', text: { content: title } }] } };
      } else if (title && properties && !properties.title && !properties.Name) {
        props.title = { title: [{ type: 'text', text: { content: title } }] };
      }

      const content = content_markdown ? markdownToBlocks(content_markdown) : undefined;

      const result = await notionClient.createPage(parent_id, {
        properties: props,
        content,
        icon,
        cover,
        is_database,
        workspace,
      });

      return {
        content: [{
          type: 'text',
          text: `Page created.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    })
  );

  // ============================================================
  // 4. UPDATE PAGE PROPERTIES
  // ============================================================

  server.tool(
    'update_page_properties',
    `Update properties on an existing Notion page or database row. Only the specified properties are changed; omitted properties remain unchanged.

## Prerequisites
Use fetch_page or fetch_database FIRST to get the exact property names and types from the database schema.

## Property Format
Properties use Notion API format. Common patterns:
- Title: {"Name": {"title": [{"text": {"content": "New Title"}}]}}
- Select: {"Status": {"select": {"name": "Done"}}}
- Multi-select: {"Tags": {"multi_select": [{"name": "urgent"}, {"name": "bug"}]}}
- Number: {"Priority": {"number": 1}}
- Checkbox: {"Complete": {"checkbox": true}}
- Date: {"Due": {"date": {"start": "2026-04-15", "end": "2026-04-20"}}}
- URL: {"Link": {"url": "https://example.com"}}
- Rich text: {"Notes": {"rich_text": [{"text": {"content": "Some notes"}}]}}
- Relation: {"Project": {"relation": [{"id": "page-uuid-1"}, {"id": "page-uuid-2"}]}}

Use the build_property_value helper tool to construct these from simple values.

<example description="Update status and priority">
{"page_id": "abc123", "properties": {"Status": {"select": {"name": "Done"}}, "Priority": {"number": 1}}}
</example>
<example description="Update in personal workspace">
{"page_id": "abc123", "properties": {"Mood": {"select": {"name": "Great"}}}, "workspace": "paolo"}
</example>`,
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      properties: z.record(z.any()).describe('Properties to update in Notion API format. Only included properties are changed. Use fetch_database to get exact property names and types.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_id, properties, workspace }) => {
      const result = await notionClient.updatePageProperties(page_id, properties, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Page updated.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    })
  );

  // ============================================================
  // 5. UPDATE PAGE CONTENT (oldStr/newStr diffing)
  // ============================================================

  server.tool(
    'update_page_content',
    `Update the body content of a Notion page using targeted text replacement (diff-based editing).

## How It Works
1. Fetches all page blocks and converts them to Markdown
2. Performs oldStr → newStr text replacement on the Markdown
3. Deletes all existing blocks and recreates from the modified Markdown

## Prerequisites
ALWAYS use fetch_page FIRST to get the current page content. You need the exact text for oldStr matching.

## Modes
- **Targeted replacement**: Provide oldStr (text to find) and newStr (replacement). Only the matched portion changes.
- **Full replacement**: Omit oldStr, provide only newStr. The ENTIRE page content is replaced.
- **Multiple updates**: Pass an array of updates — they are applied sequentially.

## Important
- oldStr must EXACTLY match a substring of the page's Markdown content (case-sensitive)
- If oldStr is not found, the tool returns an error
- Both oldStr and newStr use Markdown format

<example description="Replace a specific paragraph">
{"page_id": "abc123", "updates": [{"oldStr": "The old paragraph text here.", "newStr": "The new updated paragraph."}]}
</example>
<example description="Replace all page content">
{"page_id": "abc123", "updates": [{"newStr": "# New Page Title\\n\\nCompletely new content."}]}
</example>
<example description="Multiple targeted edits">
{"page_id": "abc123", "updates": [{"oldStr": "Draft", "newStr": "Final"}, {"oldStr": "TODO: review", "newStr": "Reviewed on 2026-04-09"}]}
</example>
<example description="Replace all occurrences">
{"page_id": "abc123", "updates": [{"oldStr": "old-url.com", "newStr": "new-url.com", "replaceAllMatches": true}]}
</example>`,
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      updates: z.array(z.object({
        oldStr: z.string().optional().describe('Exact text to find in the page Markdown. Case-sensitive. Omit to replace ALL page content.'),
        newStr: z.string().describe('Replacement text in Markdown. If oldStr is omitted, this becomes the entire page content.'),
        replaceAllMatches: z.boolean().optional().describe('If true, replaces ALL occurrences of oldStr. Default: false (first match only).'),
      })).describe('Array of content updates applied sequentially. Each update has oldStr (find) and newStr (replace).'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_id, updates, workspace }) => {
      const result = await notionClient.updatePageContent(page_id, updates, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Page content updated.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    })
  );

  // ============================================================
  // 6. ARCHIVE PAGES
  // ============================================================

  server.tool(
    'archive_pages',
    `Archive (soft-delete) one or more Notion pages. Archived pages move to the workspace trash and can be restored from there. This does NOT permanently delete pages.

<example description="Archive a single page">
{"page_ids": ["abc123-uuid"]}
</example>
<example description="Archive multiple pages">
{"page_ids": ["uuid-1", "uuid-2", "uuid-3"]}
</example>`,
    {
      page_ids: z.array(z.string()).describe('Array of page IDs (UUIDs) to archive. Each ID can be with or without dashes.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_ids, workspace }) => {
      const result = await notionClient.archivePages(page_ids, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Archived ${result.archived.length} page(s): ${result.archived.join(', ')}`,
        }],
      };
    })
  );

  // ============================================================
  // 7. UNARCHIVE PAGES
  // ============================================================

  server.tool(
    'unarchive_pages',
    `Restore previously archived Notion pages from trash. The pages return to their original location in the workspace.

<example>{"page_ids": ["abc123-uuid"]}</example>`,
    {
      page_ids: z.array(z.string()).describe('Array of page IDs (UUIDs) to restore from trash'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_ids, workspace }) => {
      const result = await notionClient.unarchivePages(page_ids, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Unarchived ${result.unarchived.length} page(s): ${result.unarchived.join(', ')}`,
        }],
      };
    })
  );

  // ============================================================
  // 8. DELETE BLOCK
  // ============================================================

  server.tool(
    'delete_block',
    `Delete (archive) a specific block from a Notion page. The block is soft-deleted and can be recovered from Notion's trash.
Use fetch_block_children first to get block IDs for the target page.

<example>{"block_id": "block-uuid-here"}</example>`,
    {
      block_id: z.string().describe('Block ID to delete (UUID). Get block IDs from fetch_block_children.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ block_id, workspace }) => {
      const result = await notionClient.deleteBlock(block_id, { workspace });
      return { content: [{ type: 'text', text: `Block deleted: ${result.deleted}` }] };
    })
  );

  // ============================================================
  // 9. FETCH DATABASE
  // ============================================================

  server.tool(
    'fetch_database',
    `Retrieve a Notion database's schema and metadata. Returns the complete structure: title, description, icon, timestamps, and all column definitions (property names, types, select/multi-select options, formula expressions, relation targets, rollup configs, number formats).

## When to Use
- BEFORE creating pages in a database — to get exact property names and types
- BEFORE querying a database — to understand available filter/sort properties
- BEFORE updating a database schema — to see current columns
- To discover what data a database contains

## Output
Returns a structured Markdown document with:
- Database title, URL, icon, timestamps
- Full schema listing every property with its type and configuration

<example description="Fetch business database">
{"database_id": "abc123-uuid"}
</example>
<example description="Fetch personal database by URL">
{"database_id": "https://www.notion.so/2740a71f491a8016894bc48206d0c7a8", "workspace": "paolo"}
</example>
<example description="Fetch Sentiment Tracker schema">
{"database_id": "2740a71f-491a-8016-894b-c48206d0c7a8", "workspace": "paolo"}
</example>`,
    {
      database_id: z.string().describe('Notion database ID (UUID with or without dashes) or full Notion URL. Auto-extracts ID from URLs.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ database_id, workspace }) => {
      const db = await notionClient.fetchDatabase(database_id, { workspace });
      const lines = [];
      lines.push(`# Database: ${db.title}`);
      lines.push('');
      if (db.description) lines.push(`Description: ${db.description}`);
      lines.push(`URL: ${db.url}`);
      if (db.icon) lines.push(`Icon: ${db.icon}`);
      lines.push(`Inline: ${db.is_inline}`);
      lines.push(`Created: ${db.created_time}`);
      lines.push(`Last edited: ${db.last_edited_time}`);
      lines.push('');
      lines.push('## Schema');
      lines.push('');
      for (const [name, def] of Object.entries(db.schema || {})) {
        let desc = `- **${name}** (${def.type})`;
        if (def.options) desc += `: ${def.options.join(', ')}`;
        if (def.format) desc += ` [format: ${def.format}]`;
        if (def.expression) desc += ` [formula: ${def.expression}]`;
        if (def.database_id) desc += ` [-> db: ${def.database_id}]`;
        if (def.relation_property) desc += ` [rollup: ${def.relation_property} -> ${def.rollup_property} (${def.function})]`;
        if (def.groups) desc += ` [groups: ${def.groups.map(g => g.name).join(', ')}]`;
        lines.push(desc);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    })
  );

  // ============================================================
  // 10. QUERY DATABASE
  // ============================================================

  server.tool(
    'query_database',
    `Query a Notion database to retrieve rows matching filter and sort criteria. Returns paginated results with all properties formatted as key-value pairs.

## Prerequisites
Use fetch_database FIRST to get the schema — you need exact property names and types for filters and sorts.

## Filters
Filters use the Notion API filter format. Common patterns:
- Select equals: {"property": "Status", "select": {"equals": "Active"}}
- Text contains: {"property": "Name", "rich_text": {"contains": "keyword"}}
- Number greater than: {"property": "Priority", "number": {"greater_than": 3}}
- Checkbox is true: {"property": "Done", "checkbox": {"equals": true}}
- Date after: {"property": "Due", "date": {"after": "2026-04-01"}}
- Compound AND: {"and": [filter1, filter2]}
- Compound OR: {"or": [filter1, filter2]}

Filters can be passed as JSON objects or JSON strings (auto-parsed).

## Sorts
Sort array format: [{"property": "Date", "direction": "descending"}]
Multiple sorts are applied in order (first sort is primary).

## Pagination
Returns up to page_size rows (default 20, max 100). If has_more is true, use start_cursor from the response to get the next page.

<example description="All rows, no filter">
{"database_id": "db-uuid"}
</example>
<example description="Filter by status">
{"database_id": "db-uuid", "filter": {"property": "Status", "select": {"equals": "Active"}}}
</example>
<example description="Sort by date descending, get 50 rows">
{"database_id": "db-uuid", "sorts": [{"property": "Created", "direction": "descending"}], "page_size": 50}
</example>
<example description="Compound filter (AND)">
{"database_id": "db-uuid", "filter": {"and": [{"property": "Status", "select": {"equals": "Active"}}, {"property": "Priority", "number": {"greater_than": 2}}]}}
</example>
<example description="Query personal Sentiment Tracker">
{"database_id": "2740a71f-491a-8016-894b-c48206d0c7a8", "sorts": [{"property": "Date", "direction": "descending"}], "page_size": 7, "workspace": "paolo"}
</example>`,
    {
      database_id: z.string().describe('Notion database ID (UUID) or full Notion URL'),
      filter: z.union([z.string(), z.record(z.any())]).optional().describe('Notion API filter object or JSON string. Use fetch_database first to get property names. See examples in tool description.'),
      sorts: z.union([z.string(), z.array(z.any())]).optional().describe('Sort array or JSON string. Format: [{"property": "Name", "direction": "ascending"|"descending"}]'),
      page_size: z.number().min(1).max(100).optional().describe('Rows per page (default: 20, max: 100)'),
      start_cursor: z.string().optional().describe('Pagination cursor from previous query response (next_cursor field)'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ database_id, filter, sorts, page_size, start_cursor, workspace }) => {
      const result = await notionClient.queryDatabase(database_id, { filter, sorts, page_size, start_cursor, workspace });

      const lines = [];
      lines.push(`Results: ${result.results.length} rows${result.has_more ? ` (more available, cursor: ${result.next_cursor})` : ''}`);
      lines.push('');

      for (const row of result.results) {
        lines.push(`---`);
        lines.push(`ID: ${row.id}`);
        lines.push(`URL: ${row.url}`);
        for (const [key, value] of Object.entries(row.properties || {})) {
          const display = Array.isArray(value) ? value.join(', ') : String(value ?? '');
          lines.push(`  ${key}: ${display}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    })
  );

  // ============================================================
  // 11. CREATE DATABASE
  // ============================================================

  server.tool(
    'create_database',
    `Create a new Notion database as a child of a page. Define the schema with property (column) definitions.

## Schema Format
Properties use Notion API type definitions. At minimum, include a title property: {"Name": {"title": {}}}.

Common property types:
- Title: {"Name": {"title": {}}}
- Rich text: {"Description": {"rich_text": {}}}
- Select: {"Status": {"select": {"options": [{"name": "Active", "color": "green"}, {"name": "Done", "color": "gray"}]}}}
- Multi-select: {"Tags": {"multi_select": {"options": [{"name": "urgent"}, {"name": "bug"}]}}}
- Number: {"Priority": {"number": {"format": "number"}}}
- Date: {"Due Date": {"date": {}}}
- Checkbox: {"Complete": {"checkbox": {}}}
- URL: {"Link": {"url": {}}}
- Email: {"Contact": {"email": {}}}
- Phone: {"Phone": {"phone_number": {}}}
- Relation: {"Project": {"relation": {"database_id": "target-db-uuid"}}}

<example description="Simple task database">
{"parent_page_id": "page-uuid", "title": "Tasks", "properties": {"Name": {"title": {}}, "Status": {"select": {"options": [{"name": "To Do"}, {"name": "In Progress"}, {"name": "Done"}]}}, "Due": {"date": {}}}, "icon": "📋"}
</example>`,
    {
      parent_page_id: z.string().describe('Parent page ID (UUID or Notion URL) where the database will be created as an inline child'),
      title: z.string().describe('Database title displayed at the top'),
      properties: z.record(z.any()).optional().describe('Schema definition — map of property name to Notion type config. Default: {"Name": {"title": {}}}'),
      icon: z.string().optional().describe('Emoji character or external image URL for the database icon'),
      description: z.string().optional().describe('Database description shown below the title'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ parent_page_id, title, properties, icon, description, workspace }) => {
      const result = await notionClient.createDatabase(parent_page_id, { title, properties, icon, description, workspace });
      return {
        content: [{
          type: 'text',
          text: `Database created.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    })
  );

  // ============================================================
  // 12. UPDATE DATABASE
  // ============================================================

  server.tool(
    'update_database',
    `Update a Notion database's title, description, or schema. Add new columns, rename existing ones, or modify column options. Properties not included in the update are left unchanged.

## Prerequisites
Use fetch_database first to see the current schema before making changes.

<example description="Add a new column">
{"database_id": "db-uuid", "properties": {"Priority": {"number": {"format": "number"}}}}
</example>
<example description="Rename database">
{"database_id": "db-uuid", "title": "Project Tracker v2"}
</example>
<example description="Add select options">
{"database_id": "db-uuid", "properties": {"Status": {"select": {"options": [{"name": "Blocked", "color": "red"}]}}}}
</example>`,
    {
      database_id: z.string().describe('Notion database ID (UUID) or full Notion URL'),
      title: z.string().optional().describe('New database title'),
      properties: z.record(z.any()).optional().describe('Schema updates — only included properties are added/modified. Existing properties not listed are unchanged.'),
      description: z.string().optional().describe('New database description'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ database_id, title, properties, description, workspace }) => {
      const result = await notionClient.updateDatabase(database_id, { title, properties, description, workspace });
      return {
        content: [{
          type: 'text',
          text: `Database updated.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    })
  );

  // ============================================================
  // 13. DELETE DATABASES
  // ============================================================

  server.tool(
    'delete_databases',
    `Archive (soft-delete) one or more Notion databases. Databases are technically pages in Notion, so archiving moves them to trash. They can be restored with unarchive_pages.

<example>{"database_ids": ["db-uuid-1", "db-uuid-2"]}</example>`,
    {
      database_ids: z.array(z.string()).describe('Array of database IDs (UUIDs) to archive'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ database_ids, workspace }) => {
      const result = await notionClient.deleteDatabases(database_ids, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Archived ${result.archived.length} database(s): ${result.archived.join(', ')}`,
        }],
      };
    })
  );

  // ============================================================
  // 14. CREATE TWO-WAY RELATION
  // ============================================================

  server.tool(
    'create_two_way_relation',
    `Create a bidirectional (two-way) relation between two Notion databases. This creates a relation property on the source database AND automatically creates a synced relation property on the target database.

Use this when you need pages in two databases to reference each other (e.g., Projects ↔ Tasks, Clients ↔ Orders).

<example description="Link Projects to Tasks">
{"source_database_id": "projects-db-uuid", "target_database_id": "tasks-db-uuid", "source_property_name": "Tasks", "target_property_name": "Project"}
</example>`,
    {
      source_database_id: z.string().describe('Source database ID (UUID) — where the relation property is created'),
      target_database_id: z.string().describe('Target database ID (UUID) — the related database'),
      source_property_name: z.string().describe('Name for the relation column in the source database (e.g., "Tasks")'),
      target_property_name: z.string().describe('Name for the auto-created synced column in the target database (e.g., "Project")'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ source_database_id, target_database_id, source_property_name, target_property_name, workspace }) => {
      const result = await notionClient.createTwoWayRelation(source_database_id, target_database_id, source_property_name, target_property_name, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Two-way relation created.\nSource DB: ${result.source_database_id} (property: ${result.source_property})\nTarget DB: ${result.target_database_id} (property: ${result.target_property})`,
        }],
      };
    })
  );

  // ============================================================
  // 15. GET PAGE PROPERTY (paginated)
  // ============================================================

  server.tool(
    'get_page_property',
    `Retrieve a specific property value from a Notion page with pagination support. Use this for properties that may contain large or paginated data: rich_text, relation, rollup, people.

For most cases, fetch_page returns all properties already. Use this tool only when you need raw property data or a paginated property exceeds the inline limit.

## Prerequisites
The property_id is the internal Notion property ID (not the name). Get it from the raw page object or from fetch_block_children metadata.

<example>{"page_id": "page-uuid", "property_id": "abc123"}</example>`,
    {
      page_id: z.string().describe('Notion page ID (UUID) or Notion URL'),
      property_id: z.string().describe('Property ID (internal Notion ID, not the display name). Found in page metadata.'),
      page_size: z.number().optional().describe('Results per page for paginated properties'),
      start_cursor: z.string().optional().describe('Pagination cursor from previous response'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_id, property_id, page_size, start_cursor, workspace }) => {
      const result = await notionClient.getPageProperty(page_id, property_id, { page_size, start_cursor, workspace });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    })
  );

  // ============================================================
  // 16. APPEND CONTENT
  // ============================================================

  server.tool(
    'append_content',
    `Append Markdown content as new blocks at the END of an existing Notion page. This adds to the page without modifying or deleting any existing content.

Use this instead of update_page_content when you want to ADD content without touching what's already there.

Automatically chunks large content (>100 blocks) into multiple API calls.

Supported Markdown: # headings, - bullets, 1. numbered, - [ ] todos, > quotes, \`\`\`code\`\`\`, --- dividers, **bold**, *italic*, [links](url)

<example description="Append a section">
{"page_id": "abc123", "content_markdown": "## New Section\\n\\nThis content is added at the bottom of the page.\\n\\n- Point 1\\n- Point 2"}
</example>
<example description="Append to personal page">
{"page_id": "abc123", "content_markdown": "### Evening Notes\\n\\nReflections for today...", "workspace": "paolo"}
</example>`,
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      content_markdown: z.string().describe('Markdown content to append at the end of the page'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_id, content_markdown, workspace }) => {
      const blocks = markdownToBlocks(content_markdown);
      if (blocks.length === 0) {
        return { content: [{ type: 'text', text: 'No content to append — markdown produced zero blocks.' }] };
      }
      const result = await notionClient.appendContent(page_id, blocks, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Appended ${result.appended} blocks to page.`,
        }],
      };
    })
  );

  // ============================================================
  // 17. BUILD PROPERTY VALUE (helper)
  // ============================================================

  server.tool(
    'build_property_value',
    `Helper tool that converts simple values into Notion API property format. Use this when you need to construct property values for create_page or update_page_properties without manually building the nested Notion API structures.

## Supported Types
- title: string → {"title": [{"text": {"content": "value"}}]}
- rich_text: string → {"rich_text": [{"text": {"content": "value"}}]}
- number: number → {"number": value}
- select: string → {"select": {"name": "value"}}
- multi_select: string[] → {"multi_select": [{"name": "v1"}, {"name": "v2"}]}
- status: string → {"status": {"name": "value"}}
- date: string|{start,end} → {"date": {"start": "2026-01-01"}}
- checkbox: boolean → {"checkbox": true}
- url: string → {"url": "value"}
- email: string → {"email": "value"}
- phone_number: string → {"phone_number": "value"}
- relation: string[] (page IDs) → {"relation": [{"id": "uuid"}]}
- people: string[] (user IDs) → {"people": [{"id": "uuid"}]}
- files: string[] (URLs) → {"files": [{"external": {"url": "..."}}]}

<example description="Build multiple properties at once">
{"properties": {"Name": {"type": "title", "value": "My Task"}, "Status": {"type": "select", "value": "Active"}, "Priority": {"type": "number", "value": 1}, "Done": {"type": "checkbox", "value": false}}}
</example>`,
    {
      properties: z.record(z.object({
        type: z.string().describe('Property type: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, relation, people, files'),
        value: z.any().describe('Simple value — string for most types, number for number, boolean for checkbox, string[] for relation/people/multi_select/files, {start, end} for date ranges'),
      })).describe('Map of property name → {type, value} pairs to convert'),
    },
    safeHandler(async ({ properties }) => {
      const built = {};
      for (const [name, { type, value }] of Object.entries(properties)) {
        built[name] = buildPropertyValue(type, value);
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(built, null, 2),
        }],
      };
    })
  );

  // ============================================================
  // 18. FETCH BLOCK CHILDREN
  // ============================================================

  server.tool(
    'fetch_block_children',
    `List the child blocks of a Notion block or page. Returns block objects with their type, content preview, and metadata.

Use this for inspecting page structure at the block level — to get block IDs for delete_block or update_block, or to understand the block hierarchy before making changes.

Each result includes: block ID, block type, has_children flag, and a text content preview.

Supports pagination for pages with many blocks.

<example description="Get all blocks on a page">
{"block_id": "page-uuid"}
</example>
<example description="Paginate through blocks">
{"block_id": "page-uuid", "page_size": 50, "start_cursor": "cursor-from-previous-response"}
</example>`,
    {
      block_id: z.string().describe('Block or page ID (UUID). A page ID returns the top-level blocks of that page.'),
      page_size: z.number().min(1).max(100).optional().describe('Results per page (default: 100, max: 100)'),
      start_cursor: z.string().optional().describe('Pagination cursor from previous response'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ block_id, page_size, start_cursor, workspace }) => {
      const result = await notionClient.fetchBlockChildren(block_id, { page_size, start_cursor, workspace });
      const summary = result.results.map(b => ({
        id: b.id,
        type: b.type,
        has_children: b.has_children,
        content: b[b.type]?.rich_text?.map(rt => rt.plain_text).join('') || '',
      }));
      const out = {
        blocks: summary,
        has_more: result.has_more,
        next_cursor: result.next_cursor,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    })
  );

  // ============================================================
  // 19. GET COMMENTS
  // ============================================================

  server.tool(
    'get_comments',
    `List all comments on a Notion page or block. Returns each comment's text, author, timestamp, and discussion thread ID.

Use discussion_id from the results with create_comment to reply to an existing thread.

<example>{"page_id": "page-uuid"}</example>`,
    {
      page_id: z.string().describe('Notion page or block ID (UUID) or Notion URL'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_id, workspace }) => {
      const comments = await notionClient.getComments(page_id, { workspace });
      if (comments.length === 0) {
        return { content: [{ type: 'text', text: 'No comments on this page.' }] };
      }
      const lines = comments.map(c =>
        `[${c.created_time}] ${c.created_by}: ${c.text}${c.discussion_id ? ` (thread: ${c.discussion_id})` : ''}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    })
  );

  // ============================================================
  // 20. CREATE COMMENT
  // ============================================================

  server.tool(
    'create_comment',
    `Add a comment to a Notion page or reply to an existing discussion thread.

## Modes
- **New page comment**: Provide page_id and text only. Creates a top-level comment.
- **Thread reply**: Provide page_id, text, AND discussion_id. Replies to an existing thread. Get discussion_id from get_comments.

<example description="New comment on a page">
{"page_id": "page-uuid", "text": "Looks good, approved!"}
</example>
<example description="Reply to existing thread">
{"page_id": "page-uuid", "text": "Done, changes made.", "discussion_id": "disc-uuid"}
</example>`,
    {
      page_id: z.string().describe('Notion page ID (UUID) or Notion URL'),
      text: z.string().describe('Comment text content'),
      discussion_id: z.string().optional().describe('Discussion thread ID to reply to. Get from get_comments results. Omit for new top-level comment.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_id, text, discussion_id, workspace }) => {
      const result = await notionClient.createComment(page_id, text, discussion_id, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Comment created.\nID: ${result.id}\nCreated: ${result.created_time}`,
        }],
      };
    })
  );

  // ============================================================
  // 21. GET USERS
  // ============================================================

  server.tool(
    'get_users',
    `List all users (members and bots) in a Notion workspace. Returns each user's ID, name, email (if person), type (person/bot), and avatar URL.

Useful for: finding user IDs for people properties, checking workspace membership, or discovering bot integrations.

<example description="List all users in business workspace">
{"page_size": 100}
</example>
<example description="List users in personal workspace">
{"workspace": "paolo"}
</example>`,
    {
      page_size: z.number().min(1).max(100).optional().describe('Number of users to return (default: 100)'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_size, workspace }) => {
      const users = await notionClient.getUsers(page_size, { workspace });
      const lines = users.map(u =>
        `${u.name} (${u.type}) — ID: ${u.id}${u.email ? ` — ${u.email}` : ''}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    })
  );

  // ============================================================
  // 22. GET USER
  // ============================================================

  server.tool(
    'get_user',
    `Retrieve detailed information about a specific Notion user by their ID. Returns name, type (person/bot), email, and avatar URL.

<example>{"user_id": "user-uuid-here"}</example>`,
    {
      user_id: z.string().describe('Notion user ID (UUID)'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ user_id, workspace }) => {
      const user = await notionClient.getUser(user_id, { workspace });
      return {
        content: [{
          type: 'text',
          text: `${user.name} (${user.type})\nID: ${user.id}${user.email ? `\nEmail: ${user.email}` : ''}${user.avatar ? `\nAvatar: ${user.avatar}` : ''}`,
        }],
      };
    })
  );

  // ============================================================
  // 23. BATCH GET PAGES
  // ============================================================

  server.tool(
    'batch_get_pages',
    `Fetch multiple Notion pages in a single call. Returns each page with title, properties, and full Markdown content. Significantly more efficient than calling fetch_page multiple times.

Individual page errors are caught and returned inline (the batch continues even if one page fails).

<example description="Fetch 3 pages at once">
{"page_ids": ["uuid-1", "uuid-2", "uuid-3"]}
</example>
<example description="Fetch personal pages">
{"page_ids": ["uuid-1", "uuid-2"], "workspace": "paolo"}
</example>`,
    {
      page_ids: z.array(z.string()).describe('Array of page IDs (UUIDs or Notion URLs). All pages must be in the same workspace.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_ids, workspace }) => {
      const results = [];
      for (const pid of page_ids) {
        try {
          const page = await notionClient.fetchPage(pid, { workspace });
          results.push({ id: page.id, title: page.title, url: page.url, properties: page.properties, content: page.content });
        } catch (e) {
          results.push({ id: pid, error: e.message });
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    })
  );

  // ============================================================
  // 24. BATCH GET DATABASES
  // ============================================================

  server.tool(
    'batch_get_databases',
    `Fetch multiple Notion database schemas in a single call. Returns each database with title, description, URL, and full column schema. More efficient than calling fetch_database multiple times.

Individual database errors are caught and returned inline.

<example>{"database_ids": ["db-uuid-1", "db-uuid-2"]}</example>`,
    {
      database_ids: z.array(z.string()).describe('Array of database IDs (UUIDs or Notion URLs). All databases must be in the same workspace.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ database_ids, workspace }) => {
      const results = [];
      for (const did of database_ids) {
        try {
          const db = await notionClient.fetchDatabase(did, { workspace });
          results.push({ id: db.id, title: db.title, url: db.url, schema: db.schema });
        } catch (e) {
          results.push({ id: did, error: e.message });
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    })
  );

  // ============================================================
  // 25. MOVE PAGE
  // ============================================================

  server.tool(
    'move_page',
    `Move a Notion page to a new parent (another page or a database). The page is re-parented — it disappears from its old location and appears under the new parent.

For database destinations, set is_database=true so the page becomes a row in that database.

<example description="Move to another page">
{"page_id": "page-uuid", "new_parent_id": "parent-page-uuid"}
</example>
<example description="Move into a database">
{"page_id": "page-uuid", "new_parent_id": "database-uuid", "is_database": true}
</example>`,
    {
      page_id: z.string().describe('Page ID to move (UUID)'),
      new_parent_id: z.string().describe('Destination parent ID — page UUID or database UUID'),
      is_database: z.boolean().optional().describe('Set true if new_parent_id is a database. Default: false (page parent).'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ page_id, new_parent_id, is_database, workspace }) => {
      const result = await notionClient.movePage(page_id, new_parent_id, is_database, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Page moved.\nID: ${result.id}\nURL: ${result.url}`,
        }],
      };
    })
  );

  // ============================================================
  // 26. DUPLICATE PAGE
  // ============================================================

  server.tool(
    'duplicate_page',
    `Duplicate a Notion page with all its content, icon, and cover image. Creates a full copy by reading the source as Markdown and recreating all blocks in the new page.

By default, the copy is created under the same parent as the source. Optionally specify a different parent and/or a new title.

Note: Properties (database row fields) are NOT duplicated — only the page body content, icon, and cover.

<example description="Duplicate in place">
{"source_page_id": "page-uuid"}
</example>
<example description="Duplicate with new title and parent">
{"source_page_id": "page-uuid", "new_parent_id": "other-page-uuid", "new_title": "Copy of Original"}
</example>`,
    {
      source_page_id: z.string().describe('Source page ID to duplicate (UUID or Notion URL)'),
      new_parent_id: z.string().optional().describe('New parent page ID. If omitted, uses the same parent as the source.'),
      new_title: z.string().optional().describe('Title for the copy. If omitted, uses the source page title.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ source_page_id, new_parent_id, new_title, workspace }) => {
      const result = await notionClient.duplicatePage(source_page_id, new_parent_id, new_title, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Page duplicated.\nNew ID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    })
  );

  // ============================================================
  // 27. UPDATE BLOCK
  // ============================================================

  server.tool(
    'update_block',
    `Update a specific Notion block's content or properties. Pass block type-specific data in Notion API format.

## Prerequisites
Use fetch_block_children first to get the block ID and current block type.

## Common Updates
- Paragraph text: {"paragraph": {"rich_text": [{"text": {"content": "new text"}}]}}
- Heading text: {"heading_1": {"rich_text": [{"text": {"content": "New Heading"}}]}}
- Toggle state: {"toggle": {"rich_text": [{"text": {"content": "Updated toggle"}}]}}
- To-do checked: {"to_do": {"checked": true, "rich_text": [{"text": {"content": "Done task"}}]}}

<example description="Update paragraph text">
{"block_id": "block-uuid", "data": {"paragraph": {"rich_text": [{"text": {"content": "Updated paragraph content."}}]}}}
</example>
<example description="Check a to-do item">
{"block_id": "block-uuid", "data": {"to_do": {"checked": true}}}
</example>`,
    {
      block_id: z.string().describe('Block ID to update (UUID). Get from fetch_block_children.'),
      data: z.record(z.any()).describe('Block update payload in Notion API format. Must include the block type key with updated fields.'),
      workspace: WORKSPACE_ENUM,
    },
    safeHandler(async ({ block_id, data, workspace }) => {
      const result = await notionClient.updateBlock(block_id, data, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Block updated.\nID: ${result.id}\nType: ${result.type}`,
        }],
      };
    })
  );

  return server;
}
