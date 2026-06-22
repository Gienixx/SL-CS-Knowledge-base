import {
  appendInlineFormatting,
  createExcerpt,
  parseArticleContent as parseRichContent,
  renderArticleUnit,
  stripInlineFormatting
} from './article-content-renderer-v4.js?v=1'

export {
  appendInlineFormatting,
  createExcerpt,
  renderArticleUnit,
  stripInlineFormatting
}

const BLOCK_START_PATTERN =
  /^:::(step|table|rules|response-template|checklist|callout|statements)(?:\s+.*)?$/i
const TOP_LEVEL_HEADING_PATTERN = /^#{1,2}\s+.+$/

function recoverMissingBlockClosures(content) {
  const output = []
  const openBlocks = []
  const lines = String(content ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (
      TOP_LEVEL_HEADING_PATTERN.test(line) &&
      openBlocks.length
    ) {
      while (openBlocks.length) {
        output.push(':::')
        openBlocks.pop()
      }
    }

    output.push(rawLine)

    if (line === ':::') {
      if (openBlocks.length) {
        openBlocks.pop()
      }
      continue
    }

    const blockStartMatch = line.match(BLOCK_START_PATTERN)

    if (blockStartMatch) {
      openBlocks.push(blockStartMatch[1].toLowerCase())
    }
  }

  return output.join('\n')
}

export function parseArticleContent(content) {
  return parseRichContent(recoverMissingBlockClosures(content))
}
