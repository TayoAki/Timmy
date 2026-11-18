/**
 * A small force-directed layout for a few hundred nodes: everything pushes everything else away, each link pulls its
 * two ends together, and a gentle pull keeps the whole near the middle. Deterministic: the same graph always lands
 * the same way, so the map doesn't jump between visits.
 */
export interface LayoutNode {
  id: string;
  /** Bigger nodes push harder and sit a little further from their neighbours. */
  size: number;
  /** Nodes of one group start near each other. */
  group: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

/** A number in [0, 1) from a string, the same every time. */
function seeded(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

const GRAVITY = 0.06;

export function forceLayout(nodes: LayoutNode[], edges: LayoutEdge[], iterations = 320): Map<string, { x: number; y: number }> {
  const n = nodes.length;
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const groups = Math.max(1, ...nodes.map((d) => d.group + 1));
  const spread = 120 + Math.sqrt(n) * 60;
  nodes.forEach((d, i) => {
    // Each group starts in its own slice of a ring, scattered a little.
    const angle = (2 * Math.PI * (d.group + seeded(d.id) * 0.8)) / groups;
    const r = spread * (0.35 + 0.65 * seeded(`${d.id}r`));
    x[i] = Math.cos(angle) * r;
    y[i] = Math.sin(angle) * r;
  });
  const links = edges.map((e) => [index.get(e.source), index.get(e.target)] as const).filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined);
  // The distance two linked things settle at. Pushing stops a few of these apart, so groups that don't touch don't
  // drift off: the pull to the middle gathers them instead.
  const k = 110;
  const reach2 = (k * 4) ** 2;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  let temperature = spread / 4;
  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = x[i]! - x[j]!;
        let ddy = y[i]! - y[j]!;
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 > reach2) continue;
        if (d2 < 0.01) {
          ddx = seeded(`${i}:${j}`) - 0.5;
          ddy = seeded(`${j}:${i}`) - 0.5;
          d2 = 0.01;
        }
        const push = (k * k * (1 + (nodes[i]!.size + nodes[j]!.size) / 40)) / d2;
        dx[i]! += ddx * push;
        dy[i]! += ddy * push;
        dx[j]! -= ddx * push;
        dy[j]! -= ddy * push;
      }
    }
    for (const [a, b] of links) {
      const ddx = x[a]! - x[b]!;
      const ddy = y[a]! - y[b]!;
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
      const pull = d / k;
      dx[a]! -= ddx * pull;
      dy[a]! -= ddy * pull;
      dx[b]! += ddx * pull;
      dy[b]! += ddy * pull;
    }
    for (let i = 0; i < n; i++) {
      // A gentle pull to the middle keeps loose pieces from drifting off.
      dx[i]! -= x[i]! * GRAVITY;
      dy[i]! -= y[i]! * GRAVITY;
      const len = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!) || 1;
      const step = Math.min(len, temperature);
      x[i]! += (dx[i]! / len) * step;
      y[i]! += (dy[i]! / len) * step;
    }
    temperature = Math.max(1, temperature * 0.985);
  }
  return new Map(nodes.map((d, i) => [d.id, { x: x[i]!, y: y[i]! }]));
}
