import { useState } from 'react'
import AppShell from '../../components/layout/AppShell'
import { type AccessEvent, fetchAccessEvents } from '../../services/accessEvents'

type ReportFormat = 'CSV' | 'PDF'

function localDateInputValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function csvEscape(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

function htmlEscape(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? '' : String(value)
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function toCsv(events: AccessEvent[]) {
  const headers = [
    'requestId',
    'employeeId',
    'displayName',
    'departmentId',
    'gateId',
    'direction',
    'decision',
    'reason',
    'previousState',
    'currentState',
    'latencyMs',
    'timestamp',
    'consumedAt',
  ]

  const rows = events.map((event) =>
    [
      event.requestId,
      event.employeeId,
      event.displayName,
      event.departmentId,
      event.gateId,
      event.direction,
      event.decision,
      event.reason,
      event.previousState,
      event.currentState,
      event.latencyMs,
      event.timestamp,
      event.consumedAt,
    ]
      .map(csvEscape)
      .join(','),
  )

  return [headers.join(','), ...rows].join('\n')
}

function buildPrintableReport(events: AccessEvent[], from: string, to: string, departmentId: string) {
  const generatedAt = new Date().toLocaleString()
  const rows =
    events.length > 0
      ? events
          .map(
            (event) => `
              <tr>
                <td>${htmlEscape(event.timestamp)}</td>
                <td>${htmlEscape(event.employeeId)}</td>
                <td>${htmlEscape(event.displayName)}</td>
                <td>${htmlEscape(event.departmentId)}</td>
                <td>${htmlEscape(event.gateId)}</td>
                <td>${htmlEscape(event.direction)}</td>
                <td>${htmlEscape(event.decision)}</td>
                <td>${htmlEscape(event.reason)}</td>
                <td>${htmlEscape(event.latencyMs)}</td>
              </tr>
            `,
          )
          .join('')
      : '<tr><td colspan="9" class="empty">No events matched the selected filters.</td></tr>'

  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <title>Access Events Report</title>
    <style>
      body { color: #172033; font-family: Arial, "Noto Sans TC", sans-serif; margin: 28px; }
      h1 { font-size: 22px; margin: 0 0 8px; }
      .meta { color: #5f6b7a; font-size: 12px; margin-bottom: 20px; }
      table { border-collapse: collapse; font-size: 10px; width: 100%; }
      th, td { border: 1px solid #cfd6df; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #edf2f7; color: #253044; }
      .empty { color: #5f6b7a; padding: 18px; text-align: center; }
      @media print {
        body { margin: 14mm; }
      }
    </style>
  </head>
  <body>
    <h1>Access Events Report</h1>
    <div class="meta">
      Date range: ${htmlEscape(from)} to ${htmlEscape(to)} | Department: ${htmlEscape(departmentId)} | Rows: ${events.length} | Generated: ${htmlEscape(generatedAt)}
    </div>
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Employee ID</th>
          <th>Name</th>
          <th>Department</th>
          <th>Gate</th>
          <th>Direction</th>
          <th>Decision</th>
          <th>Reason</th>
          <th>Latency ms</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <script>
      window.addEventListener('load', () => {
        setTimeout(() => window.print(), 250)
      })
    </script>
  </body>
</html>`
}

function Reports() {
  const [from, setFrom] = useState('2026-05-01')
  const [to, setTo] = useState(() => localDateInputValue(new Date()))
  const [departmentId, setDepartmentId] = useState('ALL')
  const [format, setFormat] = useState<ReportFormat>('CSV')
  const [isDownloading, setIsDownloading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const downloadReport = async () => {
    setIsDownloading(true)
    setMessage(null)
    const printWindow = format === 'PDF' ? window.open('', '_blank') : null

    try {
      if (format === 'PDF' && !printWindow) {
        throw new Error('瀏覽器封鎖了 PDF 視窗，請允許彈出視窗後再試一次。')
      }

      const result = await fetchAccessEvents({
        from,
        to,
        departmentId,
        limit: 200,
        offset: 0,
      })
      const deptPart = departmentId === 'ALL' ? 'all' : departmentId.toLowerCase()

      if (format === 'PDF') {
        printWindow?.document.open()
        printWindow?.document.write(buildPrintableReport(result.events, from, to, departmentId))
        printWindow?.document.close()
        setMessage(`已開啟 PDF 列印視窗，共 ${result.events.length} 筆資料。`)
        return
      }

      const csv = toCsv(result.events)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `access-events-${deptPart}-${from}-to-${to}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setMessage(`已下載 CSV，共 ${result.events.length} 筆資料。`)
    } catch (error) {
      printWindow?.close()
      setMessage(error instanceof Error ? error.message : '下載失敗')
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <AppShell title="報表中心" subtitle="出勤報表匯出與下載">
      <section className="panel-card">
        <h2 className="h6 mb-3">報表下載</h2>
        <div className="row g-3 align-items-end">
          <div className="col-md-3">
            <label className="form-label">起始日期</label>
            <input className="form-control" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <div className="col-md-3">
            <label className="form-label">結束日期</label>
            <input className="form-control" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <div className="col-md-3">
            <label className="form-label">部門</label>
            <select className="form-select" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="ALL">全部部門</option>
              <option value="FAB_A">FAB_A</option>
              <option value="FAB_B">FAB_B</option>
              <option value="FAB_C">FAB_C</option>
              <option value="OPS_A">OPS_A</option>
              <option value="SECURITY">SECURITY</option>
            </select>
          </div>
          <div className="col-md-3">
            <label className="form-label">格式</label>
            <select className="form-select" value={format} onChange={(event) => setFormat(event.target.value as ReportFormat)}>
              <option value="CSV">CSV</option>
              <option value="PDF">PDF</option>
            </select>
          </div>
          <div className="col-12 d-flex justify-content-end">
            <button className="btn btn-primary px-4" type="button" onClick={downloadReport} disabled={isDownloading}>
              {isDownloading ? '下載中...' : '下載報表'}
            </button>
          </div>
          {message && <div className="col-12 small text-secondary text-end">{message}</div>}
        </div>
      </section>
    </AppShell>
  )
}

export default Reports
