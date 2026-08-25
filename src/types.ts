/**
 * Contract between the extension host and the webview.
 *
 * Every value that crosses the boundary is already a display-ready string.
 * The webview never sees a BigInt, Date or Uint8Array — see formatCell() in parquet.ts.
 */

export interface FileInfo {
  fileName: string
  fileSize: string
  /** String, not number: num_rows is a bigint and would break postMessage. */
  totalRows: string
  totalCols: number
  codec: string
  createdBy: string
}

/**
 * Header of the Data tab: top-level fields, one per column of the rendered table.
 * A nested field (STRUCT/LIST/MAP) stays a single column and renders as JSON.
 */
export interface DataColumn {
  name: string
  type: string
  /** Right-aligns the column in the webview. */
  numeric: boolean
  /** False for nested and repeated fields — they have no single value to order by. */
  sortable: boolean
  /** Why not, worded per case and ready to show as-is. Set only when `sortable` is false. */
  unsortableReason?: string
}

/** Row of the Schema tab: one per leaf column, where parquet keeps its statistics. */
export interface ColumnSummary {
  name: string
  physical: string
  logical: string
  nullable: boolean
  nullCount: string
  min: string
  max: string
  compressed: string
  numeric: boolean
}

export interface SortState {
  /** Index into dataColumns. */
  column: number
  dir: 'asc' | 'desc'
}

/**
 * Everything about the Data tab that can change after `init`: page size follows the
 * setting, sorting follows the user. Sent with every page so one message describes
 * the whole visible state.
 */
export interface ViewState {
  /** Rows per page actually used, after the wide-file guard. */
  pageSize: number
  /** What the setting asked for. Differs from pageSize on wide files. */
  pageSizeSetting: number
  sortable: boolean
  /** Why sorting is off, ready to show as-is. Set only when `sortable` is false. */
  sortDisabledReason?: string
  sort: SortState | null
}

export type ToWebview =
  /** `source` is echoed back so the webview can remember it across a window reload. */
  | {
      type: 'init'
      source: string
      info: FileInfo
      dataColumns: DataColumn[]
      schema: ColumnSummary[]
    }
  | {
      type: 'page'
      rows: string[][]
      page: number
      totalPages: number
      /** Row number of the first row shown, counted within the current view. */
      rowOffset: number
      state: ViewState
    }
  /** One cell, untruncated — fetched on demand so pages stay small. `row` is absolute. */
  | { type: 'cell'; row: number; col: number; column: string; value: string }
  | { type: 'error'; message: string }

export type FromWebview =
  | { type: 'ready' }
  | { type: 'requestPage'; page: number }
  /** `row` counts within the current view, not the file — the host translates. */
  | { type: 'requestCell'; row: number; col: number }
  | { type: 'copy'; text: string }
  /** `column: null` clears the sort and returns to file order. */
  | { type: 'sort'; column: number | null; dir: 'asc' | 'desc' }
  /** Picked from the footer; the host writes it back to the setting. */
  | { type: 'pageSize'; value: number }
