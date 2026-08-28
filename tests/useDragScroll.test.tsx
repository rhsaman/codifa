import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useDragScroll, DragScroll } from '../src/lib/useDragScroll'

describe('useDragScroll', () => {
  it('scrolls only when Cmd/Ctrl is held, plain drag does nothing', () => {
    function Probe() {
      const h = useDragScroll<HTMLDivElement>()
      return (
        <div
          data-testid="box"
          style={{ overflow: 'auto', width: 100, height: 100 }}
          {...h}
        >
          <div style={{ width: 500, height: 500 }}>big</div>
        </div>
      )
    }
    const { getByTestId } = render(<Probe />)
    const box = getByTestId('box') as HTMLDivElement

    // Plain drag: no scroll change.
    fireEvent.mouseDown(box, { clientX: 50, clientY: 50 })
    fireEvent.mouseMove(box, { clientX: 10, clientY: 10 })
    expect(box.scrollLeft).toBe(0)
    expect(box.scrollTop).toBe(0)

    // Cmd/Ctrl + drag: scrolls opposite to pointer movement.
    fireEvent.mouseDown(box, { clientX: 50, clientY: 50, metaKey: true })
    fireEvent.mouseMove(box, { clientX: 10, clientY: 10 })
    expect(box.scrollLeft).toBe(40)
    expect(box.scrollTop).toBe(40)
    fireEvent.mouseUp(box)
  })

  it('DragScroll wrapper applies handlers', () => {
    const { getByTestId } = render(
      <DragScroll data-testid="wrap">
        <div style={{ width: 500, height: 500 }}>big</div>
      </DragScroll>,
    )
    const box = getByTestId('wrap') as HTMLDivElement
    fireEvent.mouseDown(box, { clientX: 50, clientY: 50, ctrlKey: true })
    fireEvent.mouseMove(box, { clientX: 30, clientY: 30 })
    expect(box.scrollLeft).toBe(20)
    expect(box.scrollTop).toBe(20)
  })
})
