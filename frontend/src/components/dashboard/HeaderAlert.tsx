type Props = {
  count?: number
}

function HeaderAlert({ count = 0 }: Props) {
  if (count <= 0) return null

  return (
    <div className="bg-danger text-white py-2">
      <div className="container d-flex justify-content-between align-items-center">
        <div>
          <strong>⚠ 系統警示：</strong>目前轄下有 {count} 筆單日停留超過 12 小時之異常紀錄，請確認。
        </div>
        <div>
          <button className="btn btn-light btn-sm">查看異常</button>
        </div>
      </div>
    </div>
  )
}

export default HeaderAlert
