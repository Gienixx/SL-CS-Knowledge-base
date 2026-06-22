function createSnapshot(input) {
  return {
    value: input.value,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    scrollTop: input.scrollTop
  }
}

function snapshotsMatch(first, second) {
  return (
    first.value === second.value &&
    first.selectionStart === second.selectionStart &&
    first.selectionEnd === second.selectionEnd
  )
}

export function setupArticleEditorHistory(input) {
  if (!input) {
    return {
      undo() {},
      redo() {},
      reset() {}
    }
  }

  let history = [createSnapshot(input)]
  let historyIndex = 0
  let restoring = false
  let lastInputTime = 0
  let lastInputType = ''

  function restore(snapshot) {
    if (!snapshot) {
      return
    }

    restoring = true
    input.value = snapshot.value
    input.focus()
    input.setSelectionRange(
      snapshot.selectionStart,
      snapshot.selectionEnd
    )
    input.scrollTop = snapshot.scrollTop
    input.dispatchEvent(new Event('input', { bubbles: true }))
    restoring = false
  }

  function pushSnapshot(snapshot, mergeWithCurrent = false) {
    const currentSnapshot = history[historyIndex]

    if (snapshotsMatch(currentSnapshot, snapshot)) {
      return
    }

    if (historyIndex < history.length - 1) {
      history = history.slice(0, historyIndex + 1)
    }

    if (mergeWithCurrent && historyIndex > 0) {
      history[historyIndex] = snapshot
      return
    }

    history.push(snapshot)
    historyIndex = history.length - 1

    if (history.length > 150) {
      history.shift()
      historyIndex -= 1
    }
  }

  function undo() {
    if (historyIndex <= 0) {
      return
    }

    historyIndex -= 1
    restore(history[historyIndex])
  }

  function redo() {
    if (historyIndex >= history.length - 1) {
      return
    }

    historyIndex += 1
    restore(history[historyIndex])
  }

  function reset() {
    history = [createSnapshot(input)]
    historyIndex = 0
    lastInputTime = 0
    lastInputType = ''
  }

  input.addEventListener('input', event => {
    if (restoring) {
      return
    }

    const now = Date.now()
    const inputType = event.inputType || 'programmatic'
    const isTyping =
      inputType === 'insertText' ||
      inputType === 'insertCompositionText' ||
      inputType === 'deleteContentBackward' ||
      inputType === 'deleteContentForward'
    const shouldMerge =
      isTyping &&
      inputType === lastInputType &&
      now - lastInputTime < 750

    pushSnapshot(createSnapshot(input), shouldMerge)
    lastInputTime = now
    lastInputType = inputType
  })

  input.addEventListener('keydown', event => {
    const modifierPressed = event.ctrlKey || event.metaKey

    if (!modifierPressed || event.altKey) {
      return
    }

    const key = event.key.toLowerCase()

    if (key === 'z') {
      event.preventDefault()

      if (event.shiftKey) {
        redo()
      } else {
        undo()
      }
      return
    }

    if (key === 'y') {
      event.preventDefault()
      redo()
    }
  })

  input.form?.addEventListener('reset', () => {
    queueMicrotask(reset)
  })

  return {
    undo,
    redo,
    reset
  }
}
