import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstPhraseCut, FIRST_PHRASE_MIN, FIRST_PHRASE_MAX } from './phrases.ts'

const spoken = (buffer: string) => {
  const cut = firstPhraseCut(buffer)
  return cut < 0 ? null : buffer.slice(0, cut)
}

test('cuts a long opener at its first clause boundary', () => {
  assert.equal(
    spoken('Certainly, the meeting with the design team has moved, and it now starts'),
    'Certainly, the meeting with the design team has moved, ',
  )
})

test('waits while the phrase before the boundary is too short to sound natural', () => {
  assert.equal(spoken('Well, '), null)
  assert.equal(spoken('Yes, sir, '), null)
  assert.equal(spoken('Certainly, the meeting with'), null, 'no boundary yet')
})

test('needs whitespace after the boundary, so a half-streamed token is not cut', () => {
  assert.equal(spoken('The forecast for tomorrow afternoon,'), null)
  assert.equal(spoken('The forecast for tomorrow afternoon, '), 'The forecast for tomorrow afternoon, ')
})

test('semicolons, colons and spaced dashes are boundaries too', () => {
  assert.equal(spoken('Three things are on your list: '), 'Three things are on your list: ')
  assert.equal(spoken('The build finished cleanly; two warnings '), 'The build finished cleanly; ')
  assert.equal(spoken('The build finished just now — all green '), 'The build finished just now — ')
})

test('never cuts inside a number', () => {
  assert.equal(spoken('The total comes to about 1, 2'), null)
  assert.equal(spoken('Scores across the matches were 3, 4 and then '), null)
})

test('gives up once the opener is too long to be worth a phrase cut', () => {
  const long = 'a'.repeat(FIRST_PHRASE_MAX + 10) + ', then more'
  assert.equal(firstPhraseCut(long), -1)
})

test('a phrase exactly at the minimum is spoken', () => {
  const phrase = 'x'.repeat(FIRST_PHRASE_MIN)
  assert.equal(spoken(`${phrase}, and so on`), `${phrase}, `)
})

test('is stateless across calls (the shared regex is reset)', () => {
  const s = 'Certainly, the meeting with the design team has moved, and'
  assert.equal(firstPhraseCut(s), firstPhraseCut(s))
})
