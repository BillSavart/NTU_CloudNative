function ComplianceAlerts() {
  return (
    <main className="container py-5">
      <h1 className="h4 mb-3">出勤異常與合規管理</h1>

      <div className="card p-3">
        <table className="table table-hover">
          <thead>
            <tr>
              <th>員工編號</th>
              <th>姓名</th>
              <th>停留時數</th>
              <th>異常時間</th>
              <th>備註</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>EMP001</td>
              <td className="text-danger fw-bold">王小明</td>
              <td className="text-danger">13.5</td>
              <td>2026-05-19 08:00</td>
              <td>
                <button className="btn btn-sm btn-outline-primary">查看</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  )
}

export default ComplianceAlerts
