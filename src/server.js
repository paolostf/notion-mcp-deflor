// server.js — MCP tool definitions for Notion DeFlorance
// 26 tools covering: search, pages, databases, blocks, comments, users, batch ops

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notionClient } from './notion-client.js';
import { markdownToBlocks, buildPropertyValue } from './blocks.js';

const WORKSPACE_ENUM = z.enum(['deflorance', 'paolo']).optional().describe('Workspace to operate on (default: deflorance)');

export function createServer() {
  const server = new McpServer({
    name: 'notion-mcp-deflor',
    version: '2.1.0',
  });

  // ============================================================
  // 1. SEARCH
  // ============================================================

  server.tool(
    'search',
    'Search Notion workspace for pages and databases by title or keyword. Returns matching items with id, title, url, type, and last_edited timestamp. Use filter_type to narrow to "page" or "database" only.',
    {
      query: z.string().describe('Search query text — matches against page/database titles'),
      filter_type: z.enum(['page', 'database']).optional().describe('Restrict results to pages or databases only'),
      sort_direction: z.enum(['ascending', 'descending']).optional().describe('Sort by last_edited_time'),
      page_size: z.number().min(1).max(100).optional().describe('Number of results (default 10, max 100)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ query, filter_type, sort_direction, page_size, workspace }) => {
      const result = await notionClient.search(query, { filter_type, sort_direction, page_size, workspace });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ============================================================
  // 2. FETCH PAGE
  // ============================================================

  server.tool(
    'fetch_page',
    'Retrieve a Notion page with full content converted to Markdown. Accepts a page ID or full Notion URL. Returns title, properties (formatted key-value), and the complete page body as Markdown including headings, lists, tables, code blocks, images, toggles, callouts, and nested content up to 3 levels deep.',
    {
      page_id: z.string().describe('Notion page ID (UUID with or without dashes) or full Notion URL'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_id, workspace }) => {
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
    }
  );

  // ============================================================
  // 3. CREATE PAGE
  // ============================================================

  server.tool(
    'create_page',
    'Create a new Notion page inside a database or under a parent page. Supports properties (Notion API format), Markdown content (auto-converted to blocks), icon (emoji or URL), and cover image. For database pages, set is_database=true.',
    {
      parent_id: z.string().describe('Parent page ID or database ID (UUID or Notion URL)'),
      is_database: z.boolean().optional().describe('True if parent_id is a database (default false)'),
      title: z.string().optional().describe('Page title shorthand — auto-sets the title property'),
      properties: z.record(z.any()).optional().describe('Notion API properties object. Example: {"Name": {"title": [{"text": {"content": "My Page"}}]}, "Status": {"select": {"name": "Active"}}}'),
      content_markdown: z.string().optional().describe('Page body in Markdown. Supports: # headings, - lists, 1. numbered, - [x] todos, > quotes, ```code```, ---, **bold**, *italic*, [links](url)'),
      icon: z.string().optional().describe('Emoji character or external image URL'),
      cover: z.string().optional().describe('Cover image URL'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ parent_id, is_database, title, properties, content_markdown, icon, cover, workspace }) => {
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
    }
  );

  // ============================================================
  // 4. UPDATE PAGE PROPERTIES
  // ============================================================

  server.tool(
    'update_page_properties',
    'Update properties on an existing Notion page or database row. Pass properties in Notion API format. Supports all property types: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, relation, people, files. Use build_property_value to construct values from simple inputs.',
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      properties: z.record(z.any()).describe('Properties to update. Example: {"Status": {"select": {"name": "Done"}}, "Priority": {"number": 1}}'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_id, properties, workspace }) => {
      const result = await notionClient.updatePageProperties(page_id, properties, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Page updated.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // 5. UPDATE PAGE CONTENT (oldStr/newStr diffing)
  // ============================================================

  server.tool(
    'update_page_content',
    'Update the content of a Notion page using oldStr/newStr replacement (like a text diff). Fetches all blocks as Markdown, performs the string replacement, and replaces all blocks with the modified content. If oldStr is omitted, performs a full content replacement. Supports multiple sequential updates in one call.',
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      updates: z.array(z.object({
        oldStr: z.string().optional().describe('Text to find in the page Markdown. Omit for full content replacement.'),
        newStr: z.string().describe('Replacement text (Markdown). If oldStr omitted, this replaces ALL page content.'),
        replaceAllMatches: z.boolean().optional().describe('Replace all occurrences of oldStr (default: first only)'),
      })).describe('Array of content updates to apply sequentially'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_id, updates, workspace }) => {
      const result = await notionClient.updatePageContent(page_id, updates, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Page content updated.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // 6. ARCHIVE PAGES
  // ============================================================

  server.tool(
    'archive_pages',
    'Archive (soft-delete) one or more Notion pages. Archived pages can be restored from Notion trash. Accepts an array of page IDs.',
    {
      page_ids: z.array(z.string()).describe('Array of page IDs (UUIDs) to archive'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_ids, workspace }) => {
      const result = await notionClient.archivePages(page_ids, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Archived ${result.archived.length} page(s): ${result.archived.join(', ')}`,
        }],
      };
    }
  );

  // ============================================================
  // 7. UNARCHIVE PAGES
  // ============================================================

  server.tool(
    'unarchive_pages',
    'Restore previously archived Notion pages from trash. Accepts an array of page IDs.',
    {
      page_ids: z.array(z.string()).describe('Array of page IDs (UUIDs) to unarchive'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_ids, workspace }) => {
      const result = await notionClient.unarchivePages(page_ids, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Unarchived ${result.unarchived.length} page(s): ${result.unarchived.join(', ')}`,
        }],
      };
    }
  );

  // ============================================================
  // 8. DELETE BLOCK
  // ============================================================

  server.tool(
    'delete_block',
    'Delete (archive) a specific block from a Notion page. Soft-deleted blocks can be recovered from trash.',
    {
      block_id: z.string().describe('Block ID to delete (UUID)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ block_id, workspace }) => {
      const result = await notionClient.deleteBlock(block_id, { workspace });
      return { content: [{ type: 'text', text: `Block deleted: ${result.deleted}` }] };
    }
  );

  // ============================================================
  // 9. FETCH DATABASE
  // ============================================================

  server.tool(
    'fetch_database',
    'Retrieve a Notion database schema and metadata. Returns title, description, column definitions (property names, types, select options, formula expressions, relation targets, rollup configs). Use this to understand database structure before querying or creating pages.',
    {
      database_id: z.string().describe('Notion database ID (UUID) or full Notion URL'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ database_id, workspace }) => {
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
    }
  );

  // ============================================================
  // 10. QUERY DATABASE
  // ============================================================

  server.tool(
    'query_database',
    'Query a Notion database with filters and sorts. Returns rows with properties as key-value pairs. Supports Notion API filter objects and sort arrays. Filters/sorts can be JSON strings or objects.',
    {
      database_id: z.string().describe('Notion database ID (UUID) or full Notion URL'),
      filter: z.union([z.string(), z.record(z.any())]).optional().describe('Notion filter object or JSON string. Example: {"property": "Status", "select": {"equals": "Active"}}'),
      sorts: z.union([z.string(), z.array(z.any())]).optional().describe('Sort array or JSON string. Example: [{"property": "Date", "direction": "descending"}]'),
      page_size: z.number().min(1).max(100).optional().describe('Rows to return (default 20, max 100)'),
      start_cursor: z.string().optional().describe('Pagination cursor from previous query'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ database_id, filter, sorts, page_size, start_cursor, workspace }) => {
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
    }
  );

  // ============================================================
  // 11. CREATE DATABASE
  // ============================================================

  server.tool(
    'create_database',
    'Create a new Notion database as a child of a page. Define schema with property definitions. At minimum include a title property: {"Name": {"title": {}}}. Supports all property types.',
    {
      parent_page_id: z.string().describe('Parent page ID (UUID or Notion URL)'),
      title: z.string().describe('Database title'),
      properties: z.record(z.any()).optional().describe('Schema — property name to type definition. Default: {"Name": {"title": {}}}'),
      icon: z.string().optional().describe('Emoji or URL'),
      description: z.string().optional().describe('Database description'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ parent_page_id, title, properties, icon, description, workspace }) => {
      const result = await notionClient.createDatabase(parent_page_id, { title, properties, icon, description, workspace });
      return {
        content: [{
          type: 'text',
          text: `Database created.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // 12. UPDATE DATABASE
  // ============================================================

  server.tool(
    'update_database',
    'Update a Notion database title, description, or schema. Add new properties, rename existing ones, or change types/options. Properties not included are left unchanged.',
    {
      database_id: z.string().describe('Notion database ID (UUID) or full Notion URL'),
      title: z.string().optional().describe('New title'),
      properties: z.record(z.any()).optional().describe('Schema updates — properties to add or modify'),
      description: z.string().optional().describe('New description'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ database_id, title, properties, description, workspace }) => {
      const result = await notionClient.updateDatabase(database_id, { title, properties, description, workspace });
      return {
        content: [{
          type: 'text',
          text: `Database updated.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // 13. DELETE DATABASES
  // ============================================================

  server.tool(
    'delete_databases',
    'Archive (soft-delete) one or more Notion databases. Databases are pages internally, so this archives them. Recoverable from trash.',
    {
      database_ids: z.array(z.string()).describe('Array of database IDs (UUIDs) to archive'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ database_ids, workspace }) => {
      const result = await notionClient.deleteDatabases(database_ids, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Archived ${result.archived.length} database(s): ${result.archived.join(', ')}`,
        }],
      };
    }
  );

  // ============================================================
  // 14. CREATE TWO-WAY RELATION
  // ============================================================

  server.tool(
    'create_two_way_relation',
    'Create a bidirectional (two-way) relation between two Notion databases. Creates a relation property on the source database that auto-creates a synced property on the target database.',
    {
      source_database_id: z.string().describe('Source database ID (UUID)'),
      target_database_id: z.string().describe('Target database ID (UUID)'),
      source_property_name: z.string().describe('Name for the relation column in the source database'),
      target_property_name: z.string().describe('Name for the synced relation column in the target database'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ source_database_id, target_database_id, source_property_name, target_property_name, workspace }) => {
      const result = await notionClient.createTwoWayRelation(source_database_id, target_database_id, source_property_name, target_property_name, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Two-way relation created.\nSource DB: ${result.source_database_id} (property: ${result.source_property})\nTarget DB: ${result.target_database_id} (property: ${result.target_property})`,
        }],
      };
    }
  );

  // ============================================================
  // 15. GET PAGE PROPERTY (paginated)
  // ============================================================

  server.tool(
    'get_page_property',
    'Retrieve a specific property value from a Notion page with pagination support. Use this for large property values (rich_text, relation, rollup, people) that may be paginated. Returns the raw Notion API property response.',
    {
      page_id: z.string().describe('Notion page ID (UUID) or Notion URL'),
      property_id: z.string().describe('Property ID (from page properties metadata, not the property name)'),
      page_size: z.number().optional().describe('Results per page'),
      start_cursor: z.string().optional().describe('Pagination cursor'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_id, property_id, page_size, start_cursor, workspace }) => {
      const result = await notionClient.getPageProperty(page_id, property_id, { page_size, start_cursor, workspace });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ============================================================
  // 16. APPEND CONTENT
  // ============================================================

  server.tool(
    'append_content',
    'Append Markdown content as blocks to the end of a Notion page. Does not replace existing content. Handles >100 blocks by chunking automatically.',
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      content_markdown: z.string().describe('Markdown to append. Supports: # headings, - lists, 1. numbered, - [x] todos, > quotes, ```code```, ---, **bold**, *italic*, [links](url)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_id, content_markdown, workspace }) => {
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
    }
  );

  // ============================================================
  // 17. BUILD PROPERTY VALUE (helper — workspace-agnostic)
  // ============================================================

  server.tool(
    'build_property_value',
    'Convert simple values into Notion API property format. Use when constructing property values for create_page or update_page_properties without manually building nested structures. Supports: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, relation, people, files.',
    {
      properties: z.record(z.object({
        type: z.string().describe('Property type: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, relation, people, files'),
        value: z.any().describe('Simple value. Strings for most types, number for number, boolean for checkbox, array of IDs for relation/people, array of URLs for files, {start, end} for date ranges'),
      })).describe('Map of property name -> {type, value} pairs'),
    },
    async ({ properties }) => {
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
    }
  );

  // ============================================================
  // 18. FETCH BLOCK CHILDREN
  // ============================================================

  server.tool(
    'fetch_block_children',
    'List child blocks of a Notion block or page. Returns raw block objects with type, content, and metadata. Use for inspecting page structure at the block level. Supports pagination.',
    {
      block_id: z.string().describe('Block or page ID (UUID)'),
      page_size: z.number().min(1).max(100).optional().describe('Results per page (default 100)'),
      start_cursor: z.string().optional().describe('Pagination cursor'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ block_id, page_size, start_cursor, workspace }) => {
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
    }
  );

  // ============================================================
  // 19. GET COMMENTS
  // ============================================================

  server.tool(
    'get_comments',
    'List all comments on a Notion page or block. Returns comment text, author, timestamp, and discussion thread IDs. Use discussion_id with create_comment to reply to threads.',
    {
      page_id: z.string().describe('Notion page or block ID (UUID) or Notion URL'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_id, workspace }) => {
      const comments = await notionClient.getComments(page_id, { workspace });
      if (comments.length === 0) {
        return { content: [{ type: 'text', text: 'No comments on this page.' }] };
      }
      const lines = comments.map(c =>
        `[${c.created_time}] ${c.created_by}: ${c.text}${c.discussion_id ? ` (thread: ${c.discussion_id})` : ''}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ============================================================
  // 20. CREATE COMMENT
  // ============================================================

  server.tool(
    'create_comment',
    'Add a comment to a Notion page or reply to an existing discussion thread. For page-level comments, provide page_id. For thread replies, provide discussion_id.',
    {
      page_id: z.string().describe('Notion page ID (UUID) or Notion URL'),
      text: z.string().describe('Comment text'),
      discussion_id: z.string().optional().describe('Discussion thread ID to reply to (from get_comments). Omit for new top-level comment.'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_id, text, discussion_id, workspace }) => {
      const result = await notionClient.createComment(page_id, text, discussion_id, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Comment created.\nID: ${result.id}\nCreated: ${result.created_time}`,
        }],
      };
    }
  );

  // ============================================================
  // 21. GET USERS
  // ============================================================

  server.tool(
    'get_users',
    'List all users in the Notion workspace. Returns IDs, names, emails, types (person/bot), and avatars.',
    {
      page_size: z.number().min(1).max(100).optional().describe('Number of users (default 100)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_size, workspace }) => {
      const users = await notionClient.getUsers(page_size, { workspace });
      const lines = users.map(u =>
        `${u.name} (${u.type}) — ID: ${u.id}${u.email ? ` — ${u.email}` : ''}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ============================================================
  // 22. GET USER
  // ============================================================

  server.tool(
    'get_user',
    'Retrieve details for a specific Notion user by ID. Returns name, type, email, and avatar.',
    {
      user_id: z.string().describe('Notion user ID (UUID)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ user_id, workspace }) => {
      const user = await notionClient.getUser(user_id, { workspace });
      return {
        content: [{
          type: 'text',
          text: `${user.name} (${user.type})\nID: ${user.id}${user.email ? `\nEmail: ${user.email}` : ''}${user.avatar ? `\nAvatar: ${user.avatar}` : ''}`,
        }],
      };
    }
  );

  // ============================================================
  // 23. BATCH GET PAGES
  // ============================================================

  server.tool(
    'batch_get_pages',
    'Fetch multiple Notion pages in one call. Returns each page with title, properties, and full Markdown content. More efficient than calling fetch_page multiple times.',
    {
      page_ids: z.array(z.string()).describe('Array of page IDs (UUIDs or Notion URLs)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_ids, workspace }) => {
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
    }
  );

  // ============================================================
  // 24. BATCH GET DATABASES
  // ============================================================

  server.tool(
    'batch_get_databases',
    'Fetch multiple Notion database schemas in one call. Returns each database with title, description, and full schema. More efficient than calling fetch_database multiple times.',
    {
      database_ids: z.array(z.string()).describe('Array of database IDs (UUIDs or Notion URLs)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ database_ids, workspace }) => {
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
    }
  );

  // ============================================================
  // 25. MOVE PAGE
  // ============================================================

  server.tool(
    'move_page',
    'Move a Notion page to a new parent (page or database). Updates the parent reference. For database destinations, set is_database=true.',
    {
      page_id: z.string().describe('Page ID to move (UUID)'),
      new_parent_id: z.string().describe('Destination parent ID (page or database UUID)'),
      is_database: z.boolean().optional().describe('True if new parent is a database (default false)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ page_id, new_parent_id, is_database, workspace }) => {
      const result = await notionClient.movePage(page_id, new_parent_id, is_database, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Page moved.\nID: ${result.id}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // 26. DUPLICATE PAGE
  // ============================================================

  server.tool(
    'duplicate_page',
    'Duplicate a Notion page with all its content, icon, and cover. Creates a copy under the same parent or a specified new parent. Content is read as Markdown from the source and recreated as blocks in the copy.',
    {
      source_page_id: z.string().describe('Source page ID to duplicate (UUID or Notion URL)'),
      new_parent_id: z.string().optional().describe('Optional new parent ID. If omitted, copy goes under the same parent as the source.'),
      new_title: z.string().optional().describe('Title for the copy. If omitted, uses source title.'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ source_page_id, new_parent_id, new_title, workspace }) => {
      const result = await notionClient.duplicatePage(source_page_id, new_parent_id, new_title, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Page duplicated.\nNew ID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // 27. UPDATE BLOCK
  // ============================================================

  server.tool(
    'update_block',
    'Update a specific Notion block. Pass the block type-specific data to modify. Supports changing text content, toggling, and other block-specific properties.',
    {
      block_id: z.string().describe('Block ID to update (UUID)'),
      data: z.record(z.any()).describe('Block update data in Notion API format (block type-specific fields)'),
      workspace: WORKSPACE_ENUM,
    },
    async ({ block_id, data, workspace }) => {
      const result = await notionClient.updateBlock(block_id, data, { workspace });
      return {
        content: [{
          type: 'text',
          text: `Block updated.\nID: ${result.id}\nType: ${result.type}`,
        }],
      };
    }
  );

  return server;
}
