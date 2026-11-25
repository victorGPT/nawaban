import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RENAMED_VERBS = ['index', 'inbox', 'page', 'renew', 'progress', 'guard']
const VERBS_THAT_TOOK_A_BODY_FLAG = ['event', 'create']
const WHERE_CALLS_ARE_WRITTEN = ['hooks', 'board/src', 'skills', 'docs/agents', 'herdr/mods', 'install.sh']
const THE_OLD_CLI_SPEAKS_ON_THIS_LINE = /cli\.py|'#\d|'#N'|#<|--db\b/
const RENAMED_CALL = new RegExp(`(?:board/src/cli\\.ts["']?|\\bnawaban)\\s+(?:--\\S+\\s+)*(?:${RENAMED_VERBS.join('|')})\\b`)
const OLD_FLAG_CALL = /(?:board\/src\/cli\.ts["']?|\bnawaban)\s+(?:event|create)\b[^\n]*?\s--(?:kind|body)(?![\w-])/

export function oldUsesOf(row) {
  if (row.cli === 'old') return 0
  if (RENAMED_VERBS.includes(row.verb) || row.verb.startsWith('event --kind')) return row.runs
  return VERBS_THAT_TOOK_A_BODY_FLAG.includes(row.verb) ? (row.flags.body ?? 0) : 0
}

function* filesUnder(path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return
  }
  if (stat.isFile()) yield path
  else if (stat.isDirectory()) for (const name of readdirSync(path)) if (name !== 'node_modules') yield* filesUnder(join(path, name))
}

export function oldCallSites(root) {
  return WHERE_CALLS_ARE_WRITTEN.flatMap((where) => [...filesUnder(join(root, where))]).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => ((RENAMED_CALL.test(line) || OLD_FLAG_CALL.test(line)) && !THE_OLD_CLI_SPEAKS_ON_THIS_LINE.test(line) ? [`${relative(root, file)}:${i + 1}: ${line.trim()}`] : [])),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sites = oldCallSites(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
  process.stdout.write(sites.length ? sites.join('\n') + `\n旧写法调用点 ${sites.length} 处\n` : '旧写法调用点 0 处\n')
  process.exitCode = sites.length ? 1 : 0
}
