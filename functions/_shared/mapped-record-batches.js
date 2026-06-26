const DEFAULT_BATCH_SIZE = 1000

function getConflictColumns(destination) {
  return Array.isArray(destination?.conflictColumns)
    ? destination.conflictColumns
    : [destination?.conflictColumn]
}

function validateConflictColumns(columns) {
  if (
    columns.length === 0 ||
    columns.some(column =>
      typeof column !== 'string' ||
      !/^[a-z_][a-z0-9_]*$/i.test(column)
    )
  ) {
    throw new Error('The database conflict columns are invalid.')
  }
}

function inferConflictColumns(record) {
  if (!record || typeof record !== 'object') return null

  if ('dimension_type' in record && 'dimension_key' in record) {
    return ['report_date', 'dimension_type', 'dimension_key']
  }

  if ('agent_key' in record) {
    return ['report_date', 'agent_key']
  }

  if ('driver_key' in record) {
    return ['report_date', 'driver_key']
  }

  return null
}

export function deduplicateMappedRecords(records, conflictColumns) {
  if (!Array.isArray(records) || records.length === 0) {
    return []
  }

  const columns = Array.isArray(conflictColumns)
    ? conflictColumns
    : [conflictColumns]
  validateConflictColumns(columns)

  const uniqueRecords = new Map()

  records.forEach((record, recordIndex) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Mapped record ${recordIndex + 1} is invalid.`)
    }

    const values = columns.map(column => record[column])

    if (values.some(value =>
      value === null || value === undefined || value === ''
    )) {
      throw new Error(
        `Mapped record ${recordIndex + 1} is missing a conflict-key value.`
      )
    }

    const key = JSON.stringify(values)
    uniqueRecords.set(key, record)
  })

  return [...uniqueRecords.values()]
}

export function getMappedRecordBatches(records, batchSize = DEFAULT_BATCH_SIZE) {
  if (!Array.isArray(records) || records.length === 0) {
    return []
  }

  const conflictColumns = inferConflictColumns(records[0])
  const sourceRecords = conflictColumns
    ? deduplicateMappedRecords(records, conflictColumns)
    : records
  const batches = []

  for (let start = 0; start < sourceRecords.length; start += batchSize) {
    batches.push(sourceRecords.slice(start, start + batchSize))
  }

  return batches
}

export function getMappedDestination(destination) {
  const tableName = destination?.tableName
  const columns = getConflictColumns(destination)

  if (
    typeof tableName !== 'string' ||
    !/^[a-z_][a-z0-9_]*$/i.test(tableName)
  ) {
    throw new Error('The database table name is invalid.')
  }

  validateConflictColumns(columns)

  return Object.freeze({
    tableName,
    conflictColumns: Object.freeze([...columns]),
    conflictTarget: columns.join(',')
  })
}
