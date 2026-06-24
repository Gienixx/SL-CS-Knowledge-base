import {
  WORKBOOK_SOURCE_INVENTORY
} from './workbook-source-inventory.js'

function columnNumberToLetter(columnNumber) {
  let value = columnNumber
  let result = ''

  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }

  return result
}

function normalizeDriverKey(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

const DRIVER_GROUP_DEFINITIONS = Object.freeze([
  Object.freeze({
    groupKey: 'survey',
    groupLabel: 'Survey',
    entries: Object.freeze([
      Object.freeze(['not_rewarded', 'Not rewarded']),
      Object.freeze(['disqualified', 'Disqualified']),
      Object.freeze(['forced_exit', 'Forced Exit']),
      Object.freeze([
        'survey_closed/not_available',
        'Survey is Closed/ Not Available'
      ]),
      Object.freeze(['locked_surveys', 'Locked Surveys']),
      Object.freeze(['reduced_reward', 'Reduced Reward']),
      Object.freeze(['no_survey', 'No Survey']),
      Object.freeze([
        'survey_issue_banners_-too_many_survey_rejected',
        'Too Many Survey Rejected'
      ]),
      Object.freeze([
        'survey_issue_banners_-_survey_recon',
        'Survey Recon'
      ]),
      Object.freeze([
        'survey_issue_banners_-_speeding',
        'Speeding'
      ]),
      Object.freeze(['other_survey_issue', 'Other Survey Issue'])
    ])
  }),
  Object.freeze({
    groupKey: 'cashout',
    groupLabel: 'Cashout',
    entries: Object.freeze([
      Object.freeze([
        'cash_out_follow-up_paypal',
        'Cash Out follow-up PayPal'
      ]),
      Object.freeze([
        'cash_out_follow-up_tremendous',
        'Cash Out follow-up Tremendous'
      ]),
      Object.freeze([
        'cashout_follow-up_-_venmo',
        'Cash Out follow-up Venmo'
      ]),
      Object.freeze([
        'cash_out_inquiry/email_issue_paypal',
        'Cash Out Inquiry/Email Issue/ PayPal'
      ]),
      Object.freeze([
        'cash_out_inquiry/email_issue_tremendous',
        'Cash Out Inquiry/Email Issue/ Tremendous'
      ]),
      Object.freeze([
        'cashout_inquiry/email_issue_-_venmo',
        'Cash Out Inquiry/Email Issue/ Venmo'
      ]),
      Object.freeze([
        'cash_out_sent_with_recon_reminder-_paypal',
        'Cash Out Sent with Recon Reminder- PayPal'
      ]),
      Object.freeze([
        'cash_out_sent_with_recon_reminder-_tremendous',
        'Cash Out Sent with Recon Reminder- Tremendous'
      ]),
      Object.freeze([
        'cashout_sent_with_recon_reminder-_venmo',
        'Cash Out Sent with Recon Reminder- Venmo'
      ]),
      Object.freeze([
        'cash_out_skipped_paypal',
        'Cash Out Skipped PayPal'
      ]),
      Object.freeze([
        'cash_out_skipped_tremendous',
        'Cash Out Skipped Tremendous'
      ]),
      Object.freeze([
        'cash_out_skipped_-_venmo',
        'Cash Out Skipped Venmo'
      ]),
      Object.freeze([
        'cashout_skipped_to_sent_paypal',
        'Cashout Skipped to Sent PayPal'
      ]),
      Object.freeze([
        'cashout_skipped_to_sent_tremendous',
        'Cashout Skipped to Sent Tremendous'
      ]),
      Object.freeze([
        'cashout_skipped_to_sent_-_venmo',
        'Cashout Skipped to Sent Venmo'
      ]),
      Object.freeze([
        'cashout_pend-_paypal',
        'Cashout Pend- PayPal'
      ]),
      Object.freeze([
        'cashout_pend-_tremendous_',
        'Cashout Pend- Tremendous'
      ]),
      Object.freeze([
        'cashout_pend_-_venmo',
        'Cashout Pend- Venmo'
      ]),
      Object.freeze([
        'cashout_pended_to_sent_paypal',
        'Cashout Pended to Sent PayPal'
      ]),
      Object.freeze([
        'cashout_pended_to_sent_tremendous',
        'Cashout Pended to Sent Tremendous'
      ]),
      Object.freeze([
        'cashout_pended_to_sent_-venmo',
        'Cashout Pended to Sent Venmo'
      ]),
      Object.freeze([
        'other_cashout_inquiry',
        'Cashout Other Inquiry'
      ])
    ])
  }),
  Object.freeze({
    groupKey: 'login',
    groupLabel: 'Login',
    entries: Object.freeze([
      Object.freeze([
        'sign_in_wrong_email_used',
        'Sign in Wrong Email Used'
      ]),
      Object.freeze(['sign_in_code_issue', 'Sign in Code issue']),
      Object.freeze([
        'sign_in_cross_platform_issue',
        'Sign in Cross Platform Issue'
      ]),
      Object.freeze([
        'sign_in_other_issues',
        'Sign in Other Issues'
      ])
    ])
  }),
  Object.freeze({
    groupKey: 'paid_offers_promos',
    groupLabel: 'Paid Offers & Promos',
    entries: Object.freeze([
      Object.freeze(['promo_adgem', 'Adgem']),
      Object.freeze(['promo_adjoe', 'Adjoe']),
      Object.freeze(['paid_offer_revu', 'RevU']),
      Object.freeze(['paid_offer_bitlabs', 'Bitlabs']),
      Object.freeze(['paid_offer_besitos', 'Besitos']),
      Object.freeze(['paid_offer_appsflyer', 'AppsFlyer']),
      Object.freeze(['paid_offer_mowpod_', 'Mowpod']),
      Object.freeze(['paid_offer_onetap_', 'OneTap']),
      Object.freeze(['promo_check-ins', 'Check-ins']),
      Object.freeze(['promo_location_bonus', 'Location Bonus']),
      Object.freeze(['promo_referrals', 'Referrals']),
      Object.freeze([
        'other_promo_related_concerns',
        'Other Promo Inquiry'
      ])
    ])
  }),
  Object.freeze({
    groupKey: 'user_profile',
    groupLabel: 'User Profile',
    entries: Object.freeze([
      Object.freeze([
        'user_profile/onboarding',
        'User Profile & Onboarding'
      ]),
      Object.freeze([
        'change_profile_email',
        'Change Profile Email'
      ]),
      Object.freeze(['profile_deletion', 'Profile Deletion'])
    ])
  }),
  Object.freeze({
    groupKey: 'suggestions',
    groupLabel: 'Suggestions',
    entries: Object.freeze([
      Object.freeze(['suggestions', 'Suggestions'])
    ])
  }),
  Object.freeze({
    groupKey: 'fraud_control',
    groupLabel: 'Fraud Control',
    entries: Object.freeze([
      Object.freeze([
        'sms_verification_-_first_attempt',
        'SMS Verification - First Attempt'
      ]),
      Object.freeze([
        'sms_verification_-_change_phone_number_',
        'SMS Verification - Change Phone number'
      ]),
      Object.freeze([
        'sms_verification_-_change_phone_number_reset',
        'SMS Verification - RESET Change Phone number'
      ]),
      Object.freeze([
        'sms_verification_-_change_phone_number_denied',
        'SMS Verification - DENIED Change Phone number'
      ]),
      Object.freeze([
        'sms_verification_others',
        'SMS Verification - Others'
      ]),
      Object.freeze([
        'updates_paypal_verification',
        'PayPal Verification'
      ]),
      Object.freeze(['new_app_feature', 'New App Feature']),
      Object.freeze([
        'fraud_check_-_sms_cashout_requirement',
        'Fraud Check - SMS Re-verification Cashout Requirement'
      ]),
      Object.freeze([
        'fraud_check_-_sms_reset_requirement',
        'Fraud Check - SMS Re-verification RESET Cashout Requirement'
      ]),
      Object.freeze([
        'fraud_check_-_sms_re-verification_denied_cashout_requirement',
        'Fraud Check - SMS Re-verification DENIED Cashout Requirement'
      ]),
      Object.freeze([
        'fraud_check_-_1st_time_cashout_wait_time',
        'Fraud Check - 1st time Cashout wait time'
      ]),
      Object.freeze([
        'fraud_check_-_2nd_time_cashout_wait_time',
        'Fraud Check - 2nd time Cashout wait time'
      ]),
      Object.freeze(['new_fraud_control', 'New Security Control'])
    ])
  }),
  Object.freeze({
    groupKey: 'others',
    groupLabel: 'Others',
    entries: Object.freeze([
      Object.freeze([
        'others_non-target_country_user',
        'Non-Target Country user'
      ]),
      Object.freeze([
        'others_reward_balance_issue',
        'Reward Balance Issue'
      ]),
      Object.freeze(['blank_emails', 'Blank Emails']),
      Object.freeze([
        'other_w9_inquiries_',
        'Other W9 inquiries'
      ]),
      Object.freeze(['user_inbox_full_', 'Inbox Full']),
      Object.freeze(['other_concerns', 'Other Concerns'])
    ])
  })
])

const DRIVER_GROUPS = Object.freeze(
  DRIVER_GROUP_DEFINITIONS.map((group, groupIndex, groups) => {
    const precedingCount = groups
      .slice(0, groupIndex)
      .reduce(
        (total, precedingGroup) =>
          total + precedingGroup.entries.length,
        0
      )
    const firstColumnNumber = precedingCount + 2
    const lastColumnNumber =
      firstColumnNumber + group.entries.length - 1

    return Object.freeze({
      groupKey: group.groupKey,
      groupLabel: group.groupLabel,
      sourceRange:
        `${columnNumberToLetter(firstColumnNumber)}:` +
        `${columnNumberToLetter(lastColumnNumber)}`,
      firstSourceIndex: firstColumnNumber - 1,
      lastSourceIndex: lastColumnNumber - 1,
      concernCount: group.entries.length
    })
  })
)

const DRIVER_COLUMNS = Object.freeze(
  DRIVER_GROUP_DEFINITIONS.flatMap(group =>
    group.entries.map(([sourceKey, driverLabel], groupEntryIndex) => {
      const precedingCount = DRIVER_GROUP_DEFINITIONS
        .slice(
          0,
          DRIVER_GROUP_DEFINITIONS.indexOf(group)
        )
        .reduce(
          (total, precedingGroup) =>
            total + precedingGroup.entries.length,
          0
        )
      const sourceIndex =
        precedingCount + groupEntryIndex + 1
      const sourceColumn =
        columnNumberToLetter(sourceIndex + 1)

      return Object.freeze({
        sourceColumn,
        sourceIndex,
        sourceKey,
        sourceLabel: driverLabel,
        driverKey: normalizeDriverKey(sourceKey),
        driverLabel,
        groupKey: group.groupKey,
        groupLabel: group.groupLabel
      })
    })
  )
)

export const DRIVER_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName: WORKBOOK_SOURCE_INVENTORY.dailyDrivers.sheetName,
    range: "'Daily Drivers'!A:BU",
    stableKeyRow: 1,
    displayLabelRow: 2,
    dataStartRow:
      WORKBOOK_SOURCE_INVENTORY.dailyDrivers.dataStartRow,
    dateColumn: Object.freeze({
      sourceColumn: 'A',
      sourceIndex: 0,
      sourceHeader: 'DATE',
      targetColumn: 'report_date',
      valueType: 'date',
      required: true
    }),
    ignoredFormulaRange: 'BV:CD'
  }),

  destination: Object.freeze({
    tableName: 'ticket_driver_metrics',
    conflictColumns: Object.freeze([
      'report_date',
      'driver_key'
    ])
  }),

  expectedConcernCount: 72,
  groups: DRIVER_GROUPS,
  columns: DRIVER_COLUMNS
})

export const DRIVER_GROUP_KEYS = Object.freeze(
  DRIVER_GROUPS.map(group => group.groupKey)
)

export const DRIVER_KEYS = Object.freeze(
  DRIVER_COLUMNS.map(column => column.driverKey)
)

export function findDriverBySourceColumn(sourceColumn) {
  return DRIVER_COLUMNS.find(
    column => column.sourceColumn === sourceColumn
  ) || null
}

export function findDriverBySourceKey(sourceKey) {
  return DRIVER_COLUMNS.find(
    column => column.sourceKey === sourceKey
  ) || null
}

export function findDriverByKey(driverKey) {
  return DRIVER_COLUMNS.find(
    column => column.driverKey === driverKey
  ) || null
}

export function validateDriverMapping() {
  const errors = []
  const sourceKeys = new Set()
  const driverKeys = new Set()
  const sourceColumns = new Set()

  if (
    DRIVER_COLUMNS.length !==
    DRIVER_MAPPING.expectedConcernCount
  ) {
    errors.push(
      `Expected ${DRIVER_MAPPING.expectedConcernCount} driver columns, ` +
      `received ${DRIVER_COLUMNS.length}.`
    )
  }

  DRIVER_COLUMNS.forEach(column => {
    if (sourceKeys.has(column.sourceKey)) {
      errors.push(`Duplicate source key: ${column.sourceKey}`)
    }

    if (driverKeys.has(column.driverKey)) {
      errors.push(`Duplicate driver key: ${column.driverKey}`)
    }

    if (sourceColumns.has(column.sourceColumn)) {
      errors.push(`Duplicate source column: ${column.sourceColumn}`)
    }

    sourceKeys.add(column.sourceKey)
    driverKeys.add(column.driverKey)
    sourceColumns.add(column.sourceColumn)
  })

  const groupedCount = DRIVER_GROUPS.reduce(
    (total, group) => total + group.concernCount,
    0
  )

  if (groupedCount !== DRIVER_COLUMNS.length) {
    errors.push(
      `Driver group count ${groupedCount} does not match ` +
      `column count ${DRIVER_COLUMNS.length}.`
    )
  }

  return Object.freeze(errors)
}
