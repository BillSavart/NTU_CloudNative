import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type DeptOption = { id: string; name: string; depth: number }

type Props = {
  options: DeptOption[]
  selected: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
}

// Options are depth-first ordered; descendants have strictly greater depth
// and appear immediately after their parent until a node of equal/lesser depth.
function getDescendantIds(options: DeptOption[], id: string): string[] {
  const idx = options.findIndex((o) => o.id === id)
  if (idx === -1) return []
  const parentDepth = options[idx].depth
  const result: string[] = []
  for (let i = idx + 1; i < options.length; i++) {
    if (options[i].depth <= parentDepth) break
    result.push(options[i].id)
  }
  return result
}

export default function DeptMultiSelect({ options, selected, onChange, placeholder = '全部部門' }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  // Build a human-readable label for the button
  const label = (() => {
    if (selected.length === 0) return placeholder
    // Show only top-level selected (those whose parent is NOT also selected)
    const topLevel = selected.filter((id) => {
      const idx = options.findIndex((o) => o.id === id)
      if (idx <= 0) return true
      const myDepth = options[idx]?.depth ?? 0
      // Check if any ancestor is also selected
      for (let i = idx - 1; i >= 0; i--) {
        if (options[i].depth < myDepth && selected.includes(options[i].id)) return false
        if (options[i].depth < myDepth) break
      }
      return true
    })
    if (topLevel.length === 1) return options.find((o) => o.id === topLevel[0])?.name ?? topLevel[0]
    return `已選 ${topLevel.length} 個部門`
  })()

  const openDropdown = () => {
    if (!btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setPos({
      top: rect.bottom + window.scrollY + 4,
      left: rect.left + window.scrollX,
      width: Math.max(rect.width, 220),
    })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        dropRef.current && !dropRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggle = (id: string) => {
    const descendants = getDescendantIds(options, id)
    const affected = [id, ...descendants]
    if (selected.includes(id)) {
      // deselect: remove this node and all descendants
      onChange(selected.filter((s) => !affected.includes(s)))
    } else {
      // select: add this node and all descendants (deduplicated)
      const next = Array.from(new Set([...selected, ...affected]))
      onChange(next)
    }
  }

  // A node is "indeterminate" when some but not all descendants are selected
  const isIndeterminate = (id: string): boolean => {
    const descendants = getDescendantIds(options, id)
    if (descendants.length === 0) return false
    const selectedCount = descendants.filter((d) => selected.includes(d)).length
    return selectedCount > 0 && selectedCount < descendants.length
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="form-select text-start"
        style={{ cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        onClick={() => (open ? setOpen(false) : openDropdown())}
      >
        {label}
      </button>

      {open && pos && createPortal(
        <div
          ref={dropRef}
          style={{
            position: 'absolute',
            top: pos.top,
            left: pos.left,
            width: pos.width,
            zIndex: 9999,
            background: '#fff',
            border: '1px solid #dee2e6',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,.12)',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          <div className="d-flex justify-content-between align-items-center px-3 py-2 border-bottom">
            <span className="small fw-semibold text-secondary">選擇部門</span>
            {selected.length > 0 && (
              <button type="button" className="btn btn-link btn-sm p-0 text-secondary" onClick={() => onChange([])}>
                清除
              </button>
            )}
          </div>
          {options.map((o) => {
            const checked = selected.includes(o.id)
            const indeterminate = !checked && isIndeterminate(o.id)
            return (
              <label
                key={o.id}
                className="d-flex align-items-center gap-2 py-1 small"
                style={{ cursor: 'pointer', paddingLeft: `${12 + o.depth * 14}px`, paddingRight: 12 }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  ref={(el) => { if (el) el.indeterminate = indeterminate }}
                  onChange={() => toggle(o.id)}
                />
                {o.name}
                <span className="text-secondary ms-1">({o.id})</span>
              </label>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
