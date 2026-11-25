import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ACCOUNT_DECLARED_IN, ghEnvOf, githubAccountOf, githubTokenOf, whyThisGhWriteMustNotRun } from '../src/github-account.ts'

const sh = promisify(execFile)
const HOOK = new URL('../../hooks/gh-account-guard.sh', import.meta.url).pathname
const GH_LOGGED_IN_AS_BOTH_WITH_WUXIANZHONG_ACTIVE = `#!/bin/sh
case "$*" in
  "auth token --user victorGPT") echo tok-victor ;;
  "auth token --user wuxianzhong-gpt") echo tok-wxz ;;
  "auth token") echo "\${GH_TOKEN:-tok-wxz}" ;;
  *) echo "no oauth token found" >&2; exit 1 ;;
esac
`
let tmp: string
let boardDir: string
const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, HOME: process.env.HOME }

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'gh-account-')))
  await mkdir(join(tmp, 'bin'))
  await writeFile(join(tmp, 'bin', 'gh'), GH_LOGGED_IN_AS_BOTH_WITH_WUXIANZHONG_ACTIVE)
  await chmod(join(tmp, 'bin', 'gh'), 0o755)
  process.env.PATH = `${join(tmp, 'bin')}:${saved.PATH}`
  process.env.HOME = tmp
  delete process.env.GH_TOKEN
  boardDir = join(tmp, 'board')
  await mkdir(boardDir)
})
afterEach(() => {
  process.env.PATH = saved.PATH
  process.env.HOME = saved.HOME
  if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = saved.GH_TOKEN
})

async function ownersMapTo(accounts: Record<string, string>) {
  await mkdir(join(tmp, '.nawaban'), { recursive: true })
  await writeFile(join(tmp, '.nawaban', 'github-accounts.json'), JSON.stringify(accounts))
}

async function repoDeclaring(name: string, tracker: string | null, origin?: string) {
  const repo = join(tmp, name)
  await mkdir(join(repo, 'docs', 'agents'), { recursive: true })
  await sh('git', ['init', '-q', '-b', 'main', repo])
  if (origin) await sh('git', ['-C', repo, 'remote', 'add', 'origin', origin])
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
    await expect(githubTokenOf(repo)).rejects.toThrow(`${ACCOUNT_DECLARED_IN} 加一行 github-account: <账号>`)
  }
})

test('a declared account this machine has not logged into is refused, naming the account to log in', async () => {
  const repo = await repoDeclaring('elsewhere', 'github-account: someone-else\n')
  await expect(githubTokenOf(repo)).rejects.toThrow('要用的账号 someone-else')
})

test('a worktree cut before the declaration merged reads it from the main checkout', async () => {
  const repo = await repoDeclaring('nawaban', null)
  await sh('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  await sh('git', ['-C', repo, 'worktree', 'add', '-q', join(tmp, 'wt'), '-b', 'wt/x'])
  await writeFile(join(repo, ACCOUNT_DECLARED_IN), 'github-account: victorGPT\n')
  expect(await githubTokenOf(join(tmp, 'wt'))).toBe('tok-victor')
})

test('a gh write running on the active account instead of the declared one is refused with the command to run instead', async () => {
  const repo = await repoDeclaring('nawaban', 'github-account: victorGPT\n')
  const why = await whyThisGhWriteMustNotRun('gh pr create --fill', repo, boardDir)
  expect(why).toContain('GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill')
  for (const cmd of ['GH_TOKEN=$(gh auth token --user wuxianzhong-gpt) gh pr create --fill', 'export GH_TOKEN=x; gh pr comment 1 -b hi', 'gh auth switch -u victorGPT && gh pr merge 1',
    'gh api -X POST repos/o/r/issues', 'gh api repos/o/r/issues -f title=a', 'gh api -XPOST repos/o/r/issues', 'gh api repos/o/r/issues -ftitle=a', 'gh api --method=PATCH repos/o/r/issues/1',
    'echo "$(gh pr create --fill)"', 'env GH_TOKEN=$(gh auth token --user wuxianzhong-gpt) gh pr create --fill', 'command gh pr create --fill', 'bash -c "gh pr create --fill"', "sh -c 'gh pr comment 1 -b x'", 'eval "gh pr merge 1"', 'echo 1 | xargs gh pr close', 'env -u GITHUB_TOKEN GH_TOKEN=$(gh auth token --user wuxianzhong-gpt) gh pr create --fill', 'for n in 1 2; do GH_TOKEN=$(gh auth token --user wuxianzhong-gpt) gh pr comment $n --body ok; done', 'xargs -n1 gh pr close', 'gh api graphql -f query="\nmutation { addStar(input: {starrableId: \\"X\\"}) { clientMutationId } }\n"', 'GH_TOKEN=$(gh auth token --user victorGPT) env -u GH_TOKEN gh pr create --fill', 'gh api graphql -F query=@update.graphql', 'gh pr create --title list --body x', 'gh api \\\n  --method POST repos/o/r/issues/1/comments -f body=x', 'QUERY="mutation { x }"; gh api graphql -f query="$QUERY"', 'gh label clone cli/cli --force', "gh api graphql -f query='mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }'", 'echo `gh pr create --fill`', 'cat <<EOF\n$(gh pr create --fill)\nEOF', 'true\ngh pr create --fill', 'cd . && gh issue comment 3 --body "进展：y"', 'gh pr review 4 --approve', 'GH_TOKEN=$TOK gh pr edit 4 --title t']) {
    expect(await whyThisGhWriteMustNotRun(cmd, repo, boardDir), cmd).toContain('victorGPT')
  }
})

test('a gh write that proves it runs as the declared account, and every gh read, passes', async () => {
  const repo = await repoDeclaring('nawaban', 'github-account: victorGPT\n')
  for (const cmd of ['GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill', 'GH_TOKEN="$(gh auth token --user victorGPT)" gh pr merge 1 --squash',
    'gh pr view 1', 'gh pr checks 1', 'gh pr --help', 'gh issue create --help', 'gh pr', 'gh pr checkout 187', 'gh repo deploy-key list', 'GH_TOKEN=$(gh auth token --user victorGPT) gh pr comment 1 --body "先跑 \\`gh pr merge 1\\` 再说"', 'gh repo set-default --view', 'gh repo clone o/r', 'gh api repos/o/r', 'gh api --method GET repos/o/r', 'gh api -X GET search/issues -f q=repo:cli/cli', "gh api graphql -f query='query { viewer { login } }'", 'gh api --silent graphql -f query="{ viewer { login } }"', 'for n in 1 2; do GH_TOKEN=$(gh auth token --user victorGPT) gh pr comment $n --body ok; done', 'env -u GITHUB_TOKEN GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill', 'env GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill', 'gh auth status',
    "GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --body \"$(cat <<'EOF'\nRun this:\ngh pr merge 1 --squash\nEOF\n)\"", 'echo "gh pr create"', 'git commit -m "gh pr merge 1"', 'rg "gh pr create" src']) {
    expect(await whyThisGhWriteMustNotRun(cmd, repo, boardDir), cmd).toBeNull()
  }
  process.env.GH_TOKEN = 'tok-victor'
  expect(await whyThisGhWriteMustNotRun('gh pr create --fill', repo, boardDir)).toBeNull()
})

test('a gh write after cd into another repository uses that repository account', async () => {
  await ownersMapTo({ acme: 'wuxianzhong-gpt' })
  const here = await repoDeclaring('nawaban', 'github-account: victorGPT\n')
  const other = await repoDeclaring('other', null, 'https://github.com/acme/other.git')
  expect(await whyThisGhWriteMustNotRun(`cd ${other} && GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill`, here, boardDir)).toContain('wuxianzhong-gpt')
  expect(await whyThisGhWriteMustNotRun('cd $DIR && GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill', here, boardDir)).toContain('cd')
  expect(await whyThisGhWriteMustNotRun(`cd ${here}/docs && GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill`, other, boardDir)).toBeNull()
})

test('without a declaration the account comes from this machine owner map, and a declaration overrides it', async () => {
  await ownersMapTo({ 'Business-Center-AI-Efficiency': 'wuxianzhong-gpt', victorGPT: 'victorGPT' })
  const nawaban = await repoDeclaring('nawaban', null, 'https://github.com/victorGPT/nawaban.git')
  const roubao = await repoDeclaring('roubao', null, 'git@github.com:business-center-ai-efficiency/roubao.git')
  const overridden = await repoDeclaring('overridden', 'github-account: wuxianzhong-gpt\n', 'https://github.com/victorGPT/x.git')
  expect(await githubAccountOf(nawaban)).toBe('victorGPT')
  expect(await githubTokenOf(roubao)).toBe('tok-wxz')
  expect(await githubAccountOf(overridden)).toBe('wuxianzhong-gpt')
  expect(await whyThisGhWriteMustNotRun('gh pr create --fill', nawaban, boardDir)).toContain('GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill')
  expect(await whyThisGhWriteMustNotRun('gh issue comment 1 -b x', roubao, boardDir)).toBeNull()
})

test('a repository neither declared nor owned by a mapped owner is left alone, as on a teammate machine without the map', async () => {
  const theirs = await repoDeclaring('theirs', null, 'https://github.com/Business-Center-AI-Efficiency/roubao.git')
  expect(await whyThisGhWriteMustNotRun('GH_TOKEN=$(gh auth token --user victorGPT) gh issue comment 1 -b x', theirs, boardDir)).toBeNull()
  expect(await whyThisGhWriteMustNotRun('cd $DIR && gh pr create --fill', theirs, boardDir)).toBeNull()
  await ownersMapTo({ victorGPT: 'victorGPT' })
  expect(await whyThisGhWriteMustNotRun('gh issue comment 1 -b x', theirs, boardDir)).toBeNull()
  await expect(githubTokenOf(theirs)).rejects.toThrow('github-accounts.json')
})

test('a write to another repository with -R uses that repository declaration, found through repos.json', async () => {
  const here = await repoDeclaring('nawaban', 'github-account: victorGPT\n')
  const roubao = await repoDeclaring('roubao', 'github-account: wuxianzhong-gpt\n', 'https://github.com/Acme/roubao.git')
  await writeFile(join(boardDir, 'repos.json'), JSON.stringify({ roubao }))
  expect(await whyThisGhWriteMustNotRun('GH_TOKEN=$(gh auth token --user wuxianzhong-gpt) gh issue comment 5 -R acme/roubao -b x', here, boardDir)).toBeNull()
  expect(await whyThisGhWriteMustNotRun('gh issue comment 5 --repo acme/roubao -b x', here, boardDir)).toBeNull()
  expect(await whyThisGhWriteMustNotRun('GH_TOKEN=$(gh auth token --user victorGPT) gh issue comment 5 -R acme/roubao -b x', here, boardDir)).toContain('wuxianzhong-gpt')
  expect(await whyThisGhWriteMustNotRun('gh issue comment 5 -R acme/unknown -b x', here, boardDir)).toBeNull()
  await ownersMapTo({ acme: 'wuxianzhong-gpt' })
  expect(await whyThisGhWriteMustNotRun('GH_TOKEN=$(gh auth token --user victorGPT) gh issue comment 5 -R acme/unknown -b x', here, boardDir)).toContain('wuxianzhong-gpt')
})

test('the PreToolUse hook as Claude Code runs it refuses a wrong-account gh write with exit 2 and lets reads through', async () => {
  const repo = await repoDeclaring('nawaban', 'github-account: victorGPT\n')
  const hook = (command: string) =>
    new Promise<{ code: number; err: string }>((done) => {
      const child = execFile('sh', [HOOK], { env: { ...process.env, NAWABAN_BOARD_DIR: boardDir } }, (error, _out, err) => done({ code: error ? Number(error.code) : 0, err }))
      child.stdin!.end(JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command } }))
    })
  const refused = await hook('gh pr create --fill')
  expect(refused.code).toBe(2)
  expect(refused.err).toContain('GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill')
  expect((await hook('GH_TOKEN=$(gh auth token --user victorGPT) gh pr create --fill')).code).toBe(0)
  expect((await hook('ls high')).code).toBe(0)
  expect((await hook('true\ngh pr create --fill')).code).toBe(2)
  await writeFile(join(boardDir, 'repos.json'), '{not json')
  const unreadableRepos = await hook('GH_TOKEN=$(gh auth token --user victorGPT) gh issue comment 1 -R acme/x -b y')
  expect(unreadableRepos.code).toBe(2)
  expect(unreadableRepos.err).toContain('repos.json')
})
