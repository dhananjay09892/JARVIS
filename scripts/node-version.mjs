/**
 * The Node.js version JARVIS needs, in one place.
 *
 * The bridge stores memory, workflows and settings with `node:sqlite`, which is
 * only available without a flag from Node 22.13. On an older Node the import
 * fails before any code runs, so no try/catch can recover — the only way to give
 * a readable message is to check first, from a launcher that does not import it.
 */
export const MIN_NODE = [22, 13, 0]
export const MIN_NODE_TEXT = '22.13'

/** True when `version` ("22.13.1", "v24.8.0") is at least MIN_NODE. */
export function nodeSupported(version = process.versions.node) {
  const parts = String(version).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < MIN_NODE.length; i++) {
    const have = Number.isFinite(parts[i]) ? parts[i] : 0
    if (have !== MIN_NODE[i]) return have > MIN_NODE[i]
  }
  return true
}

export function nodeProblem(version = process.versions.node) {
  return (
    `JARVIS needs Node.js ${MIN_NODE_TEXT} or newer, but this is Node.js ${version}.\n` +
    'Install the current LTS from https://nodejs.org, open a new terminal, and try again.\n' +
    '(The Windows installer includes its own Node.js, so none of this applies to it.)'
  )
}

/** Print the problem and exit, unless this Node is new enough. */
export function assertNode() {
  if (nodeSupported()) return
  console.error(`\n${nodeProblem()}\n`)
  process.exit(1)
}
