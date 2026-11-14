import { useEffect, useRef, useState } from 'react'
import { answerApproval, reportApprovalsShown, watchApprovals, type ApprovalRequest } from '../lib/bridge'

const expiry = (seconds = 90) =>
  seconds >= 3600 ? `${Math.round(seconds / 3600)} hours` : `${seconds} seconds`

/** A mission's card is titled `Task "name" (agent): action`; the inbox shows the mission apart from the action. */
function cardParts(title: string) {
  const m = /^Task "(.*?)"(?: \((.*?)\))?: ([\s\S]*)$/.exec(title)
  return m ? { mission: m[2] ? `${m[1]} (${m[2]})` : m[1], action: m[3] } : { mission: '', action: title }
}

/**
 * Every approval waiting on the owner, in one numbered list. Each card shows
 * its mission, action and details, so whatever the owner can say "approve the
 * first two" about is on screen. The numbers match what the voice inbox reads.
 */
export function Approvals() {
  const [requests, setRequests] = useState<ApprovalRequest[]>([])
  const [error, setError] = useState('')
  const firstReject = useRef<HTMLButtonElement>(null)
  useEffect(() => watchApprovals(
    (request) => setRequests((current) => [...current, request]),
    (id) => setRequests((current) => id === '*' ? [] : current.filter((request) => request.approvalId !== id)),
  ), [])
  const ids = requests.map((request) => request.id).join('\n')
  useEffect(() => {
    // Only what is drawn counts as shown; nothing drawn clears the list.
    reportApprovalsShown(ids ? ids.split('\n') : [])
    return () => reportApprovalsShown([])
  }, [ids])
  const first = requests[0]?.id
  useEffect(() => {
    setError('')
    firstReject.current?.focus()
  }, [first])
  if (!requests.length) return null

  const answer = (request: ApprovalRequest, approved: boolean) => {
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
          if (event.key === 'Escape') answer(requests[0], false)
        }}>
        <h2 id="approval-title">
          {requests.length === 1 ? 'Needs your approval' : `${requests.length} things need your approval`}
        </h2>
        <p>
          Review before approving. No action runs without approval.
          {requests.length > 1 && ' You can say "approve the first two" or "deny the third".'}
        </p>
        {error && <p role="alert">{error}</p>}
        <ol className="approval-inbox">
          {requests.map((request, i) => {
            const { mission, action } = cardParts(request.title)
            return (
              <li key={request.id} className="approval-item">
                <h3>{mission && <span className="approval-mission">{mission}: </span>}{action}</h3>
                <pre>{request.details}</pre>
                <p className="approval-expiry">Expires after {expiry(request.expiresInSec)}.</p>
                <div>
                  <button ref={i === 0 ? firstReject : undefined} onClick={() => answer(request, false)}>Reject</button>
                  <button onClick={() => answer(request, true)}>Approve once</button>
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    </div>
  )
}
