import { useState } from 'react'

type AlertRow = {
  id: number
  name: string
  date: string
  status: string
  isOvernight: boolean
}

function CriticalAlertsPanel() {
  const [alerts] = useState<AlertRow[]>([
    { id: 1, name: '王小明', date: '2026-05-19（一）', status: '超時 14h', isOvernight: true },
    { id: 2, name: '陳怡君', date: '2026-05-20（二）', status: '超時 12.5h', isOvernight: false },
  ])

  const [historyEmp, setHistoryEmp] = useState<string | null>(null)

  return (
    <div className="card h-100 border-0 shadow-sm p-4 bg-white rounded-3 position-relative">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="h5 fw-bold text-dark mb-0">超時警示（&gt; 12h）</h2>
        <span className="badge bg-light text-muted border px-2 py-1 small">即時更新</span>
      </div>

      <div className="table-responsive">
        <table className="table table-hover align-middle mb-0">
          <tbody>
            {alerts.map((item) => (
              <tr key={item.id}>
                <td className="ps-0 border-bottom">
                  <button
                    type="button"
                    onClick={() => setHistoryEmp(item.name)}
                    className="btn btn-link p-0 fw-bold text-dark text-decoration-none"
                  >
                    {item.name}
                  </button>
                  {item.isOvernight && (
                    <span className="badge bg-warning-subtle text-warning-emphasis ms-1" style={{ fontSize: '10px' }}>
                      跨日
                    </span>
                  )}
                </td>
                <td className="text-muted border-bottom small">{item.date}</td>
                <td className="text-end border-bottom fw-bold text-danger pe-0">{item.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {historyEmp && (
        <div
          className="position-absolute top-0 start-0 w-100 h-100 bg-white p-4 rounded-3 shadow d-flex flex-column"
          style={{ zIndex: 5 }}
        >
          <div className="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3">
            <h6 className="fw-bold mb-0">{historyEmp} 超時歷史紀錄</h6>
            <button type="button" className="btn-close" onClick={() => setHistoryEmp(null)}></button>
          </div>
          <div className="small text-muted flex-grow-1">
            <p className="mb-2">2026/05/12 日班：13.5 小時</p>
            <p className="mb-2">2026/05/08 夜班：12.5 小時</p>
          </div>
        </div>
      )}
    </div>
  )
}

export default CriticalAlertsPanel
