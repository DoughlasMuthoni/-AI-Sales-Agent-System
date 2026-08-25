'use strict';

// Flattens a stored message's content (a plain string for old rows, or an array of Claude-style
// content blocks for newer ones) into one readable line — shared by the CSV export, the
// per-conversation transcript download, and the conversation analysis report, so all three read
// messages identically. tool_result blocks are intentionally skipped: they're internal
// bookkeeping (a tool's return value fed back to Claude) with nothing useful for a human reader.
function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') {
      return block.source
        ? '[Photo from customer]' + (block.caption ? ': ' + block.caption : '')
        : '[Photo sent: ' + (block.filename || '') + ']' + (block.caption ? ' — ' + block.caption : '');
    }
    if (block.type === 'document') return '[Document sent: ' + (block.filename || '') + ']' + (block.caption ? ' — ' + block.caption : '');
    if (block.type === 'video') return '[Video from customer]';
    if (block.type === 'tool_use') return '[Tool used: ' + block.name + ']';
    return '';
  }).filter(Boolean).join(' ');
}

function senderLabel(role, source) {
  if (role === 'user') return 'Customer';
  return source === 'human' ? 'Human Agent' : 'AI Agent';
}

module.exports = { extractMessageText, senderLabel };
