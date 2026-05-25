import { useRef, useState } from 'react'

function AttendanceReport() {
  const [showChart, setShowChart] = useState(false)
  const [selectedDepts] = useState(['A 部門', 'B 部門'])
  const lastToggleTime = useRef(0)

  const handleToggleChart = () => {
    const now = Date.now()
    if (now - lastToggleTime.current < 2000) return
    lastToggleTime.current = now
    setShowChart((prev) => !prev)
  }

  return (
    <div className="card h-100 border-0 shadow-sm p-4 bg-white rounded-3">
      <h2 className="h5 fw-bold text-dark mb-4">出勤異常趨勢</h2>

      <div className="d-flex gap-2 mb-3 align-items-center">
        <input
          className="form-control form-control-sm w-auto"
          value={`${selectedDepts.length} 已選擇`}
          readOnly
          aria-label="已選擇部門數量"
        />
        <button className="btn btn-sm btn-outline-secondary d-flex align-items-center" type="button">
          <i className="bi bi-funnel me-1"></i> 篩選
        </button>
        <button
          onClick={handleToggleChart}
          type="button"
          className={`btn btn-sm ${showChart ? 'btn-danger' : 'btn-outline-danger'} ms-auto d-flex align-items-center`}
        >
          <i className="bi bi-exclamation-circle me-1"></i> {showChart ? '隱藏圖表' : '顯示圖表'}
        </button>
      </div>

      {!showChart ? (
        <div className="table-responsive">
          <table className="table table-sm text-start mb-0 align-middle">
            <thead>
              <tr className="text-muted small">
                <th className="border-0 ps-0">類別</th>
                <th className="border-0">部門</th>
                <th className="border-0 text-end pe-0">狀態</th>
              </tr>
            </thead>
            <tbody className="small">
              <tr>
                <td className="ps-0 py-2 fw-bold">遲到</td>
                <td>{selectedDepts[0]}</td>
                <td className="text-end text-muted pe-0">今日 3 筆</td>
              </tr>
              <tr>
                <td className="ps-0 py-2 fw-bold">缺勤</td>
                <td>{selectedDepts[0]}</td>
                <td className="text-end text-muted pe-0">已通知</td>
              </tr>
              <tr>
                <td className="ps-0 py-2 fw-bold">超時</td>
                <td>{selectedDepts[1]}</td>
                <td className="text-end text-muted pe-0">待主管確認</td>
              </tr>
              <tr>
                <td className="ps-0 py-2 fw-bold">未配對</td>
                <td>C 部門</td>
                <td className="text-end text-muted pe-0">已補登</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div
          className="p-3 border rounded text-center d-flex flex-column justify-content-center align-items-center"
          style={{ height: '160px', backgroundColor: '#fafafa' }}
        >
          <div className="small text-muted mb-3">示意圖：各部門異常分布</div>
          <div className="d-flex justify-content-center align-items-end gap-3 w-100" style={{ height: '80px' }}>
            <div className="bg-primary rounded-top" style={{ width: '30px', height: '90%' }} title="A 部門"></div>
            <div className="bg-info rounded-top" style={{ width: '30px', height: '65%' }} title="B 部門"></div>
            <div className="bg-secondary rounded-top" style={{ width: '30px', height: '40%' }} title="C 部門"></div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AttendanceReport
