import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan } from '../types'
import { renderPlanBody } from './markdown'

const PANE = 'plans'
const DEFAULT_PLAN_DIRS = ['.claude/plans']
const POLL_MS = 1500
const MAX_HOTKEYS = 9

const plans = atom({ plugin: 'plans-viewer', key: 'plans' } as const, [])
const selected = atom({ plugin: 'plans-viewer', key: 'selected' } as const, null)

const countText = (count: number, dirs: readonly string[]) =>
  `${count} plan${count === 1 ? '' : 's'} in ${dirs.length === 1 ? dirs[0] : `${dirs.length} folders`}`

const resolveDir = async ($: EngineInterface, dir: string) => `${await $.session.root()}/${dir}`

// Plan folders live inside the project: absolute, `~` and `..` paths would reach outside it.
const isInsideProject = (dir: string) => !dir.startsWith('/') && !dir.startsWith('~') && !dir.split('/').includes('..')

// Re-reads only the files whose mtime changed, and writes state only when the
// listing changed, so idle folders never redraw the pane.
const refresh = async ($: EngineInterface, dirs: readonly string[]) => {
  const listed = await Promise.all(
    dirs.map(async dir => {
      const resolved = await resolveDir($, dir)
      const entries = await $.fs.list(resolved).catch(() => [])
      return entries
        .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(entry => ({ path: `${resolved}/${entry.name}`, dir, name: entry.name, mtimeMs: entry.mtimeMs }))
    }),
  )
  const files = listed.flat()
  const previous = await read($, plans)
  const isUnchanged =
    previous.length === files.length &&
    files.every((file, i) => previous[i]?.path === file.path && previous[i]?.mtimeMs === file.mtimeMs)
  if (isUnchanged) return

  const next: Plan[] = await Promise.all(
    files.map(
      async file =>
        previous.find(plan => plan.path === file.path && plan.mtimeMs === file.mtimeMs) ?? {
          ...file,
          text: await $.fs.read(file.path).catch(error => `_Could not read this plan: ${error}_`),
        },
    ),
  )
  await update($, plans, () => next)
  $.ui.status(countText(next.length, dirs))
}

export const register: Register = (on, options) => {
  const configured = Array.isArray(options.planDirs)
    ? options.planDirs.map(dir => dir.trim().replace(/\/+$/, '')).filter(dir => dir !== '')
    : []
  const allowed = configured.filter(isInsideProject)
  const ignored = configured.filter(dir => !isInsideProject(dir))
  const dirs = allowed.length > 0 ? allowed : DEFAULT_PLAN_DIRS

  on('session.start', async ($, e, next) => {
    if (ignored.length > 0) {
      $.ui.log(`plans-viewer: ignored planDirs outside the project: ${ignored.join(', ')}`)
    }
    await $.command.register({
      name: 'plans',
      description: `Toggle the live pane of plans in ${dirs.join(', ')}`,
    })
    await refresh($, dirs)
    $.ui.status(countText((await read($, plans)).length, dirs))
    $.clock.every(POLL_MS, () => {
      refresh($, dirs).catch(error => $.ui.status(`plans-viewer: ${error}`))
    })

    return next(e)
  })

  on('command.run', { command: 'plans' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: 'Plans pane closed.' }
    }

    await refresh($, dirs)
    await $.ui.open({ id: PANE, title: 'Plans', focus: true, closeOnEscape: true })

    return { text: 'Plans pane opened. /plans or Esc closes it.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const close = <Button key="close" role="dismiss" label="Close" onPress={() => $.ui.close({ id: PANE })} />
    const list = await read($, plans)
    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No plans in {dirs.join(', ')} yet.</Text>
          {close}
        </Box>
      )
    }

    // Until a tab is picked (or the picked plan is deleted), follow the most recently edited plan.
    const chosen = await read($, selected)
    const newest = list.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
    const plan = list.find(one => one.path === chosen) ?? newest

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {list.map((one, i) => {
            const label = one.name.replace(/\.md$/, '')
            // Two folders holding the same file name: prefix the folder so the tabs stay apart.
            const isAmbiguous = list.some(other => other !== one && other.name === one.name)
            return (
              <Button
                key={`tab:${one.path}`}
                label={isAmbiguous ? `${one.dir}/${label}` : label}
                variant={one === plan ? 'primary' : 'secondary'}
                dimColor={one !== plan}
                onPress={() => update($, selected, () => one.path)}
                {...(i < MAX_HOTKEYS ? { hotkey: String(i + 1) } : {})}
              />
            )
          })}
          {close}
        </Box>
        <Text dimColor>
          {plan.dir}/{plan.name} · updated {new Date(plan.mtimeMs).toTimeString().slice(0, 8)}
        </Text>
        <Box key="plan" marginTop={1}>
          {renderPlanBody({ Box, Text, Markdown }, plan.text.trim() || '_Empty plan._', e.props.bodyColumns)}
        </Box>
      </Box>
    )
  })
}
