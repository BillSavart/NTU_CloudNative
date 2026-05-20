type Props = {
  employeeId: string | null
  onClose: () => void
}

function EmployeeDrawer({ employeeId, onClose }: Props) {
  if (!employeeId) return null

  return (
    <div className="offcanvas offcanvas-end show" style={{ visibility: 'visible', transform: 'translateX(0)' }}>
      <div className="offcanvas-header">
        <h5 className="offcanvas-title">員工異常紀錄</h5>
        <button type="button" className="btn-close text-reset" onClick={onClose}></button>
      </div>
      <div className="offcanvas-body">
        <p>員工：{employeeId}</p>
        <p>歷史異常紀錄：</p>
        <ul>
          <li>2026-05-01：13.2 小時（備註：排班調整）</li>
          <li>2026-04-20：12.5 小時（備註：追蹤）</li>
        </ul>
        <div className="mb-3">
          <label className="form-label">新增備註</label>
          <textarea className="form-control" rows={3}></textarea>
        </div>
        <div className="d-flex justify-content-end">
          <button className="btn btn-primary">儲存備註</button>
        </div>
      </div>
    </div>
  )
}

export default EmployeeDrawer
