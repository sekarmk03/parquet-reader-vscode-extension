// Dumb renderer: everything arriving here is already a display-ready string.
const vscode = acquireVsCodeApi()

let dataColumns = []
let page = 0
let totalPages = 1
let rowOffset = 0
let selectedCell = null // the <td> whose full value the detail pane is showing
let detailValue = ''

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
    renderData(message.rows, message.rowOffset)
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

function renderData(rows, rowOffset) {
  const table = document.getElementById('tbl-data')
  table.replaceChildren()
  closeDetail() // the old selection points at rows that are gone

  const head = table.createTHead()
  const nameRow = head.insertRow()
  const typeRow = head.insertRow()
  addCell(nameRow, '#', 'rownum')
  addCell(typeRow, '', 'rownum')
  for (const column of dataColumns) {
    addCell(nameRow, column.name, column.numeric ? 'num' : '')
    addCell(typeRow, column.type, 'type' + (column.numeric ? ' num' : ''))
  }

  const body = table.createTBody()
  rows.forEach((row, i) => {
    const tr = body.insertRow()
    addCell(tr, String(rowOffset + i + 1), 'rownum')
    row.forEach((value, j) => {
      const classes = []
      if (value === 'NULL') classes.push('null')
      if (dataColumns[j] && dataColumns[j].numeric) classes.push('num')
      addCell(tr, value, classes.join(' ')).title = value
    })
  })

  document.getElementById('pageinfo').textContent = `Page ${page + 1} / ${totalPages}`
  document.getElementById('range').textContent = rows.length
    ? `showing rows ${rowOffset + 1}–${rowOffset + rows.length}`
    : 'no rows'
  document.getElementById('prev').disabled = page === 0
  document.getElementById('next').disabled = page >= totalPages - 1
}

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
  const row = rowOffset + cell.parentElement.sectionRowIndex
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

document.getElementById('tbl-data').addEventListener('click', event => {
  const cell = event.target.closest('td')
  if (!cell || cell.closest('tbody') === null || cell.cellIndex === 0) return
  openDetail(cell)
})

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
