import { useEffect, useState } from 'react'
import { BACKEND, BRIDGE_HTTP_URL } from '../config'

type UpdateInfo = {
  current: string
  latest: string
  updateAvailable: boolean
  url: string | null
  downloadUrl: string | null
}

const DISMISSED = 'jarvis.update.dismissed'

const remembered = () => {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

/**
 * A small UPDATE button in the top bar when a newer release exists. It only
 * links to the installer; running it updates JARVIS in place and keeps settings.
 * Closing it hides that version until a newer one appears.
 */
export function UpdateNotice() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (BACKEND !== 'bridge') return
    fetch(`${BRIDGE_HTTP_URL}/update`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((next: UpdateInfo | null) => {
        if (next?.updateAvailable && remembered() !== next.latest) setInfo(next)
      })
      .catch(() => {})
  }, [])

  if (!info) return null

  if (!open) {
    return (
      <button className="mem-open" onClick={() => setOpen(true)} aria-label={`Update available: ${info.latest}`}>
        UPDATE {info.latest}
      </button>
    )
  }

  const hide = () => {
    try {
      localStorage.setItem(DISMISSED, info.latest)
    } catch {
      /* the notice just comes back next time */
    }
    setInfo(null)
  }

  return (
    <div className="approval-backdrop mem-backdrop">
      <section
        className="approval-card mem-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="upd-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
      >
        <header className="mem-head">
          <h2 id="upd-title">Update available</h2>
          <button onClick={() => setOpen(false)}>Close</button>
        </header>
        <p>
          JARVIS {info.latest} is ready. You have {info.current}.
        </p>
        <p className="mem-note">
          Download the new installer and run it. It closes JARVIS, updates it, and keeps your settings and memories.
        </p>
        <p>
          {info.downloadUrl && (
            <a href={info.downloadUrl} target="_blank" rel="noopener noreferrer">
              <button>Download JARVIS {info.latest}</button>
            </a>
          )}
          {info.url && (
            <a href={info.url} target="_blank" rel="noopener noreferrer">
              <button>What&apos;s new</button>
            </a>
          )}
          <button onClick={hide}>Not now</button>
        </p>
      </section>
    </div>
  )
}
