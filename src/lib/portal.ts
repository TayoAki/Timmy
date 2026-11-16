/**
 * Where overlays (modals, Ask Timmy, popovers, the "/" menu) render: the page, or on the film
 * route the film's camera, so they move and zoom with the app instead of floating over it.
 */
const cam = () => (typeof document === 'undefined' ? null : (document.querySelector('.film-cam') as HTMLElement | null));

export const portalRoot = (): HTMLElement => cam() ?? document.body;

/** A point on screen, in the portal root's own coordinates (the film's camera moves and scales the app). */
export function toRoot(x: number, y: number): { x: number; y: number } {
  const el = cam();
  if (!el) return { x, y };
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return { x, y };
  const p = new DOMMatrix(t).inverse().transformPoint(new DOMPoint(x, y));
  return { x: p.x, y: p.y };
}
