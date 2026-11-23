import { describe, expect, it } from 'vitest'
import { markdownHtml } from './markdown'

describe('markdownHtml', () => {
  it('renders headings, lists, code and links', () => {
    const html = markdownHtml('## What to build\n做成看板\n- 一\n- 二\n1. 甲\n\n```\nconst a = 1 < 2\n```\n看 `x` 与 **重点** 和 [PR](https://github.com/x/y/pull/1)')
    expect(html).toContain('<h4 class="pt-1 font-semibold">What to build</h4>')
    expect(html).toContain('<p class="whitespace-pre-wrap">做成看板</p>')
    expect(html).toMatch(/<ul [^>]*><li>一<\/li><li>二<\/li><\/ul><ol [^>]*><li>甲<\/li><\/ol>/)
    expect(html).toContain('<code>const a = 1 &lt; 2</code>')
    expect(html).toMatch(/<code [^>]*>x<\/code>/)
    expect(html).toContain('<strong class="font-semibold">重点</strong>')
    expect(html).toMatch(/<a [^>]*href="https:\/\/github.com\/x\/y\/pull\/1"[^>]*>PR<\/a>/)
  })

  it('escapes script and HTML so none of it becomes markup', () => {
    const html = markdownHtml('<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n## <b>t</b>\n- <iframe>')
    expect(html).not.toMatch(/<(script|img|b|iframe)[\s>]/)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;')
  })

  it('links only http(s), and an attribute cannot be broken out of', () => {
    expect(markdownHtml('[x](javascript:alert(1))')).not.toContain('href')
    const html = markdownHtml('[x](https://a.b/"onmouseover="alert(1))')
    expect(html).not.toContain('" onmouseover')
    expect(html).not.toMatch(/href="[^"]*"onmouseover/)
  })

  it('stops a bare URL at the first non-ASCII character or trailing punctuation', () => {
    const html = markdownHtml('画布 https://claude.ai/artifact/1cuxnyXBCB37Tx9jSVKfLw（25 张），见 https://x.y/z.')
    expect(html).toContain('href="https://claude.ai/artifact/1cuxnyXBCB37Tx9jSVKfLw"')
    expect(html).toContain('</a>（25 张）')
    expect(html).toContain('href="https://x.y/z"')
    expect(html).toMatch(/<\/a>\.<\/p>$/)
  })
})
