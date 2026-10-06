import type { BoxProps, ElementConstructor, MarkdownProps, RenderNode, TextProps } from 'claude-code'

// The terminal's Markdown element draws like an assistant reply: plain `-` bullets
// and literal `[ ]` boxes. Headings and list items are drawn here instead, with
// glyphs and hanging indents; every other block (paragraphs, tables, fences,
// quotes) still goes to the Markdown element.

export type Block =
  | { kind: 'heading'; level: number; text: string; hasGap: boolean }
  | { kind: 'item'; depth: number; marker: 'bullet' | 'ordered' | 'todo' | 'done'; ordinal: string; text: string; hasGap: boolean }
  | { kind: 'markdown'; text: string; hasGap: boolean }

type Elements = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Markdown: ElementConstructor<MarkdownProps>
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/
const FENCE = /^\s*(```|~~~)/
const INDENT_PER_DEPTH = 2
const BULLETS = ['•', '◦', '▪']
// A short `Label:` opening an item ("Status: verifying") is drawn bold.
const LABEL = /^([A-Za-z][\w /&()-]{0,28}:)(\s.*)?$/
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/

export const parseBlocks = (source: string): Block[] => {
  const blocks: Block[] = []
  let markdown: { lines: string[]; hasGap: boolean } | null = null
  let hasGap = false
  let isInFence = false

  const pushMarkdown = (line: string) => {
    markdown = markdown ?? { lines: [], hasGap }
    markdown.lines.push(line)
  }
  const flushMarkdown = () => {
    if (markdown) blocks.push({ kind: 'markdown', text: markdown.lines.join('\n').trimEnd(), hasGap: markdown.hasGap })
    markdown = null
  }

  for (const line of source.split('\n')) {
    const isFence = FENCE.test(line)
    if (isInFence || isFence) {
      pushMarkdown(line)
      isInFence = isFence ? !isInFence : isInFence
      hasGap = false
      continue
    }
    if (line.trim() === '') {
      if (markdown) pushMarkdown(line)
      hasGap = true
      continue
    }

    const heading = HEADING.exec(line)
    const item = ITEM.exec(line)
    const last = blocks.at(-1)
    if (heading) {
      flushMarkdown()
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '', hasGap })
    } else if (item) {
      flushMarkdown()
      const [, indent = '', mark = '-', box, text = ''] = item
      const marker = box === undefined ? (/\d/.test(mark) ? 'ordered' : 'bullet') : box === ' ' ? 'todo' : 'done'
      blocks.push({ kind: 'item', depth: Math.floor(indent.length / INDENT_PER_DEPTH), marker, ordinal: mark, text, hasGap })
    } else if (!markdown && !hasGap && last?.kind === 'item' && /^\s+\S/.test(line)) {
      // An indented line straight after an item continues that item's text.
      blocks[blocks.length - 1] = { ...last, text: `${last.text} ${line.trim()}` }
    } else {
      pushMarkdown(line)
    }
    hasGap = false
  }
  flushMarkdown()

  return blocks
}

const renderInline = ({ Text }: Elements, text: string): RenderNode[] =>
  text
    .split(INLINE)
    .filter(part => part !== '')
    .map(part => {
      if (part.startsWith('`')) return <Text color="suggestion">{part.slice(1, -1)}</Text>
      if (part.startsWith('**')) return <Text bold>{part.slice(2, -2)}</Text>
      if (part.startsWith('~~')) return <Text strikethrough>{part.slice(2, -2)}</Text>
      if (part.startsWith('[')) return <Text underline>{part.slice(1, part.indexOf(']'))}</Text>
      return part
    })

const renderItemText = (elements: Elements, text: string): RenderNode[] => {
  const label = LABEL.exec(text)
  if (!label) return renderInline(elements, text)
  const { Text } = elements
  return [<Text bold>{label[1]}</Text>, ...renderInline(elements, label[2] ?? '')]
}

const markerFor = (block: Extract<Block, { kind: 'item' }>) => {
  if (block.marker === 'todo') return '☐'
  if (block.marker === 'done') return '☑'
  if (block.marker === 'ordered') return block.ordinal
  return BULLETS[Math.min(block.depth, BULLETS.length - 1)] ?? '•'
}

export const renderPlanBody = (elements: Elements, text: string, columns: number) => {
  const { Box, Text, Markdown } = elements

  return (
    <Box flexDirection="column">
      {parseBlocks(text).map((block, i) => {
        const marginTop = i > 0 && (block.hasGap || block.kind === 'heading') ? 1 : 0
        if (block.kind === 'markdown') {
          return (
            <Box marginTop={marginTop}>
              <Markdown text={block.text} />
            </Box>
          )
        }
        if (block.kind === 'heading') {
          return (
            <Box flexDirection="column" marginTop={marginTop}>
              <Text bold underline={block.level === 1} color={block.level <= 2 ? 'claude' : 'text'}>
                {renderInline(elements, block.text)}
              </Text>
              {block.level <= 2 && <Text dimColor>{'─'.repeat(Math.max(1, columns))}</Text>}
            </Box>
          )
        }
        const isDone = block.marker === 'done'
        return (
          <Box flexDirection="row" marginTop={marginTop} paddingLeft={block.depth * INDENT_PER_DEPTH}>
            <Text color={isDone ? 'success' : block.marker === 'todo' ? 'warning' : 'subtle'}>{markerFor(block)} </Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor={isDone}>{renderItemText(elements, block.text)}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}
