import { useEffect, useRef, useState } from 'react'
import { answerApproval, watchApprovals, type ApprovalRequest } from '../lib/bridge'

const expiry = (seconds = 90) =>
  seconds >= 3600 ? `${Math.round(seconds / 3600)} hours` : `${seconds} seconds`

export function Approvals() {
  const [requests, setRequests] = useState<ApprovalRequest[]>([])
  const [error, setError] = useState('')
  const rejectButton = useRef<HTMLButtonElement>(null)
  const approveButton = useRef<HTMLButtonElement>(null)
  useEffect(() => watchApprovals(
    (request) => setRequests((current) => [...current, request]),
    (id) => setRequests((current) => id === '*' ? [] : current.filter((request) => request.approvalId !== id)),
  ), [])
  const request = requests[0]
  useEffect(() => {
    setError('')
    rejectButton.current?.focus()
  }, [request?.id])
  if (!request) return null

  const answer = (approved: boolean) => {
    try {
      answerApproval(request.id, approved)
      setRequests((current) => current.filter((item) => item.id !== request.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval could not be sent.')
    }
  }
  return (
    <div className="approval-backdrop">
      <section className="approval-card" role="dialog" aria-modal="true" aria-labelledby="approval-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') answer(false)
          if (event.key === 'Tab') {
            event.preventDefault()
            if (document.activeElement === rejectButton.current) approveButton.current?.focus()
            else rejectButton.current?.focus()
          }
        }}>
        <h2 id="approval-title">{request.title}</h2>
        <p>Review before approving. No action runs without approval. Request expires after {expiry(request.expiresInSec)}.</p>
        <pre>{request.details}</pre>
        {error && <p role="alert">{error}</p>}
        <div>
          <button ref={rejectButton} onClick={() => answer(false)}>Reject</button>
          <button ref={approveButton} onClick={() => answer(true)}>Approve once</button>
        </div>
      </section>
    </div>
  )
}
