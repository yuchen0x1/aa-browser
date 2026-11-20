/**
 * Window placement rules shared by the display regression and its DPI matrix.
 *
 * The app enforces a 960×640 DIP minimum window. On small displays that is
 * larger than the usable work area, so the OS cannot satisfy "window fully
 * inside the display". These helpers keep the real assertion where it is
 * meaningful and let the test report the constraint instead of failing.
 */
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 640

// Windows converts physical frame sizes to integer DIP; a round trip can
// differ by up to 2 DIP at fractional device scale factors.
export const BOUNDS_TOLERANCE = 2

/**
 * Target bounds for placing `bounds` on `area`: shrink to the work area when
 * possible, keep the 960×640 minimum, and inset by at most 24px.
 * `fits` is false when the display cannot contain the minimum window at all.
 */
export function fitWindowToDisplay(bounds, area) {
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(bounds.width, area.width))
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(bounds.height, area.height))
  const inset = (limit, size) => Math.max(0, Math.min(24, limit - size))
  return {
    x: area.x + inset(area.width, width),
    y: area.y + inset(area.height, height),
    width,
    height,
    fits: area.width >= MIN_WINDOW_WIDTH && area.height >= MIN_WINDOW_HEIGHT,
  }
}