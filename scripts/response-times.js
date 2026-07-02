import './response-times-base.js?v=1'

function configureResponseOnlyPage() {
  document.body.classList.add('response-times-only')
  document.title = 'Response Times | SocialLoop CS Base'

  const heading = document.querySelector('.details-title-block h1')
  const subtitle = document.querySelector('.details-title-block p')
  const footer = document.querySelector('.footer-note')
  const readiness = document.getElementById('slaReadiness')
  const slaCard = document.querySelector('.response-sla-card')

  if (heading) heading.textContent = 'Response Times'
  if (subtitle) {
    subtitle.textContent =
      'First-response and resolution-time reporting from normalized Zendesk ticket events.'
  }
  if (footer) {
    footer.textContent =
      'This dashboard uses normalized Zendesk ticket lifecycle events.'
  }

  for (const element of [readiness, slaCard]) {
    if (!element) continue
    element.hidden = true
    element.setAttribute('aria-hidden', 'true')
  }

  const style = document.createElement('style')
  style.id = 'responseTimesOnlyStyles'
  style.textContent = `
    body.response-times-only .response-summary-card:last-child,
    body.response-times-only .detail-table th:nth-child(4),
    body.response-times-only .detail-table td:nth-child(4) {
      display: none !important;
    }
  `
  document.head.appendChild(style)
}

configureResponseOnlyPage()
