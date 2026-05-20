import React, { useRef, useState } from 'react'

function AttendanceReport(): JSX.Element {
  const [showChart, setShowChart] = useState(false)
  const [selectedDepts] = useState(['A組', 'B組'])
  const lastToggleTime = useRef(0)

  const handleToggleChart = () => {
    const now = Date.now()
    if (now - lastToggleTime.current < 2000) return
    lastToggleTime.current = now
    setShowChart((s) => !s)
  }

  return (
    <div className="card h-100 border-0 shadow-sm p-4 bg-white rounded-3">
      <h2 className="h5 fw-bold text-dark mb-4">即時出勤報表</h2>

      <div className="d-flex gap-2 mb-3">
        <select className="form-select form-select-sm w-auto" value={`${selectedDepts.length} 已選擇`} readOnly>
          <option>{selectedDepts.length} 已選擇</option>
        </select>
        <button className="btn btn-sm btn-outline-secondary d-flex align-items-center">
          <i className="bi bi-funnel me-1"></i> 篩選
        </button>
        <button onClick={handleToggleChart} className={`btn btn-sm ${showChart ? 'btn-danger' : 'btn-outline-danger'} ms-auto d-flex align-items-center`}>
          <i className="bi bi-exclamation-circle me-1"></i> {showChart ? '數據列表' : '圖形分析'}
        </button>
      </div>

      {!showChart ? (
        <div className="table-responsive">
          <table className="table table-sm text-start mb-0 align-middle">
            <thead>
              <tr className="text-muted small">
                <th className="border-0 ps-0">員工</th>
                <th className="border-0">轄下部門</th>
                <th className="border-0 text-end pe-0">職稱</th>
              </tr>
            </thead>
            <tbody className="small">
              <tr>
                <td className="ps-0 py-2 fw-bold">傑森</td>
                <td>生產線 A 組</td>
                <td className="text-end text-muted pe-0">產品設計師</td>
              </tr>
              <tr>
                <td className="ps-0 py-2 fw-bold">王德美</td>
                <td>生產線 A 組</td>
                <td className="text-end text-muted pe-0">行銷顧問</td>
              </tr>
              <tr>
                <td className="ps-0 py-2 fw-bold">凱文</td>
                <td>生產線 B 組</td>
                <td className="text-end text-muted pe-0">前端工程師</td>
              </tr>
              <tr>
                <td className="ps-0 py-2 fw-bold">陳麥可</td>
                <td>生產線 C 組</td>
                <td className="text-end text-muted pe-0">產品測試工程師</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="p-3 border rounded text-center d-flex flex-column justify-content-center align-items-center" style={{ height: '160px', backgroundColor: '#fafafa' }}>
          <div className="small text-muted mb-3">各組別平均在廠滯留時數圖表</div>
          <div className="d-flex justify-content-center align-items-end gap-3 w-100" style={{ height: '80px' }}>
            <div className="bg-primary rounded-top" style={{ width: '30px', height: '90%' }} title="A組"></div>
            <div className="bg-info rounded-top" style={{ width: '30px', height: '65%' }} title="B組"></div>
            <div className="bg-secondary rounded-top" style={{ width: '30px', height: '40%' }} title="C組"></div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AttendanceReport
