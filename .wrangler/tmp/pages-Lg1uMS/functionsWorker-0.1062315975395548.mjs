var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../config/dashboard-data-mapping.js
var DAILY_VOLUME_COLUMNS = [
  {
    sourceHeader: "DATE",
    targetColumn: "report_date",
    valueType: "date",
    required: true
  },
  {
    sourceHeader: "New",
    targetColumn: "new_tickets",
    valueType: "integer",
    required: true
  },
  {
    sourceHeader: "Unsolved",
    targetColumn: "unsolved_tickets",
    valueType: "integer",
    required: true
  },
  {
    sourceHeader: "Solved",
    targetColumn: "solved_tickets",
    valueType: "integer",
    required: true
  },
  {
    sourceHeader: "One \nTouch Resolution",
    sourceHeaderAliases: [
      "One Touch Resolution"
    ],
    targetColumn: "one_touch_resolution",
    valueType: "percentage",
    required: true
  },
  {
    sourceHeader: "Reopened",
    targetColumn: "reopened_rate",
    valueType: "percentage",
    required: true
  }
];
var PHASE_ONE_DASHBOARD_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName: "Daily Volume ",
    range: "'Daily Volume '!A:F",
    headerRow: 1
  }),
  destination: Object.freeze({
    tableName: "daily_ticket_metrics",
    conflictColumn: "report_date"
  }),
  columns: Object.freeze(
    DAILY_VOLUME_COLUMNS.map(
      (column) => Object.freeze({
        ...column,
        sourceHeaderAliases: Object.freeze(
          column.sourceHeaderAliases || []
        )
      })
    )
  )
});
var PHASE_ONE_REQUIRED_SOURCE_HEADERS = Object.freeze(
  PHASE_ONE_DASHBOARD_MAPPING.columns.filter((column) => column.required).map((column) => column.sourceHeader)
);
var PHASE_ONE_REQUIRED_DATABASE_COLUMNS = Object.freeze(
  PHASE_ONE_DASHBOARD_MAPPING.columns.filter((column) => column.required).map((column) => column.targetColumn)
);
function findPhaseOneColumnBySourceHeader(header) {
  if (typeof header !== "string") {
    return null;
  }
  const normalizedHeader = header.replace(/\s+/g, " ").trim().toLowerCase();
  return PHASE_ONE_DASHBOARD_MAPPING.columns.find((column) => {
    const acceptedHeaders = [
      column.sourceHeader,
      ...column.sourceHeaderAliases
    ];
    return acceptedHeaders.some(
      (acceptedHeader) => acceptedHeader.replace(/\s+/g, " ").trim().toLowerCase() === normalizedHeader
    );
  }) || null;
}
__name(findPhaseOneColumnBySourceHeader, "findPhaseOneColumnBySourceHeader");

// _shared/dashboard-sync-data.js
var MAX_ROWS = 1e3;
var MAX_COLUMNS = 50;
function normalizeHeader(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : "";
}
__name(normalizeHeader, "normalizeHeader");
function isBlank(value) {
  return value === null || value === void 0 || typeof value === "string" && value.trim() === "";
}
__name(isBlank, "isBlank");
function normalizeDate(value) {
  if (isBlank(value)) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(
      Date.UTC(1899, 11, 30) + Math.round(value * 864e5)
    );
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const candidate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    const date = /* @__PURE__ */ new Date(`${candidate}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate ? candidate : null;
  }
  const shortMatch = text.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/
  );
  if (shortMatch) {
    const month = Number(shortMatch[1]);
    const day = Number(shortMatch[2]);
    const year = Number(shortMatch[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
  }
  const parsedDate = new Date(text);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString().slice(0, 10);
}
__name(normalizeDate, "normalizeDate");
function normalizeInteger(value) {
  if (isBlank(value)) return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/[\s,]/g, ""));
  return Number.isFinite(number) && Number.isInteger(number) && number >= 0 ? number : null;
}
__name(normalizeInteger, "normalizeInteger");
function normalizePercentage(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  const hasPercentSign = text.includes("%");
  let number = Number(text.replace(/[\s,%]/g, ""));
  if (!Number.isFinite(number)) return null;
  if (hasPercentSign || number > 1) number /= 100;
  return number >= 0 && number <= 1 ? number : null;
}
__name(normalizePercentage, "normalizePercentage");
function normalizeValue(value, type) {
  if (type === "date") return normalizeDate(value);
  if (type === "integer") return normalizeInteger(value);
  if (type === "percentage") return normalizePercentage(value);
  return isBlank(value) ? null : value;
}
__name(normalizeValue, "normalizeValue");
function extractSheetValues(payload) {
  if (Array.isArray(payload?.values) && payload.values.length > 0) {
    return {
      sheetName: payload.sheetName,
      headers: payload.values[0],
      rows: payload.values.slice(1)
    };
  }
  if (Array.isArray(payload?.headers) && Array.isArray(payload?.rows)) {
    return {
      sheetName: payload.sheetName,
      headers: payload.headers,
      rows: payload.rows
    };
  }
  throw new Error(
    "The request must include either values or headers and rows arrays."
  );
}
__name(extractSheetValues, "extractSheetValues");
function validateSheetPayload(sheetData) {
  if (!Array.isArray(sheetData.headers)) {
    throw new Error("The spreadsheet header row is missing.");
  }
  if (!Array.isArray(sheetData.rows)) {
    throw new Error("The spreadsheet data rows are missing.");
  }
  if (sheetData.headers.length > MAX_COLUMNS) {
    throw new Error(`The spreadsheet exceeds ${MAX_COLUMNS} columns.`);
  }
  if (sheetData.rows.length > MAX_ROWS) {
    throw new Error(`The spreadsheet exceeds ${MAX_ROWS} rows.`);
  }
  const expectedName = normalizeHeader(
    PHASE_ONE_DASHBOARD_MAPPING.source.sheetName
  );
  const receivedName = normalizeHeader(sheetData.sheetName);
  if (receivedName && receivedName !== expectedName) {
    throw new Error(
      `Unexpected worksheet. Expected ${PHASE_ONE_DASHBOARD_MAPPING.source.sheetName.trim()}.`
    );
  }
}
__name(validateSheetPayload, "validateSheetPayload");
function buildColumnIndexes(headers) {
  const indexes = /* @__PURE__ */ new Map();
  headers.forEach((header, index) => {
    const mapping = findPhaseOneColumnBySourceHeader(String(header ?? ""));
    if (!mapping) return;
    if (indexes.has(mapping.targetColumn)) {
      throw new Error(
        `Duplicate spreadsheet header for ${mapping.targetColumn}.`
      );
    }
    indexes.set(mapping.targetColumn, index);
  });
  const missing = PHASE_ONE_DASHBOARD_MAPPING.columns.filter((column) => column.required).filter((column) => !indexes.has(column.targetColumn)).map((column) => column.sourceHeader.replace(/\s+/g, " ").trim());
  if (missing.length > 0) {
    throw new Error(
      `Required spreadsheet headers are missing: ${missing.join(", ")}.`
    );
  }
  return indexes;
}
__name(buildColumnIndexes, "buildColumnIndexes");
function buildRawRow(headers, row) {
  const rawRow = {};
  headers.forEach((header, index) => {
    const fallback = `column_${index + 1}`;
    const key = String(header || fallback).replace(/\s+/g, " ").trim();
    rawRow[key || fallback] = row[index] ?? null;
  });
  return rawRow;
}
__name(buildRawRow, "buildRawRow");
function processRows(headers, rows, indexes, syncRunId) {
  const importedRecords = [];
  const rawRecords = [];
  const warnings = [];
  let ignoredRows = 0;
  let skippedRows = 0;
  const metricColumns = PHASE_ONE_DASHBOARD_MAPPING.columns.filter(
    (column) => column.targetColumn !== "report_date"
  );
  rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      skippedRows += 1;
      warnings.push(`Row ${rowIndex + 2} is not an array.`);
      return;
    }
    const rawDateValue = row[indexes.get("report_date")];
    const reportDate = normalizeDate(rawDateValue);
    const hasAnyMetricValue = metricColumns.some(
      (column) => !isBlank(row[indexes.get(column.targetColumn)])
    );
    if (isBlank(rawDateValue) && !hasAnyMetricValue) {
      ignoredRows += 1;
      return;
    }
    rawRecords.push({
      sheet_name: PHASE_ONE_DASHBOARD_MAPPING.source.sheetName,
      report_date: reportDate,
      raw_data: buildRawRow(headers, row),
      imported_at: (/* @__PURE__ */ new Date()).toISOString(),
      sync_run_id: syncRunId
    });
    if (reportDate && !hasAnyMetricValue) {
      ignoredRows += 1;
      return;
    }
    const record = {};
    const invalidFields = [];
    PHASE_ONE_DASHBOARD_MAPPING.columns.forEach((column) => {
      const sourceValue = row[indexes.get(column.targetColumn)];
      const normalizedValue = normalizeValue(sourceValue, column.valueType);
      record[column.targetColumn] = normalizedValue;
      if (column.required && normalizedValue === null) {
        invalidFields.push(
          column.sourceHeader.replace(/\s+/g, " ").trim()
        );
      }
    });
    if (invalidFields.length > 0) {
      skippedRows += 1;
      warnings.push(
        `Row ${rowIndex + 2} was skipped because these fields are invalid or incomplete: ${invalidFields.join(", ")}.`
      );
      return;
    }
    record.updated_at = (/* @__PURE__ */ new Date()).toISOString();
    importedRecords.push(record);
  });
  return {
    importedRecords,
    rawRecords,
    warnings,
    ignoredRows,
    skippedRows
  };
}
__name(processRows, "processRows");
function getLatestReportDate(records) {
  return records.reduce(
    (latest, record) => !latest || record.report_date > latest ? record.report_date : latest,
    null
  );
}
__name(getLatestReportDate, "getLatestReportDate");

// ../config/workbook-source-inventory.js
var freezeEntries = /* @__PURE__ */ __name((entries) => Object.freeze(
  entries.map((entry) => Object.freeze({ ...entry }))
), "freezeEntries");
var WORKBOOK_SOURCE_INVENTORY = Object.freeze({
  dailyVolume: Object.freeze({
    sheetName: "Daily Volume ",
    usedRange: "A1:S366",
    headerRows: Object.freeze([1]),
    dataStartRow: 2,
    dateColumn: "A",
    baseMetricsRange: "B:F",
    distributions: Object.freeze({
      apps: Object.freeze({
        range: "G:I",
        headers: Object.freeze([
          "EUREKA",
          "SURVEY POP",
          "SURVEY SPIN"
        ])
      }),
      platforms: Object.freeze({
        range: "J:L",
        headers: Object.freeze([
          "iOS",
          "Android",
          "Web"
        ])
      }),
      countries: Object.freeze({
        range: "M:S",
        headers: Object.freeze([
          "Australia (AU)",
          "Canada (CA)",
          "France (FR)",
          "Germany (DE)",
          "UK (GB)",
          "USA (US)",
          "UNKNOWN"
        ])
      })
    })
  }),
  ticketProductivity: Object.freeze({
    sheetName: "Ticket Productivity",
    usedRange: "A1:Y367",
    headerRows: Object.freeze([1, 2]),
    dataStartRow: 3,
    dateColumn: "A",
    metricOrder: Object.freeze([
      "Solved Ticket",
      "Open Tickets",
      "AHT"
    ]),
    agentBlocks: freezeEntries([
      { agentName: "Amora", range: "B:D" },
      { agentName: "Ford", range: "E:G" },
      { agentName: "Gen", range: "H:J" },
      { agentName: "Arez", range: "K:M" },
      { agentName: "Tristan", range: "N:P" },
      { agentName: "Jerson", range: "Q:S" },
      { agentName: "Jean", range: "T:V" },
      { agentName: "Arby", range: "W:Y" }
    ]),
    notes: Object.freeze([
      "Agent names occupy the first column of each three-column block.",
      "The following two cells in each row-one block are blank by design.",
      "AHT is numeric in the source, but its unit must be confirmed before labeling it in the dashboard.",
      "Blank Open Tickets cells must remain null rather than being converted to zero."
    ])
  }),
  dailyDrivers: Object.freeze({
    sheetName: "Daily Drivers",
    usedRange: "A1:CD367",
    headerRows: Object.freeze([1, 2]),
    dataStartRow: 3,
    dateColumn: "A",
    stableKeyRow: 1,
    displayLabelRow: 2,
    detailRange: "B:BU",
    detailColumnCount: 72,
    driverGroups: freezeEntries([
      {
        key: "survey",
        label: "Survey",
        detailRange: "B:L",
        summaryColumn: "BV",
        concernCount: 11
      },
      {
        key: "cashout",
        label: "Cashout",
        detailRange: "M:AH",
        summaryColumn: "BW",
        concernCount: 22
      },
      {
        key: "login",
        label: "Login",
        detailRange: "AI:AL",
        summaryColumn: "BX",
        concernCount: 4
      },
      {
        key: "paid_offers_promos",
        label: "Paid Offers & Promos",
        detailRange: "AM:AX",
        summaryColumn: "BY",
        concernCount: 12
      },
      {
        key: "user_profile",
        label: "User Profile",
        detailRange: "AY:BA",
        summaryColumn: "BZ",
        concernCount: 3
      },
      {
        key: "suggestions",
        label: "Suggestions",
        detailRange: "BB:BB",
        summaryColumn: "CA",
        concernCount: 1
      },
      {
        key: "fraud_control",
        label: "Fraud Control",
        detailRange: "BC:BO",
        summaryColumn: "CB",
        concernCount: 13
      },
      {
        key: "others",
        label: "Others",
        detailRange: "BP:BU",
        summaryColumn: "CC",
        concernCount: 6
      }
    ]),
    summaryRange: "BV:CC",
    dailyTotalColumn: "CD",
    notes: Object.freeze([
      "Columns BV:CD contain worksheet formulas and are not authoritative import sources.",
      "Future dated rows can contain calculated zero or blank summaries even when B:BU has no source data.",
      "The importer must determine row completeness from B:BU, not from BV:CD.",
      "Row one provides stable machine keys and row two provides user-facing labels."
    ])
  }),
  excludedWorksheets: freezeEntries([
    {
      sheetName: "MTD YTD",
      reason: "Not required for normalized daily dashboard datasets."
    },
    {
      sheetName: "Driver Summary ",
      reason: "Contains dates but no populated driver totals in the supplied workbook; totals will be derived from Daily Drivers."
    }
  ])
});
var REQUIRED_WORKBOOK_SHEETS = Object.freeze([
  WORKBOOK_SOURCE_INVENTORY.dailyVolume.sheetName,
  WORKBOOK_SOURCE_INVENTORY.ticketProductivity.sheetName,
  WORKBOOK_SOURCE_INVENTORY.dailyDrivers.sheetName
]);

// ../config/distribution-mapping.js
var DISTRIBUTION_COLUMNS = Object.freeze([
  Object.freeze({
    dimensionType: "app",
    sourceColumn: "G",
    sourceIndex: 6,
    sourceHeader: "EUREKA",
    dimensionKey: "eureka",
    dimensionLabel: "Eureka"
  }),
  Object.freeze({
    dimensionType: "app",
    sourceColumn: "H",
    sourceIndex: 7,
    sourceHeader: "SURVEY POP",
    dimensionKey: "survey_pop",
    dimensionLabel: "SurveyPop"
  }),
  Object.freeze({
    dimensionType: "app",
    sourceColumn: "I",
    sourceIndex: 8,
    sourceHeader: "SURVEY SPIN",
    dimensionKey: "survey_spin",
    dimensionLabel: "SurveySpin"
  }),
  Object.freeze({
    dimensionType: "platform",
    sourceColumn: "J",
    sourceIndex: 9,
    sourceHeader: "iOS",
    dimensionKey: "ios",
    dimensionLabel: "iOS"
  }),
  Object.freeze({
    dimensionType: "platform",
    sourceColumn: "K",
    sourceIndex: 10,
    sourceHeader: "Android",
    dimensionKey: "android",
    dimensionLabel: "Android"
  }),
  Object.freeze({
    dimensionType: "platform",
    sourceColumn: "L",
    sourceIndex: 11,
    sourceHeader: "Web",
    dimensionKey: "web",
    dimensionLabel: "Web"
  }),
  Object.freeze({
    dimensionType: "country",
    sourceColumn: "M",
    sourceIndex: 12,
    sourceHeader: "Australia (AU)",
    dimensionKey: "au",
    dimensionLabel: "Australia"
  }),
  Object.freeze({
    dimensionType: "country",
    sourceColumn: "N",
    sourceIndex: 13,
    sourceHeader: "Canada (CA)",
    dimensionKey: "ca",
    dimensionLabel: "Canada"
  }),
  Object.freeze({
    dimensionType: "country",
    sourceColumn: "O",
    sourceIndex: 14,
    sourceHeader: "France (FR)",
    dimensionKey: "fr",
    dimensionLabel: "France"
  }),
  Object.freeze({
    dimensionType: "country",
    sourceColumn: "P",
    sourceIndex: 15,
    sourceHeader: "Germany (DE)",
    dimensionKey: "de",
    dimensionLabel: "Germany"
  }),
  Object.freeze({
    dimensionType: "country",
    sourceColumn: "Q",
    sourceIndex: 16,
    sourceHeader: "UK (GB)",
    dimensionKey: "gb",
    dimensionLabel: "United Kingdom"
  }),
  Object.freeze({
    dimensionType: "country",
    sourceColumn: "R",
    sourceIndex: 17,
    sourceHeader: "USA (US)",
    dimensionKey: "us",
    dimensionLabel: "United States"
  }),
  Object.freeze({
    dimensionType: "country",
    sourceColumn: "S",
    sourceIndex: 18,
    sourceHeader: "UNKNOWN",
    dimensionKey: "unknown",
    dimensionLabel: "Unknown"
  })
]);
var DISTRIBUTION_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName: WORKBOOK_SOURCE_INVENTORY.dailyVolume.sheetName,
    range: "'Daily Volume '!A:S",
    headerRow: 1,
    dataStartRow: WORKBOOK_SOURCE_INVENTORY.dailyVolume.dataStartRow,
    dateColumn: Object.freeze({
      sourceColumn: "A",
      sourceIndex: 0,
      sourceHeader: "DATE",
      targetColumn: "report_date",
      valueType: "date",
      required: true
    })
  }),
  destination: Object.freeze({
    tableName: "daily_distribution_metrics",
    conflictColumns: Object.freeze([
      "report_date",
      "dimension_type",
      "dimension_key"
    ])
  }),
  columns: DISTRIBUTION_COLUMNS
});
var DISTRIBUTION_TYPES = Object.freeze([
  "app",
  "platform",
  "country"
]);
var DISTRIBUTION_REQUIRED_SOURCE_HEADERS = Object.freeze([
  DISTRIBUTION_MAPPING.source.dateColumn.sourceHeader,
  ...DISTRIBUTION_COLUMNS.map((column) => column.sourceHeader)
]);

// ../config/productivity-mapping.js
var PRODUCTIVITY_AGENTS = Object.freeze([
  Object.freeze({
    agentKey: "amora",
    agentName: "Amora",
    sourceName: "Amora ",
    sourceNameAliases: Object.freeze(["Amora"]),
    sourceRange: "B:D",
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: "B",
        sourceIndex: 1,
        sourceHeader: "Solved Ticket",
        targetColumn: "solved_tickets",
        valueType: "integer",
        nullable: false
      }),
      Object.freeze({
        sourceColumn: "C",
        sourceIndex: 2,
        sourceHeader: "Open Tickets",
        targetColumn: "open_tickets",
        valueType: "integer",
        nullable: true
      }),
      Object.freeze({
        sourceColumn: "D",
        sourceIndex: 3,
        sourceHeader: "AHT",
        targetColumn: "aht_value",
        valueType: "number",
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: "ford",
    agentName: "Ford",
    sourceName: "Ford",
    sourceNameAliases: Object.freeze([]),
    sourceRange: "E:G",
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: "E",
        sourceIndex: 4,
        sourceHeader: "Solved Ticket",
        targetColumn: "solved_tickets",
        valueType: "integer",
        nullable: false
      }),
      Object.freeze({
        sourceColumn: "F",
        sourceIndex: 5,
        sourceHeader: "Open Tickets",
        targetColumn: "open_tickets",
        valueType: "integer",
        nullable: true
      }),
      Object.freeze({
        sourceColumn: "G",
        sourceIndex: 6,
        sourceHeader: "AHT",
        targetColumn: "aht_value",
        valueType: "number",
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: "gen",
    agentName: "Gen",
    sourceName: "Gen",
    sourceNameAliases: Object.freeze([]),
    sourceRange: "H:J",
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: "H",
        sourceIndex: 7,
        sourceHeader: "Solved Ticket",
        targetColumn: "solved_tickets",
        valueType: "integer",
        nullable: false
      }),
      Object.freeze({
        sourceColumn: "I",
        sourceIndex: 8,
        sourceHeader: "Open Tickets",
        targetColumn: "open_tickets",
        valueType: "integer",
        nullable: true
      }),
      Object.freeze({
        sourceColumn: "J",
        sourceIndex: 9,
        sourceHeader: "AHT",
        targetColumn: "aht_value",
        valueType: "number",
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: "arez",
    agentName: "Arez",
    sourceName: "Arez",
    sourceNameAliases: Object.freeze([]),
    sourceRange: "K:M",
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: "K",
        sourceIndex: 10,
        sourceHeader: "Solved Ticket",
        targetColumn: "solved_tickets",
        valueType: "integer",
        nullable: false
      }),
      Object.freeze({
        sourceColumn: "L",
        sourceIndex: 11,
        sourceHeader: "Open Tickets",
        targetColumn: "open_tickets",
        valueType: "integer",
        nullable: true
      }),
      Object.freeze({
        sourceColumn: "M",
        sourceIndex: 12,
        sourceHeader: "AHT",
        targetColumn: "aht_value",
        valueType: "number",
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: "tristan",
    agentName: "Tristan",
    sourceName: "Tristan",
    sourceNameAliases: Object.freeze([]),
    sourceRange: "N:P",
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: "N",
        sourceIndex: 13,
        sourceHeader: "Solved Ticket",
        targetColumn: "solved_tickets",
        valueType: "integer",
        nullable: false
      }),
      Object.freeze({
        sourceColumn: "O",
        sourceIndex: 14,
        sourceHeader: "Open Tickets",
        targetColumn: "open_tickets",
        valueType: "integer",
        nullable: true
      }),
      Object.freeze({
        sourceColumn: "P",
        sourceIndex: 15,
        sourceHeader: "AHT",
        targetColumn: "aht_value",
        valueType: "number",
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: "jerson",
    agentName: "Jerson",
    sourceName: "Jerson",
    sourceNameAliases: Object.freeze([]),
    sourceRange: "Q:S",
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: "Q",
        sourceIndex: 16,
        sourceHeader: "Solved Ticket",
        targetColumn: "solved_tickets",
        valueType: "integer",
        nullable: false
      }),
      Object.freeze({
        sourceColumn: "R",
        sourceIndex: 17,
        sourceHeader: "Open Tickets",
        targetColumn: "open_tickets",
        valueType: "integer",
        nullable: true
      }),
      Object.freeze({
        sourceColumn: "S",
        sourceIndex: 18,
        sourceHeader: "AHT",
        targetColumn: "aht_value",
        valueType: "number",
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: "jean",
    agentName: "Jean",
    sourceName: "Jean",
    sourceNameAliases: Object.freeze([]),
    sourceRange: "T:V",
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: "T",
        sourceIndex: 19,
        sourceHeader: "Solved Ticket",
        targetColumn: "solved_tickets",
        valueType: "integer",
        nullable: false
      }),
      Object.freeze({
        sourceColumn: "U",
        sourceIndex: 20,
        sourceHeader: "Open Tickets",
        targetColumn: "open_tickets",
        valueType: "integer",
        nullable: true
      }),
      Object.freeze({
        sourceColumn: "V",
        sourceIndex: 21,
        sourceHeader: "AHT",
        targetColumn: "aht_value",
        valueType: "number",
        nullable: true
      })
    ])
  }),
  Object.freeze({
    agentKey: "arby",
    agentName: "Arby",
    sourceName: "Arby",
    sourceNameAliases: Object.freeze([]),
    sourceRange: "W:Y",
    metrics: Object.freeze([
      Object.freeze({
        sourceColumn: "W",
        sourceIndex: 22,
        sourceHeader: "Solved Ticket",
        targetColumn: "solved_tickets",
        valueType: "integer",
        nullable: false
      }),
      Object.freeze({
        sourceColumn: "X",
        sourceIndex: 23,
        sourceHeader: "Open Tickets",
        targetColumn: "open_tickets",
        valueType: "integer",
        nullable: true
      }),
      Object.freeze({
        sourceColumn: "Y",
        sourceIndex: 24,
        sourceHeader: "AHT",
        targetColumn: "aht_value",
        valueType: "number",
        nullable: true
      })
    ])
  })
]);
var PRODUCTIVITY_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName: WORKBOOK_SOURCE_INVENTORY.ticketProductivity.sheetName,
    range: "'Ticket Productivity'!A:Y",
    headerRows: Object.freeze([1, 2]),
    dataStartRow: WORKBOOK_SOURCE_INVENTORY.ticketProductivity.dataStartRow,
    dateColumn: Object.freeze({
      sourceColumn: "A",
      sourceIndex: 0,
      sourceHeader: "DATE",
      targetColumn: "report_date",
      valueType: "date",
      required: true
    })
  }),
  destination: Object.freeze({
    tableName: "agent_productivity",
    conflictColumns: Object.freeze([
      "report_date",
      "agent_key"
    ])
  }),
  agents: PRODUCTIVITY_AGENTS,
  defaults: Object.freeze({
    ahtUnit: null
  })
});
var PRODUCTIVITY_AGENT_KEYS = Object.freeze(
  PRODUCTIVITY_AGENTS.map((agent) => agent.agentKey)
);

// ../config/driver-mapping.js
function columnNumberToLetter(columnNumber) {
  let value = columnNumber;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}
__name(columnNumberToLetter, "columnNumberToLetter");
function normalizeDriverKey(value) {
  return value.trim().toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}
__name(normalizeDriverKey, "normalizeDriverKey");
var DRIVER_GROUP_DEFINITIONS = Object.freeze([
  Object.freeze({
    groupKey: "survey",
    groupLabel: "Survey",
    entries: Object.freeze([
      Object.freeze(["not_rewarded", "Not rewarded"]),
      Object.freeze(["disqualified", "Disqualified"]),
      Object.freeze(["forced_exit", "Forced Exit"]),
      Object.freeze([
        "survey_closed/not_available",
        "Survey is Closed/ Not Available"
      ]),
      Object.freeze(["locked_surveys", "Locked Surveys"]),
      Object.freeze(["reduced_reward", "Reduced Reward"]),
      Object.freeze(["no_survey", "No Survey"]),
      Object.freeze([
        "survey_issue_banners_-too_many_survey_rejected",
        "Too Many Survey Rejected"
      ]),
      Object.freeze([
        "survey_issue_banners_-_survey_recon",
        "Survey Recon"
      ]),
      Object.freeze([
        "survey_issue_banners_-_speeding",
        "Speeding"
      ]),
      Object.freeze(["other_survey_issue", "Other Survey Issue"])
    ])
  }),
  Object.freeze({
    groupKey: "cashout",
    groupLabel: "Cashout",
    entries: Object.freeze([
      Object.freeze([
        "cash_out_follow-up_paypal",
        "Cash Out follow-up PayPal"
      ]),
      Object.freeze([
        "cash_out_follow-up_tremendous",
        "Cash Out follow-up Tremendous"
      ]),
      Object.freeze([
        "cashout_follow-up_-_venmo",
        "Cash Out follow-up Venmo"
      ]),
      Object.freeze([
        "cash_out_inquiry/email_issue_paypal",
        "Cash Out Inquiry/Email Issue/ PayPal"
      ]),
      Object.freeze([
        "cash_out_inquiry/email_issue_tremendous",
        "Cash Out Inquiry/Email Issue/ Tremendous"
      ]),
      Object.freeze([
        "cashout_inquiry/email_issue_-_venmo",
        "Cash Out Inquiry/Email Issue/ Venmo"
      ]),
      Object.freeze([
        "cash_out_sent_with_recon_reminder-_paypal",
        "Cash Out Sent with Recon Reminder- PayPal"
      ]),
      Object.freeze([
        "cash_out_sent_with_recon_reminder-_tremendous",
        "Cash Out Sent with Recon Reminder- Tremendous"
      ]),
      Object.freeze([
        "cashout_sent_with_recon_reminder-_venmo",
        "Cash Out Sent with Recon Reminder- Venmo"
      ]),
      Object.freeze([
        "cash_out_skipped_paypal",
        "Cash Out Skipped PayPal"
      ]),
      Object.freeze([
        "cash_out_skipped_tremendous",
        "Cash Out Skipped Tremendous"
      ]),
      Object.freeze([
        "cash_out_skipped_-_venmo",
        "Cash Out Skipped Venmo"
      ]),
      Object.freeze([
        "cashout_skipped_to_sent_paypal",
        "Cashout Skipped to Sent PayPal"
      ]),
      Object.freeze([
        "cashout_skipped_to_sent_tremendous",
        "Cashout Skipped to Sent Tremendous"
      ]),
      Object.freeze([
        "cashout_skipped_to_sent_-_venmo",
        "Cashout Skipped to Sent Venmo"
      ]),
      Object.freeze([
        "cashout_pend-_paypal",
        "Cashout Pend- PayPal"
      ]),
      Object.freeze([
        "cashout_pend-_tremendous_",
        "Cashout Pend- Tremendous"
      ]),
      Object.freeze([
        "cashout_pend_-_venmo",
        "Cashout Pend- Venmo"
      ]),
      Object.freeze([
        "cashout_pended_to_sent_paypal",
        "Cashout Pended to Sent PayPal"
      ]),
      Object.freeze([
        "cashout_pended_to_sent_tremendous",
        "Cashout Pended to Sent Tremendous"
      ]),
      Object.freeze([
        "cashout_pended_to_sent_-venmo",
        "Cashout Pended to Sent Venmo"
      ]),
      Object.freeze([
        "other_cashout_inquiry",
        "Cashout Other Inquiry"
      ])
    ])
  }),
  Object.freeze({
    groupKey: "login",
    groupLabel: "Login",
    entries: Object.freeze([
      Object.freeze([
        "sign_in_wrong_email_used",
        "Sign in Wrong Email Used"
      ]),
      Object.freeze(["sign_in_code_issue", "Sign in Code issue"]),
      Object.freeze([
        "sign_in_cross_platform_issue",
        "Sign in Cross Platform Issue"
      ]),
      Object.freeze([
        "sign_in_other_issues",
        "Sign in Other Issues"
      ])
    ])
  }),
  Object.freeze({
    groupKey: "paid_offers_promos",
    groupLabel: "Paid Offers & Promos",
    entries: Object.freeze([
      Object.freeze(["promo_adgem", "Adgem"]),
      Object.freeze(["promo_adjoe", "Adjoe"]),
      Object.freeze(["paid_offer_revu", "RevU"]),
      Object.freeze(["paid_offer_bitlabs", "Bitlabs"]),
      Object.freeze(["paid_offer_besitos", "Besitos"]),
      Object.freeze(["paid_offer_appsflyer", "AppsFlyer"]),
      Object.freeze(["paid_offer_mowpod_", "Mowpod"]),
      Object.freeze(["paid_offer_onetap_", "OneTap"]),
      Object.freeze(["promo_check-ins", "Check-ins"]),
      Object.freeze(["promo_location_bonus", "Location Bonus"]),
      Object.freeze(["promo_referrals", "Referrals"]),
      Object.freeze([
        "other_promo_related_concerns",
        "Other Promo Inquiry"
      ])
    ])
  }),
  Object.freeze({
    groupKey: "user_profile",
    groupLabel: "User Profile",
    entries: Object.freeze([
      Object.freeze([
        "user_profile/onboarding",
        "User Profile & Onboarding"
      ]),
      Object.freeze([
        "change_profile_email",
        "Change Profile Email"
      ]),
      Object.freeze(["profile_deletion", "Profile Deletion"])
    ])
  }),
  Object.freeze({
    groupKey: "suggestions",
    groupLabel: "Suggestions",
    entries: Object.freeze([
      Object.freeze(["suggestions", "Suggestions"])
    ])
  }),
  Object.freeze({
    groupKey: "fraud_control",
    groupLabel: "Fraud Control",
    entries: Object.freeze([
      Object.freeze([
        "sms_verification_-_first_attempt",
        "SMS Verification - First Attempt"
      ]),
      Object.freeze([
        "sms_verification_-_change_phone_number_",
        "SMS Verification - Change Phone number"
      ]),
      Object.freeze([
        "sms_verification_-_change_phone_number_reset",
        "SMS Verification - RESET Change Phone number"
      ]),
      Object.freeze([
        "sms_verification_-_change_phone_number_denied",
        "SMS Verification - DENIED Change Phone number"
      ]),
      Object.freeze([
        "sms_verification_others",
        "SMS Verification - Others"
      ]),
      Object.freeze([
        "updates_paypal_verification",
        "PayPal Verification"
      ]),
      Object.freeze(["new_app_feature", "New App Feature"]),
      Object.freeze([
        "fraud_check_-_sms_cashout_requirement",
        "Fraud Check - SMS Re-verification Cashout Requirement"
      ]),
      Object.freeze([
        "fraud_check_-_sms_reset_requirement",
        "Fraud Check - SMS Re-verification RESET Cashout Requirement"
      ]),
      Object.freeze([
        "fraud_check_-_sms_re-verification_denied_cashout_requirement",
        "Fraud Check - SMS Re-verification DENIED Cashout Requirement"
      ]),
      Object.freeze([
        "fraud_check_-_1st_time_cashout_wait_time",
        "Fraud Check - 1st time Cashout wait time"
      ]),
      Object.freeze([
        "fraud_check_-_2nd_time_cashout_wait_time",
        "Fraud Check - 2nd time Cashout wait time"
      ]),
      Object.freeze(["new_fraud_control", "New Security Control"])
    ])
  }),
  Object.freeze({
    groupKey: "others",
    groupLabel: "Others",
    entries: Object.freeze([
      Object.freeze([
        "others_non-target_country_user",
        "Non-Target Country user"
      ]),
      Object.freeze([
        "others_reward_balance_issue",
        "Reward Balance Issue"
      ]),
      Object.freeze(["blank_emails", "Blank Emails"]),
      Object.freeze([
        "other_w9_inquiries_",
        "Other W9 inquiries"
      ]),
      Object.freeze(["user_inbox_full_", "Inbox Full"]),
      Object.freeze(["other_concerns", "Other Concerns"])
    ])
  })
]);
var DRIVER_GROUPS = Object.freeze(
  DRIVER_GROUP_DEFINITIONS.map((group, groupIndex, groups) => {
    const precedingCount = groups.slice(0, groupIndex).reduce(
      (total, precedingGroup) => total + precedingGroup.entries.length,
      0
    );
    const firstColumnNumber = precedingCount + 2;
    const lastColumnNumber = firstColumnNumber + group.entries.length - 1;
    return Object.freeze({
      groupKey: group.groupKey,
      groupLabel: group.groupLabel,
      sourceRange: `${columnNumberToLetter(firstColumnNumber)}:${columnNumberToLetter(lastColumnNumber)}`,
      firstSourceIndex: firstColumnNumber - 1,
      lastSourceIndex: lastColumnNumber - 1,
      concernCount: group.entries.length
    });
  })
);
var DRIVER_COLUMNS = Object.freeze(
  DRIVER_GROUP_DEFINITIONS.flatMap(
    (group) => group.entries.map(([sourceKey, driverLabel], groupEntryIndex) => {
      const precedingCount = DRIVER_GROUP_DEFINITIONS.slice(
        0,
        DRIVER_GROUP_DEFINITIONS.indexOf(group)
      ).reduce(
        (total, precedingGroup) => total + precedingGroup.entries.length,
        0
      );
      const sourceIndex = precedingCount + groupEntryIndex + 1;
      const sourceColumn = columnNumberToLetter(sourceIndex + 1);
      return Object.freeze({
        sourceColumn,
        sourceIndex,
        sourceKey,
        sourceLabel: driverLabel,
        driverKey: normalizeDriverKey(sourceKey),
        driverLabel,
        groupKey: group.groupKey,
        groupLabel: group.groupLabel
      });
    })
  )
);
var DRIVER_MAPPING = Object.freeze({
  source: Object.freeze({
    sheetName: WORKBOOK_SOURCE_INVENTORY.dailyDrivers.sheetName,
    range: "'Daily Drivers'!A:BU",
    stableKeyRow: 1,
    displayLabelRow: 2,
    dataStartRow: WORKBOOK_SOURCE_INVENTORY.dailyDrivers.dataStartRow,
    dateColumn: Object.freeze({
      sourceColumn: "A",
      sourceIndex: 0,
      sourceHeader: "DATE",
      targetColumn: "report_date",
      valueType: "date",
      required: true
    }),
    ignoredFormulaRange: "BV:CD"
  }),
  destination: Object.freeze({
    tableName: "ticket_driver_metrics",
    conflictColumns: Object.freeze([
      "report_date",
      "driver_key"
    ])
  }),
  expectedConcernCount: 72,
  groups: DRIVER_GROUPS,
  columns: DRIVER_COLUMNS
});
var DRIVER_GROUP_KEYS = Object.freeze(
  DRIVER_GROUPS.map((group) => group.groupKey)
);
var DRIVER_KEYS = Object.freeze(
  DRIVER_COLUMNS.map((column) => column.driverKey)
);
function validateDriverMapping() {
  const errors = [];
  const sourceKeys = /* @__PURE__ */ new Set();
  const driverKeys = /* @__PURE__ */ new Set();
  const sourceColumns = /* @__PURE__ */ new Set();
  if (DRIVER_COLUMNS.length !== DRIVER_MAPPING.expectedConcernCount) {
    errors.push(
      `Expected ${DRIVER_MAPPING.expectedConcernCount} driver columns, received ${DRIVER_COLUMNS.length}.`
    );
  }
  DRIVER_COLUMNS.forEach((column) => {
    if (sourceKeys.has(column.sourceKey)) {
      errors.push(`Duplicate source key: ${column.sourceKey}`);
    }
    if (driverKeys.has(column.driverKey)) {
      errors.push(`Duplicate driver key: ${column.driverKey}`);
    }
    if (sourceColumns.has(column.sourceColumn)) {
      errors.push(`Duplicate source column: ${column.sourceColumn}`);
    }
    sourceKeys.add(column.sourceKey);
    driverKeys.add(column.driverKey);
    sourceColumns.add(column.sourceColumn);
  });
  const groupedCount = DRIVER_GROUPS.reduce(
    (total, group) => total + group.concernCount,
    0
  );
  if (groupedCount !== DRIVER_COLUMNS.length) {
    errors.push(
      `Driver group count ${groupedCount} does not match column count ${DRIVER_COLUMNS.length}.`
    );
  }
  return Object.freeze(errors);
}
__name(validateDriverMapping, "validateDriverMapping");

// _shared/dashboard-sync-datasets.js
var MAX_DATASET_ROWS = 1e3;
var MAX_DATASET_COLUMNS = 100;
var REQUIRED_DATASET_KEYS = Object.freeze([
  "dailyVolume",
  "ticketProductivity",
  "dailyDrivers"
]);
function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : "";
}
__name(normalizeText, "normalizeText");
function isBlank2(value) {
  return value === null || value === void 0 || typeof value === "string" && value.trim() === "";
}
__name(isBlank2, "isBlank");
function normalizeDate2(value) {
  if (isBlank2(value)) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(
      Date.UTC(1899, 11, 30) + Math.round(value * 864e5)
    );
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const candidate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    const date = /* @__PURE__ */ new Date(`${candidate}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate ? candidate : null;
  }
  const parsedDate = new Date(text);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString().slice(0, 10);
}
__name(normalizeDate2, "normalizeDate");
function normalizeInteger2(value) {
  if (isBlank2(value)) return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/[\s,]/g, ""));
  return Number.isFinite(number) && Number.isInteger(number) && number >= 0 ? number : null;
}
__name(normalizeInteger2, "normalizeInteger");
function normalizeNumber(value) {
  if (isBlank2(value)) return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(/[\s,]/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : null;
}
__name(normalizeNumber, "normalizeNumber");
function columnNumberToLetter2(columnNumber) {
  let value = columnNumber;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}
__name(columnNumberToLetter2, "columnNumberToLetter");
function buildRawData(headerRows, row) {
  const rawData = {};
  const firstHeaderRow = headerRows[0] || [];
  const secondHeaderRow = headerRows[1] || [];
  let activeGroup = "";
  row.forEach((value, index) => {
    const firstHeader = String(firstHeaderRow[index] ?? "").trim();
    const secondHeader = String(secondHeaderRow[index] ?? "").trim();
    if (firstHeader) activeGroup = firstHeader;
    const sourceColumn = columnNumberToLetter2(index + 1);
    const parts = [];
    if (index === 0) {
      parts.push(firstHeader || secondHeader || "DATE");
    } else {
      if (activeGroup) parts.push(activeGroup);
      if (secondHeader) parts.push(secondHeader);
      if (!secondHeader && firstHeader) parts.push(firstHeader);
    }
    const key = parts.length > 0 ? parts.join(" / ").replace(/\s+/g, " ").trim() : `column_${sourceColumn}`;
    rawData[key] = value ?? null;
  });
  return rawData;
}
__name(buildRawData, "buildRawData");
function buildRawRecord(sheetName, headerRows, row, reportDate, syncRunId, importedAt) {
  return {
    sheet_name: sheetName,
    report_date: reportDate,
    raw_data: buildRawData(headerRows, row),
    imported_at: importedAt,
    sync_run_id: syncRunId
  };
}
__name(buildRawRecord, "buildRawRecord");
function getDataset(payload, datasetKey) {
  const dataset = payload?.datasets?.[datasetKey];
  if (!dataset || typeof dataset !== "object") {
    throw new Error(`Missing required dataset: ${datasetKey}.`);
  }
  return dataset;
}
__name(getDataset, "getDataset");
function validateDatasetEnvelope(dataset, expected) {
  if (!Array.isArray(dataset.values) || dataset.values.length === 0) {
    throw new Error(
      `${expected.datasetLabel} must include a non-empty values array.`
    );
  }
  if (dataset.values.length > MAX_DATASET_ROWS) {
    throw new Error(
      `${expected.datasetLabel} exceeds ${MAX_DATASET_ROWS} rows.`
    );
  }
  const receivedSheetName = normalizeText(dataset.sheetName);
  const expectedSheetName = normalizeText(expected.sheetName);
  if (receivedSheetName !== expectedSheetName) {
    throw new Error(
      `${expected.datasetLabel} uses an unexpected worksheet name.`
    );
  }
  if (dataset.columnCount !== void 0 && Number(dataset.columnCount) !== expected.columnCount) {
    throw new Error(
      `${expected.datasetLabel} must contain ${expected.columnCount} columns.`
    );
  }
  if (dataset.headerRows !== void 0 && Number(dataset.headerRows) !== expected.headerRows) {
    throw new Error(
      `${expected.datasetLabel} must contain ${expected.headerRows} header rows.`
    );
  }
  if (dataset.dataStartRow !== void 0 && Number(dataset.dataStartRow) !== expected.dataStartRow) {
    throw new Error(
      `${expected.datasetLabel} data must begin on row ${expected.dataStartRow}.`
    );
  }
  dataset.values.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Error(
        `${expected.datasetLabel} row ${rowIndex + 1} is not an array.`
      );
    }
    if (row.length > MAX_DATASET_COLUMNS) {
      throw new Error(
        `${expected.datasetLabel} exceeds ${MAX_DATASET_COLUMNS} columns.`
      );
    }
    if (row.length !== expected.columnCount) {
      throw new Error(
        `${expected.datasetLabel} row ${rowIndex + 1} contains ${row.length} columns instead of ${expected.columnCount}.`
      );
    }
  });
}
__name(validateDatasetEnvelope, "validateDatasetEnvelope");
function assertHeader(actual, expected, description) {
  if (normalizeText(actual) !== normalizeText(expected)) {
    throw new Error(
      `${description} does not match the configured workbook mapping.`
    );
  }
}
__name(assertHeader, "assertHeader");
function validateDistributionHeaders(dataset) {
  const headers = dataset.values[0];
  assertHeader(
    headers[DISTRIBUTION_MAPPING.source.dateColumn.sourceIndex],
    DISTRIBUTION_MAPPING.source.dateColumn.sourceHeader,
    "Daily Volume date header"
  );
  DISTRIBUTION_MAPPING.columns.forEach((column) => {
    assertHeader(
      headers[column.sourceIndex],
      column.sourceHeader,
      `Daily Volume column ${column.sourceColumn}`
    );
  });
}
__name(validateDistributionHeaders, "validateDistributionHeaders");
function validateProductivityHeaders(dataset) {
  const agentHeaderRow = dataset.values[0];
  const metricHeaderRow = dataset.values[1];
  assertHeader(
    agentHeaderRow[PRODUCTIVITY_MAPPING.source.dateColumn.sourceIndex],
    PRODUCTIVITY_MAPPING.source.dateColumn.sourceHeader,
    "Ticket Productivity date header"
  );
  PRODUCTIVITY_MAPPING.agents.forEach((agent) => {
    const firstMetric = agent.metrics[0];
    const acceptedNames = [
      agent.sourceName,
      ...agent.sourceNameAliases
    ].map(normalizeText);
    if (!acceptedNames.includes(
      normalizeText(agentHeaderRow[firstMetric.sourceIndex])
    )) {
      throw new Error(
        `Ticket Productivity agent header ${agent.agentName} does not match the configured workbook mapping.`
      );
    }
    agent.metrics.forEach((metric) => {
      assertHeader(
        metricHeaderRow[metric.sourceIndex],
        metric.sourceHeader,
        `Ticket Productivity column ${metric.sourceColumn}`
      );
    });
  });
}
__name(validateProductivityHeaders, "validateProductivityHeaders");
function validateDriverHeaders(dataset) {
  const sourceKeyRow = dataset.values[0];
  const displayLabelRow = dataset.values[1];
  const mappingErrors = validateDriverMapping();
  if (mappingErrors.length > 0) {
    throw new Error(
      `Ticket driver mapping is invalid: ${mappingErrors.join(" ")}`
    );
  }
  assertHeader(
    displayLabelRow[DRIVER_MAPPING.source.dateColumn.sourceIndex],
    DRIVER_MAPPING.source.dateColumn.sourceHeader,
    "Daily Drivers date header"
  );
  DRIVER_MAPPING.columns.forEach((column) => {
    assertHeader(
      sourceKeyRow[column.sourceIndex],
      column.sourceKey,
      `Daily Drivers key in column ${column.sourceColumn}`
    );
    assertHeader(
      displayLabelRow[column.sourceIndex],
      column.sourceLabel,
      `Daily Drivers label in column ${column.sourceColumn}`
    );
  });
}
__name(validateDriverHeaders, "validateDriverHeaders");
function isMultiDatasetPayload(payload) {
  return payload?.payloadVersion === 2 && payload?.datasets && typeof payload.datasets === "object";
}
__name(isMultiDatasetPayload, "isMultiDatasetPayload");
function validateMultiDatasetPayload(payload) {
  if (!isMultiDatasetPayload(payload)) {
    throw new Error(
      "The multi-dataset request must use payloadVersion 2."
    );
  }
  REQUIRED_DATASET_KEYS.forEach((datasetKey) => {
    getDataset(payload, datasetKey);
  });
  const dailyVolume = getDataset(payload, "dailyVolume");
  const ticketProductivity = getDataset(
    payload,
    "ticketProductivity"
  );
  const dailyDrivers = getDataset(payload, "dailyDrivers");
  validateDatasetEnvelope(dailyVolume, {
    datasetLabel: "Daily Volume",
    sheetName: DISTRIBUTION_MAPPING.source.sheetName,
    columnCount: 19,
    headerRows: 1,
    dataStartRow: 2
  });
  validateDatasetEnvelope(ticketProductivity, {
    datasetLabel: "Ticket Productivity",
    sheetName: PRODUCTIVITY_MAPPING.source.sheetName,
    columnCount: 25,
    headerRows: 2,
    dataStartRow: 3
  });
  validateDatasetEnvelope(dailyDrivers, {
    datasetLabel: "Daily Drivers",
    sheetName: DRIVER_MAPPING.source.sheetName,
    columnCount: 73,
    headerRows: 2,
    dataStartRow: 3
  });
  validateDistributionHeaders(dailyVolume);
  validateProductivityHeaders(ticketProductivity);
  validateDriverHeaders(dailyDrivers);
}
__name(validateMultiDatasetPayload, "validateMultiDatasetPayload");
function processDistributionDataset(dataset, importedAt) {
  const rows = dataset.values.slice(1);
  const importedRecords = [];
  const warnings = [];
  let ignoredRows = 0;
  let skippedRecords = 0;
  rows.forEach((row, rowIndex) => {
    const sourceRowNumber = rowIndex + 2;
    const rawDate = row[DISTRIBUTION_MAPPING.source.dateColumn.sourceIndex];
    const reportDate = normalizeDate2(rawDate);
    const hasAnyValue = DISTRIBUTION_MAPPING.columns.some(
      (column) => !isBlank2(row[column.sourceIndex])
    );
    if (isBlank2(rawDate) && !hasAnyValue) {
      ignoredRows += 1;
      return;
    }
    if (!reportDate) {
      skippedRecords += 1;
      warnings.push(
        `Daily Volume row ${sourceRowNumber} has an invalid date.`
      );
      return;
    }
    if (!hasAnyValue) {
      ignoredRows += 1;
      return;
    }
    DISTRIBUTION_MAPPING.columns.forEach((column) => {
      const sourceValue = row[column.sourceIndex];
      if (isBlank2(sourceValue)) {
        skippedRecords += 1;
        warnings.push(
          `Daily Volume row ${sourceRowNumber}, column ${column.sourceColumn} is blank and was not imported.`
        );
        return;
      }
      const ticketCount = normalizeInteger2(sourceValue);
      if (ticketCount === null) {
        skippedRecords += 1;
        warnings.push(
          `Daily Volume row ${sourceRowNumber}, column ${column.sourceColumn} is not a valid non-negative integer.`
        );
        return;
      }
      importedRecords.push({
        report_date: reportDate,
        dimension_type: column.dimensionType,
        dimension_key: column.dimensionKey,
        dimension_label: column.dimensionLabel,
        ticket_count: ticketCount,
        updated_at: importedAt
      });
    });
  });
  return {
    importedRecords,
    rawRecords: [],
    warnings,
    ignoredRows,
    skippedRecords
  };
}
__name(processDistributionDataset, "processDistributionDataset");
function processProductivityDataset(dataset, syncRunId, importedAt) {
  const headerRows = dataset.values.slice(0, 2);
  const rows = dataset.values.slice(2);
  const importedRecords = [];
  const rawRecords = [];
  const warnings = [];
  let ignoredRows = 0;
  let skippedRecords = 0;
  rows.forEach((row, rowIndex) => {
    const sourceRowNumber = rowIndex + 3;
    const rawDate = row[PRODUCTIVITY_MAPPING.source.dateColumn.sourceIndex];
    const reportDate = normalizeDate2(rawDate);
    const hasAnyMetricValue = PRODUCTIVITY_MAPPING.agents.some(
      (agent) => agent.metrics.some(
        (metric) => !isBlank2(row[metric.sourceIndex])
      )
    );
    if (isBlank2(rawDate) && !hasAnyMetricValue) {
      ignoredRows += 1;
      return;
    }
    rawRecords.push(buildRawRecord(
      PRODUCTIVITY_MAPPING.source.sheetName,
      headerRows,
      row,
      reportDate,
      syncRunId,
      importedAt
    ));
    if (!reportDate) {
      skippedRecords += 1;
      warnings.push(
        `Ticket Productivity row ${sourceRowNumber} has an invalid date.`
      );
      return;
    }
    if (!hasAnyMetricValue) {
      ignoredRows += 1;
      return;
    }
    PRODUCTIVITY_MAPPING.agents.forEach((agent) => {
      const valuesByTarget = new Map(
        agent.metrics.map((metric) => [
          metric.targetColumn,
          row[metric.sourceIndex]
        ])
      );
      const allBlank = agent.metrics.every(
        (metric) => isBlank2(row[metric.sourceIndex])
      );
      if (allBlank) return;
      const solvedTickets = normalizeInteger2(
        valuesByTarget.get("solved_tickets")
      );
      const openTickets = normalizeInteger2(
        valuesByTarget.get("open_tickets")
      );
      const ahtValue = normalizeNumber(
        valuesByTarget.get("aht_value")
      );
      const invalidFields = [];
      if (solvedTickets === null) {
        invalidFields.push("Solved Ticket");
      }
      if (!isBlank2(valuesByTarget.get("open_tickets")) && openTickets === null) {
        invalidFields.push("Open Tickets");
      }
      if (!isBlank2(valuesByTarget.get("aht_value")) && ahtValue === null) {
        invalidFields.push("AHT");
      }
      if (invalidFields.length > 0) {
        skippedRecords += 1;
        warnings.push(
          `Ticket Productivity row ${sourceRowNumber}, ${agent.agentName} was skipped because these fields are invalid: ${invalidFields.join(", ")}.`
        );
        return;
      }
      importedRecords.push({
        report_date: reportDate,
        agent_key: agent.agentKey,
        agent_name: agent.agentName,
        solved_tickets: solvedTickets,
        open_tickets: openTickets,
        aht_value: ahtValue,
        aht_unit: PRODUCTIVITY_MAPPING.defaults.ahtUnit,
        updated_at: importedAt
      });
    });
  });
  return {
    importedRecords,
    rawRecords,
    warnings,
    ignoredRows,
    skippedRecords
  };
}
__name(processProductivityDataset, "processProductivityDataset");
function processDriverDataset(dataset, syncRunId, importedAt) {
  const headerRows = dataset.values.slice(0, 2);
  const rows = dataset.values.slice(2);
  const importedRecords = [];
  const rawRecords = [];
  const warnings = [];
  let ignoredRows = 0;
  let skippedRecords = 0;
  rows.forEach((row, rowIndex) => {
    const sourceRowNumber = rowIndex + 3;
    const rawDate = row[DRIVER_MAPPING.source.dateColumn.sourceIndex];
    const reportDate = normalizeDate2(rawDate);
    const hasAnyDriverValue = DRIVER_MAPPING.columns.some(
      (column) => !isBlank2(row[column.sourceIndex])
    );
    if (isBlank2(rawDate) && !hasAnyDriverValue) {
      ignoredRows += 1;
      return;
    }
    rawRecords.push(buildRawRecord(
      DRIVER_MAPPING.source.sheetName,
      headerRows,
      row,
      reportDate,
      syncRunId,
      importedAt
    ));
    if (!reportDate) {
      skippedRecords += 1;
      warnings.push(
        `Daily Drivers row ${sourceRowNumber} has an invalid date.`
      );
      return;
    }
    if (!hasAnyDriverValue) {
      ignoredRows += 1;
      return;
    }
    DRIVER_MAPPING.columns.forEach((column) => {
      const sourceValue = row[column.sourceIndex];
      if (isBlank2(sourceValue)) return;
      const ticketCount = normalizeInteger2(sourceValue);
      if (ticketCount === null) {
        skippedRecords += 1;
        warnings.push(
          `Daily Drivers row ${sourceRowNumber}, column ${column.sourceColumn} is not a valid non-negative integer.`
        );
        return;
      }
      importedRecords.push({
        report_date: reportDate,
        driver_group_key: column.groupKey,
        driver_group_label: column.groupLabel,
        driver_key: column.driverKey,
        driver_label: column.driverLabel,
        ticket_count: ticketCount,
        source_column: column.sourceColumn,
        updated_at: importedAt
      });
    });
  });
  return {
    importedRecords,
    rawRecords,
    warnings,
    ignoredRows,
    skippedRecords
  };
}
__name(processDriverDataset, "processDriverDataset");
function processMultiDatasetPayload(payload, syncRunId) {
  const importedAt = (/* @__PURE__ */ new Date()).toISOString();
  const dailyVolumeDataset = getDataset(payload, "dailyVolume");
  const productivityDataset = getDataset(
    payload,
    "ticketProductivity"
  );
  const driverDataset = getDataset(payload, "dailyDrivers");
  const dailySheetData = extractSheetValues(dailyVolumeDataset);
  validateSheetPayload(dailySheetData);
  const dailyIndexes = buildColumnIndexes(dailySheetData.headers);
  const dailyMetrics = processRows(
    dailySheetData.headers,
    dailySheetData.rows,
    dailyIndexes,
    syncRunId
  );
  const distributions = processDistributionDataset(
    dailyVolumeDataset,
    importedAt
  );
  const productivity = processProductivityDataset(
    productivityDataset,
    syncRunId,
    importedAt
  );
  const drivers = processDriverDataset(
    driverDataset,
    syncRunId,
    importedAt
  );
  return {
    dailyMetrics,
    distributions,
    productivity,
    drivers,
    rawRecords: [
      ...dailyMetrics.rawRecords,
      ...productivity.rawRecords,
      ...drivers.rawRecords
    ],
    warnings: [
      ...dailyMetrics.warnings,
      ...distributions.warnings,
      ...productivity.warnings,
      ...drivers.warnings
    ]
  };
}
__name(processMultiDatasetPayload, "processMultiDatasetPayload");
function getMultiDatasetSummary(result) {
  const rowsImported = result.dailyMetrics.importedRecords.length + result.distributions.importedRecords.length + result.productivity.importedRecords.length + result.drivers.importedRecords.length;
  return {
    rowsImported,
    rowsSkipped: result.dailyMetrics.skippedRows + result.distributions.skippedRecords + result.productivity.skippedRecords + result.drivers.skippedRecords,
    rowsIgnored: Math.max(
      result.dailyMetrics.ignoredRows,
      result.distributions.ignoredRows
    ) + result.productivity.ignoredRows + result.drivers.ignoredRows,
    datasets: {
      dailyVolume: {
        metricRowsImported: result.dailyMetrics.importedRecords.length,
        distributionRecordsImported: result.distributions.importedRecords.length,
        rowsSkipped: result.dailyMetrics.skippedRows + result.distributions.skippedRecords,
        rowsIgnored: Math.max(
          result.dailyMetrics.ignoredRows,
          result.distributions.ignoredRows
        )
      },
      ticketProductivity: {
        recordsImported: result.productivity.importedRecords.length,
        recordsSkipped: result.productivity.skippedRecords,
        rowsIgnored: result.productivity.ignoredRows
      },
      dailyDrivers: {
        recordsImported: result.drivers.importedRecords.length,
        recordsSkipped: result.drivers.skippedRecords,
        rowsIgnored: result.drivers.ignoredRows
      }
    }
  };
}
__name(getMultiDatasetSummary, "getMultiDatasetSummary");
var MULTI_DATASET_DESTINATIONS = Object.freeze({
  dailyMetrics: Object.freeze({
    tableName: PHASE_ONE_DASHBOARD_MAPPING.destination.tableName,
    conflictColumns: Object.freeze([
      PHASE_ONE_DASHBOARD_MAPPING.destination.conflictColumn
    ])
  }),
  distributions: DISTRIBUTION_MAPPING.destination,
  productivity: PRODUCTIVITY_MAPPING.destination,
  drivers: DRIVER_MAPPING.destination
});

// _shared/mapped-record-batches.js
var DEFAULT_BATCH_SIZE = 1e3;
function getConflictColumns(destination) {
  return Array.isArray(destination?.conflictColumns) ? destination.conflictColumns : [destination?.conflictColumn];
}
__name(getConflictColumns, "getConflictColumns");
function validateConflictColumns(columns) {
  if (columns.length === 0 || columns.some(
    (column) => typeof column !== "string" || !/^[a-z_][a-z0-9_]*$/i.test(column)
  )) {
    throw new Error("The database conflict columns are invalid.");
  }
}
__name(validateConflictColumns, "validateConflictColumns");
function inferConflictColumns(record) {
  if (!record || typeof record !== "object") return null;
  if ("dimension_type" in record && "dimension_key" in record) {
    return ["report_date", "dimension_type", "dimension_key"];
  }
  if ("agent_key" in record) {
    return ["report_date", "agent_key"];
  }
  if ("driver_key" in record) {
    return ["report_date", "driver_key"];
  }
  return null;
}
__name(inferConflictColumns, "inferConflictColumns");
function deduplicateMappedRecords(records, conflictColumns) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }
  const columns = Array.isArray(conflictColumns) ? conflictColumns : [conflictColumns];
  validateConflictColumns(columns);
  const uniqueRecords = /* @__PURE__ */ new Map();
  records.forEach((record, recordIndex) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Mapped record ${recordIndex + 1} is invalid.`);
    }
    const values = columns.map((column) => record[column]);
    if (values.some(
      (value) => value === null || value === void 0 || value === ""
    )) {
      throw new Error(
        `Mapped record ${recordIndex + 1} is missing a conflict-key value.`
      );
    }
    const key = JSON.stringify(values);
    uniqueRecords.set(key, record);
  });
  return [...uniqueRecords.values()];
}
__name(deduplicateMappedRecords, "deduplicateMappedRecords");
function getMappedRecordBatches(records, batchSize = DEFAULT_BATCH_SIZE) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }
  const conflictColumns = inferConflictColumns(records[0]);
  const sourceRecords = conflictColumns ? deduplicateMappedRecords(records, conflictColumns) : records;
  const batches = [];
  for (let start = 0; start < sourceRecords.length; start += batchSize) {
    batches.push(sourceRecords.slice(start, start + batchSize));
  }
  return batches;
}
__name(getMappedRecordBatches, "getMappedRecordBatches");
function getMappedDestination(destination) {
  const tableName = destination?.tableName;
  const columns = getConflictColumns(destination);
  if (typeof tableName !== "string" || !/^[a-z_][a-z0-9_]*$/i.test(tableName)) {
    throw new Error("The database table name is invalid.");
  }
  validateConflictColumns(columns);
  return Object.freeze({
    tableName,
    conflictColumns: Object.freeze([...columns]),
    conflictTarget: columns.join(",")
  });
}
__name(getMappedDestination, "getMappedDestination");

// _shared/dashboard-sync-store.js
var RAW_INSERT_BATCH_SIZE = 100;
async function supabaseRequest(supabaseUrl, serviceRoleKey, path, options = {}) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        ...options.headers || {}
      }
    }
  );
  const responseText = await response.text();
  let responseData = null;
  if (responseText) {
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }
  }
  if (!response.ok) {
    const details = typeof responseData === "string" ? responseData : responseData?.message || responseData?.details || JSON.stringify(responseData);
    throw new Error(
      `Supabase request failed with status ${response.status}: ${details}`
    );
  }
  return responseData;
}
__name(supabaseRequest, "supabaseRequest");
async function createSyncRun(supabaseUrl, serviceRoleKey, startedAt) {
  const rows = await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    "sheet_sync_runs",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        started_at: startedAt,
        status: "running",
        rows_imported: 0,
        sync_source: "apps_script"
      })
    }
  );
  const syncRunId = Array.isArray(rows) ? rows[0]?.id : rows?.id;
  if (!syncRunId) {
    throw new Error("The synchronization run could not be created.");
  }
  return syncRunId;
}
__name(createSyncRun, "createSyncRun");
async function updateSyncRun(supabaseUrl, serviceRoleKey, syncRunId, updates) {
  if (!syncRunId) return;
  await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `sheet_sync_runs?id=eq.${encodeURIComponent(syncRunId)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=minimal"
      },
      body: JSON.stringify(updates)
    }
  );
}
__name(updateSyncRun, "updateSyncRun");
async function insertRawRecords(supabaseUrl, serviceRoleKey, rawRecords) {
  for (let start = 0; start < rawRecords.length; start += RAW_INSERT_BATCH_SIZE) {
    const batch = rawRecords.slice(
      start,
      start + RAW_INSERT_BATCH_SIZE
    );
    await supabaseRequest(
      supabaseUrl,
      serviceRoleKey,
      "raw_sheet_imports",
      {
        method: "POST",
        headers: {
          Prefer: "return=minimal"
        },
        body: JSON.stringify(batch)
      }
    );
  }
}
__name(insertRawRecords, "insertRawRecords");
async function upsertDashboardRecords(supabaseUrl, serviceRoleKey, records) {
  const tableName = PHASE_ONE_DASHBOARD_MAPPING.destination.tableName;
  const conflictColumn = PHASE_ONE_DASHBOARD_MAPPING.destination.conflictColumn;
  const uniqueRecords = deduplicateMappedRecords(
    records,
    [conflictColumn]
  );
  if (uniqueRecords.length === 0) return;
  await supabaseRequest(
    supabaseUrl,
    serviceRoleKey,
    `${tableName}?on_conflict=${encodeURIComponent(conflictColumn)}`,
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(uniqueRecords)
    }
  );
}
__name(upsertDashboardRecords, "upsertDashboardRecords");

// _shared/auth-header-helper.js
function getServiceHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`
  };
}
__name(getServiceHeaders, "getServiceHeaders");

// _shared/request-runner.js
async function runJsonRequest(requestUrl, requestOptions) {
  const response = await fetch(requestUrl, requestOptions);
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Request failed with status ${response.status}: ${responseText}`
    );
  }
  return responseText;
}
__name(runJsonRequest, "runJsonRequest");

// api/sync-dashboard.js
function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
__name(jsonResponse, "jsonResponse");
function getBearerToken(request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}
__name(getBearerToken, "getBearerToken");
async function secretsMatch(receivedSecret, expectedSecret) {
  if (typeof receivedSecret !== "string" || typeof expectedSecret !== "string" || !receivedSecret || !expectedSecret) {
    return false;
  }
  const encoder = new TextEncoder();
  const [receivedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(receivedSecret)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedSecret))
  ]);
  const receivedBytes = new Uint8Array(receivedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = receivedBytes.length ^ expectedBytes.length;
  for (let index = 0; index < receivedBytes.length; index += 1) {
    difference |= receivedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}
__name(secretsMatch, "secretsMatch");
function getRequiredEnvironment(context) {
  const {
    SHEET_SYNC_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env;
  if (!SHEET_SYNC_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Dashboard synchronization environment variables are incomplete."
    );
  }
  return {
    sheetSyncSecret: SHEET_SYNC_SECRET,
    supabaseUrl: SUPABASE_URL.endsWith("/") ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  };
}
__name(getRequiredEnvironment, "getRequiredEnvironment");
async function upsertMappedRecords(supabaseUrl, serviceRoleKey, destination, records) {
  const { tableName, conflictTarget } = getMappedDestination(destination);
  const path = `${tableName}?on_conflict=${encodeURIComponent(conflictTarget)}`;
  for (const batch of getMappedRecordBatches(records)) {
    await runJsonRequest(
      `${supabaseUrl}/rest/v1/${path}`,
      {
        method: "POST",
        headers: {
          ...getServiceHeaders(serviceRoleKey),
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify(batch)
      }
    );
  }
}
__name(upsertMappedRecords, "upsertMappedRecords");
async function persistMultiDatasetResult(environment, result) {
  await insertRawRecords(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    result.rawRecords
  );
  await upsertDashboardRecords(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    result.dailyMetrics.importedRecords
  );
  const writes = [
    {
      label: "distribution metrics",
      destination: MULTI_DATASET_DESTINATIONS.distributions,
      records: result.distributions.importedRecords
    },
    {
      label: "agent productivity",
      destination: MULTI_DATASET_DESTINATIONS.productivity,
      records: result.productivity.importedRecords
    },
    {
      label: "ticket drivers",
      destination: MULTI_DATASET_DESTINATIONS.drivers,
      records: result.drivers.importedRecords
    }
  ];
  for (const write of writes) {
    try {
      await upsertMappedRecords(
        environment.supabaseUrl,
        environment.serviceRoleKey,
        write.destination,
        write.records
      );
    } catch (error) {
      throw new Error(
        `Unable to store ${write.label}: ${error?.message || "Unknown database error."}`
      );
    }
  }
}
__name(persistMultiDatasetResult, "persistMultiDatasetResult");
async function runMultiDatasetSync(payload, environment, syncRunId) {
  const result = processMultiDatasetPayload(payload, syncRunId);
  await persistMultiDatasetResult(environment, result);
  const summary = getMultiDatasetSummary(result);
  const latestReportDate = getLatestReportDate([
    ...result.dailyMetrics.importedRecords,
    ...result.distributions.importedRecords,
    ...result.productivity.importedRecords,
    ...result.drivers.importedRecords
  ]);
  return {
    payloadVersion: 2,
    latestReportDate,
    summary,
    warnings: result.warnings
  };
}
__name(runMultiDatasetSync, "runMultiDatasetSync");
async function runLegacySync(payload, environment, syncRunId) {
  const sheetData = extractSheetValues(payload);
  validateSheetPayload(sheetData);
  const indexes = buildColumnIndexes(sheetData.headers);
  const result = processRows(
    sheetData.headers,
    sheetData.rows,
    indexes,
    syncRunId
  );
  await insertRawRecords(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    result.rawRecords
  );
  await upsertDashboardRecords(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    result.importedRecords
  );
  return {
    payloadVersion: 1,
    latestReportDate: getLatestReportDate(result.importedRecords),
    summary: {
      rowsImported: result.importedRecords.length,
      rowsSkipped: result.skippedRows,
      rowsIgnored: result.ignoredRows,
      datasets: {
        dailyVolume: {
          metricRowsImported: result.importedRecords.length,
          rowsSkipped: result.skippedRows,
          rowsIgnored: result.ignoredRows
        }
      }
    },
    warnings: result.warnings
  };
}
__name(runLegacySync, "runLegacySync");
async function onRequestPost(context) {
  let environment;
  let syncRunId = null;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  try {
    environment = getRequiredEnvironment(context);
    const authorized = await secretsMatch(
      getBearerToken(context.request),
      environment.sheetSyncSecret
    );
    if (!authorized) {
      return jsonResponse(
        {
          success: false,
          error: "Unauthorized synchronization request."
        },
        401
      );
    }
    let payload;
    try {
      payload = await context.request.json();
    } catch {
      return jsonResponse(
        {
          success: false,
          error: "The request body must contain valid JSON."
        },
        400
      );
    }
    const hasDatasetEnvelope = payload?.datasets !== void 0 || payload?.payloadVersion !== void 0;
    if (hasDatasetEnvelope) {
      validateMultiDatasetPayload(payload);
    } else {
      const legacySheetData = extractSheetValues(payload);
      validateSheetPayload(legacySheetData);
    }
    syncRunId = await createSyncRun(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      startedAt
    );
    const syncResult = isMultiDatasetPayload(payload) ? await runMultiDatasetSync(
      payload,
      environment,
      syncRunId
    ) : await runLegacySync(
      payload,
      environment,
      syncRunId
    );
    await updateSyncRun(
      environment.supabaseUrl,
      environment.serviceRoleKey,
      syncRunId,
      {
        completed_at: (/* @__PURE__ */ new Date()).toISOString(),
        status: "success",
        report_date: syncResult.latestReportDate,
        rows_imported: syncResult.summary.rowsImported,
        error_message: null
      }
    );
    return jsonResponse({
      success: true,
      payloadVersion: syncResult.payloadVersion,
      latestReportDate: syncResult.latestReportDate,
      rowsImported: syncResult.summary.rowsImported,
      rowsSkipped: syncResult.summary.rowsSkipped,
      rowsIgnored: syncResult.summary.rowsIgnored,
      datasets: syncResult.summary.datasets,
      warnings: syncResult.warnings.slice(0, 50),
      warningCount: syncResult.warnings.length
    });
  } catch (error) {
    console.error("Dashboard synchronization failed:", error);
    if (environment && syncRunId) {
      try {
        await updateSyncRun(
          environment.supabaseUrl,
          environment.serviceRoleKey,
          syncRunId,
          {
            completed_at: (/* @__PURE__ */ new Date()).toISOString(),
            status: "failed",
            rows_imported: 0,
            error_message: String(
              error?.message || "Unknown synchronization error."
            ).slice(0, 1e3)
          }
        );
      } catch (loggingError) {
        console.error(
          "Unable to record the failed synchronization:",
          loggingError
        );
      }
    }
    return jsonResponse(
      {
        success: false,
        error: error?.message || "Unable to synchronize dashboard data."
      },
      500
    );
  }
}
__name(onRequestPost, "onRequestPost");

// _shared/google-calendar.js
var GOOGLE_CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();
function jsonResponse2(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(jsonResponse2, "jsonResponse");
function getBearerToken2(request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}
__name(getBearerToken2, "getBearerToken");
function getCoreEnvironment(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase environment variables are incomplete.");
  }
  return {
    supabaseUrl: SUPABASE_URL.endsWith("/") ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  };
}
__name(getCoreEnvironment, "getCoreEnvironment");
function getGoogleEnvironment(context) {
  const core = getCoreEnvironment(context);
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_CALENDAR_REDIRECT_URI,
    GOOGLE_TOKEN_ENCRYPTION_KEY
  } = context.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALENDAR_REDIRECT_URI || !GOOGLE_TOKEN_ENCRYPTION_KEY) {
    throw new Error("Google Calendar environment variables are incomplete.");
  }
  return {
    ...core,
    googleClientId: GOOGLE_CLIENT_ID,
    googleClientSecret: GOOGLE_CLIENT_SECRET,
    googleRedirectUri: GOOGLE_CALENDAR_REDIRECT_URI,
    tokenEncryptionKey: GOOGLE_TOKEN_ENCRYPTION_KEY
  };
}
__name(getGoogleEnvironment, "getGoogleEnvironment");
function googleEnvironmentConfigured(context) {
  return Boolean(
    context.env.GOOGLE_CLIENT_ID && context.env.GOOGLE_CLIENT_SECRET && context.env.GOOGLE_CALENDAR_REDIRECT_URI && context.env.GOOGLE_TOKEN_ENCRYPTION_KEY
  );
}
__name(googleEnvironmentConfigured, "googleEnvironmentConfigured");
async function requireAuthorizedUser(context) {
  const accessToken = getBearerToken2(context.request);
  if (!accessToken) {
    return {
      authorized: false,
      response: jsonResponse2({ error: "Authentication required." }, 401)
    };
  }
  const environment = getCoreEnvironment(context);
  const userResponse = await fetch(
    `${environment.supabaseUrl}/auth/v1/user`,
    {
      headers: {
        apikey: environment.anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  if (!userResponse.ok) {
    return {
      authorized: false,
      response: jsonResponse2(
        { error: "Your session is invalid or has expired." },
        401
      )
    };
  }
  const user = await userResponse.json();
  const email = user.email?.trim().toLowerCase();
  if (!user.id || !email) {
    return {
      authorized: false,
      response: jsonResponse2(
        { error: "The authenticated account is incomplete." },
        401
      )
    };
  }
  const loginUrl = new URL(`${environment.supabaseUrl}/rest/v1/login`);
  loginUrl.searchParams.set("select", "email");
  loginUrl.searchParams.set("email", `eq.${email}`);
  loginUrl.searchParams.set("limit", "1");
  const loginResponse = await fetch(loginUrl, {
    headers: getServiceHeaders(environment.serviceRoleKey)
  });
  if (!loginResponse.ok) {
    console.error("Google Calendar access lookup failed:", await loginResponse.text());
    return {
      authorized: false,
      response: jsonResponse2(
        { error: "Unable to verify application access." },
        500
      )
    };
  }
  const loginRows = await loginResponse.json();
  if (!Array.isArray(loginRows) || !loginRows.length) {
    return {
      authorized: false,
      response: jsonResponse2(
        { error: "Your account is not authorized for this application." },
        403
      )
    };
  }
  return {
    authorized: true,
    accessToken,
    user: {
      id: user.id,
      email
    },
    environment
  };
}
__name(requireAuthorizedUser, "requireAuthorizedUser");
async function serviceRequest(environment, path, {
  method = "GET",
  body,
  prefer,
  allowNotFound = false
} = {}) {
  const response = await fetch(
    `${environment.supabaseUrl}/rest/v1/${path}`,
    {
      method,
      headers: {
        ...getServiceHeaders(environment.serviceRoleKey),
        ...prefer ? { Prefer: prefer } : {}
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    }
  );
  const responseText = await response.text();
  let data = null;
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  }
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    const detail = typeof data === "object" ? data?.message || data?.error || JSON.stringify(data) : data;
    throw new Error(detail || `Supabase request failed with ${response.status}.`);
  }
  return { response, data };
}
__name(serviceRequest, "serviceRequest");
async function getGoogleConnection(environment, userId) {
  const url = new URL(
    `${environment.supabaseUrl}/rest/v1/google_calendar_connections`
  );
  url.searchParams.set(
    "select",
    "user_id,encrypted_refresh_token,calendar_id,calendar_summary,calendar_timezone,granted_scope,connected_at,updated_at,last_synced_at,last_error"
  );
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("limit", "1");
  const response = await fetch(url, {
    headers: getServiceHeaders(environment.serviceRoleKey)
  });
  if (!response.ok) {
    throw new Error(
      `Unable to read Google Calendar connection: ${await response.text()}`
    );
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}
__name(getGoogleConnection, "getGoogleConnection");
async function patchGoogleConnection(environment, userId, values) {
  const path = `google_calendar_connections?user_id=eq.${encodeURIComponent(userId)}`;
  await serviceRequest(environment, path, {
    method: "PATCH",
    body: {
      ...values,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    },
    prefer: "return=minimal"
  });
}
__name(patchGoogleConnection, "patchGoogleConnection");
function createRandomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}
__name(createRandomToken, "createRandomToken");
async function hashState(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value)
  );
  return bytesToBase64Url(new Uint8Array(digest));
}
__name(hashState, "hashState");
async function encryptSecret(value, rawKey) {
  if (typeof value !== "string" || !value) {
    throw new Error("A non-empty secret is required for encryption.");
  }
  const key = await importEncryptionKey(rawKey, ["encrypt"]);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(value)
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}
__name(encryptSecret, "encryptSecret");
async function decryptSecret(value, rawKey) {
  const [version, ivValue, ciphertextValue] = String(value || "").split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue) {
    throw new Error("The stored Google Calendar token has an invalid format.");
  }
  const key = await importEncryptionKey(rawKey, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(ivValue)
    },
    key,
    base64UrlToBytes(ciphertextValue)
  );
  return textDecoder.decode(plaintext);
}
__name(decryptSecret, "decryptSecret");
async function importEncryptionKey(rawKey, usages) {
  const keyBytes = base64UrlToBytes(rawKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error(
      "GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes."
    );
  }
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    usages
  );
}
__name(importEncryptionKey, "importEncryptionKey");
function buildGoogleAuthorizationUrl(environment, state, loginHint = "") {
  const authorizationUrl = new URL(
    "https://accounts.google.com/o/oauth2/v2/auth"
  );
  authorizationUrl.searchParams.set("client_id", environment.googleClientId);
  authorizationUrl.searchParams.set("redirect_uri", environment.googleRedirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", GOOGLE_CALENDAR_READONLY_SCOPE);
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("include_granted_scopes", "true");
  authorizationUrl.searchParams.set("prompt", "consent select_account");
  authorizationUrl.searchParams.set("state", state);
  if (loginHint) {
    authorizationUrl.searchParams.set("login_hint", loginHint);
  }
  return authorizationUrl.toString();
}
__name(buildGoogleAuthorizationUrl, "buildGoogleAuthorizationUrl");
async function exchangeGoogleAuthorizationCode(environment, code) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: environment.googleClientId,
      client_secret: environment.googleClientSecret,
      redirect_uri: environment.googleRedirectUri,
      grant_type: "authorization_code"
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data.error_description || data.error || "Google authorization failed."
    );
  }
  return data;
}
__name(exchangeGoogleAuthorizationCode, "exchangeGoogleAuthorizationCode");
async function refreshGoogleAccessToken(environment, refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: environment.googleClientId,
      client_secret: environment.googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "Google access could not be refreshed."
    );
  }
  return data.access_token;
}
__name(refreshGoogleAccessToken, "refreshGoogleAccessToken");
async function googleApiRequest(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers || {},
      Authorization: `Bearer ${accessToken}`
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = typeof data === "object" ? data?.error?.message || data?.error_description || data?.error : data;
    throw new Error(message || `Google API request failed with ${response.status}.`);
  }
  return data;
}
__name(googleApiRequest, "googleApiRequest");
function safeReturnTo(value) {
  return value === "./home.html" || value === "/home.html" ? "/home.html" : "/home.html";
}
__name(safeReturnTo, "safeReturnTo");
function redirectWithResult(request, returnTo, values) {
  const requestUrl = new URL(request.url);
  const destination = new URL(safeReturnTo(returnTo), requestUrl.origin);
  for (const [key, value] of Object.entries(values)) {
    if (value !== void 0 && value !== null && value !== "") {
      destination.searchParams.set(key, String(value));
    }
  }
  return Response.redirect(destination.toString(), 302);
}
__name(redirectWithResult, "redirectWithResult");
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(bytesToBase64Url, "bytesToBase64Url");
function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + (4 - normalized.length % 4) % 4,
    "="
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
__name(base64UrlToBytes, "base64UrlToBytes");

// google-calendar/callback.js
async function onRequestGet(context) {
  let returnTo = "./home.html";
  try {
    const requestUrl = new URL(context.request.url);
    const oauthError = requestUrl.searchParams.get("error");
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (oauthError) {
      return redirectWithResult(context.request, returnTo, {
        google_calendar: "error",
        google_calendar_error: oauthError
      });
    }
    if (!code || !state) {
      return redirectWithResult(context.request, returnTo, {
        google_calendar: "error",
        google_calendar_error: "missing_callback_values"
      });
    }
    const environment = getGoogleEnvironment(context);
    const stateHash = await hashState(state);
    const statePath = `google_calendar_oauth_states?select=state_hash,user_id,return_to,expires_at,used_at&state_hash=eq.${encodeURIComponent(stateHash)}&limit=1`;
    const { data: stateRows } = await serviceRequest(environment, statePath);
    const stateRow = Array.isArray(stateRows) ? stateRows[0] : null;
    if (!stateRow) {
      throw new Error("The Google authorization state is invalid or has expired.");
    }
    returnTo = stateRow.return_to || returnTo;
    if (stateRow.used_at) {
      throw new Error("The Google authorization state has already been used.");
    }
    if (new Date(stateRow.expires_at).getTime() <= Date.now()) {
      throw new Error("The Google authorization state has expired.");
    }
    const usedAt = (/* @__PURE__ */ new Date()).toISOString();
    const { data: claimedStates } = await serviceRequest(
      environment,
      `google_calendar_oauth_states?state_hash=eq.${encodeURIComponent(stateHash)}&used_at=is.null`,
      {
        method: "PATCH",
        body: { used_at: usedAt },
        prefer: "return=representation"
      }
    );
    if (!Array.isArray(claimedStates) || claimedStates.length !== 1) {
      throw new Error("The Google authorization state could not be claimed.");
    }
    const tokenData = await exchangeGoogleAuthorizationCode(environment, code);
    const existingConnection = await getGoogleConnection(
      environment,
      stateRow.user_id
    );
    if (!tokenData.refresh_token && !existingConnection?.encrypted_refresh_token) {
      throw new Error(
        "Google did not return a refresh token. Reconnect and approve offline calendar access."
      );
    }
    const calendar = await googleApiRequest(
      "https://www.googleapis.com/calendar/v3/calendars/primary",
      tokenData.access_token
    );
    const encryptedRefreshToken = tokenData.refresh_token ? await encryptSecret(
      tokenData.refresh_token,
      environment.tokenEncryptionKey
    ) : existingConnection.encrypted_refresh_token;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await serviceRequest(
      environment,
      "google_calendar_connections?on_conflict=user_id",
      {
        method: "POST",
        body: {
          user_id: stateRow.user_id,
          encrypted_refresh_token: encryptedRefreshToken,
          calendar_id: calendar?.id || "primary",
          calendar_summary: calendar?.summary || "Google Calendar",
          calendar_timezone: calendar?.timeZone || null,
          granted_scope: tokenData.scope || GOOGLE_CALENDAR_READONLY_SCOPE,
          connected_at: existingConnection?.connected_at || now,
          updated_at: now,
          last_error: null
        },
        prefer: "resolution=merge-duplicates,return=minimal"
      }
    );
    return redirectWithResult(context.request, returnTo, {
      google_calendar: "connected"
    });
  } catch (error) {
    console.error("Google Calendar callback error:", error);
    return redirectWithResult(context.request, returnTo, {
      google_calendar: "error",
      google_calendar_error: "authorization_failed"
    });
  }
}
__name(onRequestGet, "onRequestGet");

// google-calendar/connect.js
async function onRequestPost2(context) {
  try {
    const authorization = await requireAuthorizedUser(context);
    if (!authorization.authorized) {
      return authorization.response;
    }
    const environment = getGoogleEnvironment(context);
    let requestBody = {};
    try {
      requestBody = await context.request.json();
    } catch {
      requestBody = {};
    }
    const returnTo = safeReturnTo(requestBody.returnTo);
    const state = createRandomToken(32);
    const stateHash = await hashState(state);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1e3).toISOString();
    await serviceRequest(
      environment,
      `google_calendar_oauth_states?user_id=eq.${encodeURIComponent(authorization.user.id)}&used_at=is.null`,
      {
        method: "DELETE",
        prefer: "return=minimal"
      }
    );
    await serviceRequest(environment, "google_calendar_oauth_states", {
      method: "POST",
      body: {
        state_hash: stateHash,
        user_id: authorization.user.id,
        return_to: returnTo,
        expires_at: expiresAt
      },
      prefer: "return=minimal"
    });
    return jsonResponse2({
      authorizationUrl: buildGoogleAuthorizationUrl(
        environment,
        state,
        authorization.user.email
      ),
      expiresAt
    });
  } catch (error) {
    console.error("Google Calendar connect error:", error);
    return jsonResponse2(
      {
        error: error?.message || "Unable to start Google Calendar authorization."
      },
      500
    );
  }
}
__name(onRequestPost2, "onRequestPost");

// google-calendar/disconnect.js
async function onRequestPost3(context) {
  try {
    const authorization = await requireAuthorizedUser(context);
    if (!authorization.authorized) {
      return authorization.response;
    }
    const environment = getGoogleEnvironment(context);
    const connection = await getGoogleConnection(
      environment,
      authorization.user.id
    );
    if (!connection) {
      return jsonResponse2({ success: true, connected: false });
    }
    try {
      const refreshToken = await decryptSecret(
        connection.encrypted_refresh_token,
        environment.tokenEncryptionKey
      );
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          }
        }
      );
    } catch (error) {
      console.warn("Google token revocation failed; removing local connection:", error);
    }
    await serviceRequest(
      environment,
      `google_calendar_connections?user_id=eq.${encodeURIComponent(authorization.user.id)}`,
      {
        method: "DELETE",
        prefer: "return=minimal"
      }
    );
    await serviceRequest(
      environment,
      `google_calendar_oauth_states?user_id=eq.${encodeURIComponent(authorization.user.id)}`,
      {
        method: "DELETE",
        prefer: "return=minimal"
      }
    );
    return jsonResponse2({
      success: true,
      connected: false
    });
  } catch (error) {
    console.error("Google Calendar disconnect error:", error);
    return jsonResponse2(
      {
        error: error?.message || "Unable to disconnect Google Calendar."
      },
      500
    );
  }
}
__name(onRequestPost3, "onRequestPost");

// google-calendar/events.js
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var MAX_RANGE_DAYS = 120;
async function onRequestGet2(context) {
  let authorization = null;
  let environment = null;
  try {
    authorization = await requireAuthorizedUser(context);
    if (!authorization.authorized) {
      return authorization.response;
    }
    environment = getGoogleEnvironment(context);
    const requestUrl = new URL(context.request.url);
    const start = requestUrl.searchParams.get("start");
    const end = requestUrl.searchParams.get("end");
    const range = validateRange(start, end);
    const connection = await getGoogleConnection(
      environment,
      authorization.user.id
    );
    if (!connection) {
      return jsonResponse2({
        connected: false,
        events: []
      });
    }
    const refreshToken = await decryptSecret(
      connection.encrypted_refresh_token,
      environment.tokenEncryptionKey
    );
    const accessToken = await refreshGoogleAccessToken(
      environment,
      refreshToken
    );
    const events = await listGoogleEvents(
      connection,
      accessToken,
      range
    );
    await patchGoogleConnection(
      environment,
      authorization.user.id,
      {
        last_synced_at: (/* @__PURE__ */ new Date()).toISOString(),
        last_error: null
      }
    );
    return jsonResponse2({
      connected: true,
      calendar: {
        summary: connection.calendar_summary || "Google Calendar",
        timezone: connection.calendar_timezone || null
      },
      events
    });
  } catch (error) {
    console.error("Google Calendar events error:", error);
    if (authorization?.authorized && environment) {
      try {
        await patchGoogleConnection(
          environment,
          authorization.user.id,
          {
            last_error: String(error?.message || "Google Calendar sync failed.").slice(0, 500)
          }
        );
      } catch (patchError) {
        console.error("Google Calendar error status update failed:", patchError);
      }
    }
    const needsReconnect = /invalid_grant|revoked|expired/i.test(
      String(error?.message || "")
    );
    return jsonResponse2(
      {
        error: error?.message || "Unable to load Google Calendar events.",
        needsReconnect
      },
      needsReconnect ? 401 : 500
    );
  }
}
__name(onRequestGet2, "onRequestGet");
function validateRange(start, end) {
  if (!DATE_PATTERN.test(start || "") || !DATE_PATTERN.test(end || "")) {
    throw new Error("Google Calendar start and end dates are required.");
  }
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (endDate < startDate) {
    throw new Error("Google Calendar end date cannot be earlier than start date.");
  }
  const days = Math.floor((endDate - startDate) / 864e5);
  if (days > MAX_RANGE_DAYS) {
    throw new Error(`Google Calendar date ranges cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  const expandedStart = new Date(startDate);
  expandedStart.setUTCDate(expandedStart.getUTCDate() - 1);
  const expandedEnd = new Date(endDate);
  expandedEnd.setUTCDate(expandedEnd.getUTCDate() + 2);
  return {
    timeMin: expandedStart.toISOString(),
    timeMax: expandedEnd.toISOString()
  };
}
__name(validateRange, "validateRange");
async function listGoogleEvents(connection, accessToken, range) {
  const events = [];
  let pageToken = "";
  let pageCount = 0;
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendar_id || "primary")}/events`
    );
    url.searchParams.set("timeMin", range.timeMin);
    url.searchParams.set("timeMax", range.timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "false");
    if (connection.calendar_timezone) {
      url.searchParams.set("timeZone", connection.calendar_timezone);
    }
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const data = await googleApiRequest(url.toString(), accessToken);
    for (const event of data.items || []) {
      if (event.status === "cancelled") continue;
      events.push(sanitizeEvent(event));
    }
    pageToken = data.nextPageToken || "";
    pageCount += 1;
  } while (pageToken && pageCount < 10);
  return events;
}
__name(listGoogleEvents, "listGoogleEvents");
function sanitizeEvent(event) {
  const allDay = Boolean(event.start?.date);
  return {
    id: event.id,
    source: "google_calendar",
    title: event.summary || "Busy",
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    allDay,
    location: event.location || null,
    htmlLink: event.htmlLink || null,
    status: event.status || "confirmed",
    transparency: event.transparency || "opaque",
    recurringEventId: event.recurringEventId || null
  };
}
__name(sanitizeEvent, "sanitizeEvent");
function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Google Calendar date range contains an invalid date.");
  }
  return date;
}
__name(parseDate, "parseDate");

// google-calendar/status.js
async function onRequestGet3(context) {
  try {
    const authorization = await requireAuthorizedUser(context);
    if (!authorization.authorized) {
      return authorization.response;
    }
    const configured = googleEnvironmentConfigured(context);
    if (!configured) {
      return jsonResponse2({
        configured: false,
        connected: false
      });
    }
    const connection = await getGoogleConnection(
      authorization.environment,
      authorization.user.id
    );
    return jsonResponse2({
      configured: true,
      connected: Boolean(connection),
      connection: connection ? {
        calendarSummary: connection.calendar_summary || "Google Calendar",
        calendarTimezone: connection.calendar_timezone || null,
        connectedAt: connection.connected_at,
        updatedAt: connection.updated_at,
        lastSyncedAt: connection.last_synced_at,
        lastError: connection.last_error
      } : null
    });
  } catch (error) {
    console.error("Google Calendar status error:", error);
    return jsonResponse2(
      {
        error: error?.message || "Unable to read Google Calendar status."
      },
      500
    );
  }
}
__name(onRequestGet3, "onRequestGet");

// change-password.js
function jsonResponse3(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(jsonResponse3, "jsonResponse");
function getBearerToken3(request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}
__name(getBearerToken3, "getBearerToken");
function getRequiredEnvironment2(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase environment variables are incomplete."
    );
  }
  return {
    supabaseUrl: SUPABASE_URL.endsWith("/") ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  };
}
__name(getRequiredEnvironment2, "getRequiredEnvironment");
async function requireAdmin(context) {
  const accessToken = getBearerToken3(context.request);
  if (!accessToken) {
    return {
      authorized: false,
      response: jsonResponse3(
        {
          error: "Authentication required."
        },
        401
      )
    };
  }
  const {
    supabaseUrl,
    anonKey,
    serviceRoleKey
  } = getRequiredEnvironment2(context);
  const userResponse = await fetch(
    `${supabaseUrl}/auth/v1/user`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  if (!userResponse.ok) {
    return {
      authorized: false,
      response: jsonResponse3(
        {
          error: "Your session is invalid or has expired."
        },
        401
      )
    };
  }
  const authenticatedUser = await userResponse.json();
  const email = authenticatedUser.email?.trim().toLowerCase();
  if (!email) {
    return {
      authorized: false,
      response: jsonResponse3(
        {
          error: "The authenticated account has no email address."
        },
        401
      )
    };
  }
  const permissionUrl = new URL(
    `${supabaseUrl}/rest/v1/login`
  );
  permissionUrl.searchParams.set(
    "select",
    "is_admin"
  );
  permissionUrl.searchParams.set(
    "email",
    `eq.${email}`
  );
  permissionUrl.searchParams.set(
    "limit",
    "1"
  );
  const permissionResponse = await fetch(
    permissionUrl.toString(),
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );
  if (!permissionResponse.ok) {
    console.error(
      "Admin permission lookup failed:",
      await permissionResponse.text()
    );
    return {
      authorized: false,
      response: jsonResponse3(
        {
          error: "Unable to verify administrator permissions."
        },
        500
      )
    };
  }
  const permissionRows = await permissionResponse.json();
  if (!Array.isArray(permissionRows) || permissionRows[0]?.is_admin !== true) {
    return {
      authorized: false,
      response: jsonResponse3(
        {
          error: "Administrator access required."
        },
        403
      )
    };
  }
  return {
    authorized: true,
    supabaseUrl,
    serviceRoleKey
  };
}
__name(requireAdmin, "requireAdmin");
async function findUserByEmail(supabaseUrl, serviceRoleKey, targetEmail) {
  const perPage = 1e3;
  let page = 1;
  while (page <= 20) {
    const usersUrl = new URL(
      `${supabaseUrl}/auth/v1/admin/users`
    );
    usersUrl.searchParams.set(
      "page",
      String(page)
    );
    usersUrl.searchParams.set(
      "per_page",
      String(perPage)
    );
    const usersResponse = await fetch(
      usersUrl.toString(),
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        }
      }
    );
    const usersData = await usersResponse.json();
    if (!usersResponse.ok) {
      throw new Error(
        usersData.message || usersData.error || "Unable to retrieve users."
      );
    }
    const users = Array.isArray(usersData.users) ? usersData.users : [];
    const matchingUser = users.find((user) => {
      return user.email?.trim().toLowerCase() === targetEmail;
    });
    if (matchingUser) {
      return matchingUser;
    }
    if (users.length < perPage) {
      return null;
    }
    page += 1;
  }
  return null;
}
__name(findUserByEmail, "findUserByEmail");
async function onRequestPost4(context) {
  try {
    const adminCheck = await requireAdmin(context);
    if (!adminCheck.authorized) {
      return adminCheck.response;
    }
    let requestBody;
    try {
      requestBody = await context.request.json();
    } catch {
      return jsonResponse3(
        {
          error: "The request body must contain valid JSON."
        },
        400
      );
    }
    const email = typeof requestBody.email === "string" ? requestBody.email.trim().toLowerCase() : "";
    const password = typeof requestBody.password === "string" ? requestBody.password : "";
    if (!email) {
      return jsonResponse3(
        {
          error: "A valid user email is required."
        },
        400
      );
    }
    if (password.length < 8) {
      return jsonResponse3(
        {
          error: "The new password must contain at least 8 characters."
        },
        400
      );
    }
    const {
      supabaseUrl,
      serviceRoleKey
    } = adminCheck;
    const targetUser = await findUserByEmail(
      supabaseUrl,
      serviceRoleKey,
      email
    );
    if (!targetUser) {
      return jsonResponse3(
        {
          error: "User not found."
        },
        404
      );
    }
    const updateResponse = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(targetUser.id)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        },
        body: JSON.stringify({
          password
        })
      }
    );
    const updateData = await updateResponse.json();
    if (!updateResponse.ok) {
      return jsonResponse3(
        {
          error: updateData.message || updateData.error || "Unable to change the password."
        },
        updateResponse.status
      );
    }
    return jsonResponse3({
      success: true
    });
  } catch (error) {
    console.error(
      "Change-password function error:",
      error
    );
    return jsonResponse3(
      {
        error: error.message || "Unable to change the password."
      },
      500
    );
  }
}
__name(onRequestPost4, "onRequestPost");

// create-user.js
function jsonResponse4(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
__name(jsonResponse4, "jsonResponse");
function getBearerToken4(request) {
  const authorization = request.headers.get(
    "Authorization"
  );
  if (!authorization || !authorization.startsWith(
    "Bearer "
  )) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}
__name(getBearerToken4, "getBearerToken");
function getRequiredEnvironment3(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase environment variables are incomplete."
    );
  }
  return {
    supabaseUrl: SUPABASE_URL.endsWith("/") ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  };
}
__name(getRequiredEnvironment3, "getRequiredEnvironment");
async function requireAdmin2(context) {
  const accessToken = getBearerToken4(
    context.request
  );
  if (!accessToken) {
    return {
      authorized: false,
      response: jsonResponse4(
        {
          error: "Authentication required."
        },
        401
      )
    };
  }
  const {
    supabaseUrl,
    anonKey,
    serviceRoleKey
  } = getRequiredEnvironment3(
    context
  );
  const userResponse = await fetch(
    `${supabaseUrl}/auth/v1/user`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  if (!userResponse.ok) {
    return {
      authorized: false,
      response: jsonResponse4(
        {
          error: "Your session is invalid or has expired."
        },
        401
      )
    };
  }
  const authenticatedUser = await userResponse.json();
  const email = authenticatedUser.email?.trim().toLowerCase();
  if (!email) {
    return {
      authorized: false,
      response: jsonResponse4(
        {
          error: "The authenticated account has no email address."
        },
        401
      )
    };
  }
  const permissionUrl = new URL(
    `${supabaseUrl}/rest/v1/login`
  );
  permissionUrl.searchParams.set(
    "select",
    "is_admin"
  );
  permissionUrl.searchParams.set(
    "email",
    `eq.${email}`
  );
  permissionUrl.searchParams.set(
    "limit",
    "1"
  );
  const permissionResponse = await fetch(
    permissionUrl.toString(),
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );
  if (!permissionResponse.ok) {
    console.error(
      "Admin permission lookup failed:",
      await permissionResponse.text()
    );
    return {
      authorized: false,
      response: jsonResponse4(
        {
          error: "Unable to verify administrator permissions."
        },
        500
      )
    };
  }
  const permissionRows = await permissionResponse.json();
  if (!Array.isArray(permissionRows) || permissionRows[0]?.is_admin !== true) {
    return {
      authorized: false,
      response: jsonResponse4(
        {
          error: "Administrator access required."
        },
        403
      )
    };
  }
  return {
    authorized: true,
    supabaseUrl,
    serviceRoleKey
  };
}
__name(requireAdmin2, "requireAdmin");
async function deleteAuthUser(supabaseUrl, serviceRoleKey, userId) {
  if (!userId) {
    return;
  }
  try {
    const response = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        }
      }
    );
    if (!response.ok) {
      console.error(
        "Unable to roll back Auth user:",
        await response.text()
      );
    }
  } catch (error) {
    console.error(
      "Unable to roll back Auth user:",
      error
    );
  }
}
__name(deleteAuthUser, "deleteAuthUser");
async function onRequestPost5(context) {
  try {
    const adminCheck = await requireAdmin2(context);
    if (!adminCheck.authorized) {
      return adminCheck.response;
    }
    let requestBody;
    try {
      requestBody = await context.request.json();
    } catch {
      return jsonResponse4(
        {
          error: "The request body must contain valid JSON."
        },
        400
      );
    }
    const name = typeof requestBody.name === "string" ? requestBody.name.trim() : "";
    const email = typeof requestBody.email === "string" ? requestBody.email.trim().toLowerCase() : "";
    const password = typeof requestBody.password === "string" ? requestBody.password : "";
    const isAdmin = requestBody.isAdmin === true;
    const canEditArticles = requestBody.canEditArticles === true;
    if (!name) {
      return jsonResponse4(
        {
          error: "A user name is required."
        },
        400
      );
    }
    if (!email) {
      return jsonResponse4(
        {
          error: "A valid email address is required."
        },
        400
      );
    }
    if (password.length < 8) {
      return jsonResponse4(
        {
          error: "The temporary password must contain at least 8 characters."
        },
        400
      );
    }
    const {
      supabaseUrl,
      serviceRoleKey
    } = adminCheck;
    const authResponse = await fetch(
      `${supabaseUrl}/auth/v1/admin/users`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        },
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            name
          }
        })
      }
    );
    const authData = await authResponse.json();
    if (!authResponse.ok) {
      return jsonResponse4(
        {
          error: authData.message || authData.error || "Unable to create the Auth user."
        },
        authResponse.status
      );
    }
    const loginResponse = await fetch(
      `${supabaseUrl}/rest/v1/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Prefer: "return=representation",
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        },
        body: JSON.stringify({
          name,
          email,
          is_admin: isAdmin,
          can_edit_articles: canEditArticles
        })
      }
    );
    const loginResponseText = await loginResponse.text();
    let loginData = null;
    if (loginResponseText) {
      try {
        loginData = JSON.parse(
          loginResponseText
        );
      } catch {
        loginData = loginResponseText;
      }
    }
    if (!loginResponse.ok) {
      await deleteAuthUser(
        supabaseUrl,
        serviceRoleKey,
        authData.id
      );
      console.error(
        "Login table insert failed:",
        loginData
      );
      return jsonResponse4(
        {
          error: "The user could not be added to the login table. The Auth user was rolled back."
        },
        loginResponse.status
      );
    }
    return jsonResponse4({
      success: true,
      user: {
        id: authData.id,
        name,
        email: authData.email
      }
    });
  } catch (error) {
    console.error(
      "Create-user function error:",
      error
    );
    return jsonResponse4(
      {
        error: error.message || "Unable to create the user."
      },
      500
    );
  }
}
__name(onRequestPost5, "onRequestPost");

// remove-account.js
function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(reply, "reply");
function cleanEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
__name(cleanEmail, "cleanEmail");
async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
__name(readResponse, "readResponse");
async function serviceFetch(url, key, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...options.headers || {}
    }
  });
  const data = await readResponse(response);
  if (!response.ok) {
    const error = new Error(
      data?.message || data?.error || "Supabase request failed."
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
__name(serviceFetch, "serviceFetch");
async function getAdminContext(context) {
  const authorization = context.request.headers.get("Authorization") || "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env;
  if (!accessToken) {
    const error = new Error("Authentication required.");
    error.status = 401;
    throw error;
  }
  const baseUrl = SUPABASE_URL.replace(/\/$/, "");
  const userResponse = await fetch(`${baseUrl}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`
    }
  });
  const signedInUser = await readResponse(userResponse);
  if (!userResponse.ok) {
    const error = new Error("Your session is invalid or has expired.");
    error.status = 401;
    throw error;
  }
  const adminEmail = cleanEmail(signedInUser?.email);
  const permissionUrl = new URL(`${baseUrl}/rest/v1/login`);
  permissionUrl.searchParams.set("select", "is_admin");
  permissionUrl.searchParams.set("email", `eq.${adminEmail}`);
  permissionUrl.searchParams.set("limit", "1");
  const permissionRows = await serviceFetch(
    permissionUrl.toString(),
    SUPABASE_SERVICE_ROLE_KEY
  );
  if (!Array.isArray(permissionRows) || permissionRows[0]?.is_admin !== true) {
    const error = new Error("Administrator access required.");
    error.status = 403;
    throw error;
  }
  return {
    baseUrl,
    serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    signedInUser
  };
}
__name(getAdminContext, "getAdminContext");
async function findUserByEmail2(baseUrl, serviceKey, email) {
  let page = 1;
  while (true) {
    const url = new URL(`${baseUrl}/auth/v1/admin/users`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "1000");
    const result = await serviceFetch(url.toString(), serviceKey);
    const users = Array.isArray(result?.users) ? result.users : [];
    const match2 = users.find((user) => cleanEmail(user?.email) === email);
    if (match2 || users.length < 1e3) {
      return match2 || null;
    }
    page += 1;
  }
}
__name(findUserByEmail2, "findUserByEmail");
async function onRequestPost6(context) {
  try {
    const admin = await getAdminContext(context);
    const body = await context.request.json();
    const email = cleanEmail(body.email);
    if (!email) {
      const error = new Error("A valid user email is required.");
      error.status = 400;
      throw error;
    }
    const authUser = await findUserByEmail2(
      admin.baseUrl,
      admin.serviceKey,
      email
    );
    if (!authUser?.id) {
      const error = new Error(
        "The matching Supabase Authentication user was not found."
      );
      error.status = 404;
      throw error;
    }
    if (cleanEmail(admin.signedInUser?.email) === email || admin.signedInUser?.id === authUser.id) {
      const error = new Error(
        "You cannot remove your own administrator account."
      );
      error.status = 400;
      throw error;
    }
    await serviceFetch(
      `${admin.baseUrl}/auth/v1/admin/users/${encodeURIComponent(authUser.id)}`,
      admin.serviceKey,
      { method: "DELETE" }
    );
    const loginUrl = new URL(`${admin.baseUrl}/rest/v1/login`);
    loginUrl.searchParams.set("email", `eq.${email}`);
    await serviceFetch(
      loginUrl.toString(),
      admin.serviceKey,
      {
        method: "DELETE",
        headers: {
          Prefer: "return=minimal"
        }
      }
    );
    return reply({
      success: true,
      removedFromAuthentication: true,
      removedFromLoginTable: true
    });
  } catch (error) {
    console.error("Remove-account function error:", error);
    return reply(
      { error: error.message || "Unable to remove the account." },
      Number.isInteger(error.status) ? error.status : 500
    );
  }
}
__name(onRequestPost6, "onRequestPost");

// list-users.js
function jsonResponse5(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
__name(jsonResponse5, "jsonResponse");
var RequestError = class extends Error {
  static {
    __name(this, "RequestError");
  }
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
};
function getBearerToken5(request) {
  const authorization = request.headers.get(
    "Authorization"
  );
  if (!authorization || !authorization.startsWith(
    "Bearer "
  )) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}
__name(getBearerToken5, "getBearerToken");
function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
__name(normalizeEmail, "normalizeEmail");
function getRequiredEnvironment4(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new RequestError(
      "Supabase environment variables are incomplete.",
      500
    );
  }
  return {
    supabaseUrl: SUPABASE_URL.endsWith("/") ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  };
}
__name(getRequiredEnvironment4, "getRequiredEnvironment");
async function parseResponse(response) {
  const responseText = await response.text();
  if (!responseText) {
    return null;
  }
  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}
__name(parseResponse, "parseResponse");
function getResponseError(data, fallback) {
  if (data && typeof data === "object") {
    return data.message || data.error || fallback;
  }
  if (typeof data === "string" && data.trim()) {
    return data;
  }
  return fallback;
}
__name(getResponseError, "getResponseError");
async function serviceRequest2(url, serviceRoleKey, options = {}) {
  const response = await fetch(
    url,
    {
      ...options,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        ...options.headers || {}
      }
    }
  );
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new RequestError(
      getResponseError(
        data,
        "Supabase request failed."
      ),
      response.status
    );
  }
  return data;
}
__name(serviceRequest2, "serviceRequest");
async function requireAdmin3(context) {
  const accessToken = getBearerToken5(
    context.request
  );
  if (!accessToken) {
    throw new RequestError(
      "Authentication required.",
      401
    );
  }
  const {
    supabaseUrl,
    anonKey,
    serviceRoleKey
  } = getRequiredEnvironment4(
    context
  );
  const userResponse = await fetch(
    `${supabaseUrl}/auth/v1/user`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  const authenticatedUser = await parseResponse(
    userResponse
  );
  if (!userResponse.ok) {
    throw new RequestError(
      "Your session is invalid or has expired.",
      401
    );
  }
  const authenticatedEmail = normalizeEmail(
    authenticatedUser?.email
  );
  if (!authenticatedEmail) {
    throw new RequestError(
      "The authenticated account has no email address.",
      401
    );
  }
  const permissionUrl = new URL(
    `${supabaseUrl}/rest/v1/login`
  );
  permissionUrl.searchParams.set(
    "select",
    "is_admin"
  );
  permissionUrl.searchParams.set(
    "email",
    `eq.${authenticatedEmail}`
  );
  permissionUrl.searchParams.set(
    "limit",
    "1"
  );
  const permissionRows = await serviceRequest2(
    permissionUrl.toString(),
    serviceRoleKey
  );
  if (!Array.isArray(permissionRows) || permissionRows[0]?.is_admin !== true) {
    throw new RequestError(
      "Administrator access required.",
      403
    );
  }
  return {
    supabaseUrl,
    serviceRoleKey
  };
}
__name(requireAdmin3, "requireAdmin");
async function getLoginUsers(supabaseUrl, serviceRoleKey) {
  const usersUrl = new URL(
    `${supabaseUrl}/rest/v1/login`
  );
  usersUrl.searchParams.set(
    "select",
    "name,email,is_admin,can_edit_articles"
  );
  usersUrl.searchParams.set(
    "order",
    "name.asc.nullslast,email.asc"
  );
  const users = await serviceRequest2(
    usersUrl.toString(),
    serviceRoleKey
  );
  return Array.isArray(users) ? users : [];
}
__name(getLoginUsers, "getLoginUsers");
async function getAuthUsers(supabaseUrl, serviceRoleKey) {
  const allUsers = [];
  const perPage = 1e3;
  let page = 1;
  while (true) {
    const usersUrl = new URL(
      `${supabaseUrl}/auth/v1/admin/users`
    );
    usersUrl.searchParams.set(
      "page",
      String(page)
    );
    usersUrl.searchParams.set(
      "per_page",
      String(perPage)
    );
    const result = await serviceRequest2(
      usersUrl.toString(),
      serviceRoleKey
    );
    const users = Array.isArray(result?.users) ? result.users : [];
    allUsers.push(...users);
    if (users.length < perPage) {
      break;
    }
    page += 1;
  }
  return allUsers;
}
__name(getAuthUsers, "getAuthUsers");
function getDisplayName(loginUser, email) {
  const storedName = typeof loginUser?.name === "string" ? loginUser.name.trim() : "";
  if (storedName) {
    return storedName;
  }
  return email.includes("@") ? email.split("@")[0] : email;
}
__name(getDisplayName, "getDisplayName");
async function onRequestGet4(context) {
  try {
    const {
      supabaseUrl,
      serviceRoleKey
    } = await requireAdmin3(
      context
    );
    const [
      loginUsers,
      authUsers
    ] = await Promise.all([
      getLoginUsers(
        supabaseUrl,
        serviceRoleKey
      ),
      getAuthUsers(
        supabaseUrl,
        serviceRoleKey
      )
    ]);
    const authUsersByEmail = /* @__PURE__ */ new Map();
    authUsers.forEach((authUser) => {
      const email = normalizeEmail(
        authUser.email
      );
      if (email) {
        authUsersByEmail.set(
          email,
          authUser
        );
      }
    });
    const users = loginUsers.map((loginUser) => {
      const email = normalizeEmail(
        loginUser.email
      );
      const authUser = authUsersByEmail.get(
        email
      );
      return {
        user_id: authUser?.id || "",
        name: getDisplayName(
          loginUser,
          email
        ),
        email,
        is_admin: loginUser.is_admin === true,
        can_edit_articles: loginUser.can_edit_articles === true
      };
    });
    return jsonResponse5({
      success: true,
      users
    });
  } catch (error) {
    console.error(
      "List-users function error:",
      error
    );
    return jsonResponse5(
      {
        error: error.message || "Unable to load users."
      },
      Number.isInteger(error.status) ? error.status : 500
    );
  }
}
__name(onRequestGet4, "onRequestGet");

// mark-password-change-required.js
async function onRequestPost7() {
  return new Response(JSON.stringify({
    error: "This endpoint is reserved for the first-login setup flow."
  }), {
    status: 501,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
__name(onRequestPost7, "onRequestPost");

// user-settings.js
function jsonResponse6(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(jsonResponse6, "jsonResponse");
var RequestError2 = class extends Error {
  static {
    __name(this, "RequestError");
  }
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
};
function getBearerToken6(request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}
__name(getBearerToken6, "getBearerToken");
function normalizeEmail2(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
__name(normalizeEmail2, "normalizeEmail");
function normalizeText2(value) {
  return typeof value === "string" ? value.trim() : "";
}
__name(normalizeText2, "normalizeText");
function getRequiredEnvironment5(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new RequestError2("Supabase environment variables are incomplete.", 500);
  }
  return {
    supabaseUrl: SUPABASE_URL.endsWith("/") ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  };
}
__name(getRequiredEnvironment5, "getRequiredEnvironment");
async function parseResponseBody(response) {
  const responseText = await response.text();
  if (!responseText) {
    return null;
  }
  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}
__name(parseResponseBody, "parseResponseBody");
function getResponseError2(data, fallback) {
  if (data && typeof data === "object") {
    return data.message || data.error || fallback;
  }
  if (typeof data === "string" && data.trim()) {
    return data;
  }
  return fallback;
}
__name(getResponseError2, "getResponseError");
async function serviceRequest3(url, serviceRoleKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...options.headers || {}
    }
  });
  const data = await parseResponseBody(response);
  if (!response.ok) {
    throw new RequestError2(
      getResponseError2(data, "Supabase request failed."),
      response.status
    );
  }
  return data;
}
__name(serviceRequest3, "serviceRequest");
async function requireAdmin4(context) {
  const accessToken = getBearerToken6(context.request);
  if (!accessToken) {
    throw new RequestError2("Authentication required.", 401);
  }
  const {
    supabaseUrl,
    anonKey,
    serviceRoleKey
  } = getRequiredEnvironment5(context);
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`
    }
  });
  const authenticatedUser = await parseResponseBody(userResponse);
  if (!userResponse.ok) {
    throw new RequestError2("Your session is invalid or has expired.", 401);
  }
  const authenticatedEmail = normalizeEmail2(authenticatedUser?.email);
  const authenticatedUserId = normalizeText2(authenticatedUser?.id);
  if (!authenticatedEmail) {
    throw new RequestError2("The authenticated account has no email address.", 401);
  }
  const permissionUrl = new URL(`${supabaseUrl}/rest/v1/login`);
  permissionUrl.searchParams.set("select", "is_admin");
  permissionUrl.searchParams.set("email", `eq.${authenticatedEmail}`);
  permissionUrl.searchParams.set("limit", "1");
  const permissionRows = await serviceRequest3(
    permissionUrl.toString(),
    serviceRoleKey
  );
  if (!Array.isArray(permissionRows) || permissionRows[0]?.is_admin !== true) {
    throw new RequestError2("Administrator access required.", 403);
  }
  return {
    supabaseUrl,
    serviceRoleKey,
    authenticatedEmail,
    authenticatedUserId
  };
}
__name(requireAdmin4, "requireAdmin");
async function getLoginUser(supabaseUrl, serviceRoleKey, email) {
  const userUrl = new URL(`${supabaseUrl}/rest/v1/login`);
  userUrl.searchParams.set("select", "name,email,is_admin,can_edit_articles");
  userUrl.searchParams.set("email", `eq.${email}`);
  userUrl.searchParams.set("limit", "1");
  const rows = await serviceRequest3(userUrl.toString(), serviceRoleKey);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}
__name(getLoginUser, "getLoginUser");
async function loginEmailExists(supabaseUrl, serviceRoleKey, email) {
  const userUrl = new URL(`${supabaseUrl}/rest/v1/login`);
  userUrl.searchParams.set("select", "email");
  userUrl.searchParams.set("email", `eq.${email}`);
  userUrl.searchParams.set("limit", "1");
  const rows = await serviceRequest3(userUrl.toString(), serviceRoleKey);
  return Array.isArray(rows) && rows.length > 0;
}
__name(loginEmailExists, "loginEmailExists");
async function getAuthUserById(supabaseUrl, serviceRoleKey, userId) {
  if (!userId) {
    return null;
  }
  const result = await serviceRequest3(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    serviceRoleKey
  );
  return result?.user || result || null;
}
__name(getAuthUserById, "getAuthUserById");
async function updateAuthEmail(supabaseUrl, serviceRoleKey, userId, email) {
  if (!userId) {
    return null;
  }
  return serviceRequest3(
    `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    serviceRoleKey,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email })
    }
  );
}
__name(updateAuthEmail, "updateAuthEmail");
async function updateLoginUser(supabaseUrl, serviceRoleKey, originalEmail, updates) {
  const updateUrl = new URL(`${supabaseUrl}/rest/v1/login`);
  updateUrl.searchParams.set("email", `eq.${originalEmail}`);
  const rows = await serviceRequest3(
    updateUrl.toString(),
    serviceRoleKey,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(updates)
    }
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}
__name(updateLoginUser, "updateLoginUser");
function formatUser(user) {
  return {
    name: normalizeText2(user?.name),
    email: normalizeEmail2(user?.email),
    is_admin: user?.is_admin === true,
    can_edit_articles: user?.can_edit_articles === true
  };
}
__name(formatUser, "formatUser");
async function onRequestPost8(context) {
  try {
    const admin = await requireAdmin4(context);
    let requestBody;
    try {
      requestBody = await context.request.json();
    } catch {
      throw new RequestError2("The request body must contain valid JSON.", 400);
    }
    const action = normalizeText2(requestBody.action).toLowerCase();
    if (action !== "get" && action !== "update") {
      throw new RequestError2("A valid settings action is required.", 400);
    }
    const originalEmail = normalizeEmail2(
      requestBody.originalEmail || requestBody.email
    );
    if (!originalEmail) {
      throw new RequestError2("A valid user email is required.", 400);
    }
    const existingUser = await getLoginUser(
      admin.supabaseUrl,
      admin.serviceRoleKey,
      originalEmail
    );
    if (!existingUser) {
      throw new RequestError2("User not found in the login table.", 404);
    }
    if (action === "get") {
      return jsonResponse6({
        success: true,
        user: formatUser(existingUser)
      });
    }
    const userId = normalizeText2(requestBody.userId);
    const name = normalizeText2(requestBody.name || existingUser.name);
    const email = normalizeEmail2(requestBody.email || originalEmail);
    const isAdmin = requestBody.isAdmin;
    const canEditArticles = requestBody.canEditArticles;
    if (!name) {
      throw new RequestError2("A valid user name is required.", 400);
    }
    if (!email) {
      throw new RequestError2("A valid user email is required.", 400);
    }
    if (typeof isAdmin !== "boolean" || typeof canEditArticles !== "boolean") {
      throw new RequestError2(
        "Administrator and editor settings must be true or false.",
        400
      );
    }
    const editingSelf = userId && userId === admin.authenticatedUserId || originalEmail === admin.authenticatedEmail;
    if (editingSelf && isAdmin !== true) {
      throw new RequestError2(
        "You cannot remove administrator access from your own account.",
        400
      );
    }
    const emailChanged = email !== originalEmail;
    let authUser = null;
    if (userId) {
      authUser = await getAuthUserById(
        admin.supabaseUrl,
        admin.serviceRoleKey,
        userId
      );
      if (!authUser) {
        throw new RequestError2("The Supabase Auth user was not found.", 404);
      }
      const authEmail = normalizeEmail2(authUser.email);
      if (authEmail && authEmail !== originalEmail) {
        throw new RequestError2(
          "The selected User ID does not match the selected email address.",
          409
        );
      }
    }
    if (emailChanged && !userId) {
      throw new RequestError2(
        "This email cannot be changed because no Supabase Auth User ID is linked to the account.",
        400
      );
    }
    if (emailChanged && await loginEmailExists(
      admin.supabaseUrl,
      admin.serviceRoleKey,
      email
    )) {
      throw new RequestError2(
        "Another user already uses that email address.",
        409
      );
    }
    let authEmailUpdated = false;
    if (emailChanged) {
      await updateAuthEmail(
        admin.supabaseUrl,
        admin.serviceRoleKey,
        userId,
        email
      );
      authEmailUpdated = true;
    }
    let updatedUser;
    try {
      updatedUser = await updateLoginUser(
        admin.supabaseUrl,
        admin.serviceRoleKey,
        originalEmail,
        {
          name,
          email,
          is_admin: isAdmin,
          can_edit_articles: canEditArticles
        }
      );
    } catch (error) {
      if (authEmailUpdated) {
        try {
          await updateAuthEmail(
            admin.supabaseUrl,
            admin.serviceRoleKey,
            userId,
            originalEmail
          );
        } catch (rollbackError) {
          console.error("Unable to roll back auth email:", rollbackError);
        }
      }
      throw error;
    }
    if (!updatedUser) {
      if (authEmailUpdated) {
        try {
          await updateAuthEmail(
            admin.supabaseUrl,
            admin.serviceRoleKey,
            userId,
            originalEmail
          );
        } catch (rollbackError) {
          console.error("Unable to roll back auth email:", rollbackError);
        }
      }
      throw new RequestError2("User not found in the login table.", 404);
    }
    return jsonResponse6({
      success: true,
      user: {
        user_id: userId,
        ...formatUser(updatedUser)
      }
    });
  } catch (error) {
    console.error("User-settings function error:", error);
    return jsonResponse6(
      {
        error: error.message || "Unable to update user settings."
      },
      Number.isInteger(error.status) ? error.status : 500
    );
  }
}
__name(onRequestPost8, "onRequestPost");

// ../shared/workforce-access.js
var WORKFORCE_PERMISSION_KEYS = Object.freeze([
  "manage_employees",
  "manage_schedules",
  "view_team_attendance",
  "correct_attendance",
  "approve_attendance",
  "approve_leave",
  "view_workforce_reports",
  "edit_articles",
  "manage_payroll"
]);
var LEGACY_ADMIN_PERMISSION_KEYS = Object.freeze([
  "manage_employees",
  "manage_schedules",
  "view_team_attendance",
  "approve_leave",
  "view_workforce_reports"
]);
function toBoolean(value) {
  return value === true;
}
__name(toBoolean, "toBoolean");
function normalizeText3(value) {
  return typeof value === "string" ? value.trim() : "";
}
__name(normalizeText3, "normalizeText");
function normalizeEmail3(value) {
  return normalizeText3(value).toLowerCase();
}
__name(normalizeEmail3, "normalizeEmail");
function normalizeUuidList(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.filter((item) => typeof item === "string" && item.trim()))];
}
__name(normalizeUuidList, "normalizeUuidList");
function createPermissionMap(source = {}) {
  const permissions = {};
  for (const key of WORKFORCE_PERMISSION_KEYS) {
    permissions[key] = toBoolean(source?.[key]);
  }
  return permissions;
}
__name(createPermissionMap, "createPermissionMap");
function getWorkforceAccessType({
  is_admin: isAdmin = false,
  is_agent: isAgent = false,
  is_system_admin: isSystemAdmin = false,
  permissions = {}
} = {}) {
  if (isSystemAdmin) {
    return "regular_agent";
  }
  if (isAdmin && isAgent) {
    return "admin_agent";
  }
  if (isAdmin) {
    return "admin";
  }
  if (isAgent && permissions.edit_articles === true) {
    return "agent_editor";
  }
  return "regular_agent";
}
__name(getWorkforceAccessType, "getWorkforceAccessType");
function normalizeWorkforceAccess(payload, {
  user = null,
  source = "workforce_rpc"
} = {}) {
  const data = payload && typeof payload === "object" ? payload : {};
  const permissions = createPermissionMap(data.permissions);
  const authenticated = Boolean(user?.id || data.auth_user_id || data.user_id);
  const isActive = data.is_active === true;
  const baseRole = normalizeText3(data.base_role) || "agent";
  const isSystemAdmin = isActive && data.is_system_admin === true;
  const isAdmin = isActive && (data.is_admin === true || isSystemAdmin);
  const isAgent = isActive && data.is_agent === true;
  const resolvedUserId = data.user_id || user?.id || null;
  const linkedProfileIds = normalizeUuidList(
    data.linked_profile_ids,
    resolvedUserId ? [resolvedUserId] : []
  );
  if (resolvedUserId && !linkedProfileIds.includes(resolvedUserId)) {
    linkedProfileIds.unshift(resolvedUserId);
  }
  if (isActive && data.can_edit_articles === true) {
    permissions.edit_articles = true;
  }
  if (isActive && data.can_manage_payroll === true) {
    permissions.manage_payroll = true;
  }
  if (isActive && data.can_correct_attendance === true) {
    permissions.correct_attendance = true;
  }
  if (isActive && data.can_approve_attendance === true) {
    permissions.approve_attendance = true;
  }
  return {
    authenticated,
    allowed: authenticated && isActive,
    source,
    user,
    auth_user_id: data.auth_user_id || user?.id || null,
    user_id: resolvedUserId,
    linked_profile_ids: linkedProfileIds,
    full_name: normalizeText3(data.full_name),
    email: normalizeEmail3(data.email || user?.email),
    employee_id: normalizeText3(data.employee_id),
    employment_status: normalizeText3(data.employment_status),
    is_active: isActive,
    base_role: baseRole,
    is_admin: isAdmin,
    is_system_admin: isSystemAdmin,
    is_agent: isAgent,
    team_id: data.team_id || null,
    supervisor_id: data.supervisor_id || null,
    timezone: normalizeText3(data.timezone) || "America/New_York",
    permissions,
    can_edit_articles: permissions.edit_articles === true,
    can_manage_payroll: permissions.manage_payroll === true,
    can_correct_attendance: permissions.correct_attendance === true,
    can_approve_attendance: permissions.approve_attendance === true,
    legacy: data.legacy && typeof data.legacy === "object" ? data.legacy : null,
    access_type: getWorkforceAccessType({
      is_admin: baseRole === "admin",
      is_agent: isAgent,
      is_system_admin: isSystemAdmin,
      permissions
    })
  };
}
__name(normalizeWorkforceAccess, "normalizeWorkforceAccess");
function createLegacyWorkforceAccess(loginRecord, {
  user = null,
  source = "legacy_login"
} = {}) {
  const row = loginRecord && typeof loginRecord === "object" ? loginRecord : null;
  if (!row) {
    return normalizeWorkforceAccess(
      {
        auth_user_id: user?.id || null,
        user_id: user?.id || null,
        linked_profile_ids: user?.id ? [user.id] : [],
        email: user?.email || "",
        is_active: false,
        employment_status: "inactive",
        permissions: {}
      },
      { user, source }
    );
  }
  const permissions = createPermissionMap();
  const isAdmin = row.is_admin === true;
  if (isAdmin) {
    for (const key of LEGACY_ADMIN_PERMISSION_KEYS) {
      permissions[key] = true;
    }
  }
  permissions.edit_articles = row.can_edit_articles === true;
  const metadata = user?.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  return normalizeWorkforceAccess(
    {
      auth_user_id: user?.id || null,
      user_id: user?.id || null,
      linked_profile_ids: user?.id ? [user.id] : [],
      full_name: normalizeText3(row.name) || normalizeText3(metadata.full_name) || normalizeText3(metadata.name) || normalizeEmail3(row.email || user?.email).split("@")[0],
      email: row.email || user?.email || "",
      employee_id: "",
      employment_status: "active",
      is_active: true,
      base_role: isAdmin ? "admin" : "agent",
      is_admin: isAdmin,
      is_system_admin: false,
      is_agent: true,
      timezone: "America/New_York",
      permissions,
      can_edit_articles: permissions.edit_articles,
      can_manage_payroll: false,
      can_correct_attendance: false,
      can_approve_attendance: false,
      legacy: {
        is_admin: isAdmin,
        can_edit_articles: row.can_edit_articles === true
      }
    },
    { user, source }
  );
}
__name(createLegacyWorkforceAccess, "createLegacyWorkforceAccess");
function hasWorkforcePermission(access, permissionKey) {
  if (!WORKFORCE_PERMISSION_KEYS.includes(permissionKey)) {
    return false;
  }
  return Boolean(
    access?.allowed === true && access?.permissions?.[permissionKey] === true
  );
}
__name(hasWorkforcePermission, "hasWorkforcePermission");

// _shared/workforce-auth.js
var WorkforceAuthorizationError = class extends Error {
  static {
    __name(this, "WorkforceAuthorizationError");
  }
  constructor(message, status = 500) {
    super(message);
    this.name = "WorkforceAuthorizationError";
    this.status = status;
  }
};
function normalizeEmail4(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
__name(normalizeEmail4, "normalizeEmail");
function getBearerToken7(request) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return "";
  }
  return authorization.slice("Bearer ".length).trim();
}
__name(getBearerToken7, "getBearerToken");
function getRequiredEnvironment6(context) {
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY
  } = context.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new WorkforceAuthorizationError(
      "Supabase environment variables are incomplete.",
      500
    );
  }
  return {
    supabaseUrl: SUPABASE_URL.endsWith("/") ? SUPABASE_URL.slice(0, -1) : SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
  };
}
__name(getRequiredEnvironment6, "getRequiredEnvironment");
async function parseResponse2(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
__name(parseResponse2, "parseResponse");
function responseError(data, fallback) {
  if (data && typeof data === "object") {
    return data.message || data.error || fallback;
  }
  return typeof data === "string" && data.trim() ? data : fallback;
}
__name(responseError, "responseError");
function isMissingAccessRpcResponse(response, data) {
  const code = String(data?.code || "").toUpperCase();
  const message = String(
    data?.message || data?.error || data || ""
  ).toLowerCase();
  return response.status === 404 || code === "PGRST202" || code === "42883" || message.includes("workforce_get_current_access") && (message.includes("not find") || message.includes("does not exist") || message.includes("schema cache"));
}
__name(isMissingAccessRpcResponse, "isMissingAccessRpcResponse");
async function authenticateUser(supabaseUrl, anonKey, accessToken) {
  const response = await fetch(
    `${supabaseUrl}/auth/v1/user`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      }
    }
  );
  const data = await parseResponse2(response);
  if (!response.ok) {
    throw new WorkforceAuthorizationError(
      "Your session is invalid or has expired.",
      401
    );
  }
  if (!normalizeEmail4(data?.email)) {
    throw new WorkforceAuthorizationError(
      "The authenticated account has no email address.",
      401
    );
  }
  return data;
}
__name(authenticateUser, "authenticateUser");
async function loadRpcAccess(supabaseUrl, anonKey, accessToken, user) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/workforce_get_current_access`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    }
  );
  const data = await parseResponse2(response);
  if (!response.ok) {
    if (isMissingAccessRpcResponse(response, data)) {
      return null;
    }
    throw new WorkforceAuthorizationError(
      responseError(data, "Unable to load workforce permissions."),
      response.status >= 400 && response.status < 600 ? response.status : 500
    );
  }
  return data ? normalizeWorkforceAccess(data, { user }) : null;
}
__name(loadRpcAccess, "loadRpcAccess");
async function loadLegacyAccess(supabaseUrl, serviceRoleKey, user) {
  const email = normalizeEmail4(user?.email);
  if (!email) {
    return createLegacyWorkforceAccess(null, { user });
  }
  const url = new URL(`${supabaseUrl}/rest/v1/login`);
  url.searchParams.set(
    "select",
    "name,email,is_admin,can_edit_articles"
  );
  url.searchParams.set("email", `eq.${email}`);
  url.searchParams.set("limit", "1");
  const response = await fetch(url.toString(), {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });
  const data = await parseResponse2(response);
  if (!response.ok) {
    throw new WorkforceAuthorizationError(
      responseError(data, "Unable to verify workforce permissions."),
      500
    );
  }
  return createLegacyWorkforceAccess(
    Array.isArray(data) ? data[0] : null,
    { user }
  );
}
__name(loadLegacyAccess, "loadLegacyAccess");
async function loadWorkforceAuthorization(context) {
  const accessToken = getBearerToken7(context.request);
  if (!accessToken) {
    throw new WorkforceAuthorizationError(
      "Authentication required.",
      401
    );
  }
  const environment = getRequiredEnvironment6(context);
  const user = await authenticateUser(
    environment.supabaseUrl,
    environment.anonKey,
    accessToken
  );
  const rpcAccess = await loadRpcAccess(
    environment.supabaseUrl,
    environment.anonKey,
    accessToken,
    user
  );
  const access = rpcAccess || await loadLegacyAccess(
    environment.supabaseUrl,
    environment.serviceRoleKey,
    user
  );
  if (!access.allowed) {
    throw new WorkforceAuthorizationError(
      "Your workforce account is inactive or unavailable.",
      403
    );
  }
  return {
    ...environment,
    accessToken,
    user,
    access
  };
}
__name(loadWorkforceAuthorization, "loadWorkforceAuthorization");
async function requireWorkforcePermission(context, permissionKey, {
  requireAdmin: requireAdmin5 = false
} = {}) {
  const authorization = await loadWorkforceAuthorization(context);
  if (!hasWorkforcePermission(authorization.access, permissionKey)) {
    throw new WorkforceAuthorizationError(
      "You do not have the required workforce permission.",
      403
    );
  }
  if (requireAdmin5 && authorization.access.is_admin !== true) {
    throw new WorkforceAuthorizationError(
      "Administrator access required.",
      403
    );
  }
  return authorization;
}
__name(requireWorkforcePermission, "requireWorkforcePermission");

// _middleware.js
var PROTECTED_ROUTES = Object.freeze({
  "/list-users": {
    methods: ["GET"],
    permission: "manage_employees",
    requireAdmin: true
  },
  "/create-user": {
    methods: ["POST"],
    permission: "manage_employees",
    requireAdmin: true
  },
  "/user-settings": {
    methods: ["POST"],
    permission: "manage_employees",
    requireAdmin: true
  },
  "/remove-account": {
    methods: ["POST"],
    permission: "manage_employees",
    requireAdmin: true
  },
  "/delete-user": {
    methods: ["POST"],
    permission: "manage_employees",
    requireAdmin: true
  },
  "/change-password": {
    methods: ["POST"],
    permission: "manage_employees",
    requireAdmin: true
  }
});
function jsonResponse7(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(jsonResponse7, "jsonResponse");
async function onRequest(context) {
  if (context.request.method === "OPTIONS") {
    return context.next();
  }
  const pathname = new URL(context.request.url).pathname;
  const route = PROTECTED_ROUTES[pathname];
  const method = context.request.method.toUpperCase();
  if (!route || !route.methods.includes(method)) {
    return context.next();
  }
  try {
    const authorization = await requireWorkforcePermission(
      context,
      route.permission,
      { requireAdmin: route.requireAdmin }
    );
    context.data.workforceAuthorization = authorization;
    return context.next();
  } catch (error) {
    console.error("Workforce authorization middleware error:", error);
    const status = error instanceof WorkforceAuthorizationError && Number.isInteger(error.status) ? error.status : 500;
    return jsonResponse7(
      {
        error: status === 500 ? "Unable to verify workforce permissions." : error.message
      },
      status
    );
  }
}
__name(onRequest, "onRequest");

// ../.wrangler/tmp/pages-Lg1uMS/functionsRoutes-0.37406707664277294.mjs
var routes = [
  {
    routePath: "/api/sync-dashboard",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  },
  {
    routePath: "/google-calendar/callback",
    mountPath: "/google-calendar",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/google-calendar/connect",
    mountPath: "/google-calendar",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost2]
  },
  {
    routePath: "/google-calendar/disconnect",
    mountPath: "/google-calendar",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost3]
  },
  {
    routePath: "/google-calendar/events",
    mountPath: "/google-calendar",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/google-calendar/status",
    mountPath: "/google-calendar",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet3]
  },
  {
    routePath: "/change-password",
    mountPath: "/",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost4]
  },
  {
    routePath: "/create-user",
    mountPath: "/",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost5]
  },
  {
    routePath: "/delete-user",
    mountPath: "/",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost6]
  },
  {
    routePath: "/list-users",
    mountPath: "/",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet4]
  },
  {
    routePath: "/mark-password-change-required",
    mountPath: "/",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost7]
  },
  {
    routePath: "/remove-account",
    mountPath: "/",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost6]
  },
  {
    routePath: "/user-settings",
    mountPath: "/",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost8]
  },
  {
    routePath: "/",
    mountPath: "/",
    method: "",
    middlewares: [onRequest],
    modules: []
  }
];

// ../../AppData/Roaming/npm/node_modules/wrangler/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../AppData/Roaming/npm/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../.wrangler/tmp/bundle-FI4uAV/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../.wrangler/tmp/bundle-FI4uAV/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.1062315975395548.mjs.map
