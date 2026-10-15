import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

export const WORKSPACE_ROOT = join(homedir(), 'Documents', 'GitHub')
const MAX_BYTES = 256 * 1024
const digest = (data) => createHash('sha256').update(data).digest('hex')

function pathParts(path, allowRoot = false) {
  if (allowRoot && path === '.') return []
  const parts = path.split(/[\\/]/)
  if (!path || isAbsolute(path) || parts.some((part) =>
    !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) ||
    [...part].some((character) => character.charCodeAt(0) < 32) ||
    /[. ]$/.test(part) || /^\.git$/i.test(part) || /^\.env(?:\.|$)/i.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  )) throw new Error('Use a relative workspace path without traversal, Git metadata, environment files, or Windows special names.')
  return parts
}

export function workspaceFiles(root = WORKSPACE_ROOT) {
  async function resolveFile(path, createParents = false, allowRoot = false) {
    const parts = pathParts(path, allowRoot)
    const canonicalRoot = await realpath(root)
    let current = canonicalRoot
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i])
      let info
      try {
        info = await lstat(current)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
        if (!createParents) throw err
        if (i === parts.length - 1) return current
        await mkdir(current)
        info = await lstat(current)
      }
      if (info.isSymbolicLink()) throw new Error('Workspace links and junctions are not allowed.')
      const resolved = await realpath(current)
      const rel = relative(canonicalRoot, resolved)
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../')) {
        throw new Error('Path escapes the workspace.')
      }
      if (i < parts.length - 1 && !info.isDirectory()) throw new Error('Parent is not a directory.')
      current = resolved
    }
    return current
  }

  return {
    async directory(path = '.') {
      const directory = await resolveFile(path, false, true)
      if (!(await lstat(directory)).isDirectory()) throw new Error('Working directory must be a directory.')
      return directory
    },
    async list(path = '.') {
      const directory = await resolveFile(path, false, true)
      const entries = await readdir(directory, { withFileTypes: true })
      if (entries.length > 1000) throw new Error('Directory is too large; select a smaller subdirectory.')
      return entries.filter((entry) => !/^\.git$/i.test(entry.name) && !/^\.env(?:\.|$)/i.test(entry.name))
        .map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? 'blocked-link' : entry.isDirectory() ? 'directory' : 'file' }))
    },
    async read(path) {
      const file = await open(await resolveFile(path), 'r')
      try {
        const info = await file.stat()
        if (!info.isFile() || info.nlink !== 1) throw new Error('Only ordinary, non-hard-linked files are allowed.')
        if (info.size > MAX_BYTES) throw new Error('File exceeds the 256 KiB text limit.')
        const data = await file.readFile()
        if (data.includes(0)) throw new Error('Binary files are not supported.')
        return { path, content: data.toString('utf8'), sha256: digest(data) }
      } finally {
        await file.close()
      }
    },
    async write(path, content, expectedSha256) {
      const data = Buffer.from(content, 'utf8')
      if (data.length > MAX_BYTES || data.includes(0)) throw new Error('Only text files up to 256 KiB are supported.')
      const destination = await resolveFile(path, true)
      const file = await open(destination, expectedSha256 ? 'r+' : 'wx')
      try {
        const info = await file.stat()
        if (!info.isFile() || info.nlink !== 1) throw new Error('Only ordinary, non-hard-linked files are allowed.')
        if (expectedSha256) {
          if (info.size > MAX_BYTES) throw new Error('File exceeds the 256 KiB text limit.')
          if (digest(await file.readFile()) !== expectedSha256) throw new Error('File changed. Read it again before editing.')
        }
        await file.write(data, 0, data.length, 0)
        await file.truncate(data.length)
        await file.sync()
        return { path, bytes: data.length, sha256: digest(data) }
      } finally {
        await file.close()
      }
    },
    async delete(path, expectedSha256) {
      const destination = await resolveFile(path)
      const info = await lstat(destination)
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) {
        throw new Error('Deletion supports only ordinary text files up to 256 KiB.')
      }
      const file = await open(destination, 'r')
      try {
        const data = await file.readFile()
        if (data.includes(0) || digest(data) !== expectedSha256) {
          throw new Error('File changed or is not text. Read it again before deletion.')
        }
      } finally {
        await file.close()
      }
      await unlink(destination)
      return { path, deleted: true }
    },
  }
}

export function workspaceServer(approve) {
  const files = workspaceFiles()
  const handle = (operation) => async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await operation(args)) }] }
    } catch (err) {
      console.error('[jarvis] workspace operation failed:', err)
      return { isError: true, content: [{ type: 'text', text: `Workspace operation failed: ${err.message}` }] }
    }
  }
  return createSdkMcpServer({
    name: 'jarvis_workspace',
    version: '1.0.0',
    alwaysLoad: true,
    instructions: `The owner's local workspace is ${WORKSPACE_ROOT}. Paths are relative to this GitHub folder, including the repository name. Read existing files before editing and supply their sha256. Single-file deletion requires explicit browser approval. Commands and pushes require separate approved development tools.`,
    tools: [
      tool('list_files', 'List a relative directory in the GitHub workspace. Links, Git metadata and environment files are off limits.',
        { path: z.string().default('.') }, handle(({ path }) => files.list(path))),
      tool('read_file', 'Read a UTF-8 text file in the GitHub workspace and return its SHA-256 for safe editing.',
        { path: z.string() }, handle(({ path }) => files.read(path))),
      tool('write_file', 'Create or edit a text file in the GitHub workspace. Omit expectedSha256 to create a new file; to edit, provide the hash from read_file. Creates missing parent directories.',
        { path: z.string(), content: z.string(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() },
        handle(({ path, content, expectedSha256 }) => files.write(path, content, expectedSha256))),
      tool('delete_file', 'Delete one text file only after the owner approves the displayed path. Read it first and supply its SHA-256. Recursive deletion is not supported.',
        { path: z.string(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) },
        handle(async ({ path, expectedSha256 }) => {
          await files.read(path)
          if (!approve || !await approve('Delete file', `Workspace: ${WORKSPACE_ROOT}\nFile: ${path}\nSHA-256: ${expectedSha256}`)) {
            throw new Error('Deletion was not approved.')
          }
          return files.delete(path, expectedSha256)
        })),
    ],
  })
}
