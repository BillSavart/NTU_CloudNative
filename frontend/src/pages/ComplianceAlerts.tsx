import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import AppShell from '../components/layout/AppShell'

type AlertType = 'overtime_daily' | 'overtime_crossday' | 'unpaired_access'

type AlertItem = {
  id: string
  employeeId: string
  departmentId: string
  type: AlertType
  typeLabel: string
  hours: string
  occurredAt: string
  note: string
}

const seedAlerts: AlertItem[] = [
  {
    id: 'A-1',
    employeeId: 'E14502',
    departmentId: 'FAB_A',
    type: 'overtime_daily',
    typeLabel: '超過 12 小時',
    hours: '13.5h',
    occurredAt: '2026-05-25 07:40',
    note: '待主管確認',
  },
  {
    id: 'A-2',
    employeeId: 'E10210',
    departmentId: 'FAB_B',
    type: 'overtime_crossday',
    typeLabel: '跨日連續超時',
    hours: '12.8h',
    occurredAt: '2026-05-24 23:10',
    note: '已通知營運經理',
  },
  {
    id: 'A-3',
    employeeId: 'E22031',
    departmentId: 'SECURITY',
    type: 'unpaired_access',
    typeLabel: '未配對進出紀錄',
    hours: '-',
    occurredAt: '2026-05-24 20:16',
    note: '待人資回覆',
  },
]

function ComplianceAlerts() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [alerts, setAlerts] = useState<AlertItem[]>(seedAlerts)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftNote, setDraftNote] = useState('')

  const selectedType = searchParams.get('type') ?? 'all'
  const keyword = searchParams.get('q') ?? ''

  const filteredAlerts = useMemo(() => {
    return alerts.filter((item) => {
      const typeMatch = selectedType === 'all' || item.type === selectedType
      const keywordMatch =
        keyword.trim() === '' ||
        item.employeeId.toLowerCase().includes(keyword.toLowerCase()) ||
        item.departmentId.toLowerCase().includes(keyword.toLowerCase())

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

  const startEdit = (item: AlertItem) => {
    setEditingId(item.id)
    setDraftNote(item.note)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraftNote('')
  }

  const saveNote = (id: string) => {
    setAlerts((prev) => prev.map((item) => (item.id === id ? { ...item, note: draftNote } : item)))
    cancelEdit()
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
              <option value="overtime_daily">單日超過 12 小時</option>
              <option value="overtime_crossday">跨日連續超時</option>
              <option value="unpaired_access">未配對進出紀錄</option>
            </select>
          </div>
          <div className="col-md-4">
            <label className="form-label">員工搜尋</label>
            <input
              className="form-control"
              value={keyword}
              onChange={(event) => handleKeywordChange(event.target.value)}
              placeholder="輸入員工編號或姓名"
            />
          </div>
          <div className="col-md-4">
            <div className="small text-secondary">共 {filteredAlerts.length} 筆異常</div>
          </div>
        </div>
      </section>

      <section className="panel-card">
        <h2 className="h6 mb-3">異常清單</h2>
        <table className="table-clean">
          <thead>
            <tr>
              <th>員工編號</th>
              <th>部門</th>
              <th>異常類型</th>
              <th>連續工時</th>
              <th>發生時間</th>
              <th>備註</th>
              <th className="alert-actions-header">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredAlerts.map((item) => {
              const isEditing = editingId === item.id

              return (
                <tr key={item.id}>
                  <td>{item.employeeId}</td>
                  <td>{item.departmentId}</td>
                  <td className="danger-text">{item.typeLabel}</td>
                  <td className="danger-text">{item.hours}</td>
                  <td>{item.occurredAt}</td>
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
                          送出
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
            })}
          </tbody>
        </table>
      </section>
    </AppShell>
  )
}

export default ComplianceAlerts
