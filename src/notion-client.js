// notion-client.js — High-level Notion API client
// Wraps @notionhq/client with methods designed for LLM tool consumption

import { Client } from '@notionhq/client';
import { blocksToMarkdown, markdownToBlocks, formatProperties, formatDatabaseSchema } from './blocks.js';

// Workspace registry — maps alias to env var name
// Default workspace uses NOTION_TOKEN, extras use NOTION_TOKEN_{ALIAS}
const WORKSPACE_REGISTRY = {
  deflorance: 'NOTION_TOKEN',
  paolo: 'NOTION_TOKEN_PAOLO',
};

const DEFAULT_WORKSPACE = 'deflorance';

class NotionClient {
  constructor() {
    this.clients = {};  // workspace -> Client instance
  }

  /** Get or create a Notion Client for the given workspace */
  _getClient(workspace) {
    const ws = (workspace || DEFAULT_WORKSPACE).toLowerCase();
    if (this.clients[ws]) return this.clients[ws];

    const envVar = WORKSPACE_REGISTRY[ws];
    if (!envVar) {
      const available = Object.keys(WORKSPACE_REGISTRY).join(', ');
      throw new Error(`Unknown workspace "${ws}". Available: ${available}`);
    }
    const token = process.env[envVar];
    if (!token) throw new Error(`${envVar} env var required for workspace "${ws}"`);

    this.clients[ws] = new Client({ auth: token });
    return this.clients[ws];
  }

  /** @deprecated — backward compat, routes to default workspace */
  init() {
    this._getClient(DEFAULT_WORKSPACE);
  }

  /** Get the raw Notion SDK client for a workspace */
  get client() { return this._getClient(DEFAULT_WORKSPACE); }
  set client(_) { /* no-op for backward compat */ }

  // ============================================================
  // SEARCH
  // ============================================================

  async search(query, { filter_type, sort_direction, page_size, workspace } = {}) {
    const client = this._getClient(workspace);
    const params = { query, page_size: page_size || 10 };
    if (filter_type) params.filter = { property: 'object', value: filter_type };
    if (sort_direction) params.sort = { direction: sort_direction, timestamp: 'last_edited_time' };

    const response = await client.search(params);
    const results = response.results.map(r => {
      if (r.object === 'page') {
        const title = this._extractTitle(r);
        return {
          type: 'page',
          id: r.id,
          title,
          url: r.url,
          last_edited: r.last_edited_time,
          parent: r.parent?.type === 'database_id' ? `database:${r.parent.database_id}` : r.parent?.type,
        };
      } else if (r.object === 'database') {
        const title = r.title?.map(t => t.plain_text).join('') || 'Untitled';
        return {
          type: 'database',
          id: r.id,
          title,
          url: r.url,
          last_edited: r.last_edited_time,
        };
      }
      return { type: r.object, id: r.id };
    });

    return { results, has_more: response.has_more, next_cursor: response.next_cursor };
  }

  // ============================================================
  // FETCH PAGE (metadata + full content as Markdown)
  // ============================================================

  async fetchPage(pageId, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const page = await client.pages.retrieve({ page_id: id });
    const title = this._extractTitle(page);
    const properties = formatProperties(page.properties);
    const blocks = await this._getAllBlocks(id, 0, client);
    const content = blocksToMarkdown(blocks);

    return {
      id: page.id,
      title,
      url: page.url,
      icon: page.icon?.emoji || page.icon?.external?.url || null,
      cover: page.cover?.external?.url || page.cover?.file?.url || null,
      created_time: page.created_time,
      last_edited_time: page.last_edited_time,
      parent: page.parent,
      properties,
      content,
    };
  }

  // ============================================================
  // FETCH DATABASE (schema + views)
  // ============================================================

  async fetchDatabase(databaseId, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(databaseId);
    const db = await client.databases.retrieve({ database_id: id });
    const title = db.title?.map(t => t.plain_text).join('') || 'Untitled';
    const schema = formatDatabaseSchema(db.properties);

    return {
      id: db.id,
      title,
      url: db.url,
      icon: db.icon?.emoji || db.icon?.external?.url || null,
      description: db.description?.map(t => t.plain_text).join('') || '',
      is_inline: db.is_inline,
      created_time: db.created_time,
      last_edited_time: db.last_edited_time,
      schema,
    };
  }

  // ============================================================
  // QUERY DATABASE (with filters and sorts)
  // ============================================================

  async queryDatabase(databaseId, { filter, sorts, page_size, start_cursor, workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(databaseId);
    const params = { database_id: id, page_size: page_size || 20 };
    if (filter) params.filter = typeof filter === 'string' ? JSON.parse(filter) : filter;
    if (sorts) params.sorts = typeof sorts === 'string' ? JSON.parse(sorts) : sorts;
    if (start_cursor) params.start_cursor = start_cursor;

    const response = await client.databases.query(params);
    const results = response.results.map(page => ({
      id: page.id,
      url: page.url,
      properties: formatProperties(page.properties),
    }));

    return { results, has_more: response.has_more, next_cursor: response.next_cursor };
  }

  // ============================================================
  // CREATE PAGE
  // ============================================================

  async createPage(parentId, { properties, content, icon, cover, is_database, workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(parentId);
    const parent = is_database ? { database_id: id } : { page_id: id };
    const params = { parent };

    if (properties) {
      params.properties = properties;
    } else {
      params.properties = { title: { title: [{ type: 'text', text: { content: 'Untitled' } }] } };
    }

    if (content && Array.isArray(content) && content.length > 0) {
      // Notion limits children to 100 blocks per request
      params.children = content.slice(0, 100);
    }

    if (icon) params.icon = icon.startsWith('http') ? { type: 'external', external: { url: icon } } : { type: 'emoji', emoji: icon };
    if (cover) params.cover = { type: 'external', external: { url: cover } };

    const page = await client.pages.create(params);

    // Append remaining blocks if > 100
    if (content && content.length > 100) {
      for (let i = 100; i < content.length; i += 100) {
        await client.blocks.children.append({
          block_id: page.id,
          children: content.slice(i, i + 100),
        });
      }
    }

    return { id: page.id, url: page.url, title: this._extractTitle(page) };
  }

  // ============================================================
  // UPDATE PAGE PROPERTIES
  // ============================================================

  async updatePageProperties(pageId, properties, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const page = await client.pages.update({ page_id: id, properties });
    return { id: page.id, url: page.url, title: this._extractTitle(page) };
  }

  // ============================================================
  // APPEND CONTENT (blocks) TO PAGE
  // ============================================================

  async appendContent(pageId, blocks, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const results = [];
    for (let i = 0; i < blocks.length; i += 100) {
      const response = await client.blocks.children.append({
        block_id: id,
        children: blocks.slice(i, i + 100),
      });
      results.push(...response.results);
    }
    return { appended: results.length, block_ids: results.map(b => b.id) };
  }

  // ============================================================
  // DELETE BLOCK
  // ============================================================

  async deleteBlock(blockId, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(blockId);
    await client.blocks.update({ block_id: id, archived: true });
    return { deleted: id };
  }

  // ============================================================
  // CREATE DATABASE
  // ============================================================

  async createDatabase(parentPageId, { title, properties, icon, description, workspace }) {
    const client = this._getClient(workspace);
    const id = this._cleanId(parentPageId);
    const params = {
      parent: { page_id: id },
      title: [{ type: 'text', text: { content: title || 'Untitled Database' } }],
      properties: properties || { Name: { title: {} } },
    };
    if (icon) params.icon = icon.startsWith('http') ? { type: 'external', external: { url: icon } } : { type: 'emoji', emoji: icon };
    if (description) params.description = [{ type: 'text', text: { content: description } }];

    const db = await client.databases.create(params);
    return { id: db.id, url: db.url, title: db.title?.map(t => t.plain_text).join('') };
  }

  // ============================================================
  // UPDATE DATABASE SCHEMA
  // ============================================================

  async updateDatabase(databaseId, { title, properties, description, workspace }) {
    const client = this._getClient(workspace);
    const id = this._cleanId(databaseId);
    const params = { database_id: id };
    if (title) params.title = [{ type: 'text', text: { content: title } }];
    if (properties) params.properties = properties;
    if (description) params.description = [{ type: 'text', text: { content: description } }];

    const db = await client.databases.update(params);
    return { id: db.id, url: db.url, title: db.title?.map(t => t.plain_text).join('') };
  }

  // ============================================================
  // COMMENTS
  // ============================================================

  async getComments(pageId, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const response = await client.comments.list({ block_id: id });
    return response.results.map(c => ({
      id: c.id,
      created_time: c.created_time,
      created_by: c.created_by?.name || c.created_by?.id,
      text: c.rich_text?.map(rt => rt.plain_text).join('') || '',
      discussion_id: c.discussion_id,
    }));
  }

  async createComment(pageId, text, discussionId, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const params = {
      rich_text: [{ type: 'text', text: { content: text } }],
    };
    if (discussionId) {
      params.discussion_id = discussionId;
    } else {
      params.parent = { page_id: id };
    }
    const comment = await client.comments.create(params);
    return { id: comment.id, created_time: comment.created_time };
  }

  // ============================================================
  // USERS
  // ============================================================

  async getUsers(page_size, { workspace } = {}) {
    const client = this._getClient(workspace);
    const response = await client.users.list({ page_size: page_size || 100 });
    return response.results.map(u => ({
      id: u.id,
      type: u.type,
      name: u.name,
      email: u.person?.email || null,
      avatar: u.avatar_url,
    }));
  }

  async getUser(userId, { workspace } = {}) {
    const client = this._getClient(workspace);
    const user = await client.users.retrieve({ user_id: userId });
    return {
      id: user.id,
      type: user.type,
      name: user.name,
      email: user.person?.email || null,
      avatar: user.avatar_url,
    };
  }

  // ============================================================
  // ARCHIVE / UNARCHIVE / DELETE PAGES
  // ============================================================

  async archivePages(pageIds, { workspace } = {}) {
    const client = this._getClient(workspace);
    const results = [];
    for (const pid of pageIds) {
      const id = this._cleanId(pid);
      await client.pages.update({ page_id: id, archived: true });
      results.push(id);
    }
    return { archived: results };
  }

  async unarchivePages(pageIds, { workspace } = {}) {
    const client = this._getClient(workspace);
    const results = [];
    for (const pid of pageIds) {
      const id = this._cleanId(pid);
      await client.pages.update({ page_id: id, archived: false });
      results.push(id);
    }
    return { unarchived: results };
  }

  async deletePages(pageIds, opts = {}) {
    return this.archivePages(pageIds, opts);
  }

  async deleteDatabases(databaseIds, opts = {}) {
    return this.archivePages(databaseIds, opts);
  }

  // ============================================================
  // UPDATE PAGE CONTENT (oldStr/newStr diffing)
  // ============================================================

  async updatePageContent(pageId, contentUpdates, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);

    for (const update of contentUpdates) {
      if (!update.oldStr) {
        // Full replacement: delete all blocks, append new content
        const existingBlocks = await this._getAllBlocks(id, 0, client);
        for (const block of existingBlocks) {
          try { await client.blocks.update({ block_id: block.id, archived: true }); } catch (e) { /* skip undeletable */ }
        }
        if (update.newStr) {
          const newBlocks = markdownToBlocks(update.newStr);
          await this.appendContent(id, newBlocks, { workspace });
        }
      } else {
        // Targeted replacement: find matching blocks, replace
        const blocks = await this._getAllBlocks(id, 0, client);
        const fullMarkdown = blocksToMarkdown(blocks);

        if (!fullMarkdown.includes(update.oldStr)) {
          throw new Error(`Content not found: "${update.oldStr.substring(0, 100)}..."`);
        }

        // Simple approach: replace in markdown, then replace all content
        let newMarkdown;
        if (update.replaceAllMatches) {
          newMarkdown = fullMarkdown.split(update.oldStr).join(update.newStr);
        } else {
          const idx = fullMarkdown.indexOf(update.oldStr);
          newMarkdown = fullMarkdown.substring(0, idx) + update.newStr + fullMarkdown.substring(idx + update.oldStr.length);
        }

        // Delete all existing blocks and replace with new content
        for (const block of blocks) {
          try { await client.blocks.update({ block_id: block.id, archived: true }); } catch (e) { /* skip */ }
        }
        const newBlocks = markdownToBlocks(newMarkdown);
        if (newBlocks.length > 0) {
          await this.appendContent(id, newBlocks, { workspace });
        }
      }
    }

    return this.fetchPage(pageId, { workspace });
  }

  // ============================================================
  // BLOCK OPERATIONS
  // ============================================================

  async fetchBlockChildren(blockId, { page_size, start_cursor, workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(blockId);
    const params = { block_id: id, page_size: page_size || 100 };
    if (start_cursor) params.start_cursor = start_cursor;
    const response = await client.blocks.children.list(params);
    return {
      results: response.results,
      has_more: response.has_more,
      next_cursor: response.next_cursor,
    };
  }

  async updateBlock(blockId, data, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(blockId);
    const block = await client.blocks.update({ block_id: id, ...data });
    return { id: block.id, type: block.type };
  }

  // ============================================================
  // TWO-WAY RELATION
  // ============================================================

  async createTwoWayRelation(sourceDbId, targetDbId, sourcePropName, targetPropName, { workspace } = {}) {
    const client = this._getClient(workspace);
    const srcId = this._cleanId(sourceDbId);
    const tgtId = this._cleanId(targetDbId);
    const properties = {};
    properties[sourcePropName] = {
      type: 'relation',
      relation: {
        database_id: tgtId,
        type: 'dual_property',
        dual_property: { synced_property_name: targetPropName },
      },
    };
    const db = await client.databases.update({ database_id: srcId, properties });
    return {
      source_database_id: srcId,
      target_database_id: tgtId,
      source_property: sourcePropName,
      target_property: targetPropName,
    };
  }

  // ============================================================
  // PAGE PROPERTY (paginated retrieval)
  // ============================================================

  async getPageProperty(pageId, propertyId, { page_size, start_cursor, workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const params = { page_id: id, property_id: propertyId };
    if (page_size) params.page_size = page_size;
    if (start_cursor) params.start_cursor = start_cursor;
    const response = await client.pages.properties.retrieve(params);
    return response;
  }

  // ============================================================
  // MOVE PAGE
  // ============================================================

  async movePage(pageId, newParentId, isDatabase = false, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const parentId = this._cleanId(newParentId);
    const parent = isDatabase ? { database_id: parentId } : { page_id: parentId };
    const page = await client.pages.update({ page_id: id, ...{ parent } });
    return { id: page.id, url: page.url };
  }

  // ============================================================
  // DUPLICATE PAGE
  // ============================================================

  async duplicatePage(sourcePageId, newParentId, newTitle, { workspace } = {}) {
    const source = await this.fetchPage(sourcePageId, { workspace });

    // Build properties for new page
    let properties = {};
    if (newTitle) {
      properties = { title: { title: [{ type: 'text', text: { content: newTitle } }] } };
    }

    // Determine parent
    const parent = source.parent;
    let parentId = newParentId;
    let isDatabase = false;
    if (!parentId) {
      if (parent.database_id) { parentId = parent.database_id; isDatabase = true; }
      else if (parent.page_id) { parentId = parent.page_id; }
      else { throw new Error('Cannot determine parent for duplication'); }
    }

    // Convert content back to blocks
    const blocks = markdownToBlocks(source.content || '');

    return this.createPage(parentId, {
      properties: Object.keys(properties).length > 0 ? properties : undefined,
      content: blocks.length > 0 ? blocks : undefined,
      icon: source.icon,
      cover: source.cover,
      is_database: isDatabase,
      workspace,
    });
  }

  // ============================================================
  // HELPERS
  // ============================================================

  _cleanId(idOrUrl) {
    if (!idOrUrl) return idOrUrl;
    // Extract UUID from Notion URL
    const urlMatch = idOrUrl.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (urlMatch) return urlMatch[1];
    return idOrUrl.replace(/-/g, '');
  }

  _extractTitle(page) {
    if (!page.properties) return 'Untitled';
    for (const prop of Object.values(page.properties)) {
      if (prop.type === 'title') {
        return prop.title?.map(t => t.plain_text).join('') || 'Untitled';
      }
    }
    return 'Untitled';
  }

  async _getAllBlocks(blockId, depth = 0, client = null) {
    if (depth > 3) return []; // prevent infinite recursion, limit to 3 levels deep
    const c = client || this._getClient(DEFAULT_WORKSPACE);
    const blocks = [];
    let cursor = undefined;

    do {
      const response = await c.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const block of response.results) {
        if (block.has_children) {
          block.children = await this._getAllBlocks(block.id, depth + 1, c);
        }
        blocks.push(block);
      }

      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    return blocks;
  }
}

export const notionClient = new NotionClient();
