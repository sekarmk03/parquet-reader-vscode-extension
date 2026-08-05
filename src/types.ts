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

export type ToWebview =
  /** `source` is echoed back so the webview can remember it across a window reload. */
  | {
      type: 'init'
      source: string
      info: FileInfo
      dataColumns: DataColumn[]
      schema: ColumnSummary[]
    }
  | { type: 'page'; rows: string[][]; page: number; totalPages: number; rowOffset: number }
  /** One cell, untruncated — fetched on demand so pages stay small. `row` is absolute. */
  | { type: 'cell'; row: number; col: number; column: string; value: string }
  | { type: 'error'; message: string }

export type FromWebview =
  | { type: 'ready' }
  | { type: 'requestPage'; page: number }
  | { type: 'requestCell'; row: number; col: number }
  | { type: 'copy'; text: string }
