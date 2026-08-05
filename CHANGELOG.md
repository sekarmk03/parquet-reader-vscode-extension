# Change Log

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
