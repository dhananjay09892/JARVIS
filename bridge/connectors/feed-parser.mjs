/**
 * RSS and Atom parsing for the News / RSS connector (task C25).
 *
 * A feed is a stranger's XML, so this is a small scanner rather than a general
 * XML library (nothing else in the bridge needs one, and a new dependency would
 * have to be vetted for little gain). What it deliberately cannot do is the
 * point:
 *   - no DOCTYPE with an internal subset, so no custom entities: no XXE and no
 *     entity-expansion bomb. External DTDs are never fetched.
 *   - only the five XML entities and numeric references are decoded, in one pass.
 *   - nesting is capped, and every loop moves forward: it runs in linear time.
 * Anything that is not well-formed throws `FeedParseError`; the adapter turns
 * that into one failed feed, not a failed sync.
 *
 * Handles RSS 0.9x/2.0, RSS 1.0 (RDF) and Atom 1.0 (RFC 4287).
 */
import { htmlToText } from './mime.mjs'

export class FeedParseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FeedParseError'
  }
}

const MAX_DEPTH = 64
/** htmlToText's regexes are fine at this size; a post is never longer. */
const MAX_HTML = 200_000
const MAX_TEXT = 20_000

const NAME_END = /[\s/>]/
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s) {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (all, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e] ?? all
    const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''
  })
}

/** Attributes of a start tag, from the text between the name and the `>`. */
function parseAttributes(s) {
  const attrs = {}
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    const eq = s.indexOf('=', i)
    if (eq < 0) throw new FeedParseError('attribute without a value')
    const name = s.slice(i, eq).trim().toLowerCase()
    i = eq + 1
    while (i < s.length && /\s/.test(s[i])) i++
    const quote = s[i]
    if (quote !== '"' && quote !== "'") throw new FeedParseError('attribute value without quotes')
    const end = s.indexOf(quote, i + 1)
    if (end < 0) throw new FeedParseError('unterminated attribute')
    if (name && !Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(s.slice(i + 1, end))
    i = end + 1
  }
  return attrs
}

/** Where a tag starting at `from` ends: the `>` outside any quotes. -1 if none. */
function tagEnd(xml, from) {
  let quote = ''
  for (let i = from; i < xml.length; i++) {
    const c = xml[i]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

/**
 * Well-formed XML to a tree of `{ name, attrs, children, text }`. Names are
 * lower-cased and keep their prefix (`content:encoded`).
 * @param {string} xml
 */
export function parseXml(xml) {
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0
  /** @type {any[]} */
  const stack = []
  let root = null

  const addText = (t) => {
    const top = stack[stack.length - 1]
    if (top) top.parts.push(t)
    else if (t.trim()) throw new FeedParseError('text outside the root element')
  }

  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      addText(decodeEntities(xml.slice(i)))
      break
    }
    if (lt > i) addText(decodeEntities(xml.slice(i, lt)))

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      if (end < 0) throw new FeedParseError('unterminated comment')
      i = end + 3
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      if (end < 0) throw new FeedParseError('unterminated CDATA')
      addText(xml.slice(lt + 9, end))
      i = end + 3
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      if (end < 0) throw new FeedParseError('unterminated declaration')
      i = end + 2
    } else if (xml.startsWith('<!', lt)) {
      const end = tagEnd(xml, lt + 2)
      if (end < 0) throw new FeedParseError('unterminated declaration')
      // An internal subset is how custom entities get in.
      if (xml.slice(lt, end).includes('[')) throw new FeedParseError('internal DTD subset refused')
      i = end + 1
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt + 2)
      if (end < 0) throw new FeedParseError('unterminated end tag')
      const name = xml.slice(lt + 2, end).trim().toLowerCase()
      const top = stack.pop()
      if (!top || top.name !== name) throw new FeedParseError('mismatched end tag')
      top.text = top.parts.join('')
      delete top.parts
      i = end + 1
    } else {
      const end = tagEnd(xml, lt + 1)
      if (end < 0) throw new FeedParseError('unterminated start tag')
      const selfClosing = xml[end - 1] === '/'
      const inner = xml.slice(lt + 1, selfClosing ? end - 1 : end)
      const nameEnd = inner.search(NAME_END)
      const rawName = nameEnd < 0 ? inner : inner.slice(0, nameEnd)
      if (!/^[\p{L}_:][\p{L}\p{N}_.:-]*$/u.test(rawName)) throw new FeedParseError('bad element name')
      const node = {
        name: rawName.toLowerCase(),
        attrs: nameEnd < 0 ? {} : parseAttributes(inner.slice(nameEnd)),
        children: [],
        parts: [],
        text: '',
      }
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(node)
      else if (root) throw new FeedParseError('more than one root element')
      else root = node
      if (selfClosing) delete node.parts
      else {
        if (stack.length >= MAX_DEPTH) throw new FeedParseError('nested too deeply')
        stack.push(node)
      }
      i = end + 1
    }
  }
  if (stack.length) throw new FeedParseError('unclosed element')
  if (!root) throw new FeedParseError('no root element')
  return root
}

const local = (name) => name.slice(name.lastIndexOf(':') + 1)
const child = (node, ...names) => node.children.find((c) => names.includes(c.name))
const childLocal = (node, name) => node.children.find((c) => local(c.name) === name)
const childrenLocal = (node, name) => node.children.filter((c) => local(c.name) === name)
/** All the text under a node, tags dropped (Atom's inline XHTML). */
const deepText = (node) => (node.children.length ? [node.text, ...node.children.map(deepText)].join(' ') : node.text)

/** One line of plain text: no control characters, spaces collapsed. */
export const oneLine = (s, max = 500) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const fromHtml = (s) => htmlToText(String(s ?? '').slice(0, MAX_HTML)).slice(0, MAX_TEXT)
const lineFromHtml = (node) => (node ? oneLine(fromHtml(deepText(node))) : '')

/** An http(s) link, resolved against the feed's address; '' for anything else. */
function safeLink(href, base) {
  const s = String(href ?? '').trim()
  if (!s || s.length > 2000) return ''
  try {
    const u = new URL(s, base)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.href : ''
  } catch {
    return ''
  }
}

/** ms since epoch, or null. */
function parseDate(node) {
  const s = oneLine(node?.text, 80)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) && t >= 0 ? t : null
}

function atomLink(entry, base) {
  const links = childrenLocal(entry, 'link')
  const best = links.find((l) => (l.attrs.rel ?? 'alternate') === 'alternate') ?? links[0]
  return best ? safeLink(best.attrs.href, base) : ''
}

function atomBody(entry) {
  const node = childLocal(entry, 'content') ?? childLocal(entry, 'summary')
  if (!node) return ''
  // type="text" is literal: "a < b" is not markup. html and xhtml are.
  const type = (node.attrs.type ?? 'text').toLowerCase()
  return type === 'text' ? oneLine(deepText(node), MAX_TEXT) : fromHtml(deepText(node))
}

function atomItem(entry, base) {
  const author = childLocal(entry, 'author')
  return {
    guid: oneLine(childLocal(entry, 'id')?.text, 1000),
    title: lineFromHtml(childLocal(entry, 'title')),
    link: atomLink(entry, base),
    author: oneLine(author ? (childLocal(author, 'name')?.text ?? '') : '', 200),
    body: atomBody(entry),
    date: parseDate(childLocal(entry, 'updated')) ?? parseDate(childLocal(entry, 'published')),
    published: parseDate(childLocal(entry, 'published')),
  }
}

function rssItem(item, base) {
  const guid = child(item, 'guid')
  const link = safeLink(child(item, 'link')?.text, base)
  const permalink = guid && (guid.attrs.ispermalink ?? 'true') !== 'false' ? safeLink(guid.text, base) : ''
  const encoded = child(item, 'content:encoded')
  const date = parseDate(child(item, 'pubdate')) ?? parseDate(child(item, 'dc:date'))
  return {
    guid: oneLine(guid?.text ?? item.attrs['rdf:about'], 1000),
    title: lineFromHtml(child(item, 'title')),
    link: link || permalink,
    author: oneLine(child(item, 'dc:creator', 'author')?.text, 200),
    body: fromHtml(deepText(encoded ?? child(item, 'description') ?? { text: '', children: [] })),
    date,
    published: date,
  }
}

/**
 * A feed's text to `{ format, title, updatedAt, items }`, newest source order
 * kept. Items are plain text; nothing here is trusted. Throws FeedParseError.
 * @param {string} xml
 * @param {string} base the feed's address, for relative links
 */
export function parseFeed(xml, base) {
  const root = parseXml(xml)
  const kind = local(root.name)
  if (kind === 'feed') {
    return {
      format: 'atom',
      title: lineFromHtml(childLocal(root, 'title')),
      updatedAt: parseDate(childLocal(root, 'updated')),
      items: childrenLocal(root, 'entry').map((e) => atomItem(e, base)),
    }
  }
  if (kind === 'rss' || kind === 'rdf') {
    const channel = childLocal(root, 'channel')
    if (!channel) throw new FeedParseError('no channel')
    // RSS 1.0 keeps its items beside the channel, not in it.
    const items = [...childrenLocal(channel, 'item'), ...(kind === 'rdf' ? childrenLocal(root, 'item') : [])]
    return {
      format: kind === 'rss' ? 'rss' : 'rdf',
      title: lineFromHtml(child(channel, 'title')),
      updatedAt: parseDate(child(channel, 'lastbuilddate', 'pubdate', 'dc:date')),
      items: items.map((e) => rssItem(e, base)),
    }
  }
  throw new FeedParseError('not an RSS or Atom feed')
}

const ENCODING = /^\s*<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9._:-]{1,40})["']/

/** A feed's bytes to text: BOM, then the XML declaration, then the HTTP charset. */
export function decodeFeed(bytes, contentType = '') {
  const head = Buffer.from(bytes.subarray(0, 200)).toString('latin1')
  const b0 = bytes[0]
  const b1 = bytes[1]
  let label = b0 === 0xff && b1 === 0xfe ? 'utf-16le' : b0 === 0xfe && b1 === 0xff ? 'utf-16be' : ''
  label ||= ENCODING.exec(head)?.[1] ?? /charset="?([A-Za-z0-9._:-]{1,40})/i.exec(contentType)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}
