/**
 * The MIME reader (task C09): headers, encoded words, transfer encodings,
 * charsets, multipart walking and attachments listed but never opened.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessage, decodeEncodedWords, decodeQuotedPrintable, parseParams, htmlToText } from './mime.mjs'
import { htmlToText as gmailHtmlToText } from './gmail.mjs'

const crlf = (s) => Buffer.from(s.replace(/\n/g, '\r\n'), 'utf8')

test('encoded words: base64, Q, mixed with plain text, adjacent words joined', () => {
  assert.equal(decodeEncodedWords('=?UTF-8?B?w6l0w6k=?='), 'été')
  assert.equal(decodeEncodedWords('=?iso-8859-1?Q?caf=E9_cr=E8me?='), 'café crème')
  assert.equal(decodeEncodedWords('Re: =?utf-8?q?hello?= =?utf-8?q?_world?= !'), 'Re: hello world !')
  assert.equal(decodeEncodedWords('plain'), 'plain')
  assert.equal(decodeEncodedWords('=?bogus-charset?Q?ok?='), 'ok')
})

test('quoted-printable: soft breaks and escapes', () => {
  assert.equal(decodeQuotedPrintable('caf=C3=A9 =\r\nnext').toString('utf8'), 'café next')
  assert.equal(decodeQuotedPrintable('a=3Db =ZZ').toString('utf8'), 'a=b =ZZ')
})

test('parameters: quoted, RFC 2231 encoded and continued', () => {
  assert.deepEqual(parseParams('text/plain; charset="UTF-8"; format=flowed'), { value: 'text/plain', params: { charset: 'UTF-8', format: 'flowed' } })
  assert.equal(parseParams("attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf").params.filename, 'résumé.pdf')
  assert.equal(parseParams('attachment; filename*0="long"; filename*1="name.txt"').params.filename, 'longname.txt')
  assert.equal(parseParams('attachment; filename="a;b.txt"').params.filename, 'a;b.txt')
})

test('a plain message: folded headers, encoded subject, 8-bit body', () => {
  const m = parseMessage(crlf('From: =?utf-8?B?SsO8cmdlbg==?= <j@example.com>\nSubject: Long\n subject line\nContent-Type: text/plain; charset=utf-8\n\nGrüße'))
  assert.equal(m.header('from'), 'Jürgen <j@example.com>')
  assert.equal(m.header('subject'), 'Long subject line')
  assert.equal(m.text, 'Grüße')
  assert.deepEqual(m.attachments, [])
})

test('multipart/alternative prefers text/plain; html is the fallback', () => {
  const both = parseMessage(crlf([
    'Content-Type: multipart/alternative; boundary="b1"', '', 'preamble',
    '--b1', 'Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: quoted-printable', '', 'Caf=E9 plain', '',
    '--b1', 'Content-Type: text/html', '', '<p>Html</p>',
    '--b1--', 'epilogue',
  ].join('\n')))
  assert.equal(both.text, 'Café plain')
  const htmlOnly = parseMessage(crlf([
    'Content-Type: multipart/alternative; boundary=b2', '',
    '--b2', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>you</b></p><script>alert(1)</script></body></html>').toString('base64'),
    '--b2--',
  ].join('\n')))
  assert.equal(htmlOnly.text, 'Hello you')
})

test('attachments and attached messages are listed by name and type, never decoded', () => {
  const secret = 'TOP-SECRET-ATTACHMENT-CONTENT'
  const m = parseMessage(crlf([
    'Content-Type: multipart/mixed; boundary="mix"', '',
    '--mix', 'Content-Type: text/plain', '', 'See attached.',
    '--mix', 'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(secret).toString('base64'),
    '--mix', 'Content-Type: message/rfc822', '', 'Subject: inner', '', 'inner body',
    '--mix', 'Content-Type: image/png', 'Content-Disposition: inline', '', 'PNGDATA',
    '--mix--',
  ].join('\n')))
  assert.equal(m.text, 'See attached.')
  assert.deepEqual(m.attachments, [
    { name: 'invoice.pdf', type: 'application/pdf' },
    { name: 'attached message', type: 'message/rfc822' },
    { name: 'unnamed', type: 'image/png' },
  ])
  assert.ok(!JSON.stringify(m).includes(secret))
})

test('nesting is capped and a message with no blank line still parses', () => {
  let msg = 'Content-Type: text/plain\n\ninnermost'
  for (let i = 0; i < 30; i++) msg = `Content-Type: multipart/mixed; boundary="n${i}"\n\n--n${i}\n${msg}\n--n${i}--`
  const deep = parseMessage(crlf(msg))
  assert.equal(deep.text, '') // deeper than the cap: not read
  assert.equal(parseMessage(Buffer.from('Subject: only headers')).header('subject'), 'only headers')
})

test('the Gmail API connector shares the same htmlToText', () => {
  assert.equal(gmailHtmlToText, htmlToText)
})
