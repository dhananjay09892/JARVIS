import { randomUUID } from 'node:crypto'

export function approvalQueue({ send, connected, timeoutMs = 90_000 }) {
  const pending = new Map()
  const settle = (id, approved) => {
    const slot = pending.get(id)
    if (!slot) return false
    pending.delete(id)
    clearTimeout(slot.timer)
    slot.resolve(approved === true && connected())
    send({ type: 'approval_closed', approvalId: id })
    return true
  }
  return {
    request(title, details) {
      if (!connected()) return Promise.resolve(false)
      const id = `approval-${randomUUID()}`
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.warn('[jarvis] approval expired:', id)
          settle(id, false)
        }, timeoutMs)
        pending.set(id, { resolve, timer })
        send({ type: 'approval', id, approvalId: id, title, details })
      })
    },
    reply(id, approved) {
      return settle(id, approved)
    },
    cancel() {
      for (const id of pending.keys()) settle(id, false)
    },
  }
}
