import { createReadStream, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { oldUsesOf } from './old-forms.mjs'

const DAYS = 7
const since = Date.now() - DAYS * 86400e3
const KNOWN = new Set('init create block claim close event show list dispatch backup json brief index okr merge import guard inbox web progress page renew serve whoami grants channels schemas actors read post reply schedule schedules edit delete react label typing sync sources download conformance tasks hooks tail wait'.split(' '))
const SUB = new Set(['tasks', 'json', 'grants', 'channels', 'schemas', 'schedule', 'sources', 'hooks'])
const CALL = /(?:^|[;&|(\n]|\$\()\s*(?:cd\s+\S+\s*&&\s*)?(?:\w+=\S*\s+)*(?:(?:node|python3)\s+\S*(board\/src\/cli\.ts|nawaban\/cli\.py)|(nawaban))((?:\s+--(?:db|url|as|scope|name)[ =]\S+)*)\s+([a-z][a-z-]*)([^\n;|&)]*)/g
const withoutHeredocBodies = (t) => t.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '')
const withoutQuotedProse = (t) => t.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (m, a, b) => (/\s/.test(a ?? b ?? '') ? 'Q' : (a ?? b ?? '')))

function* walk(dir) {
  let names
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    const p = join(dir, n)
    let s
    try { s = statSync(p) } catch { continue }
    if (s.isDirectory()) yield* walk(p)
    else if (n.endsWith('.jsonl') && s.mtimeMs >= since) yield p
  }
}

const rows = new Map()
const sessionsThatDispatch = new Set()
const perSession = new Map()
function count(cli, verb, rest, session, typedByPerson, harness) {
  const first = rest.trim().split(/\s+/)[0] ?? ''
  const kind = /--kind[ =]+["']?([a-z]+)/.exec(rest)?.[1]
  const name = SUB.has(verb) && /^[a-z][a-z-]*$/.test(first) ? verb + ' ' + first : verb === 'event' && kind ? 'event --kind ' + kind : verb
  const key = cli + '\t' + name
  const row = rows.get(key) ?? { cli, verb: name, runs: 0, typed: 0, sessions: new Set(), flags: {}, harness: {} }
  row.runs++
  if (typedByPerson) row.typed++
  row.sessions.add(session)
  row.harness[harness] = (row.harness[harness] ?? 0) + 1
  for (const [, f] of rest.matchAll(/\s--([a-z][a-z-]*)/g)) row.flags[f] = (row.flags[f] ?? 0) + 1
  rows.set(key, row)
  if (verb === 'dispatch') sessionsThatDispatch.add(session)
  const mine = perSession.get(session) ?? []
  mine.push(key)
  perSession.set(session, mine)
}
function scan(text, session, typedByPerson, harness) {
  for (const [, path, bare, , verb, rest] of withoutQuotedProse(withoutHeredocBodies(text)).matchAll(CALL)) {
    const cli = bare ? 'nawaban' : path.endsWith('cli.ts') ? 'board' : 'old'
    count(cli, KNOWN.has(verb) ? verb : '(不存在) ' + verb, rest, session, typedByPerson, harness)
  }
}
const seen = new Set()
const commandsOf = (o) => {
  const out = []
  for (const c of Array.isArray(o.message?.content) ? o.message.content : []) {
    if (c.type !== 'tool_use' || seen.has(c.id)) continue
    seen.add(c.id)
    if (typeof c.input?.command === 'string') out.push(c.input.command)
    else if (typeof c.input?.code === 'string') out.push(c.input.code)
  }
  const p = o.payload
  if (p && /call/.test(p.type ?? '') && !seen.has(p.call_id)) {
    seen.add(p.call_id)
    let a = p.arguments ?? p.input ?? p.action
    try { a = typeof a === 'string' ? JSON.parse(a) : a } catch {}
    const cmd = a?.command ?? a?.cmd ?? a
    const text = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : JSON.stringify(cmd ?? '')
    const inJs = [...text.matchAll(/cmd:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\n/g, '\n').replace(/\\(["\\$`])/g, '$1'))
    out.push(...(inJs.length ? inJs : [text]))
  }
  return out
}
let files = 0
for (const [root, harness] of [[join(homedir(), '.claude/projects'), 'claude'], [join(homedir(), '.codex/sessions'), 'codex']]) {
  for (const file of walk(root)) {
    files++
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      if (!line.includes('nawaban') && !line.includes('cli.ts')) continue
      let o
      try { o = JSON.parse(line) } catch { continue }
      const at = Date.parse(o.timestamp ?? '')
      if (at && at < since) continue
      const typed = typeof o.message?.content === 'string' ? /<bash-input>([\s\S]*?)<\/bash-input>/.exec(o.message.content)?.[1] : undefined
      if (typed && !seen.has(o.uuid)) { seen.add(o.uuid); scan(typed, file, true, harness) }
      for (const cmd of commandsOf(o)) scan(cmd, file, false, harness)
    }
  }
}
const out = [...rows.values()].map((r) => {
  const sessions = [...r.sessions]
  return { cli: r.cli, verb: r.verb, runs: r.runs, typed: r.typed, sessions: sessions.length, orchestrator: sessions.filter((s) => sessionsThatDispatch.has(s)).length, harness: r.harness, flags: r.flags }
}).sort((a, b) => b.runs - a.runs)
const old = out.map((r) => ({ cli: r.cli, verb: r.verb, runs: oldUsesOf(r) })).filter((r) => r.runs)
console.log(JSON.stringify({ since: new Date(since).toISOString(), files, sessions: perSession.size, orchestratorSessions: sessionsThatDispatch.size, oldForms: old.reduce((n, r) => n + r.runs, 0), old, rows: out }))
