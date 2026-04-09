// notion-client.js — High-level Notion API client
// Wraps @notionhq/client with methods designed for LLM tool consumption

import { Client } from '@notionhq/client';
import { blocksToMarkdown, formatProperties, formatDatabaseSchema } from './blocks.js';

class NotionClient {
  constructor() {
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;
    const token = process.env.NOTION_TOKEN;
    if (!token) throw new Error('NOTION_TOKEN env var required');
    this.client = new Client({ auth: token });
    this.initialized = true;
  }

  // ============================================================
  // SEARCH
  // ============================================================

  async search(query, { filter_type, sort_direction, page_size } = {}) {
    this.init();
    const params = { query, page_size: page_size || 10 };
    if (filter_type) params.filter = { property: 'object', value: filter_type };
    if (sort_direction) params.sort = { direction: sort_direction, timestamp: 'last_edited_time' };

    const response = await this.client.search(params);
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

  async fetchPage(pageId) {
    this.init();
    const id = this._cleanId(pageId);
    const page = await this.client.pages.retrieve({ page_id: id });
    const title = this._extractTitle(page);
    const properties = formatProperties(page.properties);
    const blocks = await this._getAllBlocks(id);
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

  async fetchDatabase(databaseId) {
    this.init();
    const id = this._cleanId(databaseId);
    const db = await this.client.databases.retrieve({ database_id: id });
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

  async queryDatabase(databaseId, { filter, sorts, page_size, start_cursor } = {}) {
    this.init();
    const id = this._cleanId(databaseId);
    const params = { database_id: id, page_size: page_size || 20 };
    if (filter) params.filter = typeof filter === 'string' ? JSON.parse(filter) : filter;
    if (sorts) params.sorts = typeof sorts === 'string' ? JSON.parse(sorts) : sorts;
    if (start_cursor) params.start_cursor = start_cursor;

    const response = await this.client.databases.query(params);
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

  async createPage(parentId, { properties, content, icon, cover, is_database } = {}) {
    this.init();
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

    const page = await this.client.pages.create(params);

    // Append remaining blocks if > 100
    if (content && content.length > 100) {
      for (let i = 100; i < content.length; i += 100) {
        await this.client.blocks.children.append({
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

  async updatePageProperties(pageId, properties) {
    this.init();
    const id = this._cleanId(pageId);
    const page = await this.client.pages.update({ page_id: id, properties });
    return { id: page.id, url: page.url, title: this._extractTitle(page) };
  }

  // ============================================================
  // APPEND CONTENT (blocks) TO PAGE
  // ============================================================

  async appendContent(pageId, blocks) {
    this.init();
    const id = this._cleanId(pageId);
    const results = [];
    for (let i = 0; i < blocks.length; i += 100) {
      const response = await this.client.blocks.children.append({
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

  async deleteBlock(blockId) {
    this.init();
    const id = this._cleanId(blockId);
    await this.client.blocks.update({ block_id: id, archived: true });
    return { deleted: id };
  }

  // ============================================================
  // CREATE DATABASE
  // ============================================================

  async createDatabase(parentPageId, { title, properties, icon, description }) {
    this.init();
    const id = this._cleanId(parentPageId);
    const params = {
      parent: { page_id: id },
      title: [{ type: 'text', text: { content: title || 'Untitled Database' } }],
      properties: properties || { Name: { title: {} } },
    };
    if (icon) params.icon = icon.startsWith('http') ? { type: 'external', external: { url: icon } } : { type: 'emoji', emoji: icon };
    if (description) params.description = [{ type: 'text', text: { content: description } }];

    const db = await this.client.databases.create(params);
    return { id: db.id, url: db.url, title: db.title?.map(t => t.plain_text).join('') };
  }

  // ============================================================
  // UPDATE DATABASE SCHEMA
  // ============================================================

  async updateDatabase(databaseId, { title, properties, description }) {
    this.init();
    const id = this._cleanId(databaseId);
    const params = { database_id: id };
    if (title) params.title = [{ type: 'text', text: { content: title } }];
    if (properties) params.properties = properties;
    if (description) params.description = [{ type: 'text', text: { content: description } }];

    const db = await this.client.databases.update(params);
    return { id: db.id, url: db.url, title: db.title?.map(t => t.plain_text).join('') };
  }

  // ============================================================
  // COMMENTS
  // ============================================================

  async getComments(pageId) {
    this.init();
    const id = this._cleanId(pageId);
    const response = await this.client.comments.list({ block_id: id });
    return response.results.map(c => ({
      id: c.id,
      created_time: c.created_time,
      created_by: c.created_by?.name || c.created_by?.id,
      text: c.rich_text?.map(rt => rt.plain_text).join('') || '',
      discussion_id: c.discussion_id,
    }));
  }

  async createComment(pageId, text, discussionId) {
    this.init();
    const id = this._cleanId(pageId);
    const params = {
      rich_text: [{ type: 'text', text: { content: text } }],
    };
    if (discussionId) {
      params.discussion_id = discussionId;
    } else {
      params.parent = { page_id: id };
    }
    const comment = await this.client.comments.create(params);
    return { id: comment.id, created_time: comment.created_time };
  }

  // ============================================================
  // USERS
  // ============================================================

  async getUsers(page_size) {
    this.init();
    const response = await this.client.users.list({ page_size: page_size || 100 });
    return response.results.map(u => ({
      id: u.id,
      type: u.type,
      name: u.name,
      email: u.person?.email || null,
      avatar: u.avatar_url,
    }));
  }

  async getUser(userId) {
    this.init();
    const user = await this.client.users.retrieve({ user_id: userId });
    return {
      id: user.id,
      type: user.type,
      name: user.name,
      email: user.person?.email || null,
      avatar: user.avatar_url,
    };
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

  async _getAllBlocks(blockId, depth = 0) {
    if (depth > 3) return []; // prevent infinite recursion, limit to 3 levels deep
    const blocks = [];
    let cursor = undefined;

    do {
      const response = await this.client.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const block of response.results) {
        if (block.has_children) {
          block.children = await this._getAllBlocks(block.id, depth + 1);
        }
        blocks.push(block);
      }

      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);

    return blocks;
  }
}

export const notionClient = new NotionClient();
