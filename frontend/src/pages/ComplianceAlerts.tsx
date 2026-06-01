import { useEffect, useMemo, useState } from 'react'
import AppShell from '../components/layout/AppShell'
import { fetchComplianceAnomalies, fetchDepartmentTree, updateComplianceAnomalyRemark, type ComplianceAnomaly, type DepartmentNode } from '../services/accessEvents'

function flattenDepts(nodes: DepartmentNode[], depth = 0): { id: string; name: string; depth: number }[] {
  return nodes.flatMap((n) => [{ id: n.departmentId, name: n.name, depth }, ...flattenDepts(n.children ?? [], depth + 1)])
}

function formatDateTime(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value || '-'
  return parsed.toLocaleString('zh-TW', { hour12: false })
}

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
    case 'today':     return { from: `${today}T00:00:00`, to: `${today}T23:59:59`, days: 1 }
    case 'last3d':    return { from: `${daysAgo(3)}T00:00:00`, to: `${today}T23:59:59`, days: 3 }
    case 'last7d':    return { from: `${daysAgo(7)}T00:00:00`, to: `${today}T23:59:59`, days: 7 }
    case 'thisMonth': return { from: `${startOfMonth()}T00:00:00`, to: `${today}T23:59:59`, days: 31 }
    case 'last3m':    return { from: `${monthsAgo(3)}T00:00:00`, to: `${today}T23:59:59`, days: 91 }
    case 'custom':    return { from: `${cFrom}T00:00:00`, to: `${cTo}T23:59:59`, days: 91 }
  }
}

const PAGE_LIMIT = 100

function ComplianceAlerts() {
  const [rangePreset, setRangePreset] = useState<RangePreset>('last7d')
  const [customFrom, setCustomFrom] = useState(daysAgo(7))
  const [customTo, setCustomTo] = useState(toDateStr)
  const [selectedType, setSelectedType] = useState('denied_access')
  const [selectedDept, setSelectedDept] = useState('ALL')
  const [deptOptions, setDeptOptions] = useState<{ id: string; name: string; depth: number }[]>([])
  const [keyword, setKeyword] = useState('')
  const [alerts, setAlerts] = useState<ComplianceAnomaly[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftNote, setDraftNote] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  const today = toDateStr()
  const range = useMemo(() => resolveRange(rangePreset, customFrom, customTo), [rangePreset, customFrom, customTo])

  useEffect(() => {
    fetchDepartmentTree().then((tree) => setDeptOptions(flattenDepts(tree))).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchComplianceAnomalies(PAGE_LIMIT, selectedDept !== 'ALL' ? selectedDept : undefined, selectedType, range.days, range.from, range.to, page * PAGE_LIMIT)
      .then((result) => {
        if (cancelled) return
        setAlerts(result.items)
        setTotal(result.total)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load compliance anomalies')
        setAlerts([])
        setTotal(0)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range.from, range.to, range.days, selectedType, selectedDept, page])

  const filteredAlerts = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    return alerts.filter((item) => {
      if (item.type !== selectedType) return false
      if (!q) return true
      return (
        item.employeeId.toLowerCase().includes(q) ||
        (item.displayName?.toLowerCase().includes(q) ?? false) ||
        item.departmentId.toLowerCase().includes(q)
      )
    })
  }, [alerts, keyword, selectedType])

  const handleTypeChange = (v: string) => { setSelectedType(v); setPage(0) }
  const handleDeptChange = (v: string) => { setSelectedDept(v); setPage(0) }
  const handlePresetChange = (p: RangePreset) => { setRangePreset(p); setPage(0) }

  const startEdit = (item: ComplianceAnomaly) => { setEditingId(item.id); setDraftNote(item.note) }
  const cancelEdit = () => { setEditingId(null); setDraftNote('') }

  const saveNote = async (id: string) => {
    try {
      setSavingId(id)
      setError(null)
      const result = await updateComplianceAnomalyRemark(id, draftNote)
      setAlerts((prev) => prev.map((item) => (item.id === id ? { ...item, note: result.note } : item)))
      cancelEdit()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '備註更新失敗')
    } finally {
      setSavingId(null)
    }
  }

  const maxTo = addMonths(customFrom, 3) < today ? addMonths(customFrom, 3) : today

  return (
    <AppShell title="異常合規" subtitle="超時工時與高風險出勤事件">
      <section className="panel-card mb-3">
        <h2 className="h6 mb-3">篩選器</h2>
        <div className="row g-3 align-items-end">
          <div className="col-md-3">
            <label className="form-label" htmlFor="compliance-type">異常類型</label>
            <select id="compliance-type" className="form-select" value={selectedType} onChange={(e) => handleTypeChange(e.target.value)}>
              <option value="late_arrival">遲到人員</option>
              <option value="overtime_daily">單日超過 12 小時</option>
              <option value="denied_access">拒絕通行事件</option>
              <option value="unpaired_access">未配對進出紀錄</option>
            </select>
          </div>
          <div className="col-md-3">
            <label className="form-label" htmlFor="compliance-dept">部門</label>
            <select id="compliance-dept" className="form-select" value={selectedDept} onChange={(e) => handleDeptChange(e.target.value)}>
              <option value="ALL">全部部門</option>
              {deptOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {' '.repeat(d.depth * 2)}{d.name} ({d.id})
                </option>
              ))}
            </select>
          </div>
          <div className="col-md-3">
            <label className="form-label" htmlFor="compliance-keyword">員工搜尋</label>
            <input
              id="compliance-keyword"
              className="form-control"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="輸入員工編號、姓名或部門"
            />
          </div>
          <div className="col-12">
            <label className="form-label">時間範圍</label>
            <div className="d-flex flex-wrap gap-2">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`btn btn-sm ${rangePreset === p.key ? 'btn-primary' : 'btn-outline-secondary'}`}
                  onClick={() => handlePresetChange(p.key)}
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
                    setPage(0)
                  }}
                />
                <span className="text-secondary small">至</span>
                <input
                  type="date"
                  className="form-control form-control-sm w-auto"
                  value={customTo}
                  min={customFrom}
                  max={maxTo}
                  onChange={(e) => { setCustomTo(e.target.value); setPage(0) }}
                />
                <span className="text-secondary small">（區間最大 3 個月）</span>
              </div>
            )}
            {rangePreset !== 'custom' && (
              <div className="small text-secondary mt-1">{range.from.slice(0, 10)} 至 {range.to.slice(0, 10)}</div>
            )}
          </div>
        </div>
      </section>

      <section className="panel-card">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h2 className="h6 m-0">異常清單</h2>
          <span className="small text-secondary">共 {total.toLocaleString()} 筆</span>
        </div>
        <div className="table-responsive">
          <table className="table-clean">
            <thead>
              <tr>
                <th>員工</th>
                <th>部門</th>
                <th>異常類型</th>
                <th>異常內容</th>
                <th>發生時間</th>
                <th>備註</th>
                <th className="alert-actions-header">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-secondary text-center py-4">載入中…</td></tr>
              ) : error ? (
                <tr><td colSpan={7} className="text-danger">{error}</td></tr>
              ) : filteredAlerts.length === 0 ? (
                <tr><td colSpan={7} className="text-secondary text-center py-4">目前沒有符合條件的異常資料</td></tr>
              ) : (
                filteredAlerts.map((item) => {
                  const isEditing = editingId === item.id
                  const employeeText = item.displayName?.trim() ? `${item.displayName} (${item.employeeId})` : item.employeeId
                  return (
                    <tr key={item.id}>
                      <td>{employeeText}</td>
                      <td>{item.departmentId}</td>
                      <td className="danger-text">{item.typeLabel}</td>
                      <td className="danger-text">{item.hours}</td>
                      <td>{formatDateTime(item.occurredAt)}</td>
                      <td>
                        <input
                          className="form-control form-control-sm"
                          value={isEditing ? draftNote : item.note}
                          readOnly={!isEditing}
                          onChange={(e) => setDraftNote(e.target.value)}
                        />
                      </td>
                      <td className="alert-actions-cell">
                        {isEditing ? (
                          <>
                            <button className="btn btn-sm btn-primary" type="button" onClick={() => saveNote(item.id)}>
                              {savingId === item.id ? '儲存中…' : '送出'}
                            </button>
                            <button className="btn btn-sm btn-outline-secondary" type="button" onClick={cancelEdit}>取消</button>
                          </>
                        ) : (
                          <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => startEdit(item)}>修改</button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        {!loading && !error && total > 0 && (
          <div className="d-flex justify-content-between align-items-center mt-2 small text-secondary">
            <span>第 {page * PAGE_LIMIT + 1}–{Math.min(page * PAGE_LIMIT + filteredAlerts.length, total)} 筆，共 {total.toLocaleString()} 筆</span>
            <div className="d-flex gap-2">
              <button className="btn btn-sm btn-outline-secondary" type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← 上一頁</button>
              <button className="btn btn-sm btn-outline-secondary" type="button" disabled={page * PAGE_LIMIT + PAGE_LIMIT >= total} onClick={() => setPage((p) => p + 1)}>下一頁 →</button>
            </div>
          </div>
        )}
      </section>
    </AppShell>
  )
}

export default ComplianceAlerts
