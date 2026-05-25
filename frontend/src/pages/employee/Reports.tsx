import AppShell from '../../components/layout/AppShell'

function Reports() {
  return (
    <AppShell title="報表中心" subtitle="出勤報表匯出與下載">
      <section className="panel-card">
        <h2 className="h6 mb-3">報表下載</h2>
        <div className="row g-3 align-items-end">
          <div className="col-md-3">
            <label className="form-label">起始日期</label>
            <input className="form-control" type="date" defaultValue="2026-05-01" />
          </div>
          <div className="col-md-3">
            <label className="form-label">結束日期</label>
            <input className="form-control" type="date" defaultValue="2026-05-25" />
          </div>
          <div className="col-md-3">
            <label className="form-label">部門</label>
            <select className="form-select" defaultValue="ALL">
              <option value="ALL">全部部門</option>
              <option value="FAB_A">FAB_A</option>
              <option value="FAB_B">FAB_B</option>
              <option value="FAB_C">FAB_C</option>
            </select>
          </div>
          <div className="col-md-3">
            <label className="form-label">格式</label>
            <select className="form-select" defaultValue="CSV">
              <option>CSV</option>
              <option>PDF</option>
            </select>
          </div>
          <div className="col-12 d-flex justify-content-end">
            <button className="btn btn-primary px-4">下載報表</button>
          </div>
        </div>
      </section>
    </AppShell>
  )
}

export default Reports
