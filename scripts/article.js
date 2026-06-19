import { supabase } from './supabaseClient.js'

const titleElement =
document.getElementById('articleTitle')

const dateElement =
document.getElementById('articleDate')

const authorElement =
document.getElementById('articleAuthor')

const dekElement =
document.getElementById('articleDek')

const ghostTitleElement =
document.getElementById('ghostTitle')

const loadingSection =
document.getElementById('loadingSection')

const errorSection =
document.getElementById('errorSection')

const errorElement =
document.getElementById('articleError')

const contentGrid =
document.getElementById('contentGrid')

const tocLinks =
document.getElementById('tocLinks')

const articleBody =
document.getElementById('articleBody')

const footerNote =
document.getElementById('footerNote')

function requiredElementsExist() {
return Boolean(
titleElement &&
dateElement &&
authorElement &&
dekElement &&
ghostTitleElement &&
loadingSection &&
errorSection &&
errorElement &&
contentGrid &&
tocLinks &&
articleBody &&
footerNote
)
}

function getErrorMessage(error) {
if (
error &&
typeof error.message === 'string'
) {
return error.message
}

return 'An unexpected error occurred.'
}

function stripInlineFormatting(text) {
return String(text ?? '')
.replace(
/***([^*\n]+)***/g,
'$1'
)
.replace(
/**([^*\n]+)**/g,
'$1'
)
.replace(
/*([^*\n]+)*/g,
'$1'
)
}

function appendInlineFormatting(
container,
text
) {
const value = String(text ?? '')

const formattingPattern =
/(***[^*\n]+?***|**[^*\n]+?**|*[^*\n]+?*)/g

let previousIndex = 0

for (
const match of value.matchAll(
formattingPattern
)
) {
const matchIndex =
match.index ?? 0

```
if (matchIndex > previousIndex) {
  container.appendChild(
    document.createTextNode(
      value.slice(
        previousIndex,
        matchIndex
      )
    )
  )
}

const formattedText = match[0]

if (
  formattedText.startsWith('***') &&
  formattedText.endsWith('***')
) {
  const strong =
    document.createElement('strong')

  const emphasis =
    document.createElement('em')

  emphasis.textContent =
    formattedText.slice(3, -3)

  strong.appendChild(emphasis)
  container.appendChild(strong)
} else if (
  formattedText.startsWith('**') &&
  formattedText.endsWith('**')
) {
  const strong =
    document.createElement('strong')

  strong.textContent =
    formattedText.slice(2, -2)

  container.appendChild(strong)
} else {
  const emphasis =
    document.createElement('em')

  emphasis.textContent =
    formattedText.slice(1, -1)

  container.appendChild(emphasis)
}

previousIndex =
  matchIndex + formattedText.length
```

}

if (previousIndex < value.length) {
container.appendChild(
document.createTextNode(
value.slice(previousIndex)
)
)
}
}

function parseArticleContent(content) {
const lines =
String(content ?? '')
.replace(/\r\n?/g, '\n')
.split('\n')

const sections = []

let currentSection = null
let paragraphLines = []
let currentList = null

function ensureSection() {
if (!currentSection) {
currentSection = {
title: 'Overview',
blocks: []
}

```
  sections.push(currentSection)
}

return currentSection
```

}

function flushParagraph() {
const text =
paragraphLines
.join(' ')
.replace(/\s+/g, ' ')
.trim()

```
if (text) {
  ensureSection().blocks.push({
    type: 'paragraph',
    text
  })
}

paragraphLines = []
```

}

function closeList() {
currentList = null
}

function startSection(title) {
flushParagraph()
closeList()

```
currentSection = {
  title:
    title.trim() ||
    'Article Section',
  blocks: []
}

sections.push(currentSection)
```

}

for (const rawLine of lines) {
const line = rawLine.trim()

```
if (!line) {
  flushParagraph()
  closeList()
  continue
}

const subheadingMatch =
  line.match(/^###\s+(.+)$/)

if (subheadingMatch) {
  flushParagraph()
  closeList()

  ensureSection().blocks.push({
    type: 'subheading',
    text:
      subheadingMatch[1].trim()
  })

  continue
}

const sectionHeadingMatch =
  line.match(/^#{1,2}\s+(.+)$/)

if (sectionHeadingMatch) {
  startSection(
    sectionHeadingMatch[1]
  )

  continue
}

const calloutMatch =
  line.match(/^>\s*(.+)$/)

if (calloutMatch) {
  flushParagraph()
  closeList()

  ensureSection().blocks.push({
    type: 'callout',
    text:
      calloutMatch[1].trim()
  })

  continue
}

const unorderedItemMatch =
  line.match(/^[-*]\s+(.+)$/)

if (unorderedItemMatch) {
  flushParagraph()

  if (
    !currentList ||
    currentList.type !==
      'unordered-list'
  ) {
    currentList = {
      type: 'unordered-list',
      items: []
    }

    ensureSection().blocks.push(
      currentList
    )
  }

  currentList.items.push(
    unorderedItemMatch[1].trim()
  )

  continue
}

const orderedItemMatch =
  line.match(/^\d+[.)]\s+(.+)$/)

if (orderedItemMatch) {
  flushParagraph()

  if (
    !currentList ||
    currentList.type !==
      'ordered-list'
  ) {
    currentList = {
      type: 'ordered-list',
      items: []
    }

    ensureSection().blocks.push(
      currentList
    )
  }

  currentList.items.push(
    orderedItemMatch[1].trim()
  )

  continue
}

closeList()
paragraphLines.push(line)
```

}

flushParagraph()
closeList()

if (!sections.length) {
sections.push({
title: 'Article Content',
blocks: [
{
type: 'paragraph',
text:
'No article content is available.'
}
]
})
}

return sections
}

function shortenText(
text,
maximumLength
) {
const normalized =
stripInlineFormatting(text)
.replace(/\s+/g, ' ')
.trim()

if (
normalized.length <= maximumLength
) {
return normalized
}

return (
normalized
.slice(0, maximumLength)
.trim() +
'…'
)
}

function createExcerpt(
sections,
rawContent
) {
for (const section of sections) {
for (const block of section.blocks) {
if (
block.type === 'paragraph' ||
block.type === 'callout'
) {
return shortenText(
block.text,
180
)
}

```
  if (
    block.type === 'unordered-list' ||
    block.type === 'ordered-list'
  ) {
    const firstItem =
      block.items[0]

    if (firstItem) {
      return shortenText(
        firstItem,
        180
      )
    }
  }
}
```

}

return shortenText(
String(rawContent ?? '')
.replace(/[#>*-]/g, ' ')
.replace(/\s+/g, ' ')
.trim(),
180
)
}

function createUniqueSectionId(
title,
index,
usedIds
) {
const baseId =
stripInlineFormatting(title)
.toLowerCase()
.normalize('NFKD')
.replace(
/[\u0300-\u036f]/g,
''
)
.replace(
/[^a-z0-9]+/g,
'-'
)
.replace(
/^-+|-+$/g,
''
) ||
`section-${index + 1}`

let id = baseId
let suffix = 2

while (usedIds.has(id)) {
id = `${baseId}-${suffix}`
suffix += 1
}

usedIds.add(id)

return id
}

function renderTableOfContents(
sections
) {
tocLinks.replaceChildren()

const usedIds = new Set()

sections.forEach(
(section, index) => {
const plainTitle =
stripInlineFormatting(
section.title
)

```
  const id =
    createUniqueSectionId(
      plainTitle,
      index,
      usedIds
    )

  section.id = id

  const link =
    document.createElement('a')

  link.href = `#${id}`
  link.textContent = plainTitle

  tocLinks.appendChild(link)
}
```

)
}

function renderContentBlock(block) {
if (block.type === 'subheading') {
const heading =
document.createElement('h3')

```
appendInlineFormatting(
  heading,
  block.text
)

return heading
```

}

if (block.type === 'callout') {
const callout =
document.createElement('div')

```
callout.className = 'callout'

appendInlineFormatting(
  callout,
  block.text
)

return callout
```

}

if (
block.type === 'unordered-list' ||
block.type === 'ordered-list'
) {
const list =
block.type === 'ordered-list'
? document.createElement('ol')
: document.createElement('ul')

```
for (
  const itemText of block.items
) {
  const item =
    document.createElement('li')

  appendInlineFormatting(
    item,
    itemText
  )

  list.appendChild(item)
}

return list
```

}

const paragraph =
document.createElement('p')

appendInlineFormatting(
paragraph,
block.text
)

return paragraph
}

function renderSections(sections) {
articleBody.replaceChildren()

for (const sectionData of sections) {
const section =
document.createElement('section')

```
section.id = sectionData.id
section.className = 'section'

const heading =
  document.createElement('h2')

appendInlineFormatting(
  heading,
  sectionData.title
)

section.appendChild(heading)

if (!sectionData.blocks.length) {
  const emptyParagraph =
    document.createElement('p')

  emptyParagraph.textContent =
    'No additional information was provided.'

  section.appendChild(
    emptyParagraph
  )
}

for (
  const block of sectionData.blocks
) {
  section.appendChild(
    renderContentBlock(block)
  )
}

articleBody.appendChild(section)
```

}
}

function formatArticleDate(createdAt) {
if (!createdAt) {
return 'Published Article'
}

const date = new Date(createdAt)

if (
Number.isNaN(date.getTime())
) {
return 'Published Article'
}

return new Intl.DateTimeFormat(
'en-US',
{
year: 'numeric',
month: 'long',
day: 'numeric'
}
).format(date)
}

function renderArticle(article) {
const title =
String(article.title ?? '')
.trim() ||
'Untitled Article'

const description =
String(
article.description ?? ''
).trim()

const content =
String(article.content ?? '')
.trim()

const normalizedTag =
String(article.tag ?? '')
.trim()
.toLowerCase()

const category =
normalizedTag === 'cashouts'
? 'Cashout'
: 'Ticket'

const sections =
parseArticleContent(content)

const excerpt =
description
? stripInlineFormatting(
description
)
: createExcerpt(
sections,
content
)

document.title =
`${title} | SocialLoop CS Base`

titleElement.textContent = title

ghostTitleElement.textContent =
`${category}\nSupport Article`

dateElement.textContent =
formatArticleDate(
article.created_at
)

authorElement.textContent =
article.author_name
? `By: ${article.author_name}`
: 'SocialLoop Customer Support'

dekElement.textContent =
excerpt ||
`${category} knowledge base article`

renderTableOfContents(sections)
renderSections(sections)

loadingSection.hidden = true
errorSection.hidden = true
contentGrid.hidden = false
footerNote.hidden = false
}

function showError(message) {
if (!requiredElementsExist()) {
console.error(message)
return
}

document.title =
'Article unavailable | SocialLoop CS Base'

titleElement.textContent =
'Article unavailable'

dateElement.textContent =
'Unavailable'

authorElement.textContent = ''

dekElement.textContent =
'This knowledge base article cannot be displayed.'

loadingSection.hidden = true
contentGrid.hidden = true
footerNote.hidden = true

errorElement.textContent = message
errorSection.hidden = false
}

async function loadArticle() {
if (!requiredElementsExist()) {
console.error(
'Required article display elements were not found.'
)

```
return
```

}

const articleId =
new URLSearchParams(
window.location.search
).get('id')

if (!articleId) {
showError(
'No article was selected.'
)

```
return
```

}

try {
const {
data: article,
error
} = await supabase
.from('articles')
.select(`         title,
        description,
        content,
        tag,
        author_name,
        created_at,
        published
      `)
.eq('id', articleId)
.eq('published', true)
.maybeSingle()

```
if (error) {
  throw error
}

if (!article) {
  showError(
    'The requested article could not be found or is not published.'
  )

  return
}

renderArticle(article)
```

} catch (error) {
console.error(
'Article loading error:',
error
)

```
showError(
  `Unable to load article: ${getErrorMessage(error)}`
)
```

}
}

loadArticle()
