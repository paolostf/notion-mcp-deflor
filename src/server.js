// server.js — MCP tool definitions for Notion DeFlorance
// Factory function that creates and configures the MCP server with all tools

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notionClient } from './notion-client.js';
import { markdownToBlocks, buildPropertyValue } from './blocks.js';

export function createServer() {
  const server = new McpServer({
    name: 'notion-mcp-deflor',
    version: '1.0.0',
  });

  // ============================================================
  // SEARCH — Find pages and databases across the workspace
  // ============================================================

  server.tool(
    'search',
    'Search Notion workspace for pages and databases by title or keyword. Returns matching items with id, title, url, type, and last_edited timestamp. Use filter_type to narrow to "page" or "database" only.',
    {
      query: z.string().describe('Search query text — matches against page/database titles'),
      filter_type: z.enum(['page', 'database']).optional().describe('Restrict results to pages or databases only'),
      sort_direction: z.enum(['ascending', 'descending']).optional().describe('Sort by last_edited_time'),
      page_size: z.number().min(1).max(100).optional().describe('Number of results to return (default 10, max 100)'),
    },
    async ({ query, filter_type, sort_direction, page_size }) => {
      const result = await notionClient.search(query, { filter_type, sort_direction, page_size });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ============================================================
  // FETCH PAGE — Full page content as Markdown
  // ============================================================

  server.tool(
    'fetch_page',
    'Retrieve a Notion page with full content converted to Markdown. Accepts a page ID or full Notion URL. Returns title, properties (formatted as key-value pairs), and the complete page body as Markdown including headings, lists, tables, code blocks, images, toggles, callouts, and nested content up to 3 levels deep. This is the primary tool for reading page content.',
    {
      page_id: z.string().describe('Notion page ID (UUID with or without dashes) or full Notion URL'),
    },
    async ({ page_id }) => {
      const page = await notionClient.fetchPage(page_id);
      const lines = [];
      lines.push(`# ${page.title}`);
      lines.push('');
      if (page.icon) lines.push(`Icon: ${page.icon}`);
      if (page.cover) lines.push(`Cover: ${page.cover}`);
      lines.push(`URL: ${page.url}`);
      lines.push(`Created: ${page.created_time}`);
      lines.push(`Last edited: ${page.last_edited_time}`);
      lines.push('');

      // Properties section
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

      // Content section
      if (page.content) {
        lines.push('## Content');
        lines.push('');
        lines.push(page.content);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ============================================================
  // FETCH DATABASE — Schema and metadata
  // ============================================================

  server.tool(
    'fetch_database',
    'Retrieve a Notion database schema and metadata. Returns the database title, description, column definitions (property names, types, select/multi_select options, formula expressions, relation targets, rollup configs). Use this to understand a database structure before querying or creating pages in it.',
    {
      database_id: z.string().describe('Notion database ID (UUID) or full Notion URL'),
    },
    async ({ database_id }) => {
      const db = await notionClient.fetchDatabase(database_id);
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
        if (def.database_id) desc += ` [→ db: ${def.database_id}]`;
        if (def.relation_property) desc += ` [rollup: ${def.relation_property} → ${def.rollup_property} (${def.function})]`;
        if (def.groups) desc += ` [groups: ${def.groups.map(g => g.name).join(', ')}]`;
        lines.push(desc);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ============================================================
  // QUERY DATABASE — Filter and sort rows
  // ============================================================

  server.tool(
    'query_database',
    'Query a Notion database with optional filters and sorts. Returns rows with their properties formatted as key-value pairs. Supports Notion API filter objects (e.g., {"property": "Status", "select": {"equals": "Done"}}) and sort objects (e.g., [{"property": "Date", "direction": "descending"}]). Filters and sorts can be passed as JSON strings or objects.',
    {
      database_id: z.string().describe('Notion database ID (UUID) or full Notion URL'),
      filter: z.union([z.string(), z.record(z.any())]).optional().describe('Notion API filter object or JSON string. Example: {"property": "Status", "select": {"equals": "Active"}}'),
      sorts: z.union([z.string(), z.array(z.any())]).optional().describe('Array of sort objects or JSON string. Example: [{"property": "Date", "direction": "descending"}]'),
      page_size: z.number().min(1).max(100).optional().describe('Number of rows to return (default 20, max 100)'),
      start_cursor: z.string().optional().describe('Pagination cursor from a previous query response'),
    },
    async ({ database_id, filter, sorts, page_size, start_cursor }) => {
      const result = await notionClient.queryDatabase(database_id, { filter, sorts, page_size, start_cursor });

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
  // CREATE PAGE — With properties and Markdown content
  // ============================================================

  server.tool(
    'create_page',
    'Create a new Notion page inside a database or under a parent page. Supports setting properties (as Notion API property values), page content (as Markdown which gets converted to Notion blocks), icon (emoji or URL), and cover image. For database pages, set is_database=true and pass the database ID as parent_id. Content written in Markdown is automatically converted to Notion blocks including headings, lists, code blocks, quotes, to-dos, and dividers.',
    {
      parent_id: z.string().describe('Parent page ID or database ID (UUID or Notion URL)'),
      is_database: z.boolean().optional().describe('Set true if parent_id is a database (default false = parent page)'),
      title: z.string().optional().describe('Page title — shorthand that sets the title property automatically'),
      properties: z.record(z.any()).optional().describe('Notion API properties object. For databases, must match the schema. Example: {"Name": {"title": [{"text": {"content": "My Page"}}]}, "Status": {"select": {"name": "Active"}}}'),
      content_markdown: z.string().optional().describe('Page body content in Markdown. Converted to Notion blocks. Supports: # headings, - lists, 1. numbered, - [x] todos, > quotes, ```code```, ---, **bold**, *italic*, [links](url)'),
      icon: z.string().optional().describe('Page icon — emoji character (e.g., "🚀") or external image URL'),
      cover: z.string().optional().describe('Cover image URL'),
    },
    async ({ parent_id, is_database, title, properties, content_markdown, icon, cover }) => {
      // Build properties — if title provided as shorthand, inject it
      let props = properties || {};
      if (title && !properties) {
        props = { title: { title: [{ type: 'text', text: { content: title } }] } };
      } else if (title && properties && !properties.title && !properties.Name) {
        // Find the title property name from the provided properties, or default
        props.title = { title: [{ type: 'text', text: { content: title } }] };
      }

      // Convert Markdown to Notion blocks
      const content = content_markdown ? markdownToBlocks(content_markdown) : undefined;

      const result = await notionClient.createPage(parent_id, {
        properties: props,
        content,
        icon,
        cover,
        is_database,
      });

      return {
        content: [{
          type: 'text',
          text: `Page created successfully.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // UPDATE PAGE PROPERTIES
  // ============================================================

  server.tool(
    'update_page_properties',
    'Update properties on an existing Notion page. Pass a properties object matching the Notion API format. To update a database row, use the row\'s page ID. Supports all property types: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, relation, people, files. Use build_property_value tool to construct property values from simple inputs if needed.',
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      properties: z.record(z.any()).describe('Properties to update in Notion API format. Example: {"Status": {"select": {"name": "Done"}}, "Priority": {"number": 1}}'),
    },
    async ({ page_id, properties }) => {
      const result = await notionClient.updatePageProperties(page_id, properties);
      return {
        content: [{
          type: 'text',
          text: `Page updated.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // BUILD PROPERTY VALUE — Helper for constructing property values
  // ============================================================

  server.tool(
    'build_property_value',
    'Helper tool that converts simple values into Notion API property format. Use this when you need to construct property values for create_page or update_page_properties but don\'t want to manually build the nested Notion API structure. Supports: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, relation, people, files.',
    {
      properties: z.record(z.object({
        type: z.string().describe('Property type: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, relation, people, files'),
        value: z.any().describe('Simple value to convert. Strings for most types, number for number, boolean for checkbox, array of IDs for relation/people, array of URLs for files, {start, end} for date ranges'),
      })).describe('Map of property name → {type, value} pairs to convert'),
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
  // APPEND CONTENT — Add blocks to an existing page
  // ============================================================

  server.tool(
    'append_content',
    'Append content blocks to the end of an existing Notion page. Content is written in Markdown and automatically converted to Notion blocks. Use this to add new sections, paragraphs, lists, code blocks, or other content to a page without replacing existing content. Handles pages with >100 blocks by chunking automatically.',
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      content_markdown: z.string().describe('Markdown content to append. Supports: # headings, - bullet lists, 1. numbered lists, - [x] todos, > quotes, ```code blocks```, ---, **bold**, *italic*, [links](url)'),
    },
    async ({ page_id, content_markdown }) => {
      const blocks = markdownToBlocks(content_markdown);
      if (blocks.length === 0) {
        return { content: [{ type: 'text', text: 'No content to append — the markdown produced zero blocks.' }] };
      }
      const result = await notionClient.appendContent(page_id, blocks);
      return {
        content: [{
          type: 'text',
          text: `Appended ${result.appended} blocks to page.`,
        }],
      };
    }
  );

  // ============================================================
  // DELETE BLOCK — Archive a block
  // ============================================================

  server.tool(
    'delete_block',
    'Delete (archive) a specific block from a Notion page. The block is soft-deleted and can be recovered from Notion\'s trash. Use this to remove paragraphs, list items, headings, or any other block element from a page.',
    {
      block_id: z.string().describe('Block ID to delete (UUID)'),
    },
    async ({ block_id }) => {
      const result = await notionClient.deleteBlock(block_id);
      return { content: [{ type: 'text', text: `Block deleted: ${result.deleted}` }] };
    }
  );

  // ============================================================
  // CREATE DATABASE — New database under a parent page
  // ============================================================

  server.tool(
    'create_database',
    'Create a new Notion database as a child of an existing page. Define the schema with property definitions matching the Notion API format. At minimum, include a title property (e.g., {"Name": {"title": {}}}). Supports all property types: title, rich_text, number, select, multi_select, status, date, checkbox, url, email, phone_number, formula, relation, rollup, files, people, created_time, last_edited_time.',
    {
      parent_page_id: z.string().describe('Parent page ID (UUID or Notion URL) where the database will be created'),
      title: z.string().describe('Database title'),
      properties: z.record(z.any()).optional().describe('Database schema — map of property name to type definition. Default: {"Name": {"title": {}}}. Example: {"Name": {"title": {}}, "Status": {"select": {"options": [{"name": "To Do"}, {"name": "Done"}]}}, "Priority": {"number": {"format": "number"}}}'),
      icon: z.string().optional().describe('Database icon — emoji or URL'),
      description: z.string().optional().describe('Database description text'),
    },
    async ({ parent_page_id, title, properties, icon, description }) => {
      const result = await notionClient.createDatabase(parent_page_id, { title, properties, icon, description });
      return {
        content: [{
          type: 'text',
          text: `Database created.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // UPDATE DATABASE — Modify schema/title/description
  // ============================================================

  server.tool(
    'update_database',
    'Update an existing Notion database. Can modify the title, description, and schema (add new properties, rename existing ones, change property types or options). To add a new column, include it in properties. To rename, use the Notion API rename syntax. Existing properties not included in the update are left unchanged.',
    {
      database_id: z.string().describe('Notion database ID (UUID) or full Notion URL'),
      title: z.string().optional().describe('New database title'),
      properties: z.record(z.any()).optional().describe('Schema updates — property definitions to add or modify'),
      description: z.string().optional().describe('New database description'),
    },
    async ({ database_id, title, properties, description }) => {
      const result = await notionClient.updateDatabase(database_id, { title, properties, description });
      return {
        content: [{
          type: 'text',
          text: `Database updated.\nID: ${result.id}\nTitle: ${result.title}\nURL: ${result.url}`,
        }],
      };
    }
  );

  // ============================================================
  // GET COMMENTS — List comments on a page
  // ============================================================

  server.tool(
    'get_comments',
    'Retrieve all comments on a Notion page or block. Returns comment text, author, timestamp, and discussion thread IDs. Use discussion_id with create_comment to reply to specific threads.',
    {
      page_id: z.string().describe('Notion page or block ID (UUID) or full Notion URL'),
    },
    async ({ page_id }) => {
      const comments = await notionClient.getComments(page_id);
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
  // CREATE COMMENT — Add a comment to a page or reply to thread
  // ============================================================

  server.tool(
    'create_comment',
    'Add a comment to a Notion page or reply to an existing discussion thread. For page-level comments, provide page_id. For thread replies, provide discussion_id (from get_comments output). Comments appear in the page\'s comment section.',
    {
      page_id: z.string().describe('Notion page ID (UUID) or full Notion URL'),
      text: z.string().describe('Comment text content'),
      discussion_id: z.string().optional().describe('Discussion thread ID to reply to (from get_comments). Omit for a new top-level comment.'),
    },
    async ({ page_id, text, discussion_id }) => {
      const result = await notionClient.createComment(page_id, text, discussion_id);
      return {
        content: [{
          type: 'text',
          text: `Comment created.\nID: ${result.id}\nCreated: ${result.created_time}`,
        }],
      };
    }
  );

  // ============================================================
  // GET USERS — List workspace users
  // ============================================================

  server.tool(
    'get_users',
    'List all users in the Notion workspace. Returns user IDs, names, emails, types (person/bot), and avatar URLs. Use this to find user IDs for people properties, created_by filters, or to understand workspace membership.',
    {
      page_size: z.number().min(1).max(100).optional().describe('Number of users to return (default 100)'),
    },
    async ({ page_size }) => {
      const users = await notionClient.getUsers(page_size);
      const lines = users.map(u =>
        `${u.name} (${u.type}) — ID: ${u.id}${u.email ? ` — ${u.email}` : ''}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  return server;
}
