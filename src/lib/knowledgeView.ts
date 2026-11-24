/** Pure helpers for Settings → Knowledge (the folders setting, and the counts line). */

export interface KnowledgeFolder { path: string; cloud: boolean }

export interface KnowledgeStats {
  enabled: boolean
  embedder?: string
  sources?: number
  restrictedSources?: number
  files?: number
  passages?: number
  queries?: number
  found?: number
  notFound?: number
  restrictedWithheld?: number
  brainPassages?: number
  filesSkipped?: number
  folders?: { name: string; restricted: boolean }[]
}

/** Same shape the bridge accepts for one folder: an absolute path, no ";" or "|". */
const FOLDER_PATH = /^(?:[A-Za-z]:[\\/]|[\\/~])[^;|\u0000-\u001f\u007f]{0,258}$/
export const MAX_FOLDERS = 50

export function parseFolders(value: string | undefined): KnowledgeFolder[] {
  const text = (value ?? '').trim()
  if (!text || text.toLowerCase() === 'none') return []
  const seen = new Set<string>()
  const out: KnowledgeFolder[] = []
  for (const part of text.split(';')) {
    const [path, flag] = part.split('|').map((s) => s.trim())
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({ path, cloud: /^cloud$/i.test(flag ?? '') })
  }
  return out.slice(0, MAX_FOLDERS)
}

export function serialiseFolders(folders: KnowledgeFolder[]): string {
  if (folders.length === 0) return 'none'
  return folders.map((f) => (f.cloud ? `${f.path}|cloud` : f.path)).join(';')
}

/** A reason the path cannot be used, or null. */
export function folderProblem(path: string, existing: KnowledgeFolder[]): string | null {
  const p = path.trim()
  if (!p) return 'Type the folder’s full path.'
  if (!FOLDER_PATH.test(p)) return 'Use a full path such as C:\\Notes (no “;” or “|”).'
  if (existing.some((f) => f.path === p)) return 'That folder is already in the list.'
  if (existing.length >= MAX_FOLDERS) return `At most ${MAX_FOLDERS} folders.`
  return null
}

/** New folders are always restricted: a brain may not read them until the owner says so. */
export function addFolder(folders: KnowledgeFolder[], path: string): KnowledgeFolder[] {
  return [...folders, { path: path.trim(), cloud: false }]
}

export const removeFolder = (folders: KnowledgeFolder[], path: string) => folders.filter((f) => f.path !== path)

export const setFolderCloud = (folders: KnowledgeFolder[], path: string, cloud: boolean) =>
  folders.map((f) => (f.path === path ? { ...f, cloud } : f))

/** The share of questions that found an answer, as a whole percent, or null before any question. */
export function foundShare(stats: Pick<KnowledgeStats, 'queries' | 'found'>): number | null {
  const q = stats.queries ?? 0
  return q > 0 ? Math.round(((stats.found ?? 0) / q) * 100) : null
}

/** One line for Settings and Diagnostics. Counts only, never a passage. */
export function knowledgeStatsText(stats: KnowledgeStats | null | undefined): string {
  if (!stats || !stats.enabled) return 'off'
  const parts = [`${stats.files ?? 0} files`, `${stats.passages ?? 0} passages`, `${stats.sources ?? 0} folders`]
  const share = foundShare(stats)
  if (share !== null) parts.push(`${stats.queries} questions, ${share}% answered`)
  if ((stats.restrictedWithheld ?? 0) > 0) parts.push(`${stats.restrictedWithheld} kept from the brain`)
  return parts.join(' · ')
}
