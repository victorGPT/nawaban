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

export const pointAt = (words: string[]) => process.stderr.write(`改用：nawaban ${words.map(shellWord).join(' ')}\n`)
