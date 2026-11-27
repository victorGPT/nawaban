export const UPSTREAM_VERBS = ['whoami', 'grants', 'channels', 'schemas', 'actors', 'read', 'post', 'reply', 'schedule', 'schedules', 'edit', 'delete', 'react', 'label', 'typing', 'sync', 'sources', 'download', 'conformance', 'tasks', 'hooks', 'tail', 'wait']

const SHELL_SAFE_WORD = /^[\w@%+=:,./-]+$/

type Token = { kind: string; name?: string; rawName?: string; value?: string }

export const shellWord = (word: string) => (SHELL_SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)

const readAsAnOption = (word: string) => word.startsWith('-')

export const optionWordsBut = (tokens: Token[], moved: string[]) =>
  tokens.flatMap((t) => {
    if (t.kind !== 'option' || moved.includes(t.name!)) return []
    if (t.value === undefined) return [t.rawName!]
    return readAsAnOption(t.value) ? [`${t.rawName}=${t.value}`] : [t.rawName!, t.value]
  })

export const withBody = (head: string[], body: string | undefined, rest: string[]) =>
  body === undefined ? [...head, ...rest] : readAsAnOption(body) ? [...head, ...rest, '--', body] : [...head, body, ...rest]

export const commandLine = (words: string[]) => `nawaban ${words.map(shellWord).join(' ')}`

export const pointAt = (words: string[]) => process.stderr.write(`已照做，下次写：${commandLine(words)}\n`)
