# Change Log

## 0.1.1
**Page Content.** Update README page content. Place description of the main feature:
open parquet file from remote server to the beginning of the features section. Make it
more visible.

## 0.1.0

Reading tools for the Data tab. Sorting is deliberately limited this release — see below.

- **Search within the page**: filters the rows currently on screen and highlights the matches,
  case-insensitively, across every column. It runs entirely in the view: nothing is sent to the
  extension and no byte is read from the file. It searches the page you are looking at, not the
  whole file — the row count next to the box says so.
- **Column sorting**: click a header to cycle ascending → descending → back to file order.
  Sorting compares the underlying values, so `9` comes before `10` and timestamps sort
  chronologically. `NULL` sorts last in both directions, because it is the absence of a value
  rather than the smallest one.
- **A column that cannot be sorted says so.** Nested (`STRUCT`, `LIST`, `MAP`, `VARIANT`) and
  repeated columns have no single value to order rows by. Hovering one shows a `not-allowed`
  cursor, and clicking it explains why in the toolbar instead of doing nothing. The same applies
  when a file is past the sorting budget — the click tells you the numbers.
- **Sorting is capped by file size.** It holds every row in memory, so it is limited by
  `parquetReader.sortCellBudget` — 500,000 cells (rows × columns) by default. Past that, headers
  stop responding and explain the limit instead of freezing the window. Raise the setting if your
  machine can afford it.
- **Rows per page** picker in the footer: 25, 50, 100, 250, 500, 1000. It writes
  `parquetReader.pageSize`, so there is one source of truth rather than a per-tab setting that
  disagrees with your preferences. Changing it keeps the row that was at the top of the page
  in view instead of jumping.
- **`parquetReader.pageSize`**: 25 to 1000 rows per page, 100 by default. Page size does not
  change how much of the file is read — the smallest unit Parquet can read is already larger
  than a page — so it costs nothing to raise on narrow files. It is lowered automatically on
  wide files, where rendering cost grows with rows × columns; the footer says when that happens.
- Both settings apply to open tabs immediately, without reopening the file.

**Renamed identifiers.** The custom editor and the command were claiming names generic enough
that another parquet extension could claim them too — and when two extensions register the same
custom editor, one of them fails to activate outright. They are now qualified by publisher:

| | Was | Now |
|---|---|---|
| Custom editor | `parquetViewer.table` | `sekarmk03.parquetReader.table` |
| Command | `parquetViewer.openUrl` | `sekarmk03.parquetReader.openUrl` |
| Settings | `parquetViewer.*` | `parquetReader.*` |

Nothing to do for almost everyone. Two exceptions: if you pinned `.parquet` to this viewer
through `workbench.editorAssociations`, or bound a key to the old command id, update the name
there. Settings keep a short section name because you type those yourself.

## 0.0.1

First release.

- Custom read-only editor for `.parquet` and `.pq` files, opened straight from the Explorer
- Header bar with row count, column count, file size, compression codecs, and writer
- **Data** tab: 100 rows per page, sticky type header, right-aligned numerics, distinct `NULL`
  rendering, nested columns rendered as JSON
- Cell detail pane: click any cell for its untruncated value, pretty-printed for nested types,
  with a Copy button — fetched on demand rather than shipped with the page
- **Schema** tab: per leaf column, physical and logical type, nullability, null count, min,
  max, and compressed size aggregated across row groups
- **Parquet: Open Parquet from URL…** command for `https://` and `s3://` sources; `s3://` is
  signed with the AWS CLI, so credentials stay with your own profile
- Reads at data-page granularity when the file has an offset index, so large single-row-group
  files open in seconds instead of pulling whole column chunks
- Follows the active VS Code theme, including high contrast
