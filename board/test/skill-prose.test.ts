import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), '../../skills')
const INDEX_SKILL_CHARS_AT_MOST = 3000
const PROCESS_SKILL_CHARS_AT_MOST = 1200
const REFERENCE_FILE_CHARS_AT_MOST = 2000
const DESCRIPTION_CHARS_AT_MOST = 120
const INDEX_SKILLS = ['nawaban/SKILL.md']
const PROSE_AN_AGENT_ACTS_ON_HAS_NONE_OF = [
  { what: '人名', pattern: /吴献忠|岳不同/ },
  { what: '原话', pattern: /原话|their words|owner's words/ },
  { what: '署名加日期', pattern: /(决策者|编排者|decision-maker|owner)\s*1[0-2]-[0-3]\d/ },
  { what: '日期', pattern: /\b20\d\d-[01]\d-[0-3]\d\b|(?<![\d-])1[0-2]-[0-3]\d(?![\d-])/ },
  { what: '事故故事', pattern: /事故|起因|踩坑|那次|上次/ },
]

const skillFiles = readdirSync(SKILLS, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ name: f, path: join(SKILLS, f), text: readFileSync(join(SKILLS, f), 'utf8') }))

const charsAtMostFor = (name: string) =>
  INDEX_SKILLS.includes(name) ? INDEX_SKILL_CHARS_AT_MOST
    : name.endsWith('/SKILL.md') ? PROCESS_SKILL_CHARS_AT_MOST
      : REFERENCE_FILE_CHARS_AT_MOST

const anchorOf = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')

test.each(skillFiles)('$name carries no names, quotes, dates or incident stories', ({ text }) => {
  const found = PROSE_AN_AGENT_ACTS_ON_HAS_NONE_OF.filter(({ pattern }) => pattern.test(text)).map(({ what }) => what)
  expect(found).toEqual([])
})

test.each(skillFiles)('$name stays within its length budget', ({ name, text }) => {
  expect(text.length).toBeLessThanOrEqual(charsAtMostFor(name))
  const description = text.match(/^description:\s*(.*)$/m)?.[1] ?? ''
  expect(description.length).toBeLessThanOrEqual(DESCRIPTION_CHARS_AT_MOST)
})

test.each(skillFiles)('$name links only to files and headings that exist', ({ path, text }) => {
  const broken = [...text.matchAll(/\]\((?!https?:)([^)#\s]*)(?:#([^)\s]+))?\)/g)].filter(([, file, anchor]) => {
    const target = file ? resolve(dirname(path), file) : path
    if (!existsSync(target)) return true
    if (!anchor) return false
    const headings = [...readFileSync(target, 'utf8').matchAll(/^#+\s+(.*)$/gm)].map(([, h]) => anchorOf(h!))
    return !headings.includes(decodeURIComponent(anchor))
  })
  expect(broken.map(([link]) => link)).toEqual([])
})
