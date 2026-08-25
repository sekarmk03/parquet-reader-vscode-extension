import * as vscode from 'vscode'
import { ParquetHandle, buildInfo, buildSchema, openParquet } from './parquet'
import { openSource, sourceLabel } from './source'
import {
  RowView,
  buildSortedView,
  effectivePageSize,
  identityView,
  readViewCell,
  readViewPage,
  sortRefusal,
  totalPages,
} from './view'
import type { FromWebview, SortState, ToWebview, ViewState } from './types'

/** Both settings live under one section so a single change event covers them. */
function readSettings() {
  const config = vscode.workspace.getConfiguration('parquetReader')
  return {
    pageSize: config.get<number>('pageSize', 100),
    sortCellBudget: config.get<number>('sortCellBudget', 500_000),
  }
}

/**
 * Wires one webview panel to one parquet source — a local path or a remote URL.
 * The panel never learns which it is.
 */
export async function attachPanel(
  source: string,
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
): Promise<void> {
  const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media')
  panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] }
  panel.webview.html = buildHtml(panel.webview, mediaRoot)

  let handle: ParquetHandle | undefined
  let view: RowView | undefined
  let page = 0
  /** The size the page on screen was built with, so a change can keep the same first row. */
  let shownPageSize = 0
  const post = (message: ToWebview) => panel.webview.postMessage(message)

  const describeState = (): ViewState => {
    const settings = readSettings()
    const columns = handle?.dataColumns.length ?? 1
    const reason = handle ? sortRefusal(handle, settings.sortCellBudget) : undefined
    return {
      pageSize: effectivePageSize(settings.pageSize, columns),
      pageSizeSetting: settings.pageSize,
      sortable: reason === undefined,
      sortDisabledReason: reason,
      sort: view?.kind === 'materialized' ? view.sort : null,
    }
  }

  const sendPage = async (requested: number) => {
    if (!handle || !view) return
    const state = describeState()
    const pages = totalPages(view, state.pageSize)
    page = Math.min(Math.max(0, requested), pages - 1)
    shownPageSize = state.pageSize
    post({
      type: 'page',
      rows: await readViewPage(handle, view, page, state.pageSize),
      page,
      totalPages: pages,
      rowOffset: page * state.pageSize,
      state,
    })
  }

  // A different page size changes which rows belong on the current page, so the page
  // is redrawn — landing on whichever page now holds the row that was at the top.
  const settingsWatcher = vscode.workspace.onDidChangeConfiguration(async event => {
    if (!event.affectsConfiguration('parquetReader') || !handle) return
    try {
      const firstRow = page * shownPageSize
      const next = describeState()
      // Sorting may have just been forbidden by a lower budget; fall back to file order.
      if (view?.kind === 'materialized' && !next.sortable) {
        view = identityView(handle)
        page = 0
      } else {
        page = Math.floor(firstRow / next.pageSize)
      }
      await sendPage(page)
    } catch (error) {
      post({ type: 'error', message: describeError(error) })
    }
  })
  panel.onDidDispose(() => settingsWatcher.dispose())

  panel.webview.onDidReceiveMessage(async (message: FromWebview) => {
    try {
      if (message.type === 'ready') {
        handle = await openParquet(await openSource(source))
        view = identityView(handle)
        post({
          type: 'init',
          source,
          info: buildInfo(handle, sourceLabel(source)),
          dataColumns: handle.dataColumns,
          schema: buildSchema(handle),
        })
        await sendPage(0)
      } else if (message.type === 'requestPage') {
        await sendPage(message.page)
      } else if (message.type === 'pageSize') {
        // Writing the setting is the whole action: the change event redraws the page.
        await savePageSize(message.value)
      } else if (message.type === 'sort') {
        if (!handle) return
        view = await resolveSort(handle, message, describeState())
        await sendPage(0)
      } else if (message.type === 'requestCell') {
        if (!handle || !view) return
        const column = handle.dataColumns[message.col]
        if (!column) return
        post({
          type: 'cell',
          row: message.row,
          col: message.col,
          column: column.name,
          value: await readViewCell(handle, view, message.row, message.col),
        })
      } else if (message.type === 'copy') {
        // The host clipboard works regardless of webview focus rules.
        await vscode.env.clipboard.writeText(message.text)
      }
    } catch (error) {
      post({ type: 'error', message: describeError(error) })
    }
  })
}

/**
 * Writes back to wherever the value is already defined, so a workspace override is
 * updated in place rather than shadowed by a user-level one that never takes effect.
 */
async function savePageSize(value: number): Promise<void> {
  const config = vscode.workspace.getConfiguration('parquetReader')
  const declared = config.inspect<number>('pageSize')
  const target =
    declared?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : declared?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
  await config.update('pageSize', value, target)
}

/**
 * The webview disables what it must not offer, but it is a separate process:
 * every guard is re-checked here before a whole file is pulled into memory.
 */
async function resolveSort(
  handle: ParquetHandle,
  request: { column: number | null; dir: 'asc' | 'desc' },
  state: ViewState,
): Promise<RowView> {
  if (request.column === null) return identityView(handle)
  const column = handle.dataColumns[request.column]
  if (!column?.sortable || !state.sortable) return identityView(handle)
  const sort: SortState = { column: request.column, dir: request.dir }
  return buildSortedView(handle, sort)
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/magic|PAR1|not a parquet/i.test(raw)) {
    return `Not a valid Parquet file — the PAR1 magic bytes are missing.\n\n${raw}`
  }
  if (/unsupported compression|codec/i.test(raw)) {
    return `Unsupported compression codec.\n\n${raw}`
  }
  return raw
}

/**
 * Tab icons, inline rather than an icon font: the webview CSP is `default-src 'none'`,
 * and `currentColor` keeps them in step with the active/inactive tab colour.
 */
const ICON_TABLE = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="1.2"><rect x="1.6" y="2.6" width="12.8" height="10.8"
  rx="1.2"/><path d="M1.6 6.2h12.8M6.4 6.2v7.2"/></svg>`

const ICON_LIST = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="1.2"><path d="M6.2 3.8h8M6.2 8h8M6.2 12.2h8"
  stroke-linecap="round"/><circle cx="3" cy="3.8" r="1" fill="currentColor" stroke="none"/><circle
  cx="3" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="12.2" r="1"
  fill="currentColor" stroke="none"/></svg>`

function buildHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file))
  const nonce = randomNonce()

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('style.css')}">
<title>Parquet Table</title>
</head>
<body>
  <header id="info">
    <div class="fname">Loading…</div>
    <div class="meta"></div>
  </header>

  <nav id="tabs">
    <button class="tab active" data-tab="data" type="button">${ICON_TABLE}<span>Data</span></button>
    <button class="tab" data-tab="schema" type="button">${ICON_LIST}<span>Schema</span></button>
  </nav>

  <main>
    <div id="pane-data" class="pane">
      <div id="toolbar">
        <input id="search" type="search" placeholder="Search this page…" spellcheck="false"
               autocomplete="off" aria-label="Search the rows on this page">
        <span id="searchcount" class="dim"></span>
        <span class="spacer"></span>
        <span id="notice" class="hidden"></span>
        <span id="sortstate" class="dim"></span>
        <button id="sortclear" class="hidden" type="button">Clear sort</button>
      </div>
      <div class="scroll"><table id="tbl-data"></table></div>
    </div>
    <div id="pane-schema" class="pane hidden"><div class="scroll"><table id="tbl-schema"></table></div></div>
  </main>

  <section id="detail" class="hidden">
    <div class="detail-head">
      <span id="detail-title"></span>
      <span class="spacer"></span>
      <button id="detail-copy" type="button">Copy</button>
      <button id="detail-close" type="button" title="Esc">✕</button>
    </div>
    <pre id="detail-body"></pre>
  </section>

  <footer id="pager">
    <button id="prev" type="button" disabled>◀ Prev</button>
    <span id="pageinfo" class="dim"></span>
    <button id="next" type="button" disabled>Next ▶</button>
    <span id="range" class="dim"></span>
    <span class="spacer"></span>
    <span id="pagesize" class="dim"></span>
    <label id="rowsperpage">Rows per page
      <select id="pagesizepick" aria-label="Rows per page"></select>
    </label>
  </footer>

  <script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  ;(globalThis.crypto as Crypto).getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
