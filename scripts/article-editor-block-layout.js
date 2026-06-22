function dispatchInput(input) {
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function replaceRange(input, start, end, replacement, selectionStart, selectionEnd) {
  const scrollTop = input.scrollTop
  input.value =
    input.value.slice(0, start) +
    replacement +
    input.value.slice(end)
  input.focus()
  input.setSelectionRange(selectionStart, selectionEnd)
  input.scrollTop = scrollTop
  dispatchInput(input)
}

function getTargetRange(input) {
  let start = input.selectionStart
  let end = input.selectionEnd

  if (start !== end) {
    return { start, end }
  }

  const value = input.value
  const previousBreak = value.lastIndexOf('\n\n', Math.max(0, start - 1))
  const nextBreak = value.indexOf('\n\n', end)

  start = previousBreak === -1 ? 0 : previousBreak + 2
  end = nextBreak === -1 ? value.length : nextBreak

  return { start, end }
}

function getDirectiveBlocks(value) {
  const blocks = []
  const stack = []
  const linePattern = /.*(?:\n|$)/g

  for (const match of value.matchAll(linePattern)) {
    const rawLine = match[0]

    if (!rawLine) {
      continue
    }

    const lineStart = match.index || 0
    const lineEnd = lineStart + rawLine.length
    const trimmed = rawLine.replace(/\r?\n$/, '').trim()

    if (trimmed === ':::') {
      const openBlock = stack.pop()

      if (openBlock) {
        blocks.push({
          ...openBlock,
          closeStart: lineStart,
          closeEnd: lineEnd
        })
      }
      continue
    }

    const openingMatch = trimmed.match(/^:::(\S+)(?:\s+(.+))?$/)

    if (openingMatch) {
      stack.push({
        name: openingMatch[1].toLowerCase(),
        argument: openingMatch[2]?.trim() || '',
        openStart: lineStart,
        openEnd: lineEnd,
        contentStart: lineEnd
      })
    }
  }

  return blocks
}

function findContainingBlock(input, predicate) {
  const selectionStart = input.selectionStart
  const selectionEnd = input.selectionEnd

  return getDirectiveBlocks(input.value)
    .filter(block =>
      predicate(block) &&
      selectionStart >= block.contentStart &&
      selectionEnd <= block.closeStart
    )
    .sort((first, second) =>
      (first.closeEnd - first.openStart) -
      (second.closeEnd - second.openStart)
    )[0] || null
}

function replaceOpeningLine(input, block, openingLine) {
  const replacement = `${openingLine}\n`
  const selectionOffset = replacement.length - (block.openEnd - block.openStart)

  replaceRange(
    input,
    block.openStart,
    block.openEnd,
    replacement,
    Math.max(block.contentStart + selectionOffset, block.openStart + replacement.length),
    Math.max(block.contentStart + selectionOffset, block.openStart + replacement.length)
  )
}

function unwrapBlock(input, block) {
  let body = input.value.slice(block.contentStart, block.closeStart)

  if (body.endsWith('\n')) {
    body = body.slice(0, -1)
  }

  const selectionStart = block.openStart
  const selectionEnd = block.openStart + body.length

  replaceRange(
    input,
    block.openStart,
    block.closeEnd,
    body,
    selectionStart,
    selectionEnd
  )
}

function wrapTarget(input, openingLine, placeholder) {
  const { start, end } = getTargetRange(input)
  const selectedText = input.value.slice(start, end).trim() || placeholder
  const replacement = `${openingLine}\n${selectedText}\n:::`
  const contentStart = start + openingLine.length + 1

  replaceRange(
    input,
    start,
    end,
    replacement,
    contentStart,
    contentStart + selectedText.length
  )
}

function outdentPlainText(input) {
  const { start, end } = getTargetRange(input)
  const selectedText = input.value.slice(start, end)
  const outdented = selectedText
    .split(/\r?\n/)
    .map(line => line.replace(/^ {1,2}/, ''))
    .join('\n')

  if (outdented === selectedText) {
    return
  }

  replaceRange(
    input,
    start,
    end,
    outdented,
    start,
    start + outdented.length
  )
}

export function setupArticleBlockLayout(input) {
  function align(mode) {
    const normalizedMode = ['left', 'center', 'right', 'justify'].includes(mode)
      ? mode
      : 'left'
    const existingBlock = findContainingBlock(
      input,
      block => block.name.startsWith('align-')
    )

    if (existingBlock) {
      replaceOpeningLine(
        input,
        existingBlock,
        `:::align-${normalizedMode}`
      )
      return
    }

    wrapTarget(
      input,
      `:::align-${normalizedMode}`,
      'Aligned text'
    )
  }

  function increaseIndent() {
    const existingBlock = findContainingBlock(
      input,
      block => block.name === 'indent'
    )

    if (existingBlock) {
      const currentLevel = Number.parseInt(existingBlock.argument, 10) || 1
      const nextLevel = Math.min(currentLevel + 1, 6)
      replaceOpeningLine(input, existingBlock, `:::indent ${nextLevel}`)
      return
    }

    wrapTarget(input, ':::indent 1', 'Indented text')
  }

  function decreaseIndent() {
    const existingBlock = findContainingBlock(
      input,
      block => block.name === 'indent'
    )

    if (!existingBlock) {
      outdentPlainText(input)
      return
    }

    const currentLevel = Number.parseInt(existingBlock.argument, 10) || 1

    if (currentLevel <= 1) {
      unwrapBlock(input, existingBlock)
      return
    }

    replaceOpeningLine(
      input,
      existingBlock,
      `:::indent ${currentLevel - 1}`
    )
  }

  return {
    align,
    increaseIndent,
    decreaseIndent
  }
}
