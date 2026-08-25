/**
 * How the Data tab looks at the file's rows: in file order, or in an order the
 * user asked for. Pagination slices a view; it no longer maps straight onto
 * rowStart/rowEnd. See SPEC-v2.md §5.
 *
 * Only two shapes exist in v0.1: the file itself, and a fully materialised sort.
 * Filtering adds a third in v0.2.
 */
import { ParquetHandle, formatCell, formatFull, readCell, readPage, readRowValues } from './parquet'
import type { SortState } from './types'

export type RowView =
  /** Row i of the view is row i of the file. Costs nothing and holds nothing. */
  | { kind: 'identity'; total: number }
  /** Every row, raw, held in memory and reordered. Guarded by the budget below. */
  | { kind: 'materialized'; rows: unknown[][]; total: number; sort: SortState }

export function identityView(h: ParquetHandle): RowView {
  return { kind: 'identity', total: h.totalRows }
}

// ── page size ────────────────────────────────────────────────────────────────

/**
 * Rendering is what limits a page, not reading: a page costs the same bytes at 100
 * rows as at 5000, but the DOM grows with rows × columns. Measurements in SPEC-v2.md §2d–2e.
 */
const CELL_BUDGET_PER_PAGE = 20_000
const MIN_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 1000

export function effectivePageSize(setting: number, columns: number): number {
  const asked = Math.min(Math.max(Math.round(setting) || MIN_PAGE_SIZE, MIN_PAGE_SIZE), MAX_PAGE_SIZE)
  const fits = Math.floor(CELL_BUDGET_PER_PAGE / Math.max(1, columns))
  return Math.max(MIN_PAGE_SIZE, Math.min(asked, fits))
}

// ── sorting ──────────────────────────────────────────────────────────────────

/**
 * Sorting holds every row in the extension host, so it is capped in cells rather
 * than rows — a 60-column file costs far more per row than a 4-column one.
 * Returns the reason to show the user, or undefined when sorting is allowed.
 */
export function sortRefusal(h: ParquetHandle, budget: number): string | undefined {
  const cells = h.totalRows * h.dataColumns.length
  if (cells <= budget) return undefined
  const n = (v: number) => v.toLocaleString('en-US')
  return (
    `Sorting is off for this file: ${n(cells)} cells, over the ${n(budget)} limit. ` +
    'Raise parquetReader.sortCellBudget to allow it.'
  )
}

export async function buildSortedView(h: ParquetHandle, sort: SortState): Promise<RowView> {
  const rows = await readRowValues(h, 0, h.totalRows)
  const { column, dir } = sort

  // V8's sort is stable, so rows sharing a key keep the order they had in the file.
  rows.sort((a, b) => {
    const x = a[column]
    const y = b[column]
    const xNull = x === null || x === undefined
    const yNull = y === null || y === undefined
    // NULL is not the smallest value, it is the absence of one: park it last either way.
    if (xNull || yNull) return xNull && yNull ? 0 : xNull ? 1 : -1
    const order = compareValues(x, y)
    return dir === 'asc' ? order : -order
  })

  return { kind: 'materialized', rows, total: rows.length, sort }
}

/** Values within one column share a type, so a plain comparison is enough — except bytes. */
function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return compareBytes(a, b)
  if ((a as never) < (b as never)) return -1
  if ((a as never) > (b as never)) return 1
  return 0
}

/** `<` on two Uint8Arrays compares their comma-joined text, which is not their order. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

// ── reading through a view ───────────────────────────────────────────────────
// The only place that branches on the view's shape.

export function totalPages(view: RowView, pageSize: number): number {
  return Math.max(1, Math.ceil(view.total / pageSize))
}

export async function readViewPage(
  h: ParquetHandle,
  view: RowView,
  page: number,
  pageSize: number,
): Promise<string[][]> {
  if (view.kind === 'identity') return readPage(h, page, pageSize)
  const start = page * pageSize
  return view.rows.slice(start, start + pageSize).map(row => row.map(formatCell))
}

/**
 * `row` counts within the view. A materialised view already holds the value, so the
 * detail pane costs no I/O at all once a sort is active.
 */
export async function readViewCell(
  h: ParquetHandle,
  view: RowView,
  row: number,
  col: number,
): Promise<string> {
  if (view.kind === 'identity') return readCell(h, row, col)
  const record = view.rows[row]
  if (!record || col < 0 || col >= h.dataColumns.length) return 'NULL'
  return formatFull(record[col])
}
