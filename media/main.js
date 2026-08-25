// Dumb renderer: everything arriving here is already a display-ready string.
const vscode = acquireVsCodeApi()

// Falls back to a grid with sorting off rather than an empty one, so a host and a
// view that disagree about the message shape still show the data.
const DEFAULT_STATE = {
  pageSize: 100,
  pageSizeSetting: 100,
  sortable: false,
  sortDisabledReason: 'Sorting is unavailable for this file.',
  sort: null,
}

let dataColumns = []
let rows = [] // the current page, exactly as it was sent
let page = 0
let totalPages = 1
let rowOffset = 0
let state = DEFAULT_STATE
let selectedCell = null // the <td> whose full value the detail pane is showing
let detailValue = ''
let highlighted = [] // cells whose text search replaced with <mark> markup

const search = document.getElementById('search')
const pageSizePick = document.getElementById('pagesizepick')

/** Offered in the footer. Any other value typed into settings.json is added alongside. */
const PAGE_SIZE_CHOICES = [25, 50, 100, 250, 500, 1000]

// A throw while rendering used to leave a half-built table and no explanation —
// the grid looked present but had no rows, and nothing said why.
window.addEventListener('error', event => {
  showError(`The table view hit an error and stopped rendering.\n\n${event.message}`)
})
window.addEventListener('unhandledrejection', event => {
  showError(`The table view hit an error and stopped rendering.\n\n${event.reason}`)
})

window.addEventListener('message', event => {
  const message = event.data
  if (message.type === 'init') {
    // Remembered so a window reload can reopen the same source (see extension.ts).
    vscode.setState({ source: message.source })
    renderInfo(message.info)
    dataColumns = message.dataColumns
    renderSchema(message.schema)
  } else if (message.type === 'page') {
    page = message.page
    totalPages = message.totalPages
    rowOffset = message.rowOffset
    rows = message.rows
    state = { ...DEFAULT_STATE, ...message.state }
    renderData()
  } else if (message.type === 'cell') {
    showDetail(message)
  } else if (message.type === 'error') {
    showError(message.message)
  }
})

function renderInfo(info) {
  document.querySelector('#info .fname').textContent = info.fileName
  document.querySelector('#info .meta').textContent = [
    `${info.totalRows} rows`,
    `${info.totalCols} columns`,
    info.fileSize,
    info.codec,
    `created by ${info.createdBy}`,
  ].join(' · ')
}

function renderData() {
  const table = document.getElementById('tbl-data')
  table.replaceChildren()
  closeDetail() // the old selection points at rows that are gone
  highlighted = []
  search.value = '' // a query that filtered the last page would silently blank this one

  renderHead(table)

  const body = table.createTBody()
  rows.forEach((row, index) => {
    const tr = body.insertRow()
    // Search hides rows, so position in the DOM stops matching position in the page.
    tr.dataset.index = String(index)
    addCell(tr, String(rowOffset + index + 1), 'rownum')
    row.forEach((value, j) => {
      const classes = []
      if (value === 'NULL') classes.push('null')
      if (dataColumns[j] && dataColumns[j].numeric) classes.push('num')
      addCell(tr, value, classes.join(' ')).title = value
    })
  })

  renderSortState()
  showNotice('')
  applySearch()

  document.getElementById('pageinfo').textContent = `Page ${page + 1} / ${totalPages}`
  document.getElementById('range').textContent = rows.length
    ? `showing rows ${rowOffset + 1}–${rowOffset + rows.length}`
    : 'no rows'
  renderPageSize()
  document.getElementById('prev').disabled = page === 0
  document.getElementById('next').disabled = page >= totalPages - 1
}

// ── rows per page ────────────────────────────────────────────────────────────

function renderPageSize() {
  const setting = state.pageSizeSetting
  const choices = PAGE_SIZE_CHOICES.includes(setting)
    ? PAGE_SIZE_CHOICES
    : [...PAGE_SIZE_CHOICES, setting].sort((a, b) => a - b)

  // Rebuilt rather than patched, so repeated renders cannot pile up stray options.
  pageSizePick.replaceChildren(...choices.map(n => {
    const option = document.createElement('option')
    option.value = String(n)
    option.textContent = String(n)
    return option
  }))
  pageSizePick.value = String(setting)

  // The picker shows what was asked for; this says what a wide file could actually take.
  document.getElementById('pagesize').textContent =
    state.pageSize === setting
      ? ''
      : `showing ${state.pageSize} — capped for ${dataColumns.length} columns`
}

// ── header and sorting ───────────────────────────────────────────────────────

function renderHead(table) {
  const head = table.createTHead()
  const nameRow = head.insertRow()
  const typeRow = head.insertRow()
  addCell(nameRow, '#', 'rownum')
  addCell(typeRow, '', 'rownum')

  dataColumns.forEach((column, index) => {
    const cell = addCell(nameRow, column.name, column.numeric ? 'num' : '')
    // Empty when the column can be sorted; otherwise the sentence to show the user.
    const blocked = !state.sortable
      ? state.sortDisabledReason || DEFAULT_STATE.sortDisabledReason
      : column.sortable
        ? ''
        : column.unsortableReason || 'This column cannot be sorted.'

    if (blocked) {
      // Three channels, because a title alone is invisible until you hover and wait:
      // the cursor says it now, the click says why, the title stays for the patient.
      cell.classList.add('unsortable')
      cell.title = blocked
    } else {
      cell.classList.add('sortable')
      cell.dataset.col = String(index)
      cell.title = `Sort by ${column.name}`
      if (state.sort && state.sort.column === index) {
        cell.classList.add('sorted')
        const arrow = document.createElement('span')
        arrow.className = 'arrow'
        arrow.textContent = state.sort.dir === 'asc' ? '▲' : '▼'
        cell.append(' ', arrow)
      }
    }
    addCell(typeRow, column.type, 'type' + (column.numeric ? ' num' : ''))
  })
}

/** Answers an action that did nothing, in the one place the user is already looking. */
let noticeTimer = null

function showNotice(text) {
  const notice = document.getElementById('notice')
  notice.textContent = text
  notice.classList.toggle('hidden', !text)
  clearTimeout(noticeTimer)
  if (text) noticeTimer = setTimeout(() => showNotice(''), 8000)
}

function renderSortState() {
  const label = document.getElementById('sortstate')
  const clear = document.getElementById('sortclear')
  const column = state.sort ? dataColumns[state.sort.column] : null
  label.textContent = column ? `sorted by ${column.name}, ${state.sort.dir}` : ''
  clear.classList.toggle('hidden', !state.sort)
}

/** asc → desc → back to file order. */
function cycleSort(column) {
  if (!state.sort || state.sort.column !== column) return requestSort(column, 'asc')
  if (state.sort.dir === 'asc') return requestSort(column, 'desc')
  requestSort(null, 'asc')
}

function requestSort(column, dir) {
  vscode.postMessage({ type: 'sort', column, dir })
}

// ── search within the current page ───────────────────────────────────────────
// Purely local: no message crosses to the extension, and no byte is read.

// Highlighting rewrites cell contents, so a query matching most of the page is
// filtered but left unmarked rather than made to feel slow.
const HIGHLIGHT_ROW_CAP = 300

function applySearch() {
  const table = document.getElementById('tbl-data')
  const body = table.tBodies[0]
  if (!body) return

  clearHighlight()
  const query = search.value.trim().toLowerCase()
  const matched = []

  for (const tr of body.rows) {
    const row = rows[Number(tr.dataset.index)]
    const hit = !query || row.some(value => value.toLowerCase().includes(query))
    tr.classList.toggle('filtered-out', !hit)
    if (hit && query) matched.push(tr)
  }

  if (query && matched.length <= HIGHLIGHT_ROW_CAP) {
    for (const tr of matched) highlightRow(tr, query)
  }

  document.getElementById('searchcount').textContent = query
    ? `${matched.length} of ${rows.length} rows on this page`
    : ''
}

function highlightRow(tr, query) {
  const row = rows[Number(tr.dataset.index)]
  for (let i = 1; i < tr.cells.length; i++) {
    if (highlightCell(tr.cells[i], row[i - 1], query)) highlighted.push(tr.cells[i])
  }
}

/** Builds the marked-up cell out of text nodes — never innerHTML, the values are untrusted. */
function highlightCell(cell, value, query) {
  const haystack = value.toLowerCase()
  const parts = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(query, from)
    if (at === -1) break
    if (at > from) parts.push(document.createTextNode(value.slice(from, at)))
    const hit = document.createElement('mark')
    hit.textContent = value.slice(at, at + query.length)
    parts.push(hit)
    from = at + query.length
  }
  if (!parts.length) return false
  if (from < value.length) parts.push(document.createTextNode(value.slice(from)))
  cell.replaceChildren(...parts)
  return true
}

function clearHighlight() {
  for (const cell of highlighted) {
    cell.textContent = rows[Number(cell.parentElement.dataset.index)][cell.cellIndex - 1]
  }
  highlighted = []
}

// ── schema tab ───────────────────────────────────────────────────────────────

function renderSchema(columns) {
  const table = document.getElementById('tbl-schema')
  table.replaceChildren()

  const head = table.createTHead().insertRow()
  for (const label of ['Column', 'Type', 'Logical', 'Null?', 'Nulls', 'Min', 'Max', 'Size']) {
    addCell(head, label)
  }

  const body = table.createTBody()
  for (const column of columns) {
    const tr = body.insertRow()
    addCell(tr, column.name)
    addCell(tr, column.physical, 'type')
    addCell(tr, column.logical, 'type')
    addCell(tr, column.nullable ? 'yes' : 'no', 'dim')
    addCell(tr, column.nullCount, 'num')
    const align = column.numeric ? 'num' : ''
    addCell(tr, column.min, align).title = column.min
    addCell(tr, column.max, align).title = column.max
    addCell(tr, column.compressed, 'num')
  }
}

// ── cell detail ──────────────────────────────────────────────────────────────
// Grid cells hold a shortened value; the full one is fetched per click so a page
// of nested columns never has to cross postMessage in one piece.

function openDetail(cell) {
  // Counted within the view, not the file: after a sort those are different rows.
  const row = rowOffset + Number(cell.parentElement.dataset.index)
  const col = cell.cellIndex - 1 // column 0 is the row number

  if (selectedCell) selectedCell.classList.remove('selected')
  selectedCell = cell
  cell.classList.add('selected')

  detailValue = ''
  document.getElementById('detail').classList.remove('hidden')
  document.getElementById('detail-title').textContent =
    `${dataColumns[col].name} · row ${row + 1}`
  document.getElementById('detail-body').textContent = 'Loading…'
  vscode.postMessage({ type: 'requestCell', row, col })
}

function showDetail(message) {
  // A late reply for a cell the user already navigated away from.
  if (!selectedCell) return
  detailValue = message.value
  document.getElementById('detail-title').textContent =
    `${message.column} · row ${message.row + 1}`
  document.getElementById('detail-body').textContent = message.value
}

function closeDetail() {
  if (selectedCell) selectedCell.classList.remove('selected')
  selectedCell = null
  detailValue = ''
  document.getElementById('detail').classList.add('hidden')
}

// ── wiring ───────────────────────────────────────────────────────────────────

document.getElementById('tbl-data').addEventListener('click', event => {
  const header = event.target.closest('thead td')
  if (header) {
    if (header.classList.contains('sortable')) cycleSort(Number(header.dataset.col))
    // Clicking a column that cannot be sorted used to do nothing at all, which reads
    // as a broken header rather than a deliberate limit.
    else if (header.classList.contains('unsortable')) showNotice(header.title)
    return
  }
  const cell = event.target.closest('tbody td')
  if (!cell || cell.cellIndex === 0) return
  openDetail(cell)
})

pageSizePick.addEventListener('change', () => {
  vscode.postMessage({ type: 'pageSize', value: Number(pageSizePick.value) })
})

search.addEventListener('input', applySearch)

search.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !search.value) return
  search.value = ''
  applySearch()
  event.stopPropagation() // this Escape cleared the box; it must not also close the detail pane
})

document.getElementById('sortclear').addEventListener('click', () => requestSort(null, 'asc'))

document.getElementById('detail-close').addEventListener('click', closeDetail)

document.getElementById('detail-copy').addEventListener('click', event => {
  if (!detailValue) return
  vscode.postMessage({ type: 'copy', text: detailValue })
  const button = event.currentTarget
  button.textContent = 'Copied'
  setTimeout(() => (button.textContent = 'Copy'), 1200)
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeDetail()
})

// textContent, never innerHTML — cell values come from an untrusted file.
function addCell(row, text, className) {
  const cell = row.insertCell()
  cell.textContent = text
  if (className) cell.className = className
  return cell
}

function showError(message) {
  const box = document.createElement('div')
  box.className = 'error'
  box.textContent = message
  document.querySelector('main').replaceChildren(box)
  closeDetail()
  document.getElementById('pager').classList.add('hidden')
  document.getElementById('tabs').classList.add('hidden')
}

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => {
    const showData = button.dataset.tab === 'data'
    for (const other of document.querySelectorAll('.tab')) {
      other.classList.toggle('active', other === button)
    }
    document.getElementById('pane-data').classList.toggle('hidden', !showData)
    document.getElementById('pane-schema').classList.toggle('hidden', showData)
    document.getElementById('pager').classList.toggle('hidden', !showData)
    if (!showData) closeDetail()
  })
}

document.getElementById('prev').addEventListener('click', () => {
  vscode.postMessage({ type: 'requestPage', page: page - 1 })
})
document.getElementById('next').addEventListener('click', () => {
  vscode.postMessage({ type: 'requestPage', page: page + 1 })
})

vscode.postMessage({ type: 'ready' })
