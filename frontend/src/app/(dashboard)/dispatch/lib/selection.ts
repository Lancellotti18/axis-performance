// Multi-select store for the dispatch grid. Selection is a set of appointment
// ids; `last` anchors shift-click range selection. Kept in Zustand so cards, the
// bulk bar, and keyboard handlers share one source of truth without prop-drilling.
import { create } from 'zustand'

interface SelectionState {
  selected: Set<string>
  last: string | null
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
  selectOnly: (id: string) => void
  addRange: (ids: string[]) => void
  setAll: (ids: string[]) => void
  clear: () => void
  setLast: (id: string | null) => void
}

export const useSelection = create<SelectionState>((set, get) => ({
  selected: new Set<string>(),
  last: null,
  isSelected: (id) => get().selected.has(id),
  toggle: (id) => set((s) => {
    const n = new Set(s.selected)
    if (n.has(id)) n.delete(id); else n.add(id)
    return { selected: n, last: id }
  }),
  selectOnly: (id) => set({ selected: new Set([id]), last: id }),
  addRange: (ids) => set((s) => {
    const n = new Set(s.selected)
    ids.forEach((i) => n.add(i))
    return { selected: n }
  }),
  setAll: (ids) => set({ selected: new Set(ids) }),
  clear: () => set({ selected: new Set<string>(), last: null }),
  setLast: (id) => set({ last: id }),
}))
