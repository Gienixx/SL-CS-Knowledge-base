import {
  PDFDocument,
  StandardFonts,
  rgb
} from 'pdf-lib'

export const PAYSLIP_PDF_TEMPLATE_VERSION = 'A4-V1'

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN = 42
const CONTENT_WIDTH = PAGE_WIDTH - (MARGIN * 2)
const BOTTOM_LIMIT = 62

const colors = {
  ink: rgb(0.10, 0.095, 0.165),
  copy: rgb(0.37, 0.36, 0.45),
  muted: rgb(0.55, 0.54, 0.62),
  border: rgb(0.87, 0.86, 0.91),
  panel: rgb(0.975, 0.972, 0.988),
  purple: rgb(0.325, 0.29, 0.72),
  purpleSoft: rgb(0.93, 0.925, 0.995),
  green: rgb(0.18, 0.42, 0.27),
  greenSoft: rgb(0.90, 0.96, 0.92),
  white: rgb(1, 1, 1)
}

function safeText(value, fallback = '-') {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return normalized || fallback
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function money(value, currencyCode = 'USD') {
  const amount = number(value)
  const sign = amount < 0 ? '-' : ''
  const absolute = Math.abs(amount)
  const [whole, decimal] = absolute.toFixed(2).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const symbol = currencyCode === 'USD' ? '$' : `${safeText(currencyCode)} `
  return `${sign}${symbol}${grouped}.${decimal}`
}

function date(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return '-'

  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ]
  return `${months[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`
}

function dateTime(value) {
  if (!value) return '-'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '-'

  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Manila'
  }).formatToParts(parsed)
  const part = type => parts.find(item => item.type === type)?.value || ''

  return safeText(
    `${part('month')} ${part('day')}, ${part('year')} ` +
    `${part('hour')}:${part('minute')} ${part('dayPeriod')} PHT`
  )
}

function hours(value) {
  return `${number(value).toFixed(2)} h`
}

function minutesAsHours(value) {
  return `${(number(value) / 60).toFixed(2)} h`
}

function truncate(font, value, size, maxWidth) {
  const text = safeText(value)
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text

  let result = text
  while (
    result.length > 1 &&
    font.widthOfTextAtSize(`${result}...`, size) > maxWidth
  ) {
    result = result.slice(0, -1)
  }
  return `${result.trim()}...`
}

function rightAlignedX(font, value, size, rightEdge) {
  return rightEdge - font.widthOfTextAtSize(value, size)
}

function totalSpecialEarnings(totals) {
  return (
    number(totals.overtime_earnings) +
    number(totals.rest_day_earnings) +
    number(totals.holiday_earnings)
  )
}

function normalizedItems(items, type) {
  if (!Array.isArray(items)) return []

  return items.map(item => ({
    type,
    description: safeText(item?.description, type === 'earning'
      ? 'Earning'
      : 'Deduction'),
    workDate: date(item?.work_date),
    quantity: item?.quantity == null ? '-' : hours(item.quantity),
    amount: number(item?.amount),
    informationalOnly: Boolean(item?.informational_only)
  }))
}

export async function generatePayslipPdf(preview) {
  const employee = preview?.employee || {}
  const period = preview?.period || {}
  const totals = preview?.totals || {}
  const prepaid = preview?.prepaid_summary || {}
  const approval = preview?.approval || {}
  const currency = safeText(period.currency_code, 'USD')
  const payslipNumber = safeText(preview?.payslip_number, 'UNAVAILABLE')
  const earnings = normalizedItems(preview?.earnings, 'earning')
  const deductions = normalizedItems(preview?.deductions, 'deduction')

  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const pages = []
  let page
  let cursorY

  document.setTitle(`Payslip ${payslipNumber}`)
  document.setAuthor('SocialLoop Customer Support')
  document.setSubject('Finalized employee payslip')
  document.setCreator('SocialLoop Payroll')
  document.setProducer(`SocialLoop Payroll ${PAYSLIP_PDF_TEMPLATE_VERSION}`)

  function drawHeader(continuation = false) {
    page.drawRectangle({
      x: MARGIN,
      y: PAGE_HEIGHT - 77,
      width: 36,
      height: 36,
      color: colors.purple
    })
    page.drawText('SL', {
      x: MARGIN + 10.5,
      y: PAGE_HEIGHT - 64.5,
      size: 11,
      font: bold,
      color: colors.white
    })
    page.drawText('SocialLoop', {
      x: MARGIN + 47,
      y: PAGE_HEIGHT - 52,
      size: 14,
      font: bold,
      color: colors.ink
    })
    page.drawText('CUSTOMER SUPPORT', {
      x: MARGIN + 47,
      y: PAGE_HEIGHT - 67,
      size: 7,
      font: bold,
      color: colors.muted
    })

    const title = continuation ? 'EMPLOYEE PAYSLIP - CONTINUED' : 'EMPLOYEE PAYSLIP'
    page.drawText(title, {
      x: rightAlignedX(bold, title, 13, PAGE_WIDTH - MARGIN),
      y: PAGE_HEIGHT - 51,
      size: 13,
      font: bold,
      color: colors.ink
    })
    page.drawText(payslipNumber, {
      x: rightAlignedX(regular, payslipNumber, 7.5, PAGE_WIDTH - MARGIN),
      y: PAGE_HEIGHT - 66,
      size: 7.5,
      font: regular,
      color: colors.copy
    })

    page.drawLine({
      start: { x: MARGIN, y: PAGE_HEIGHT - 91 },
      end: { x: PAGE_WIDTH - MARGIN, y: PAGE_HEIGHT - 91 },
      thickness: 1.4,
      color: colors.ink
    })
  }

  function addPage(continuation = false) {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    pages.push(page)
    drawHeader(continuation)
    cursorY = PAGE_HEIGHT - 116
  }

  function labelValue(label, value, x, y, width) {
    page.drawText(safeText(label).toUpperCase(), {
      x,
      y,
      size: 6.5,
      font: bold,
      color: colors.muted
    })
    page.drawText(truncate(bold, value, 8.5, width), {
      x,
      y: y - 13,
      size: 8.5,
      font: bold,
      color: colors.ink
    })
  }

  function drawEmployeeInformation() {
    page.drawRectangle({
      x: MARGIN,
      y: cursorY - 70,
      width: CONTENT_WIDTH,
      height: 70,
      color: colors.panel,
      borderColor: colors.border,
      borderWidth: 0.7
    })

    const columnWidth = (CONTENT_WIDTH - 28) / 3
    labelValue(
      'Employee',
      employee.full_name,
      MARGIN + 12,
      cursorY - 17,
      columnWidth
    )
    labelValue(
      'Employee ID',
      employee.employee_number,
      MARGIN + 12,
      cursorY - 44,
      columnWidth
    )
    labelValue(
      'Payroll period',
      `${date(period.period_start)} - ${date(period.period_end)}`,
      MARGIN + 20 + columnWidth,
      cursorY - 17,
      columnWidth
    )
    labelValue(
      'Payment date',
      date(period.payment_date),
      MARGIN + 20 + columnWidth,
      cursorY - 44,
      columnWidth
    )
    labelValue(
      'Status',
      'FINALIZED',
      MARGIN + 28 + (columnWidth * 2),
      cursorY - 17,
      columnWidth
    )
    labelValue(
      'Currency',
      currency,
      MARGIN + 28 + (columnWidth * 2),
      cursorY - 44,
      columnWidth
    )

    cursorY -= 89
  }

  function drawSectionTitle(value) {
    page.drawText(safeText(value).toUpperCase(), {
      x: MARGIN,
      y: cursorY,
      size: 7,
      font: bold,
      color: colors.purple
    })
    cursorY -= 13
  }

  function drawTableHeader() {
    page.drawRectangle({
      x: MARGIN,
      y: cursorY - 18,
      width: CONTENT_WIDTH,
      height: 18,
      color: colors.panel
    })
    const labels = [
      ['DESCRIPTION', MARGIN + 8],
      ['WORK DATE', MARGIN + 304],
      ['HOURS', MARGIN + 384],
      ['AMOUNT', MARGIN + 447]
    ]
    for (const [value, x] of labels) {
      page.drawText(value, {
        x,
        y: cursorY - 12,
        size: 6.5,
        font: bold,
        color: colors.muted
      })
    }
    cursorY -= 18
  }

  function drawItemRow(item) {
    const amount = item.type === 'deduction' && item.amount > 0
      ? `-${money(item.amount, currency)}`
      : money(item.amount, currency)
    const description = item.informationalOnly
      ? `${item.description} (informational)`
      : item.description

    page.drawLine({
      start: { x: MARGIN, y: cursorY - 22 },
      end: { x: PAGE_WIDTH - MARGIN, y: cursorY - 22 },
      thickness: 0.45,
      color: colors.border
    })
    page.drawText(truncate(regular, description, 7.5, 285), {
      x: MARGIN + 8,
      y: cursorY - 14,
      size: 7.5,
      font: regular,
      color: colors.copy
    })
    page.drawText(item.workDate, {
      x: MARGIN + 304,
      y: cursorY - 14,
      size: 7.5,
      font: regular,
      color: colors.copy
    })
    page.drawText(item.quantity, {
      x: rightAlignedX(regular, item.quantity, 7.5, MARGIN + 426),
      y: cursorY - 14,
      size: 7.5,
      font: regular,
      color: colors.copy
    })
    page.drawText(amount, {
      x: rightAlignedX(bold, amount, 7.5, PAGE_WIDTH - MARGIN - 8),
      y: cursorY - 14,
      size: 7.5,
      font: bold,
      color: colors.ink
    })
    cursorY -= 22
  }

  function drawItems(title, items, emptyMessage) {
    if (cursorY - 55 < BOTTOM_LIMIT) addPage(true)
    drawSectionTitle(title)
    drawTableHeader()

    if (!items.length) {
      page.drawText(emptyMessage, {
        x: MARGIN + 8,
        y: cursorY - 14,
        size: 7.5,
        font: regular,
        color: colors.muted
      })
      cursorY -= 24
      return
    }

    for (const item of items) {
      if (cursorY - 24 < BOTTOM_LIMIT) {
        addPage(true)
        drawSectionTitle(`${title} - continued`)
        drawTableHeader()
      }
      drawItemRow(item)
    }
    cursorY -= 15
  }

  function summaryLine(label, value, x, y, width, emphasized = false) {
    const font = emphasized ? bold : regular
    const size = emphasized ? 9 : 7.5
    page.drawText(safeText(label), {
      x,
      y,
      size,
      font,
      color: emphasized ? colors.ink : colors.copy
    })
    page.drawText(value, {
      x: rightAlignedX(font, value, size, x + width),
      y,
      size,
      font,
      color: emphasized ? colors.purple : colors.ink
    })
  }

  function drawSummary() {
    if (cursorY - 210 < BOTTOM_LIMIT) addPage(true)

    drawSectionTitle('Payroll summary')
    const cardTop = cursorY
    const cardHeight = 157
    const gap = 14
    const leftWidth = 221
    const rightX = MARGIN + leftWidth + gap
    const rightWidth = CONTENT_WIDTH - leftWidth - gap

    page.drawRectangle({
      x: MARGIN,
      y: cardTop - cardHeight,
      width: leftWidth,
      height: cardHeight,
      borderColor: colors.border,
      borderWidth: 0.7
    })
    page.drawRectangle({
      x: rightX,
      y: cardTop - cardHeight,
      width: rightWidth,
      height: cardHeight,
      borderColor: colors.border,
      borderWidth: 0.7
    })

    page.drawText('PREPAID HOURS', {
      x: MARGIN + 12,
      y: cardTop - 18,
      size: 7,
      font: bold,
      color: colors.purple
    })
    const prepaidRows = [
      ['Opening balance', minutesAsHours(prepaid.opening_minutes)],
      ['Added this payroll', minutesAsHours(prepaid.added_minutes)],
      ['Applied to prior balances', minutesAsHours(prepaid.applied_minutes)],
      ['Closing balance', minutesAsHours(prepaid.closing_minutes)]
    ]
    prepaidRows.forEach(([label, value], index) => {
      summaryLine(
        label,
        value,
        MARGIN + 12,
        cardTop - 43 - (index * 25),
        leftWidth - 24,
        index === prepaidRows.length - 1
      )
    })

    page.drawText('PAY TOTALS', {
      x: rightX + 12,
      y: cardTop - 18,
      size: 7,
      font: bold,
      color: colors.purple
    })
    const totalRows = [
      ['Regular earnings', money(totals.regular_earnings, currency)],
      ['Prepaid earnings', money(totals.prepaid_scheduled_earnings, currency)],
      ['Overtime and special-day', money(totalSpecialEarnings(totals), currency)],
      ['Other earnings', money(totals.other_earnings, currency)],
      ['Gross pay', money(totals.gross_pay, currency)],
      ['Total deductions', money(totals.total_deductions, currency)]
    ]
    totalRows.forEach(([label, value], index) => {
      summaryLine(
        label,
        value,
        rightX + 12,
        cardTop - 39 - (index * 18),
        rightWidth - 24,
        index === 4
      )
    })

    page.drawRectangle({
      x: rightX + 9,
      y: cardTop - 148,
      width: rightWidth - 18,
      height: 28,
      color: colors.purpleSoft
    })
    summaryLine(
      'Net pay',
      money(totals.net_pay, currency),
      rightX + 16,
      cardTop - 139,
      rightWidth - 32,
      true
    )
    cursorY = cardTop - cardHeight - 20
  }

  function drawApproval() {
    if (cursorY - 77 < BOTTOM_LIMIT) addPage(true)

    drawSectionTitle('Approval information')
    const columns = [
      ['Reviewed by', approval.reviewed_by_name, approval.reviewed_at],
      ['Approved by', approval.approved_by_name, approval.approved_at],
      ['Finalized by', approval.finalized_by_name, approval.finalized_at]
    ]
    const width = CONTENT_WIDTH / columns.length

    columns.forEach(([label, name, timestamp], index) => {
      const x = MARGIN + (index * width)
      page.drawText(safeText(label).toUpperCase(), {
        x,
        y: cursorY,
        size: 6.2,
        font: bold,
        color: colors.muted
      })
      page.drawText(truncate(bold, name, 7.5, width - 12), {
        x,
        y: cursorY - 13,
        size: 7.5,
        font: bold,
        color: colors.ink
      })
      page.drawText(truncate(regular, dateTime(timestamp), 6.5, width - 12), {
        x,
        y: cursorY - 25,
        size: 6.5,
        font: regular,
        color: colors.copy
      })
    })
  }

  addPage(false)
  drawEmployeeInformation()
  drawItems('Earnings', earnings, 'No earnings were recorded.')
  drawItems('Deductions', deductions, 'No employee deductions for this payroll.')
  drawSummary()
  drawApproval()

  pages.forEach((currentPage, index) => {
    const footer = `Finalized payroll - ${PAYSLIP_PDF_TEMPLATE_VERSION} - Page ${index + 1} of ${pages.length}`
    currentPage.drawLine({
      start: { x: MARGIN, y: 43 },
      end: { x: PAGE_WIDTH - MARGIN, y: 43 },
      thickness: 0.45,
      color: colors.border
    })
    currentPage.drawText(footer, {
      x: rightAlignedX(regular, footer, 6.3, PAGE_WIDTH - MARGIN),
      y: 29,
      size: 6.3,
      font: regular,
      color: colors.muted
    })
  })

  return document.save({
    addDefaultPage: false,
    useObjectStreams: true
  })
}
