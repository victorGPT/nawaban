const SAFE_LINK = /^https?:\/\//
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!)

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[\w\-.~:/?#@!$&*+,;=%[\]]+)/g
const TRAILING_PUNCTUATION = /(?:[.,;:!?]|&#39;|&quot;)+$/
const FENCE = /^\s*```/
const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const ORDERED_ITEM = /^\s*\d+[.)]\s+/
const QUOTE = /^&gt;\s?/

const link = (href: string, text: string) =>
  SAFE_LINK.test(href) ? `<a class="text-primary underline-offset-4 hover:underline" href="${href}" target="_blank" rel="noreferrer">${text}</a>` : text

const inline = (escaped: string) =>
  escaped.replace(INLINE, (_, code?: string, strong?: string, text?: string, href?: string, bare?: string) => {
    if (code != null) return `<code class="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">${code}</code>`
    if (strong != null) return `<strong class="font-semibold">${strong}</strong>`
    if (text != null) return link(href!, text)
    const url = bare!.replace(TRAILING_PUNCTUATION, '')
    return link(url, url) + bare!.slice(url.length)
  })

const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || QUOTE.test(line)

export function markdownHtml(source: string) {
  const lines = escapeHtml(source.replace(/\r\n?/g, '\n')).split('\n')
  const blocks: string[] = []
  let i = 0
  const takeWhile = (keep: (line: string) => boolean) => {
    const taken: string[] = []
    while (i < lines.length && keep(lines[i]!)) taken.push(lines[i++]!)
    return taken
  }
  while (i < lines.length) {
    const line = lines[i]!
    const heading = HEADING.exec(line)
    if (!line.trim()) i++
    else if (FENCE.test(line)) {
      i++
      const code = takeWhile((l) => !FENCE.test(l))
      i++
      blocks.push(`<pre class="overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-5"><code>${code.join('\n')}</code></pre>`)
    } else if (heading) {
      i++
      blocks.push(heading[1]!.length === 1 ? `<h3 class="text-lg font-semibold">${inline(heading[2]!)}</h3>` : `<h4 class="pt-1 font-semibold">${inline(heading[2]!)}</h4>`)
    } else if (LIST_ITEM.test(line)) {
      const ordered = ORDERED_ITEM.test(line)
      const tag = ordered ? 'ol' : 'ul'
      const items = takeWhile((l) => LIST_ITEM.test(l) && ORDERED_ITEM.test(l) === ordered).map((l) => `<li>${inline(l.replace(LIST_ITEM, ''))}</li>`)
      blocks.push(`<${tag} class="flex ${tag === 'ol' ? 'list-decimal' : 'list-disc'} flex-col gap-1 pl-5">${items.join('')}</${tag}>`)
    } else if (QUOTE.test(line)) {
      const quoted = takeWhile((l) => QUOTE.test(l)).map((l) => inline(l.replace(QUOTE, '')))
      blocks.push(`<blockquote class="border-l-2 border-border pl-3 whitespace-pre-wrap text-muted-foreground">${quoted.join('\n')}</blockquote>`)
    } else {
      const para = [line, ...(i++, takeWhile((l) => !!l.trim() && !startsBlock(l)))]
      blocks.push(`<p class="whitespace-pre-wrap">${para.map(inline).join('\n')}</p>`)
    }
  }
  return blocks.join('')
}
