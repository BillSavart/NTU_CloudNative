import React from 'react'

function RealTimeOverview(): JSX.Element {
  return (
    <div className="card h-100 border-0 shadow-sm p-4 bg-white rounded-3">
      <h2 className="h5 fw-bold text-dark mb-4">工作狀態</h2>

      <div className="row g-4 text-center">
        <div className="col-4 mb-4">
          <div className="fs-1 fw-bold text-primary mb-1">32</div>
          <div className="text-muted small">已打卡</div>
        </div>
        <div className="col-4 mb-4">
          <div className="fs-1 fw-bold text-danger mb-1">1</div>
          <div className="text-muted small">遲到</div>
        </div>
        <div className="col-4 mb-4">
          <div className="fs-1 fw-bold" style={{ color: '#d48806' }}>0</div>
          <div className="text-muted small">未打卡</div>
        </div>
        <div className="col-4">
          <div className="fs-1 fw-bold text-secondary mb-1">0</div>
          <div className="text-muted small">早退</div>
        </div>
        <div className="col-4">
          <div className="fs-1 fw-bold text-success mb-1">3</div>
          <div className="text-muted small">休假</div>
        </div>
      </div>
    </div>
  )
}

export default RealTimeOverview
