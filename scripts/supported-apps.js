export const supportedApps = Object.freeze([
  {
    name: 'Eureka Surveys', logo: 'ES.png', website: 'https://eurekasurveys.com/',
    platforms: [
      ['android', 'https://play.google.com/store/apps/details?id=com.eureka.android&hl=en', 'Google Play'],
      ['apple', 'https://apps.apple.com/us/app/eureka-earn-money-for-surveys/id1466346433', 'App Store']
    ]
  },
  {
    name: 'SurveyPop', logo: 'SP.jpg', website: 'https://surveypop.com/',
    platforms: [
      ['android', 'https://play.google.com/store/apps/details?id=com.socialloop.surveypop&hl=en', 'Google Play'],
      ['apple', 'https://apps.apple.com/us/app/survey-pop-make-money-fast/id1619823218', 'App Store']
    ]
  },
  {
    name: 'SurveySpin', logo: 'SS.png', website: 'https://surveyspin.com/',
    platforms: [
      ['android', 'https://play.google.com/store/apps/details?id=com.socialloop.surveyspin&hl=en', 'Google Play'],
      ['apple', 'https://apps.apple.com/us/app/survey-spin-get-paid-cash/id1629477748', 'App Store']
    ]
  }
])

const platformIcons = {
  android: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7 5.7 4.7M17 7l1.3-2.3M6.5 8.5h11v6a2.5 2.5 0 0 1-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5v-6Zm0 0c0-2 1.5-3.5 3.5-3.5h4c2 0 3.5 1.5 3.5 3.5M9.5 17v2M14.5 17v2M4.5 10v3M19.5 10v3"/></svg>',
  apple: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.6 5.2c.7-.8 1.1-1.8 1-2.8-1 .1-2 .6-2.7 1.4-.6.7-1.1 1.8-1 2.7 1 .1 1.7-.5 2.4-1.3Zm1 1.8c-1.5-.1-2.7.8-3.4.8s-1.8-.8-3-.8c-1.5 0-2.8.9-3.5 2.3-.8 1.4-.7 3.1-.2 4.7.5 1.4 1.4 3.9 2.9 3.9 1 0 1.4-.7 2.7-.7s1.7.7 2.7.7c1.1 0 1.8-1 2.5-2 .8-1.2 1.2-2.4 1.3-2.5-.1 0-2.4-.9-2.4-3.5 0-2.2 1.8-3.2 1.9-3.3-1-.1-1.9-1.2-2.4-1.7Z"/></svg>'
}

export function renderSupportedApps(container, apps = supportedApps) {
  container.replaceChildren(...apps.map(app => {
    const card = document.createElement('article')
    card.className = 'landing-card'
    card.innerHTML = `<a class="app-home" href="${app.website}" target="_blank" rel="noopener noreferrer" aria-label="Visit ${app.name} website"><img src="assets/${app.logo}" alt="${app.name} logo"></a><h3><a href="${app.website}" target="_blank" rel="noopener noreferrer">${app.name}</a></h3><div class="app-platforms">${app.platforms.map(([platform, url, label]) => `<a class="platform-link platform-${platform}" href="${url}" target="_blank" rel="noopener noreferrer" aria-label="${app.name} on the ${label}">${platformIcons[platform]}</a>`).join('')}</div>`
    return card
  }))
}
