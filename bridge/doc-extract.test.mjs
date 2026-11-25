import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { extractDocument, parseToUnicode, readZipEntry } from './doc-extract.mjs'
import { createKnowledgeBase } from './knowledge-base.mjs'

// --- fixtures built here, so no binary files are committed ------------------

const crc32 = (buf) => {
  let c, crc = 0xffffffff
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c }
  return (crc ^ 0xffffffff) >>> 0
}

/** A minimal zip file; `stored` entries are not compressed. */
function zip(entries, { stored = false } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text)
    const body = stored ? data : deflateRawSync(data)
    const method = stored ? 0 : 8
    const nm = Buffer.from(name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, nm, body)
    central.push(ch, nm)
    offset += 30 + nm.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const docx = (body, opts) => zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>` }, opts)

const esc = (s) => s.replace(/[\\()]/g, '\\$&')
/**
 * A PDF with one page per entry of `pages` (each an array of lines).
 * `kind`: 'simple' = Helvetica, 'cid' = Type0 font with a ToUnicode map, 'objstm' = simple, with the page tree in an object stream.
 */
function pdf(pages, { compress = false, kind = 'simple', encrypt = false } = {}) {
  const objs = []
  const add = (body) => objs.push(body) && objs.length
  const stream = (dict, data) => {
    const body = compress ? deflateSync(Buffer.from(data, 'latin1')).toString('latin1') : data
    return `<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n${body}\nendstream`
  }
  // 1 catalog, 2 pages, 3 font, 4 (cid: descendant, tounicode)
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('PAGES')
  let fontBody = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  const extra = []
  if (kind === 'cid') {
    // codes: 1 → 'a'.. built from the letters used
    const used = [...new Set(pages.flat().join(''))]
    const code = (ch) => used.indexOf(ch) + 1
    const cmap = `/CIDInit begin begincmap ${used.length} beginbfchar\n${used.map((ch) => `<${code(ch).toString(16).padStart(4, '0')}> <${ch.codePointAt(0).toString(16).padStart(4, '0')}>`).join('\n')}\nendbfchar endcmap`
    fontBody = '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /ToUnicode 4 0 R >>'
    extra.push(stream('', cmap))
    pdf.code = code
  }
  add(fontBody)
  for (const e of extra) add(e)
  const pageRefs = []
  const pageObjs = []
  for (const lines of pages) {
    const ops = lines.map((l, i) => {
      const text = kind === 'cid'
        ? `<${[...l].map((ch) => pdf.code(ch).toString(16).padStart(4, '0')).join('')}>`
        : `(${esc(l)})`
      return `${i === 0 ? '72 700 Td' : '0 -14 Td'} ${text} Tj`
    }).join('\n')
    const content = add(stream('', `BT /F1 12 Tf\n${ops}\nET`))
    pageObjs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`)
  }
  for (const p of pageObjs) pageRefs.push(`${add(p)} 0 R`)
  objs[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`
  const out = ['%PDF-1.5\n']
  objs.forEach((b, i) => out.push(`${i + 1} 0 obj\n${b}\nendobj\n`))
  out.push(`trailer\n<< /Root 1 0 R /Size ${objs.length + 1}${encrypt ? ' /Encrypt 99 0 R' : ''} >>\n%%EOF\n`)
  return Buffer.from(out.join(''), 'latin1')
}

// --- DOCX -------------------------------------------------------------------

test('docx: paragraphs, tabs, entities, and only what is visible text', () => {
  const body = para('Tenancy &amp; deposit') + '<w:p><w:r><w:t>Rent</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>9&#8201;500</w:t></w:r></w:p>' +
    '<w:p><w:r><w:delText>deleted words</w:delText></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Last line</w:t></w:r></w:p>'
  for (const stored of [false, true]) {
    const r = extractDocument(docx(body, { stored }), '.docx')
    assert.equal(r.text, 'Tenancy & deposit\nRent\t9\u2009500\n\nLast line')
    assert.ok(!r.text.includes('deleted'))
  }
})

test('docx: page breaks Word saved become pages; an explicit break is used when none were saved', () => {
  const rendered = extractDocument(docx(para('one') + '<w:p><w:r><w:lastRenderedPageBreak/><w:t>two</w:t></w:r></w:p>'), '.docx')
  assert.equal(rendered.text, 'one\ftwo')
  assert.equal(rendered.pages, 2)
  const explicit = extractDocument(docx(para('one') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + para('two')), '.docx')
  assert.ok(explicit.text.split('\f').length === 2 && explicit.text.endsWith('two'))
})

test('docx: damaged and empty files give a reason, not text', () => {
  assert.equal(extractDocument(Buffer.from('not a zip at all'), '.docx').reason, 'unreadable')
  assert.equal(extractDocument(zip({ 'other.xml': '<a/>' }), '.docx').reason, 'unreadable')
  assert.equal(extractDocument(docx(''), '.docx').reason, 'no-text')
  assert.equal(readZipEntry(Buffer.alloc(10), 'x'), null)
})

// --- PDF --------------------------------------------------------------------

for (const compress of [false, true]) {
  test(`pdf: pages in order, lines kept, simple font (compressed: ${compress})`, () => {
    const r = extractDocument(pdf([['Lease summary', 'Notice period is (60) days.'], ['Deposit (refundable)', 'Paid 1 March']], { compress }), '.pdf')
    assert.equal(r.pages, 2)
    assert.equal(r.text, 'Lease summary\nNotice period is (60) days.\fDeposit (refundable)\nPaid 1 March')
  })
}

test('pdf: Type0 font read through its ToUnicode map', () => {
  const r = extractDocument(pdf([['Boiler service due'], ['Insurance renews in May']], { compress: true, kind: 'cid' }), '.pdf')
  assert.equal(r.text, 'Boiler service due\fInsurance renews in May')
})

test('pdf: TJ arrays join words, a big gap is a space', () => {
  const content = 'BT /F1 12 Tf 72 700 Td [(Hel) 20 (lo) -400 (World)] TJ ET'
  const raw = pdf([['x']]).toString('latin1').replace(/\(x\)[^\n]*\n/, '').replace(/stream\nBT[\s\S]*?ET\nendstream/, `stream\n${content}\nendstream`)
  const fixed = raw.replace(/\/Length \d+/, `/Length ${content.length}`)
  assert.equal(extractDocument(Buffer.from(fixed, 'latin1'), '.pdf').text, 'Hello World')
})

test('pdf: ToUnicode ranges and chars parse', () => {
  const m = parseToUnicode('2 beginbfchar <01> <0041> <02> <D83DDE00> endbfchar 2 beginbfrange <10> <12> <0061> <20> <21> [<0058> <0059>] endbfrange')
  assert.equal(m.get(1), 'A')
  assert.equal(m.get(2), '😀')
  assert.equal(m.get(0x12), 'c')
  assert.equal(m.get(0x21), 'Y')
})

test('pdf: encrypted, scanned and broken files give a reason, not text', () => {
  assert.equal(extractDocument(pdf([['secret']], { encrypt: true }), '.pdf').reason, 'encrypted')
  assert.equal(extractDocument(pdf([[]]), '.pdf').reason, 'no-text')
  assert.equal(extractDocument(Buffer.from('hello, not a pdf'), '.pdf').reason, 'not-pdf')
  assert.equal(extractDocument(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog'), '.pdf').reason, 'no-pages')
  assert.equal(extractDocument(Buffer.from('x'), '.exe').reason, 'unsupported')
})

test('pdf: a stream that expands past the limit is dropped, not inflated', () => {
  const big = deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x20)).toString('latin1')
  const bomb = `%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Filter /FlateDecode /Length ${big.length} >>\nstream\n${big}\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n`
  assert.equal(extractDocument(Buffer.from(bomb, 'latin1'), '.pdf').reason, 'no-text')
})

// --- knowledge base ----------------------------------------------------------

test('knowledge base: a PDF answer cites its page, a DOCX answer cites the file; scans and encrypted files are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-doc-'))
  writeFileSync(join(root, 'lease.pdf'), pdf([['Welcome and house rules'], ['The notice period for the flat is sixty days.']], { compress: true }))
  writeFileSync(join(root, 'plan.docx'), docx(para('The garden shed key is under the blue flowerpot.')))
  writeFileSync(join(root, 'scan.pdf'), pdf([[]]))
  writeFileSync(join(root, 'locked.pdf'), pdf([['secret']], { encrypt: true }))
  writeFileSync(join(root, 'broken.docx'), 'not a zip')
  const kb = createKnowledgeBase({ dir: mkdtempSync(join(tmpdir(), 'kb-db-')), sources: () => [{ path: root, cloud: false }] })
  const r = kb.indexAll()
  assert.equal(kb.stats().files, 2)
  assert.equal(r.sources[0].skipped, 3)
  const a = kb.answer('What is the notice period for the flat?')
  assert.equal(a.found, true)
  assert.match(a.citations[0], /lease\.pdf, page 2,/)
  const b = kb.answer('Where is the garden shed key?')
  assert.match(b.citations[0], /plan\.docx, page 1,/)
  assert.equal(kb.search('secret').found, false)
})
