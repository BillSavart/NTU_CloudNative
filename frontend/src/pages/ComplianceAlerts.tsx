import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'
import { fetchComplianceAnomalies, updateComplianceAnomalyRemark, type ComplianceAnomaly } from '../services/accessEvents'

function formatDateTime(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value || '-'
  }
  return parsed.toLocaleString('zh-TW', { hour12: false })
}

function ComplianceAlerts() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [alerts, setAlerts] = useState<ComplianceAnomaly[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftNote, setDraftNote] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  const selectedType = searchParams.get('type') ?? 'denied_access'
  const keyword = searchParams.get('q') ?? ''

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const result = await fetchComplianceAnomalies(100, undefined, selectedType, 7)
        if (!cancelled) setAlerts(result.items)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load compliance anomalies')
          setAlerts([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [selectedType])

  const filteredAlerts = useMemo(() => {
    return alerts.filter((item) => {
      const typeMatch = selectedType === 'all' || item.type === selectedType
      const normalizedKeyword = keyword.trim().toLowerCase()
      const keywordMatch =
        normalizedKeyword === '' ||
        item.employeeId.toLowerCase().includes(normalizedKeyword) ||
        item.displayName?.toLowerCase().includes(normalizedKeyword) ||
        item.departmentId.toLowerCase().includes(normalizedKeyword)

      return typeMatch && keywordMatch
    })
  }, [alerts, keyword, selectedType])

  const handleTypeChange = (value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === 'all') {
      next.delete('type')
    } else {
      next.set('type', value)
    }
    setSearchParams(next)
  }

  const handleKeywordChange = (value: string) => {
    const next = new URLSearchParams(searchParams)
    if (!value.trim()) {
      next.delete('q')
    } else {
      next.set('q', value)
    }
    setSearchParams(next)
  }

  const startEdit = (item: ComplianceAnomaly) => {
    setEditingId(item.id)
    setDraftNote(item.note)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraftNote('')
  }

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

  return (
    <AppShell title="異常合規" subtitle="超時工時與高風險出勤事件">
      <section className="panel-card mb-3">
        <h2 className="h6 mb-3">篩選器</h2>
        <div className="row g-3 align-items-end">
          <div className="col-md-4">
            <label className="form-label">異常類型</label>
            <select className="form-select" value={selectedType} onChange={(event) => handleTypeChange(event.target.value)}>
              <option value="all">全部</option>
              <option value="late_arrival">遲到人員</option>
              <option value="overtime_daily">單日超過 12 小時</option>
              <option value="denied_access">拒絕通行事件</option>
              <option value="unpaired_access">未配對進出紀錄</option>
            </select>
          </div>
          <div className="col-md-4">
            <label className="form-label">員工搜尋</label>
            <input
              className="form-control"
              value={keyword}
              onChange={(event) => handleKeywordChange(event.target.value)}
              placeholder="輸入員工編號、姓名或部門"
            />
          </div>
          <div className="col-md-4">
            <div className="small text-secondary">最近 7 天，共 {filteredAlerts.length} 筆異常</div>
          </div>
        </div>
      </section>

      <section className="panel-card">
        <h2 className="h6 mb-3">異常清單</h2>
        <table className="table-clean">
          <thead>
            <tr>
              <th>員工</th>
              <th>部門</th>
              <th>異常類型</th>
              <th>連續工時</th>
              <th>發生時間</th>
              <th>備註</th>
              <th className="alert-actions-header">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="text-secondary">
                  載入中…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={7} className="text-danger">
                  {error}
                </td>
              </tr>
            ) : filteredAlerts.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-secondary">
                  目前沒有符合條件的異常資料
                </td>
              </tr>
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
                        onChange={(event) => setDraftNote(event.target.value)}
                      />
                    </td>
                    <td className="alert-actions-cell">
                      {isEditing ? (
                        <>
                          <button className="btn btn-sm btn-primary" type="button" onClick={() => saveNote(item.id)}>
                            {savingId === item.id ? '儲存中…' : '送出'}
                          </button>
                          <button className="btn btn-sm btn-outline-secondary" type="button" onClick={cancelEdit}>
                            取消
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => startEdit(item)}>
                          修改
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </section>
    </AppShell>
  )
}

export default ComplianceAlerts
