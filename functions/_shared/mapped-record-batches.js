const DEFAULT_BATCH_SIZE = 1000

export function getMappedRecordBatches(records, batchSize = DEFAULT_BATCH_SIZE) {
  if (!Array.isArray(records) || records.length === 0) {
    return []
  }

  const batches = []

  for (let start = 0; start < records.length; start += batchSize) {
    batches.push(records.slice(start, start + batchSize))
  }

  return batches
}

export function getMappedDestination(destination) {
  const tableName = destination?.tableName
  const columns = Array.isArray(destination?.conflictColumns)
    ? destination.conflictColumns
    : [destination?.conflictColumn]

  if (
    typeof tableName !== 'string' ||
    !/^[a-z_][a-z0-9_]*$/i.test(tableName)
  ) {
    throw new Error('The database table name is invalid.')
  }

  if (
    columns.length === 0 ||
    columns.some(column =>
      typeof column !== 'string' ||
      !/^[a-z_][a-z0-9_]*$/i.test(column)
    )
  ) {
    throw new Error('The database conflict columns are invalid.')
  }

  return Object.freeze({
    tableName,
    conflictTarget: columns.join(',')
  })
}
