import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseBlocks } from '../hooks/markdown'

const ROOT = '/repo'
const DIR = `${ROOT}/.claude/plans`

type Folder = Map<string, { mtimeMs: number; text: string }>

const PANE = {
  component: 'Pane',
  requestId: 'plans',
  props: {
    title: 'Plans',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PLANS_COMMAND = {
  command: 'plans',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

// Fake plan folders beneath the plugin (absolute dir -> name -> { mtimeMs, text }),
// plus the engine's pane list, status line and log, recorded for the test to read.
const fakeFolders = (on: On, folders: Record<string, Folder>) => {
  const openPanes = new Set<string>()
  const statuses: (string | undefined)[] = []
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    openPanes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    openPanes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...openPanes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('fs.list', (_$, e) => ({
    value: [...(folders[e.path ?? ''] ?? new Map())].map(([name, file]) => ({
      name,
      kind: 'file' as const,
      size: file.text.length,
      mtimeMs: file.mtimeMs,
      isLink: false,
    })),
  }))
  on('fs.read', (_$, e) => {
    const cut = e.path.lastIndexOf('/')
    return { value: folders[e.path.slice(0, cut)]?.get(e.path.slice(cut + 1))?.text ?? '' }
  })

  return { openPanes, statuses, logs }
}

test('draws a tab per plan, follows the newest, and switches on press', async ($, on) => {
  const clock = mock.clock(on)
  const files: Folder = new Map([
    ['PLAN-A.md', { mtimeMs: 1, text: '# Plan A\n\n- [x] step one' }],
    ['PLAN-B.md', { mtimeMs: 2, text: '# Plan B' }],
  ])
  fakeFolders(on, { [DIR]: files })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plans-viewer', surface, ...PANE })
    expect(await ui.find({ key: `tab:${DIR}/PLAN-A.md` })).toBeDefined()
    expect(await ui.find({ key: `tab:${DIR}/PLAN-B.md` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Plan B' })).toBeDefined()

    await ui.press({ key: `tab:${DIR}/PLAN-A.md` })
    expect(await ui.find({ type: 'Text', text: 'Plan A' })).toBeDefined()

    // An edit on disk reaches the open tab on the next poll.
    files.set('PLAN-A.md', { mtimeMs: surface === 'terminal' ? 10 : 20, text: `# Plan A\n\n- [x] edited on ${surface}` })
    await clock.advance(1500)
    expect(await ui.find({ type: 'Text', text: `edited on ${surface}` })).toBeDefined()
    await ui.press({ key: `tab:${DIR}/PLAN-B.md` })
  }
})

test('says so when there are no plans', async ($, on) => {
  fakeFolders(on, {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'plans-viewer', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /No plans in \.claude\/plans/ })).toBeDefined()
})

test('keeps the plan count in the status line as plans come and go', async ($, on) => {
  const clock = mock.clock(on)
  const files: Folder = new Map([['PLAN-A.md', { mtimeMs: 1, text: '# Plan A' }]])
  const { statuses } = fakeFolders(on, { [DIR]: files })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('1 plan in .claude/plans')

  files.set('PLAN-B.md', { mtimeMs: 2, text: '# Plan B' })
  await clock.advance(1500)
  expect(statuses.at(-1)).toBe('2 plans in .claude/plans')
})

test(
  'reads every configured project folder and ignores ones outside the project',
  { options: { planDirs: ['.claude/plans', 'docs/plans/', '~/.claude/plans', '/shared/plans', '../other/plans'] } },
  async ($, on) => {
    const { statuses, logs } = fakeFolders(on, {
      [DIR]: new Map([['PLAN-A.md', { mtimeMs: 1, text: '# Project plan' }]]),
      [`${ROOT}/docs/plans`]: new Map([
        ['PLAN-A.md', { mtimeMs: 2, text: '# Docs plan' }],
        ['ROADMAP.md', { mtimeMs: 3, text: '# Roadmap' }],
      ]),
      '/shared/plans': new Map([['OUTSIDE.md', { mtimeMs: 4, text: '# Outside' }]]),
    })
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    expect(statuses.at(-1)).toBe('3 plans in 2 folders')
    expect(logs.at(-1)).toBe('plans-viewer: ignored planDirs outside the project: ~/.claude/plans, /shared/plans, ../other/plans')

    const ui = await $.ui.mount({ plugin: 'plans-viewer', surface: 'terminal', ...PANE })
    // The same file name in two folders gets its folder in the label.
    expect((await ui.find({ key: `tab:${DIR}/PLAN-A.md` }))?.text).toBe('.claude/plans/PLAN-A')
    expect((await ui.find({ key: `tab:${ROOT}/docs/plans/PLAN-A.md` }))?.text).toBe('docs/plans/PLAN-A')
    expect((await ui.find({ key: `tab:${ROOT}/docs/plans/ROADMAP.md` }))?.text).toBe('ROADMAP')
    expect(await ui.find({ key: 'tab:/shared/plans/OUTSIDE.md' })).toBeUndefined()
  },
)

test('stays closed at start; /plans toggles it, and Close closes it', async ($, on) => {
  const { openPanes } = fakeFolders(on, { [DIR]: new Map([['PLAN-A.md', { mtimeMs: 1, text: '# Plan A' }]]) })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(openPanes.has('plans')).toBe(false)

  await $.command.run(PLANS_COMMAND)
  expect(openPanes.has('plans')).toBe(true)
  await $.command.run(PLANS_COMMAND)
  expect(openPanes.has('plans')).toBe(false)

  await $.command.run(PLANS_COMMAND)
  const ui = await $.ui.mount({ plugin: 'plans-viewer', surface: 'terminal', ...PANE })
  await ui.press({ key: 'close' })
  expect(openPanes.has('plans')).toBe(false)
})

test('parses headings, nested bullets, checkboxes and continuation lines; leaves the rest to Markdown', () => {
  const blocks = parseBlocks(
    [
      '# Title',
      '',
      '- Status: verifying',
      '  - [x] done step',
      '  - [ ] open step',
      '    wraps onto a second line',
      '1. first',
      '',
      'A paragraph with a `code` span.',
      '| a | b |',
      '| - | - |',
      '',
      '```ts',
      '# not a heading',
      '- not an item',
      '```',
    ].join('\n'),
  )
  expect(blocks).toEqual([
    { kind: 'heading', level: 1, text: 'Title', hasGap: false },
    { kind: 'item', depth: 0, marker: 'bullet', ordinal: '-', text: 'Status: verifying', hasGap: true },
    { kind: 'item', depth: 1, marker: 'done', ordinal: '-', text: 'done step', hasGap: false },
    { kind: 'item', depth: 1, marker: 'todo', ordinal: '-', text: 'open step wraps onto a second line', hasGap: false },
    { kind: 'item', depth: 0, marker: 'ordered', ordinal: '1.', text: 'first', hasGap: false },
    // Consecutive non-list blocks stay one chunk; the Markdown element spaces them itself.
    { kind: 'markdown', text: 'A paragraph with a `code` span.\n| a | b |\n| - | - |\n\n```ts\n# not a heading\n- not an item\n```', hasGap: true },
  ])
})

test('draws checkboxes and bullets as glyphs on every surface', async ($, on) => {
  fakeFolders(on, { [DIR]: new Map([['PLAN-A.md', { mtimeMs: 1, text: '## Steps\n- [x] built\n- [ ] shipped\n- note' }]]) })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plans-viewer', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: '☑ ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '☐ ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '• ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[ \]/ })).toBeUndefined()
  }
})
