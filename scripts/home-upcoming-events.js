const DEFAULT_UPCOMING_LIMIT = 5

export function setUpcomingEventDate(card, dateKey) {
  if (card) {
    card.dataset.eventDate = String(dateKey || '')
  }
  return card
}

export function sortUpcomingEventCards(
  list,
  { limit = DEFAULT_UPCOMING_LIMIT } = {}
) {
  if (!list) return []

  const cards = [...list.querySelectorAll('.event-card')]
  cards.sort((left, right) =>
    String(left.dataset.eventDate || '').localeCompare(
      String(right.dataset.eventDate || '')
    )
  )

  cards.forEach((card, index) => {
    card.hidden = index >= limit
    list.appendChild(card)
  })

  const emptyState = list.querySelector('.home-schedule-empty')
  if (emptyState) {
    emptyState.hidden = cards.length > 0
  }

  return cards
}
