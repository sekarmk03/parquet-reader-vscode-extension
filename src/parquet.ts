/**
 * The only module that knows about parquet. Everything it returns is plain,
 * postMessage-safe data — strings, numbers, booleans.
 */
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import type { AsyncBuffer, FileMetaData, SchemaElement, SchemaTree } from 'hyparquet'
import type { ColumnSummary, DataColumn, FileInfo } from './types'

export interface ParquetHandle {
  file: AsyncBuffer
  metadata: FileMetaData
  totalRows: number
  dataColumns: DataColumn[]
}

// ── open ─────────────────────────────────────────────────────────────────────

/** Takes an already-opened buffer — see source.ts for where it comes from. */
export async function openParquet(file: AsyncBuffer): Promise<ParquetHandle> {
  const metadata = await parquetMetadataAsync(file) // reads the footer, not the file
  return {
    file,
    metadata,
    totalRows: Number(metadata.num_rows),
    dataColumns: buildDataColumns(metadata),
  }
}

// ── read one page ────────────────────────────────────────────────────────────

/**
 * Read at data-page granularity instead of whole column chunks. Files written as
 * one huge row group — Spark's default — would otherwise make the first page cost
 * the entire file. Writers that omit the offset index fall back to full chunks.
 */
const READ_OPTIONS = { compressors, useOffsetIndex: true }

/**
 * Raw values, one array per row, in dataColumns order. Everything that reads rows
 * goes through here — the grid formats them, sorting compares them untouched.
 */
export async function readRowValues(
  h: ParquetHandle,
  rowStart: number,
  rowEnd: number,
): Promise<unknown[][]> {
  if (rowStart >= h.totalRows || rowStart >= rowEnd) return []

  const rows = await parquetReadObjects({
    file: h.file,
    metadata: h.metadata,
    ...READ_OPTIONS,
    rowStart,
    rowEnd: Math.min(rowEnd, h.totalRows),
  })
  return rows.map(row => h.dataColumns.map(c => row[c.name]))
}

export async function readPage(
  h: ParquetHandle,
  page: number,
  pageSize: number,
): Promise<string[][]> {
  const rowStart = page * pageSize
  const values = await readRowValues(h, rowStart, rowStart + pageSize)
  return values.map(row => row.map(formatCell))
}

// ── read one cell, in full ───────────────────────────────────────────────────

/**
 * The untruncated value behind a single grid cell, read on demand.
 * Only that one row and one column leave the disk, so this stays cheap on big files.
 */
export async function readCell(h: ParquetHandle, row: number, col: number): Promise<string> {
  const column = h.dataColumns[col]
  if (!column || row < 0 || row >= h.totalRows) return 'NULL'

  const [record] = await parquetReadObjects({
    file: h.file,
    metadata: h.metadata,
    ...READ_OPTIONS,
    rowStart: row,
    rowEnd: row + 1,
    columns: [column.name],
  })
  return formatFull(record?.[column.name])
}

// ── the single place where a value becomes a string ──────────────────────────

/** Grid version: one line, capped, because a whole page crosses postMessage at once. */
export function formatCell(v: unknown): string {
  return truncate(render(v))
}

/** Detail-pane version: nothing dropped, and nested values pretty-printed. */
export function formatFull(v: unknown): string {
  return render(v, 2)
}

function render(v: unknown, indent = 0): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  if (v instanceof Uint8Array) return formatBytes(v)
  if (typeof v === 'object') return JSON.stringify(v, bigintSafe, indent) ?? String(v)
  return String(v)
}

function formatBytes(v: Uint8Array): string {
  const head = Array.from(v.slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return `0x${head}${v.length > 8 ? '…' : ''} (${v.length} B)`
}

function bigintSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return formatBytes(value)
  return value
}

function truncate(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

// ── schema navigation ────────────────────────────────────────────────────────

/** Top-level fields — the columns actually rendered in the Data tab. */
function buildDataColumns(md: FileMetaData): DataColumn[] {
  return parquetSchema(md).children.map(node => {
    const described = describeType(node.element)
    // A group has no physical type of its own; a repeated field reads back as an array.
    const nested = !node.element.type
    const repeated = node.element.repetition_type === 'REPEATED'
    const type = nested ? groupType(node) : described.label
    return {
      name: node.element.name,
      type,
      numeric: described.numeric,
      sortable: !nested && !repeated,
      // Worded per case: "STRING columns cannot be sorted" would be a lie about a
      // repeated STRING, since a plain STRING column sorts fine.
      unsortableReason: nested
        ? `A ${type} column holds a nested value, so there is no single value to order rows by.`
        : repeated
          ? `This column repeats — each row holds a list of ${type}, not one value to order by.`
          : undefined,
    }
  })
}

/** Leaf columns, depth-first — this is where parquet stores per-column statistics. */
export function leafColumns(md: FileMetaData): SchemaTree[] {
  const walk = (n: SchemaTree): SchemaTree[] => (n.children.length ? n.children.flatMap(walk) : [n])
  return parquetSchema(md).children.flatMap(walk)
}

/** Label for a node with no physical type of its own, i.e. a nested group. */
function groupType(node: SchemaTree): string {
  const logical = node.element.logical_type?.type ?? node.element.converted_type
  return logical === 'LIST' || logical === 'MAP' || logical === 'VARIANT' ? logical : 'STRUCT'
}

// ── file info ────────────────────────────────────────────────────────────────

export function buildInfo(h: ParquetHandle, fileName: string): FileInfo {
  const codecs = new Set<string>()
  for (const rg of h.metadata.row_groups) {
    for (const cc of rg.columns) {
      if (cc.meta_data) codecs.add(cc.meta_data.codec)
    }
  }
  return {
    fileName,
    // The buffer already knows its size, locally from stat and remotely from Content-Range.
    fileSize: humanBytes(h.file.byteLength),
    totalRows: h.totalRows.toLocaleString('en-US'),
    totalCols: h.dataColumns.length,
    codec: [...codecs].join(', ') || '—',
    createdBy: h.metadata.created_by ?? '—',
  }
}

// ── column summary (Schema tab) ──────────────────────────────────────────────

interface ColumnStats {
  nulls?: bigint
  compressed: bigint
  min?: unknown
  max?: unknown
}

export function buildSchema(h: ParquetHandle): ColumnSummary[] {
  const stats = aggregateStats(h.metadata)

  return leafColumns(h.metadata).map(node => {
    const element = node.element
    const key = node.path.join('.')
    const s = stats.get(key)
    return {
      name: key,
      physical: element.type ?? '—',
      logical: logicalLabel(element),
      nullable: element.repetition_type !== 'REQUIRED',
      // Statistics are optional in the format — plenty of writers omit them.
      nullCount: s?.nulls === undefined ? '—' : s.nulls.toString(),
      min: s?.min === undefined ? '—' : formatCell(s.min),
      max: s?.max === undefined ? '—' : formatCell(s.max),
      compressed: s === undefined ? '—' : humanBytes(Number(s.compressed)),
      numeric: describeType(element).numeric,
    }
  })
}

/** Column chunks live per row group; fold them into one entry per column path. */
function aggregateStats(md: FileMetaData): Map<string, ColumnStats> {
  const out = new Map<string, ColumnStats>()

  for (const rg of md.row_groups) {
    for (const cc of rg.columns) {
      const meta = cc.meta_data
      if (!meta) continue

      const key = meta.path_in_schema.join('.')
      const s = out.get(key) ?? { compressed: 0n }
      s.compressed += meta.total_compressed_size

      const nulls = meta.statistics?.null_count
      if (nulls !== undefined) s.nulls = (s.nulls ?? 0n) + nulls

      const min = meta.statistics?.min_value ?? meta.statistics?.min
      const max = meta.statistics?.max_value ?? meta.statistics?.max
      if (min !== undefined && (s.min === undefined || lessThan(min, s.min))) s.min = min
      if (max !== undefined && (s.max === undefined || lessThan(s.max, max))) s.max = max

      out.set(key, s)
    }
  }
  return out
}

/** Values within one column share a type, so a plain comparison is enough. */
function lessThan(a: unknown, b: unknown): boolean {
  return (a as never) < (b as never)
}

// ── labels ───────────────────────────────────────────────────────────────────

const NUMERIC_PHYSICAL = new Set(['INT32', 'INT64', 'INT96', 'FLOAT', 'DOUBLE'])
const NOT_REALLY_A_NUMBER = new Set([
  'STRING', 'TIMESTAMP', 'DATE', 'TIME', 'JSON', 'BSON', 'ENUM', 'UUID', 'INTERVAL',
])

/**
 * What to show above a data column, and whether to right-align it.
 * A timestamp is physically an INT64 but neither reads nor aligns like a number.
 */
function describeType(element: SchemaElement): { label: string; numeric: boolean } {
  const kind = logicalKind(element)
  const numeric =
    kind === 'DECIMAL' ||
    (NUMERIC_PHYSICAL.has(element.type ?? '') && !NOT_REALLY_A_NUMBER.has(kind ?? ''))
  return { label: kind ?? element.type ?? '—', numeric }
}

/** Normalises the two ways parquet records logical types into one family name. */
function logicalKind(element: SchemaElement): string | undefined {
  if (element.logical_type) return element.logical_type.type
  const converted = element.converted_type
  if (!converted) return undefined
  if (converted === 'UTF8') return 'STRING'
  if (converted.startsWith('TIMESTAMP_')) return 'TIMESTAMP'
  if (converted.startsWith('TIME_')) return 'TIME'
  if (converted.startsWith('INT_')) return `INT${converted.slice(4)}`
  if (converted.startsWith('UINT_')) return `UINT${converted.slice(5)}`
  return converted
}

/** Full detail for the Schema tab, units and all. */
function logicalLabel(element: SchemaElement): string {
  const lt = element.logical_type
  if (lt) {
    switch (lt.type) {
      case 'TIMESTAMP':
      case 'TIME':
        return `${lt.type}(${lt.unit}, ${lt.isAdjustedToUTC ? 'UTC' : 'local'})`
      case 'DECIMAL':
        return `DECIMAL(${lt.precision},${lt.scale})`
      case 'INTEGER':
        return `${lt.isSigned ? 'INT' : 'UINT'}${lt.bitWidth}`
      default:
        return lt.type
    }
  }
  return element.converted_type ?? '—'
}

export function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`
}
