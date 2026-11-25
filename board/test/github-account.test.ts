import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ACCOUNT_DECLARED_IN, ghEnvOf, githubAccountOf, githubTokenOf } from '../src/github-account.ts'

const GH_LOGGED_IN_AS_ONLY_VICTOR_GPT = `#!/bin/sh
[ "$*" = "auth token --user victorGPT" ] && echo tok-victor && exit 0
echo "no oauth token found for $4" >&2
exit 1
`
let tmp: string
const path = process.env.PATH

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'gh-account-'))
  await mkdir(join(tmp, 'bin'))
  await writeFile(join(tmp, 'bin', 'gh'), GH_LOGGED_IN_AS_ONLY_VICTOR_GPT)
  await chmod(join(tmp, 'bin', 'gh'), 0o755)
  process.env.PATH = `${join(tmp, 'bin')}:${path}`
})
afterEach(() => {
  process.env.PATH = path
})

async function repoDeclaring(name: string, tracker: string | null) {
  const repo = join(tmp, name)
  await mkdir(join(repo, 'docs', 'agents'), { recursive: true })
  if (tracker !== null) await writeFile(join(repo, ACCOUNT_DECLARED_IN), tracker)
  return repo
}

test('a repository declares its account on its own line of the tracker doc and writes get that account token', async () => {
  const repo = await repoDeclaring('nawaban', '# Issue tracker\n\ngithub-account: victorGPT\n\nMore text.\n')
  expect(await githubAccountOf(repo)).toBe('victorGPT')
  expect(await githubTokenOf(repo)).toBe('tok-victor')
  expect((await ghEnvOf(repo)).GH_TOKEN).toBe('tok-victor')
})

test('a repository without a declaration is refused, never falling back to the active gh account', async () => {
  for (const repo of [await repoDeclaring('none', null), await repoDeclaring('prose', 'Writes use github-account: victorGPT, see above.\n'), await repoDeclaring('fenced', '# Example\n```text\ngithub-account: victorGPT\n```\n'), await repoDeclaring('unclosed', '# Example\n```text\ngithub-account: victorGPT\n'), await repoDeclaring('commented', '<!--\ngithub-account: victorGPT\n-->\n')]) {
    await expect(githubTokenOf(repo)).rejects.toThrow(`在 ${ACCOUNT_DECLARED_IN} 加一行 github-account: <账号>`)
  }
})

test('a declared account this machine has not logged into is refused, naming the account to log in', async () => {
  const repo = await repoDeclaring('roubao', 'github-account: wuxianzhong-gpt\n')
  await expect(githubTokenOf(repo)).rejects.toThrow('本机 gh 没登录 ' + repo + ' 声明的账号 wuxianzhong-gpt')
})
