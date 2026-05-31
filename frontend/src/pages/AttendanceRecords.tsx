import { useEffect, useMemo, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import {
  fetchAccessEvents,
  fetchDepartmentTree,
  type AccessEvent,
  type DepartmentNode,
} from '../services/accessEvents'

// ── date helpers ──────────────────────────────────────────────────────────────

type RangePreset = 'today' | 'last3d' | 'last7d' | 'thisMonth' | 'last3m' | 'custom'

const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'today',     label: '今天' },
  { key: 'last3d',    label: '近3天' },
  { key: 'last7d',    label: '近7天' },
  { key: 'thisMonth', label: '本月' },
  { key: 'last3m',    label: '3個月內' },
  { key: 'custom',    label: '自定義' },
]

function toDateStr(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function daysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n); return toDateStr(d)
}

function monthsAgo(n: number) {
  const d = new Date(); d.setMonth(d.getMonth() - n); return toDateStr(d)
}

function startOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function addMonths(dateStr: string, n: number) {
  const d = new Date(dateStr); d.setMonth(d.getMonth() + n); return toDateStr(d)
}

function resolveRange(preset: RangePreset, cFrom: string, cTo: string) {
  const today = toDateStr()
  switch (preset) {
    case 'today':     return { from: today, to: today }
    case 'last3d':    return { from: daysAgo(3), to: today }
    case 'last7d':    return { from: daysAgo(7), to: today }
    case 'thisMonth': return { from: startOfMonth(), to: today }
    case 'last3m':    return { from: monthsAgo(3), to: today }
    case 'custom':    return { from: cFrom, to: cTo }
  }
}

function flattenDepts(nodes: DepartmentNode[], depth = 0): { id: string; name: string; depth: number }[] {
  return nodes.flatMap((n) => [{ id: n.departmentId, name: n.name, depth }, ...flattenDepts(n.children ?? [], depth + 1)])
}

function formatDateTime(value: string) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value || '-'
  return d.toLocaleString('zh-TW', { hour12: false })
}

const PAGE_SIZE = 20

// ── component ─────────────────────────────────────────────────────────────────

function AttendanceRecords() {
  const [rangePreset, setRangePreset] = useState<RangePreset>('last7d')
  const [customFrom, setCustomFrom] = useState(daysAgo(7))
  const [customTo, setCustomTo] = useState(toDateStr)
  const [departmentId, setDepartmentId] = useState('ALL')
  const [deptOptions, setDeptOptions] = useState<{ id: string; name: string; depth: number }[]>([])
  const [direction, setDirection] = useState<'IN' | 'OUT' | 'ALL'>('ALL')
  const [decision, setDecision] = useState<'GRANTED' | 'DENIED' | 'ALL'>('ALL')
  const [keyword, setKeyword] = useState('')

  const [events, setEvents] = useState<AccessEvent[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const today = toDateStr()
  const range = useMemo(() => resolveRange(rangePreset, customFrom, customTo), [rangePreset, customFrom, customTo])
  const maxTo = addMonths(customFrom, 3) < today ? addMonths(customFrom, 3) : today

  // load dept options once
  useEffect(() => {
    fetchDepartmentTree().then((tree) => setDeptOptions(flattenDepts(tree))).catch(() => {})
  }, [])

  // fetch events when filters or page changes
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchAccessEvents({
          from: range.from,
          to: range.to,
          departmentId: departmentId !== 'ALL' ? departmentId : undefined,
          direction: direction !== 'ALL' ? direction : undefined,
          decision: decision !== 'ALL' ? decision : undefined,
          limit: PAGE_SIZE,
          offset,
        })
        if (!cancelled) {
          setEvents(result.events)
          setTotal(result.total)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '載入失敗')
          setEvents([])
          setTotal(0)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [range.from, range.to, departmentId, direction, decision, offset])

  const handlePreset = (p: RangePreset) => { setRangePreset(p); setOffset(0) }
  const handleDirection = (v: 'IN' | 'OUT' | 'ALL') => { setDirection(v); setOffset(0) }
  const handleDecision = (v: 'GRANTED' | 'DENIED' | 'ALL') => { setDecision(v); setOffset(0) }
  const handleDept = (v: string) => { setDepartmentId(v); setOffset(0) }

  const handleDownloadCsv = () => {
    const params = new URLSearchParams()
    params.set('from', new Date(`${range.from}T00:00:00`).toISOString())
    params.set('to', new Date(`${range.to}T23:59:59`).toISOString())
    if (departmentId !== 'ALL') params.set('departmentId', departmentId)
    if (direction !== 'ALL') params.set('direction', direction)
    if (decision !== 'ALL') params.set('decision', decision)
    if (keyword.trim()) params.set('q', keyword.trim())
    const link = document.createElement('a')
    link.href = `/api/reports/export/events.csv?${params.toString()}`
    link.download = `swipe-records-${range.from}-to-${range.to}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const filteredEvents = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return events
    return events.filter(
      (e) =>
        e.employeeId.toLowerCase().includes(q) ||
        (e.displayName?.toLowerCase().includes(q) ?? false) ||
        (e.departmentId?.toLowerCase().includes(q) ?? false) ||
        e.gateId.toLowerCase().includes(q),
    )
  }, [events, keyword])

  return (
    <AppShell title="刷卡記錄" subtitle="門禁刷卡事件明細查詢">
      {/* ── Filters ── */}
      <section className="panel-card mb-3">
        <div className="reports-toolbar">
          <div>
            <h2 className="h6 mb-1">篩選條件</h2>
            <div className="small text-secondary">設定條件後點擊下載</div>
          </div>
          <button className="btn btn-primary px-4" type="button" onClick={handleDownloadCsv}>
            下載刷卡記錄
          </button>
        </div>

        <div className="row g-3 mt-1">
          {/* Time range */}
          <div className="col-12">
            <label className="form-label">時間範圍</label>
            <div className="d-flex flex-wrap gap-2">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`btn btn-sm ${rangePreset === p.key ? 'btn-primary' : 'btn-outline-secondary'}`}
                  onClick={() => handlePreset(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {rangePreset === 'custom' && (
              <div className="d-flex gap-2 align-items-center mt-2 flex-wrap">
                <input
                  type="date"
                  className="form-control form-control-sm w-auto"
                  value={customFrom}
                  max={customTo}
                  onChange={(e) => {
                    const v = e.target.value
                    setCustomFrom(v)
                    if (customTo > addMonths(v, 3)) setCustomTo(addMonths(v, 3) < today ? addMonths(v, 3) : today)
                    setOffset(0)
                  }}
                />
                <span className="text-secondary small">至</span>
                <input
                  type="date"
                  className="form-control form-control-sm w-auto"
                  value={customTo}
                  min={customFrom}
                  max={maxTo}
                  onChange={(e) => { setCustomTo(e.target.value); setOffset(0) }}
                />
                <span className="text-secondary small">（區間最大 3 個月）</span>
              </div>
            )}
            {rangePreset !== 'custom' && (
              <div className="small text-secondary mt-1">{range.from} 至 {range.to}</div>
            )}
          </div>

          {/* Department single-select */}
          <div className="col-md-3">
            <label className="form-label" htmlFor="ar-dept">部門</label>
            <select id="ar-dept" className="form-select" value={departmentId} onChange={(e) => handleDept(e.target.value)}>
              <option value="ALL">全部部門</option>
              {deptOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {' '.repeat(d.depth * 2)}{d.name} ({d.id})
                </option>
              ))}
            </select>
          </div>

          {/* Direction */}
          <div className="col-md-3">
            <label className="form-label">方向</label>
            <div className="d-flex gap-2">
              {(['ALL', 'IN', 'OUT'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`btn btn-sm ${direction === v ? 'btn-primary' : 'btn-outline-secondary'}`}
                  onClick={() => handleDirection(v)}
                >
                  {v === 'ALL' ? '全部' : v}
                </button>
              ))}
            </div>
          </div>

          {/* Decision */}
          <div className="col-md-3">
            <label className="form-label">結果</label>
            <div className="d-flex gap-2">
              {(['ALL', 'GRANTED', 'DENIED'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`btn btn-sm ${
                    decision === v
                      ? v === 'DENIED' ? 'btn-danger' : 'btn-primary'
                      : v === 'DENIED' ? 'btn-outline-danger' : 'btn-outline-secondary'
                  }`}
                  onClick={() => handleDecision(v)}
                >
                  {v === 'ALL' ? '全部' : v === 'GRANTED' ? '通行' : '拒絕'}
                </button>
              ))}
            </div>
          </div>

          {/* Keyword */}
          <div className="col-md-3">
            <label className="form-label" htmlFor="ar-keyword">搜尋</label>
            <input
              id="ar-keyword"
              className="form-control"
              placeholder="員工編號、姓名、門禁、部門"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
        </div>
      </section>

      {/* ── Table ── */}
      <section className="panel-card">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h2 className="h6 m-0">事件明細</h2>
          <span className="small text-secondary">共 {total.toLocaleString()} 筆</span>
        </div>
        <div className="table-responsive">
          <table className="table-clean">
            <thead>
              <tr>
                <th>時間</th>
                <th>員工</th>
                <th>部門</th>
                <th>門禁</th>
                <th>方向</th>
                <th>結果</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-secondary text-center py-4">載入中...</td></tr>
              ) : error ? (
                <tr><td colSpan={7} className="text-danger">{error}</td></tr>
              ) : filteredEvents.length === 0 ? (
                <tr><td colSpan={7} className="text-secondary text-center py-4">這段期間沒有符合條件的事件</td></tr>
              ) : (
                filteredEvents.map((event) => (
                  <tr key={event.requestId}>
                    <td>{formatDateTime(event.timestamp)}</td>
                    <td>
                      <strong>{event.displayName || event.employeeId}</strong>
                      <div className="table-subtext">{event.employeeId}</div>
                    </td>
                    <td>{event.departmentId || '-'}</td>
                    <td>{event.gateId}</td>
                    <td>
                      <span className={event.direction === 'IN' ? 'status-pill status-pill-in' : 'status-pill status-pill-out'}>
                        {event.direction}
                      </span>
                    </td>
                    <td className={event.decision === 'DENIED' ? 'danger-text' : undefined}>
                      {event.decision === 'GRANTED' ? '通行' : '拒絕'}
                    </td>
                    <td className="small text-secondary">{event.reason}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {!loading && !error && total > PAGE_SIZE && (
          <div className="d-flex justify-content-between align-items-center mt-2 small text-secondary">
            <span>第 {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} 筆，共 {total.toLocaleString()} 筆</span>
            <div className="d-flex gap-2">
              <button className="btn btn-sm btn-outline-secondary" type="button" disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>← 上一頁</button>
              <button className="btn btn-sm btn-outline-secondary" type="button" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset((o) => o + PAGE_SIZE)}>下一頁 →</button>
            </div>
          </div>
        )}
      </section>
    </AppShell>
  )
}

export default AttendanceRecords
