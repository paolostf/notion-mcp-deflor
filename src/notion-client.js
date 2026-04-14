// notion-client.js — High-level Notion API client
// Wraps @notionhq/client with methods designed for LLM tool consumption
// v2.6.0 — Surgical content editing, operation locking, idempotency

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
    this._pageLocks = new Map();  // pageId -> Promise (mutex per page)
    this._opCache = new Map();  // opHash -> { result, timestamp }
    this._OP_CACHE_TTL = 30000;  // 30s idempotency window
  }

  // ============================================================
  // PAGE LOCK — prevents concurrent destructive operations on same page
  // ============================================================

  async _withPageLock(pageId, fn) {
    // Wait for any existing lock on this page to release
    while (this._pageLocks.has(pageId)) {
      await this._pageLocks.get(pageId).catch(() => {});
    }
    // Acquire lock
    let resolve;
    const lockPromise = new Promise(r => { resolve = r; });
    this._pageLocks.set(pageId, lockPromise);
    try {
      return await fn();
    } finally {
      this._pageLocks.delete(pageId);
      resolve();
    }
  }

  // ============================================================
  // IDEMPOTENCY — prevents retry re-execution of destructive ops
  // ============================================================

  _opHash(pageId, updates) {
    // Deterministic hash of the operation params
    const key = JSON.stringify({ pageId, updates });
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }
    return `op_${pageId}_${hash}`;
  }

  _getCachedOp(hash) {
    const entry = this._opCache.get(hash);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this._OP_CACHE_TTL) {
      this._opCache.delete(hash);
      return null;
    }
    return entry.result;
  }

  _cacheOp(hash, result) {
    this._opCache.set(hash, { result, timestamp: Date.now() });
    // Prune old entries every 50 operations
    if (this._opCache.size > 50) {
      const now = Date.now();
      for (const [k, v] of this._opCache) {
        if (now - v.timestamp > this._OP_CACHE_TTL) this._opCache.delete(k);
      }
    }
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

  async fetchPage(pageId, { workspace, max_content_length } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const page = await client.pages.retrieve({ page_id: id });
    const title = this._extractTitle(page);
    const properties = formatProperties(page.properties);
    const blocks = await this._getAllBlocks(id, 0, client);
    let content = blocksToMarkdown(blocks);

    let truncated = false;
    if (max_content_length && content.length > max_content_length) {
      content = content.substring(0, max_content_length);
      truncated = true;
    }

    const result = {
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

    if (truncated) {
      result.truncated = true;
      result.full_content_length = blocks.length;
      result.note = `Content truncated at ${max_content_length} chars. Use fetch_block_children with pagination for full content.`;
    }

    return result;
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

  async appendContent(pageId, blocks, { workspace, after } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);
    const results = [];

    for (let i = 0; i < blocks.length; i += 100) {
      const params = {
        block_id: id,
        children: blocks.slice(i, i + 100),
      };
      // Use 'after' param for first batch only; subsequent batches follow naturally
      if (i === 0 && after) {
        params.after = after;
      }
      const response = await client.blocks.children.append(params);
      results.push(...response.results);
      // For subsequent batches, insert after the last block of previous batch
      if (results.length > 0 && i + 100 < blocks.length) {
        // Next batch inserts after the last block we just created
        // But we need to NOT pass 'after' for subsequent batches since
        // Notion appends at the end by default (after our just-created blocks)
        // Actually, without 'after', it appends at the very end of the page,
        // which is correct since we're building sequentially
      }
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
  // UPDATE PAGE CONTENT (v2.6.0 — surgical editing)
  //
  // Priority chain for targeted edits (oldStr/newStr):
  //   1. IN-PLACE: If edit is within ONE block → blocks.update on rich_text.
  //      No deletion, no creation, no markdown round-trip.
  //      Preserves: block ID, comments, formatting, children.
  //   2. BLOCK-LEVEL: If edit spans multiple blocks → insert new blocks
  //      at correct position (after param), then delete affected blocks.
  //      Insert-before-delete = interruption produces duplicates, not data loss.
  //   3. FULL REPLACE: Fallback for edge cases (fuzzy match, block-0 edits).
  //      Append new content, then delete old blocks.
  //
  // For full replacement (no oldStr):
  //   Uses append-then-delete with page lock + idempotency guard.
  //
  // Per-page mutex lock prevents concurrent destructive operations.
  // Idempotency cache prevents MCP transport retries from re-executing.
  // ============================================================

  async updatePageContent(pageId, contentUpdates, { workspace } = {}) {
    const client = this._getClient(workspace);
    const id = this._cleanId(pageId);

    // Idempotency check: if this exact operation was already completed recently, return cached result
    const opHash = this._opHash(id, contentUpdates);
    const cached = this._getCachedOp(opHash);
    if (cached) {
      return { ...cached, idempotent_replay: true };
    }

    // Acquire page-level lock (prevents concurrent modifications)
    const result = await this._withPageLock(id, async () => {
      // Double-check idempotency inside lock (another request may have completed while we waited)
      const cached2 = this._getCachedOp(opHash);
      if (cached2) return { ...cached2, idempotent_replay: true };

      for (const update of contentUpdates) {
        if (!update.oldStr) {
          // Full replacement: delete all blocks, append new content
          await this._safeFullReplace(id, update.newStr, workspace, client);
        } else if (update.replaceAllMatches) {
          // Replace all occurrences: must rebuild entire page content
          await this._replaceAllInPage(id, update, workspace, client);
        } else {
          // Targeted single replacement: surgical block-level edit
          await this._surgicalReplace(id, update, workspace, client);
        }
      }

      return { id, status: 'updated', updates_applied: contentUpdates.length };
    });

    // Cache the result for idempotency
    this._cacheOp(opHash, result);
    return result;
  }

  /**
   * Full page content replacement.
   * Order: append new content at end → delete old blocks.
   * If interrupted after append but before delete: duplicated content (recoverable).
   * If interrupted during delete: partial old content remains (recoverable).
   * Page lock prevents retries from causing infinite loops.
   */
  async _safeFullReplace(pageId, newContent, workspace, client) {
    const existingBlocks = await this._getAllBlocks(pageId, 0, client);

    if (newContent) {
      const newBlocks = markdownToBlocks(newContent);
      if (newBlocks.length > 0) {
        await this.appendContent(pageId, newBlocks, { workspace });
      }
    }

    // Delete old blocks (new content is already appended at the end)
    if (existingBlocks.length > 0) {
      await this._deleteBlocksBatch(existingBlocks, client);
    }
  }

  /**
   * Replace all occurrences of oldStr with newStr across entire page.
   * Must rebuild full page since matches may span block boundaries.
   * Uses safe full replace (append-then-delete).
   */
  async _replaceAllInPage(pageId, update, workspace, client) {
    const blocks = await this._getAllBlocks(pageId, 0, client);
    const fullMarkdown = blocksToMarkdown(blocks);

    const newMarkdown = this._normalizedReplace(fullMarkdown, update.oldStr, update.newStr, true);

    if (newMarkdown === fullMarkdown) {
      throw new Error(`Content not found: "${update.oldStr.substring(0, 100)}..." — Try using fetch_page first to get the exact text.`);
    }

    // Use safe full replace: append new, delete old
    const newBlocks = markdownToBlocks(newMarkdown);
    if (newBlocks.length > 0) {
      await this.appendContent(pageId, newBlocks, { workspace });
    }
    if (blocks.length > 0) {
      await this._deleteBlocksBatch(blocks, client);
    }
  }

  /**
   * Surgical single-occurrence replacement.
   *
   * Strategy (in priority order):
   * 1. IN-PLACE UPDATE: If the edit falls within a single block, modify
   *    that block's rich_text directly via blocks.update. No deletion,
   *    no creation, no markdown round-trip. Preserves block ID, comments,
   *    and formatting on unaffected segments.
   * 2. BLOCK-LEVEL REPLACE: If the edit spans multiple blocks, insert new
   *    blocks at the correct position (using 'after' param), then delete
   *    only the affected blocks. Insert-before-delete = safe on interruption.
   * 3. SAFE FULL REPLACE: Fallback for edge cases (fuzzy match, block 0 edits).
   */
  async _surgicalReplace(pageId, update, workspace, client) {
    const blocks = await this._getAllBlocks(pageId, 0, client);

    // Build per-block markdown with character offset mapping
    const blockMeta = [];
    let offset = 0;
    for (let i = 0; i < blocks.length; i++) {
      const md = blocksToMarkdown([blocks[i]]);
      blockMeta.push({
        block: blocks[i],
        markdown: md,
        start: offset,
        end: offset + md.length,
      });
      offset += md.length;
      if (i < blocks.length - 1) offset += 1; // \n separator
    }

    const fullMarkdown = blockMeta.map(bm => bm.markdown).join('\n');
    const normFull = this._normalizeText(fullMarkdown);
    const normOld = this._normalizeText(update.oldStr);

    // Find match position in normalized text
    let matchStart = normFull.indexOf(normOld);

    if (matchStart === -1) {
      // Try fuzzy match (collapse whitespace)
      const fuzzyFull = normFull.replace(/\s+/g, ' ');
      const fuzzyOld = normOld.replace(/\s+/g, ' ');
      if (!fuzzyFull.includes(fuzzyOld)) {
        throw new Error(
          `Content not found: "${update.oldStr.substring(0, 100)}..." — ` +
          `Try using fetch_page first to get the exact text, or use append_content to add to the end instead.`
        );
      }
      // Fuzzy match found but can't map to exact block positions — fall back to full replace
      const newMarkdown = this._normalizedReplace(fullMarkdown, update.oldStr, update.newStr, false);
      await this._safeFullReplace(pageId, newMarkdown, workspace, client);
      return;
    }

    const matchEnd = matchStart + normOld.length;

    // Map character offsets to block indices
    let startBlockIdx = -1;
    let endBlockIdx = -1;
    for (let i = 0; i < blockMeta.length; i++) {
      const bm = blockMeta[i];
      if (startBlockIdx === -1 && bm.end > matchStart) {
        startBlockIdx = i;
      }
      if (bm.start < matchEnd) {
        endBlockIdx = i;
      }
    }

    if (startBlockIdx === -1) startBlockIdx = 0;
    if (endBlockIdx === -1) endBlockIdx = blocks.length - 1;

    // ──────────────────────────────────────────────────────
    // STRATEGY 1: IN-PLACE UPDATE (single block, no structural change)
    // ──────────────────────────────────────────────────────
    if (startBlockIdx === endBlockIdx) {
      const block = blocks[startBlockIdx];
      const updated = this._tryInPlaceBlockUpdate(block, update.oldStr, update.newStr);
      if (updated) {
        // Apply the in-place update via Notion API — preserves block ID, comments, formatting
        await client.blocks.update({ block_id: block.id, ...updated });
        return;
      }
      // If in-place update not possible (structural change), fall through to block-level replace
    }

    // ──────────────────────────────────────────────────────
    // STRATEGY 2: BLOCK-LEVEL REPLACE (multi-block or structural change)
    // Insert new blocks at correct position, then delete affected blocks.
    // ──────────────────────────────────────────────────────
    const affectedMarkdown = blockMeta
      .slice(startBlockIdx, endBlockIdx + 1)
      .map(bm => bm.markdown)
      .join('\n');

    const newAffectedMarkdown = this._normalizedReplace(
      affectedMarkdown, update.oldStr, update.newStr, false
    );

    const newBlocks = markdownToBlocks(newAffectedMarkdown);
    const anchorBlockId = startBlockIdx > 0 ? blocks[startBlockIdx - 1].id : null;

    // SAFE ORDER: INSERT FIRST, DELETE SECOND
    if (newBlocks.length > 0) {
      if (anchorBlockId) {
        await this._appendAfter(pageId, newBlocks, anchorBlockId, client);
      } else {
        // Edit affects the first block and in-place update wasn't possible.
        // Fall back to safe full replace for this edge case.
        const newFullMarkdown = this._normalizedReplace(fullMarkdown, update.oldStr, update.newStr, false);
        await this._safeFullReplace(pageId, newFullMarkdown, workspace, client);
        return;
      }
    }

    // Delete the old affected blocks
    const affectedBlocks = blocks.slice(startBlockIdx, endBlockIdx + 1);
    await this._deleteBlocksBatch(affectedBlocks, client);
  }

  // ============================================================
  // IN-PLACE BLOCK UPDATE — modifies rich_text directly, no round-trip
  // ============================================================

  /**
   * Try to update a block's text content in-place by modifying its rich_text array.
   * Returns the Notion API update payload if successful, or null if not possible.
   *
   * Works for: paragraph, heading_1/2/3, bulleted_list_item, numbered_list_item,
   * to_do, toggle, quote, callout, code.
   *
   * Preserves: block ID, block type, formatting on unaffected rich_text segments,
   * comments attached to the block, block color, children.
   */
  _tryInPlaceBlockUpdate(block, oldStr, newStr) {
    const type = block.type;
    const data = block[type];
    if (!data || !data.rich_text) return null;

    // Don't attempt in-place if newStr contains newlines (would need new blocks)
    if (newStr.includes('\n')) return null;

    // Get the full plain text of this block
    const segments = data.rich_text;
    const fullText = segments.map(s => s.plain_text || '').join('');
    const normFullText = this._normalizeText(fullText);
    const normOld = this._normalizeText(oldStr);

    const normIdx = normFullText.indexOf(normOld);
    if (normIdx === -1) return null;

    // Map normalized match position back to original text positions
    const origStart = this._mapNormToOrigIndex(fullText, normIdx);
    const origEnd = this._mapNormToOrigIndex(fullText, normIdx + normOld.length);

    // Build new rich_text array with the replacement applied
    const newRichText = this._spliceRichText(segments, origStart, origEnd, newStr);
    if (!newRichText) return null;

    // Build the update payload — only the block type key with new rich_text
    const payload = {};
    payload[type] = { rich_text: newRichText };

    return payload;
  }

  /**
   * Splice a replacement string into a rich_text array at character positions
   * [start, end). Preserves annotations on segments before and after the edit.
   * Segments that partially overlap the edit range are split.
   *
   * Returns new rich_text array, or null if the splice isn't possible.
   */
  _spliceRichText(segments, start, end, replacement) {
    const result = [];
    let charPos = 0;

    for (const seg of segments) {
      const text = seg.plain_text || '';
      const segStart = charPos;
      const segEnd = charPos + text.length;

      if (segEnd <= start || segStart >= end) {
        // Segment is entirely outside the edit range — keep as-is
        result.push(this._cloneRichTextSegment(seg));
      } else {
        // Segment overlaps the edit range

        // Part before the edit (if any)
        if (segStart < start) {
          const beforeText = text.substring(0, start - segStart);
          result.push(this._cloneRichTextSegment(seg, beforeText));
        }

        // Insert the replacement text (only once, at the first overlapping segment)
        if (segStart <= start) {
          if (replacement) {
            // Inherit annotations from the segment where the edit starts
            result.push(this._cloneRichTextSegment(seg, replacement));
          }
        }

        // Part after the edit (if any)
        if (segEnd > end) {
          const afterText = text.substring(end - segStart);
          result.push(this._cloneRichTextSegment(seg, afterText));
        }
      }

      charPos = segEnd;
    }

    // Filter out empty text segments
    return result.filter(s => s.text?.content);
  }

  /**
   * Clone a rich_text segment, optionally replacing its text content.
   * Preserves: annotations (bold, italic, strikethrough, underline, code, color),
   * link URL, and type.
   */
  _cloneRichTextSegment(seg, newContent) {
    const clone = {
      type: 'text',
      text: {
        content: newContent !== undefined ? newContent : (seg.plain_text || seg.text?.content || ''),
      },
      annotations: seg.annotations ? { ...seg.annotations } : undefined,
    };

    // Preserve link if present and content is unchanged or explicitly set
    if (seg.text?.link?.url) {
      clone.text.link = { url: seg.text.link.url };
    }

    // Remove undefined annotations key to keep payload clean
    if (!clone.annotations) delete clone.annotations;

    return clone;
  }

  /**
   * Append blocks after a specific block using Notion's 'after' parameter.
   * Handles chunking for >100 blocks.
   */
  async _appendAfter(pageId, blocks, afterBlockId, client) {
    let currentAfter = afterBlockId;
    for (let i = 0; i < blocks.length; i += 100) {
      const chunk = blocks.slice(i, i + 100);
      const response = await client.blocks.children.append({
        block_id: pageId,
        children: chunk,
        after: currentAfter,
      });
      // For subsequent chunks, insert after the last block of this chunk
      if (response.results.length > 0) {
        currentAfter = response.results[response.results.length - 1].id;
      }
    }
  }

  /** Delete blocks in parallel batches of 10 for speed. Silently ignores already-deleted blocks. */
  async _deleteBlocksBatch(blocks, client) {
    const BATCH_SIZE = 10;
    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
      const batch = blocks.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(block =>
        client.blocks.update({ block_id: block.id, archived: true }).catch((err) => {
          // Ignore 404 (already deleted) and 409 (conflict) — safe for retries
          if (err?.status === 404 || err?.status === 409) return;
          // Log but don't throw for other errors during batch delete
          console.warn(`Block delete warning (${block.id}): ${err?.message || err}`);
        })
      ));
    }
  }

  /**
   * Normalize text for comparison.
   * Handles all unicode variants commonly produced by Notion's renderer:
   * em dash, en dash, minus sign, horizontal bar, smart quotes,
   * non-breaking space, multiplication sign, line endings.
   */
  _normalizeText(text) {
    return text
      .normalize('NFC')
      // Dashes
      .replace(/\u2014/g, '\u2014')  // em dash — keep canonical
      .replace(/\u2013/g, '\u2013')  // en dash – keep canonical
      .replace(/\u2212/g, '-')       // minus sign → hyphen
      .replace(/\u2015/g, '\u2014')  // horizontal bar → em dash
      .replace(/\uFE58/g, '\u2014')  // small em dash → em dash
      // Quotes
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")  // smart single quotes + variants
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')  // smart double quotes + variants
      // Spaces
      .replace(/\u00A0/g, ' ')       // non-breaking space
      .replace(/\u2007/g, ' ')       // figure space
      .replace(/\u202F/g, ' ')       // narrow non-breaking space
      .replace(/\u200B/g, '')        // zero-width space (remove)
      .replace(/\uFEFF/g, '')        // BOM / zero-width no-break space (remove)
      // Math/symbols
      .replace(/\u00D7/g, 'x')      // multiplication sign × → x
      .replace(/\u2026/g, '...')     // ellipsis → three dots
      // Line endings
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }

  /**
   * Replace using normalized matching but preserve original content around the match.
   * Fixed: uses character-by-character mapping between original and normalized text
   * to correctly handle cases where normalization changes string length.
   */
  _normalizedReplace(original, oldStr, newStr, replaceAll) {
    const normOrig = this._normalizeText(original);
    const normOld = this._normalizeText(oldStr);

    if (!replaceAll) {
      // Single replacement
      const normIdx = normOrig.indexOf(normOld);
      if (normIdx === -1) return original;

      // Map normalized index back to original index
      const origStart = this._mapNormToOrigIndex(original, normIdx);
      const origEnd = this._mapNormToOrigIndex(original, normIdx + normOld.length);

      return original.substring(0, origStart) + newStr + original.substring(origEnd);
    }

    // Replace all: find all occurrences and replace from end to start
    // (reverse order prevents index shifting)
    const matches = [];
    let searchFrom = 0;
    while (searchFrom < normOrig.length) {
      const idx = normOrig.indexOf(normOld, searchFrom);
      if (idx === -1) break;
      matches.push(idx);
      searchFrom = idx + normOld.length;
    }

    if (matches.length === 0) return original;

    // Apply replacements from end to start
    let result = original;
    for (let i = matches.length - 1; i >= 0; i--) {
      const normIdx = matches[i];
      const origStart = this._mapNormToOrigIndex(original, normIdx);
      const origEnd = this._mapNormToOrigIndex(original, normIdx + normOld.length);
      result = result.substring(0, origStart) + newStr + result.substring(origEnd);
    }
    return result;
  }

  /**
   * Map a character index in normalized text back to the corresponding index
   * in the original text. Handles length changes from normalization (e.g.,
   * \u2026 "…" (1 char) → "..." (3 chars) in normalized, or \u200B removed).
   */
  _mapNormToOrigIndex(original, normTargetIdx) {
    // Walk both strings simultaneously
    let origIdx = 0;
    let normIdx = 0;
    const normOrig = this._normalizeText(original);

    while (normIdx < normTargetIdx && origIdx < original.length) {
      // How many normalized chars does the current original char produce?
      const origChar = original[origIdx];
      const normChar = this._normalizeText(origChar);
      const normCharLen = normChar.length;

      if (normCharLen === 0) {
        // Original char was removed by normalization (e.g., zero-width space)
        origIdx++;
        continue;
      }

      origIdx++;
      normIdx += normCharLen;
    }

    // If normalization expanded chars (like … → ...), we may overshoot
    // Clamp to original length
    return Math.min(origIdx, original.length);
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
