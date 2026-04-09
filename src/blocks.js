// blocks.js — Notion block <-> Markdown conversion
// Converts Notion API block objects to Markdown and vice versa

// ============================================================
// RICH TEXT → MARKDOWN
// ============================================================

export function richTextToMarkdown(richTextArray) {
  if (!richTextArray || !Array.isArray(richTextArray)) return '';
  return richTextArray.map(rt => {
    let text = rt.plain_text || '';
    if (!text) return '';
    const a = rt.annotations || {};
    if (a.code) text = `\`${text}\``;
    if (a.bold) text = `**${text}**`;
    if (a.italic) text = `*${text}*`;
    if (a.strikethrough) text = `~~${text}~~`;
    if (a.underline) text = `<u>${text}</u>`;
    if (rt.type === 'text' && rt.text?.link?.url) {
      text = `[${text}](${rt.text.link.url})`;
    }
    if (rt.type === 'mention') {
      if (rt.mention?.type === 'page') text = `[@page](${rt.mention.page.id})`;
      else if (rt.mention?.type === 'user') text = `@${rt.plain_text}`;
      else if (rt.mention?.type === 'date') text = rt.plain_text;
    }
    return text;
  }).join('');
}

// ============================================================
// BLOCKS → MARKDOWN (recursive)
// ============================================================

export function blocksToMarkdown(blocks, indent = 0) {
  const lines = [];
  const prefix = '  '.repeat(indent);
  let numberedIdx = 1;

  for (const block of blocks) {
    const t = block.type;
    const data = block[t];
    if (!data) continue;

    switch (t) {
      case 'paragraph':
        lines.push(prefix + richTextToMarkdown(data.rich_text));
        break;

      case 'heading_1':
        lines.push(prefix + '# ' + richTextToMarkdown(data.rich_text));
        break;
      case 'heading_2':
        lines.push(prefix + '## ' + richTextToMarkdown(data.rich_text));
        break;
      case 'heading_3':
        lines.push(prefix + '### ' + richTextToMarkdown(data.rich_text));
        break;

      case 'bulleted_list_item':
        lines.push(prefix + '- ' + richTextToMarkdown(data.rich_text));
        if (block.children) lines.push(blocksToMarkdown(block.children, indent + 1));
        break;

      case 'numbered_list_item':
        lines.push(prefix + `${numberedIdx}. ` + richTextToMarkdown(data.rich_text));
        numberedIdx++;
        if (block.children) lines.push(blocksToMarkdown(block.children, indent + 1));
        break;

      case 'to_do':
        const check = data.checked ? '[x]' : '[ ]';
        lines.push(prefix + `- ${check} ` + richTextToMarkdown(data.rich_text));
        if (block.children) lines.push(blocksToMarkdown(block.children, indent + 1));
        break;

      case 'toggle':
        lines.push(prefix + '> **' + richTextToMarkdown(data.rich_text) + '**');
        if (block.children) lines.push(blocksToMarkdown(block.children, indent + 1));
        break;

      case 'code':
        const lang = data.language || '';
        lines.push(prefix + '```' + lang);
        lines.push(prefix + richTextToMarkdown(data.rich_text));
        lines.push(prefix + '```');
        break;

      case 'quote':
        lines.push(prefix + '> ' + richTextToMarkdown(data.rich_text));
        if (block.children) lines.push(blocksToMarkdown(block.children, indent + 1));
        break;

      case 'callout':
        const icon = data.icon?.emoji || '';
        lines.push(prefix + `> ${icon} ` + richTextToMarkdown(data.rich_text));
        if (block.children) lines.push(blocksToMarkdown(block.children, indent + 1));
        break;

      case 'divider':
        lines.push(prefix + '---');
        break;

      case 'image': {
        const url = data.type === 'external' ? data.external?.url : data.file?.url;
        const caption = data.caption ? richTextToMarkdown(data.caption) : '';
        lines.push(prefix + `![${caption}](${url || 'no-url'})`);
        break;
      }

      case 'bookmark':
        lines.push(prefix + `[${data.url}](${data.url})`);
        break;

      case 'embed':
        lines.push(prefix + `[Embed: ${data.url}](${data.url})`);
        break;

      case 'video': {
        const vurl = data.type === 'external' ? data.external?.url : data.file?.url;
        lines.push(prefix + `[Video: ${vurl || 'no-url'}]`);
        break;
      }

      case 'file': {
        const furl = data.type === 'external' ? data.external?.url : data.file?.url;
        const fname = data.caption ? richTextToMarkdown(data.caption) : 'File';
        lines.push(prefix + `[${fname}](${furl || 'no-url'})`);
        break;
      }

      case 'pdf': {
        const purl = data.type === 'external' ? data.external?.url : data.file?.url;
        lines.push(prefix + `[PDF: ${purl || 'no-url'}]`);
        break;
      }

      case 'table':
        if (block.children) {
          const rows = block.children;
          for (let ri = 0; ri < rows.length; ri++) {
            const row = rows[ri];
            const cells = (row.table_row?.cells || []).map(c => richTextToMarkdown(c));
            lines.push(prefix + '| ' + cells.join(' | ') + ' |');
            if (ri === 0) {
              lines.push(prefix + '| ' + cells.map(() => '---').join(' | ') + ' |');
            }
          }
        }
        break;

      case 'table_row':
        break; // handled by table parent

      case 'column_list':
        if (block.children) {
          for (const col of block.children) {
            if (col.children) lines.push(blocksToMarkdown(col.children, indent));
          }
        }
        break;

      case 'column':
        if (block.children) lines.push(blocksToMarkdown(block.children, indent));
        break;

      case 'child_page':
        lines.push(prefix + `> Page: **${data.title}** (id: ${block.id})`);
        break;

      case 'child_database':
        lines.push(prefix + `> Database: **${data.title}** (id: ${block.id})`);
        break;

      case 'synced_block':
        if (block.children) lines.push(blocksToMarkdown(block.children, indent));
        break;

      case 'link_to_page':
        if (data.page_id) lines.push(prefix + `[Link to page](${data.page_id})`);
        else if (data.database_id) lines.push(prefix + `[Link to database](${data.database_id})`);
        break;

      case 'equation':
        lines.push(prefix + `$$${data.expression}$$`);
        break;

      case 'table_of_contents':
        lines.push(prefix + '[Table of Contents]');
        break;

      case 'breadcrumb':
        lines.push(prefix + '[Breadcrumb]');
        break;

      default:
        if (data.rich_text) {
          lines.push(prefix + richTextToMarkdown(data.rich_text));
        } else {
          lines.push(prefix + `[${t} block]`);
        }
    }

    // Reset numbered list counter when type changes
    if (t !== 'numbered_list_item') numberedIdx = 1;
  }

  return lines.join('\n');
}

// ============================================================
// MARKDOWN → BLOCKS (for page creation / content append)
// ============================================================

function parseInlineMarkdown(text) {
  // Convert inline Markdown to Notion rich text objects
  const richText = [];
  // Simple regex-based parser for common patterns
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`|\[(.+?)\]\((.+?)\)|([^*~`\[]+))/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // ***bold italic***
      richText.push({ type: 'text', text: { content: match[2] }, annotations: { bold: true, italic: true } });
    } else if (match[3]) {
      // **bold**
      richText.push({ type: 'text', text: { content: match[3] }, annotations: { bold: true } });
    } else if (match[4]) {
      // *italic*
      richText.push({ type: 'text', text: { content: match[4] }, annotations: { italic: true } });
    } else if (match[5]) {
      // ~~strikethrough~~
      richText.push({ type: 'text', text: { content: match[5] }, annotations: { strikethrough: true } });
    } else if (match[6]) {
      // `code`
      richText.push({ type: 'text', text: { content: match[6] }, annotations: { code: true } });
    } else if (match[7] && match[8]) {
      // [link](url)
      richText.push({ type: 'text', text: { content: match[7], link: { url: match[8] } } });
    } else if (match[9]) {
      // plain text
      richText.push({ type: 'text', text: { content: match[9] } });
    }
  }

  if (richText.length === 0 && text) {
    richText.push({ type: 'text', text: { content: text } });
  }

  return richText;
}

export function markdownToBlocks(markdown) {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || 'plain text';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        object: 'block', type: 'code',
        code: { rich_text: [{ type: 'text', text: { content: codeLines.join('\n') } }], language: lang }
      });
      continue;
    }

    // Empty line → skip
    if (!line.trim()) { i++; continue; }

    // Headings
    if (line.startsWith('### ')) {
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: parseInlineMarkdown(line.slice(4)) } });
    } else if (line.startsWith('## ')) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: parseInlineMarkdown(line.slice(3)) } });
    } else if (line.startsWith('# ')) {
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: parseInlineMarkdown(line.slice(2)) } });
    }
    // Divider
    else if (line.trim() === '---') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    }
    // To-do
    else if (/^- \[(x| )\] /.test(line)) {
      const checked = line[3] === 'x';
      const text = line.slice(6);
      blocks.push({ object: 'block', type: 'to_do', to_do: { rich_text: parseInlineMarkdown(text), checked } });
    }
    // Bulleted list
    else if (line.startsWith('- ')) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseInlineMarkdown(line.slice(2)) } });
    }
    // Numbered list
    else if (/^\d+\.\s/.test(line)) {
      const text = line.replace(/^\d+\.\s/, '');
      blocks.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: parseInlineMarkdown(text) } });
    }
    // Quote
    else if (line.startsWith('> ')) {
      blocks.push({ object: 'block', type: 'quote', quote: { rich_text: parseInlineMarkdown(line.slice(2)) } });
    }
    // Paragraph
    else {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: parseInlineMarkdown(line) } });
    }

    i++;
  }

  return blocks;
}

// ============================================================
// PROPERTY FORMATTERS
// ============================================================

export function formatProperties(properties) {
  if (!properties) return {};
  const result = {};
  for (const [key, prop] of Object.entries(properties)) {
    const t = prop.type;
    switch (t) {
      case 'title':
        result[key] = richTextToMarkdown(prop.title);
        break;
      case 'rich_text':
        result[key] = richTextToMarkdown(prop.rich_text);
        break;
      case 'number':
        result[key] = prop.number;
        break;
      case 'select':
        result[key] = prop.select?.name || null;
        break;
      case 'multi_select':
        result[key] = (prop.multi_select || []).map(s => s.name);
        break;
      case 'status':
        result[key] = prop.status?.name || null;
        break;
      case 'date':
        result[key] = prop.date ? (prop.date.end ? `${prop.date.start} → ${prop.date.end}` : prop.date.start) : null;
        break;
      case 'checkbox':
        result[key] = prop.checkbox;
        break;
      case 'url':
        result[key] = prop.url;
        break;
      case 'email':
        result[key] = prop.email;
        break;
      case 'phone_number':
        result[key] = prop.phone_number;
        break;
      case 'formula':
        result[key] = prop.formula?.[prop.formula?.type] ?? null;
        break;
      case 'relation':
        result[key] = (prop.relation || []).map(r => r.id);
        break;
      case 'rollup':
        result[key] = prop.rollup?.[prop.rollup?.type] ?? null;
        break;
      case 'people':
        result[key] = (prop.people || []).map(p => p.name || p.id);
        break;
      case 'files':
        result[key] = (prop.files || []).map(f => f.file?.url || f.external?.url || f.name);
        break;
      case 'created_time':
        result[key] = prop.created_time;
        break;
      case 'last_edited_time':
        result[key] = prop.last_edited_time;
        break;
      case 'created_by':
        result[key] = prop.created_by?.name || prop.created_by?.id;
        break;
      case 'last_edited_by':
        result[key] = prop.last_edited_by?.name || prop.last_edited_by?.id;
        break;
      case 'unique_id':
        result[key] = prop.unique_id ? `${prop.unique_id.prefix || ''}${prop.unique_id.number}` : null;
        break;
      case 'verification':
        result[key] = prop.verification?.state || null;
        break;
      default:
        result[key] = `[${t}]`;
    }
  }
  return result;
}

export function formatDatabaseSchema(properties) {
  if (!properties) return {};
  const schema = {};
  for (const [key, prop] of Object.entries(properties)) {
    const entry = { type: prop.type };
    if (prop.type === 'select' && prop.select?.options) {
      entry.options = prop.select.options.map(o => o.name);
    }
    if (prop.type === 'multi_select' && prop.multi_select?.options) {
      entry.options = prop.multi_select.options.map(o => o.name);
    }
    if (prop.type === 'status' && prop.status?.options) {
      entry.options = prop.status.options.map(o => o.name);
      entry.groups = (prop.status.groups || []).map(g => ({ name: g.name, options: g.option_ids }));
    }
    if (prop.type === 'number' && prop.number?.format) {
      entry.format = prop.number.format;
    }
    if (prop.type === 'formula' && prop.formula?.expression) {
      entry.expression = prop.formula.expression;
    }
    if (prop.type === 'relation') {
      entry.database_id = prop.relation?.database_id;
      entry.synced_property_name = prop.relation?.synced_property_name;
    }
    if (prop.type === 'rollup') {
      entry.relation_property = prop.rollup?.relation_property_name;
      entry.rollup_property = prop.rollup?.rollup_property_name;
      entry.function = prop.rollup?.function;
    }
    schema[key] = entry;
  }
  return schema;
}

// ============================================================
// PROPERTY VALUE BUILDER (for creating/updating pages)
// ============================================================

export function buildPropertyValue(type, value, options = {}) {
  switch (type) {
    case 'title':
      return { title: [{ type: 'text', text: { content: String(value) } }] };
    case 'rich_text':
      return { rich_text: [{ type: 'text', text: { content: String(value) } }] };
    case 'number':
      return { number: Number(value) };
    case 'select':
      return { select: { name: String(value) } };
    case 'multi_select':
      const names = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim());
      return { multi_select: names.map(n => ({ name: n })) };
    case 'status':
      return { status: { name: String(value) } };
    case 'date':
      if (typeof value === 'object' && value.start) return { date: value };
      return { date: { start: String(value) } };
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'url':
      return { url: String(value) };
    case 'email':
      return { email: String(value) };
    case 'phone_number':
      return { phone_number: String(value) };
    case 'relation':
      const ids = Array.isArray(value) ? value : [value];
      return { relation: ids.map(id => ({ id: String(id) })) };
    case 'people':
      const pids = Array.isArray(value) ? value : [value];
      return { people: pids.map(id => ({ object: 'user', id: String(id) })) };
    case 'files':
      const urls = Array.isArray(value) ? value : [value];
      return { files: urls.map(u => ({ type: 'external', name: u.split('/').pop(), external: { url: u } })) };
    default:
      return { rich_text: [{ type: 'text', text: { content: String(value) } }] };
  }
}
