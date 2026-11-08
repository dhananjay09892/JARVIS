/**
 * Test fixture: the read connectors the shipped built-in agents name, as the
 * connector registry lists them (installed; grants are separate). Tests that
 * load every file in bridge/agents/ use this list, so a new built-in that
 * names another connector only needs it added here.
 */
const read = (id, ...tools) => Object.freeze({
  id,
  capabilities: Object.freeze({ read: true }),
  tools: Object.freeze(tools.map((name) => Object.freeze({ name, capability: 'read' }))),
})

export const BUILTIN_AGENT_CONNECTORS = Object.freeze([
  read('gdrive', 'search_files', 'read_file'),
  read('notion', 'search_pages'),
  read('obsidian', 'search_notes', 'read_note'),
  read('gmail', 'search_mail'),
  read('outlook', 'search_mail'),
  read('slack', 'list_channels', 'read_recent_messages'),
  read('gcontacts', 'find_contact'),
  read('gcalendar', 'list_events', 'check_free_busy'),
])
