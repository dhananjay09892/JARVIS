import { useCallback, useEffect, useState } from 'react'
import type { PublicSettings } from '../lib/settings'
import {
  addFolder, folderProblem, forgetKnowledgeIndex, getKnowledgeStats, indexKnowledgeNow, knowledgeStatsText,
  parseFolders, removeFolder, serialiseFolders, setFolderCloud, type KnowledgeFolder, type KnowledgeStats,
} from '../lib/knowledge'

/**
 * Settings → Knowledge (plan 33). Switch the knowledge base on, choose folders,
 * say for each whether a brain may read its passages, index now, or forget the
 * index. A folder is restricted when added: its passages never leave this
 * computer unless “let the brain read it” is ticked for that folder. The counts
 * are numbers only, never a passage. Everything shown is plain text.
 */

export function Knowledge({ settings, busy, patchSetting }: {
  settings: PublicSettings | null
  busy: boolean
  patchSetting: (change: Record<string, string>) => Promise<boolean>
}) {
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [working, setWorking] = useState(false)

  const on = (settings?.JARVIS_KNOWLEDGE ?? '0') === '1'
  const folders = parseFolders(settings?.JARVIS_KNOWLEDGE_FOLDERS)

  const load = useCallback(() => {
    getKnowledgeStats().then(setStats).catch(() => setStats(null))
  }, [])
  useEffect(load, [load, on, settings?.JARVIS_KNOWLEDGE_FOLDERS])

  const saveFolders = async (next: KnowledgeFolder[]) => {
    if (await patchSetting({ JARVIS_KNOWLEDGE_FOLDERS: serialiseFolders(next) })) load()
  }

  const add = async () => {
    const problem = folderProblem(draft, folders)
    if (problem) return setNote(problem)
    setNote('')
    await saveFolders(addFolder(folders, draft))
    setDraft('')
  }

  const act = (fn: () => Promise<{ ok: boolean; reason?: string }>, ok: string) => {
    setWorking(true)
    setNote('')
    void fn()
      .then((r) => setNote(r.ok ? ok : (r.reason ?? 'That did not work.')))
      .finally(() => { setWorking(false); load() })
  }

  const disabled = busy || working || !settings
  return (
    <section aria-label="Knowledge">
      <h4>Knowledge</h4>
      <p className="mem-note">
        Let JARVIS look through folders you choose and answer with the file and page it came from. Switched off, nothing is read and what was indexed is deleted.
      </p>
      <label>
        <input
          type="checkbox"
          checked={on}
          disabled={disabled}
          onChange={(e) => void patchSetting({ JARVIS_KNOWLEDGE: e.target.checked ? '1' : '0' }).then(load)}
        />{' '}
        Search my folders
      </label>
      {on && (
        <>
          <ul className="conn-list">
            {folders.length === 0 && <li>No folders yet.</li>}
            {folders.map((f) => (
              <li key={f.path} className="conn-card">
                <strong>{f.path}</strong>{' '}
                <span className="mem-note">{f.cloud ? 'the brain may read passages' : 'restricted: stays on this computer'}</span>
                <br />
                <label>
                  <input
                    type="checkbox"
                    checked={f.cloud}
                    disabled={disabled}
                    aria-label={`Let the brain read passages from ${f.path}`}
                    onChange={(e) => {
                      if (e.target.checked && !window.confirm(`Passages from ${f.path} will be sent to the brain you use when you ask about your files. Allow?`)) return
                      void saveFolders(setFolderCloud(folders, f.path, e.target.checked))
                    }}
                  />{' '}
                  Let the brain read it
                </label>{' '}
                <button disabled={disabled} onClick={() => void saveFolders(removeFolder(folders, f.path))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <label>
            Add a folder{' '}
            <input
              type="text"
              value={draft}
              placeholder="C:\Notes"
              disabled={disabled}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
            />
          </label>{' '}
          <button disabled={disabled || !draft.trim()} onClick={() => void add()}>
            Add
          </button>{' '}
          <button disabled={disabled || folders.length === 0} onClick={() => act(indexKnowledgeNow, 'Indexed.')}>
            Index now
          </button>{' '}
          <button
            disabled={disabled}
            onClick={() => window.confirm('Forget everything indexed? Your files are not touched.') && act(forgetKnowledgeIndex, 'The index is forgotten.')}
          >
            Forget the index
          </button>
        </>
      )}
      {note && <p role="status" className="mem-note">{note}</p>}
      <p className="mem-note">{knowledgeStatsText(stats)}</p>
    </section>
  )
}
