/**
 * The feed parser (task C25): RSS 2.0, RSS 1.0, Atom, malformed input and the
 * XML tricks it must refuse. Pure functions; no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFeed, FeedParseError, parseFeed, parseXml } from './feed-parser.mjs'

const BASE = 'https://news.example/feed.xml'

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment <item> that is not one -->
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example &amp; Co</title>
    <lastBuildDate>Mon, 02 Nov 2026 08:00:00 GMT</lastBuildDate>
    <item>
      <title>First &lt;b&gt;post&lt;/b&gt;</title>
      <link>/posts/1</link>
      <guid isPermaLink="false">tag:news.example,2026:1</guid>
      <pubDate>Mon, 02 Nov 2026 07:00:00 +0000</pubDate>
      <dc:creator><![CDATA[Asha <asha>]]></dc:creator>
      <description>Short</description>
      <content:encoded><![CDATA[<p>Long <b>body</b> &amp; more</p><script>alert(1)</script>]]></content:encoded>
    </item>
    <item>
      <title>No link</title>
      <guid>https://news.example/posts/2</guid>
      <link>javascript:alert(1)</link>
      <description>&lt;p&gt;Escaped &amp;amp; html&lt;/p&gt;</description>
    </item>
  </channel>
</rss>`

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">Atom &lt;i&gt;blog&lt;/i&gt;</title>
  <updated>2026-11-02T06:00:00Z</updated>
  <entry>
    <id>urn:uuid:1</id>
    <title>Entry</title>
    <link rel="self" href="https://news.example/self"/>
    <link href="/entry/1"/>
    <published>2026-11-01T06:00:00Z</published>
    <updated>2026-11-02T06:00:00Z</updated>
    <author><name>Ben</name></author>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Inline <em>xhtml</em></p></div></content>
  </entry>
  <entry>
    <id>urn:uuid:2</id>
    <title>Plain</title>
    <summary>a &lt; b is not markup</summary>
  </entry>
</feed>`

const RDF = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://news.example/"><title>RDF feed</title></channel>
  <item rdf:about="https://news.example/r/1"><title>One</title><link>https://news.example/r/1</link><dc:date>2026-11-01T01:00:00Z</dc:date></item>
</rdf:RDF>`

test('RSS 2.0: titles, links, dates, authors and content:encoded', () => {
  const f = parseFeed(RSS, BASE)
  assert.equal(f.format, 'rss')
  assert.equal(f.title, 'Example & Co')
  assert.equal(f.items.length, 2)
  const [a, b] = f.items
  assert.equal(a.guid, 'tag:news.example,2026:1')
  assert.equal(a.title, 'First post')
  assert.equal(a.link, 'https://news.example/posts/1')
  assert.equal(a.author, 'Asha <asha>')
  assert.equal(a.date, Date.parse('2026-11-02T07:00:00Z'))
  assert.match(a.body, /Long body & more/)
  assert.ok(!a.body.includes('alert'), 'scripts are dropped')
  assert.equal(b.link, 'https://news.example/posts/2', 'a javascript: link falls back to the permalink guid')
  assert.equal(b.body, 'Escaped & html')
  assert.equal(b.date, null)
})

test('Atom: alternate link, xhtml content, literal text, feed date', () => {
  const f = parseFeed(ATOM, BASE)
  assert.equal(f.format, 'atom')
  assert.equal(f.title, 'Atom blog')
  const [a, b] = f.items
  assert.equal(a.link, 'https://news.example/entry/1')
  assert.equal(a.author, 'Ben')
  assert.match(a.body, /Inline\s+xhtml/)
  assert.equal(a.published, Date.parse('2026-11-01T06:00:00Z'))
  assert.equal(a.date, Date.parse('2026-11-02T06:00:00Z'))
  assert.equal(b.body, 'a < b is not markup')
})

test('RSS 1.0: items beside the channel', () => {
  const f = parseFeed(RDF, BASE)
  assert.equal(f.format, 'rdf')
  assert.equal(f.items[0].guid, 'https://news.example/r/1')
  assert.equal(f.items[0].date, Date.parse('2026-11-01T01:00:00Z'))
})

test('malformed input throws FeedParseError, never anything else', () => {
  for (const xml of [
    '', 'just text', '<rss><channel></rss>', '<rss><channel>', '<a></b>', '<a b=c></a>', '<a b="1></a>',
    '<a><!-- x</a>', '<a><![CDATA[ x</a>', '<a/><b/>', 'junk<a/>', '<1a/>', '<a', '<?xml', '<!DOCTYPE',
    '<html><body>Not a feed</body></html>', '<rss version="2.0"></rss>',
  ]) {
    assert.throws(() => parseFeed(xml, BASE), FeedParseError, JSON.stringify(xml))
  }
})

test('entity bombs and XXE are refused; undeclared entities stay text', () => {
  const lol = `<!DOCTYPE rss [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><rss><channel><title>&b;</title></channel></rss>`
  const xxe = `<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>`
  assert.throws(() => parseFeed(lol, BASE), /internal DTD/)
  assert.throws(() => parseFeed(xxe, BASE), /internal DTD/)
  const plain = '<!DOCTYPE rss PUBLIC "-//Netscape//DTD RSS 0.91//EN" "http://example.com/rss.dtd"><rss><channel><title>A &x; B</title></channel></rss>'
  assert.equal(parseFeed(plain, BASE).format, 'rss')
})

test('one-pass entities: &amp;lt; stays &lt; in XML; bad code points vanish', () => {
  assert.equal(parseXml('<a>&amp;lt; &#65;&#x42; &#xD800; &#0;</a>').text, '&lt; AB  ')
})

test('nesting is capped and huge input stays fast', () => {
  assert.throws(() => parseXml('<a>'.repeat(100) + '</a>'.repeat(100)), /nested too deeply/)
  const start = performance.now()
  assert.throws(() => parseXml('<a ' + 'x="1" '.repeat(300_000)), FeedParseError)
  assert.throws(() => parseXml('<'.repeat(2_000_000)), FeedParseError)
  parseFeed(`<rss><channel>${'<item><title>t</title></item>'.repeat(50_000)}</channel></rss>`, BASE)
  assert.ok(performance.now() - start < 5000, 'parsing stays linear')
})

test('attribute names cannot reach the prototype', () => {
  const n = parseXml('<a __proto__="x" constructor="y"/>')
  assert.equal(Object.getPrototypeOf(n.attrs), Object.prototype)
  assert.equal(({}).x, undefined)
})

test('decodeFeed follows BOM, XML declaration, then the HTTP charset', () => {
  const latin1 = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>caf\xe9</a>', 'latin1')
  assert.match(decodeFeed(latin1), /café/)
  assert.match(decodeFeed(Buffer.from('<a>caf\xe9</a>', 'latin1'), 'text/xml; charset=windows-1252'), /café/)
  assert.match(decodeFeed(Buffer.from('<a>café</a>')), /café/)
  assert.match(decodeFeed(Buffer.from('﻿<a>hi</a>', 'utf16le')), /hi/)
  assert.match(decodeFeed(Buffer.from('<?xml version="1.0" encoding="no-such"?><a>hi</a>')), /hi/)
})
