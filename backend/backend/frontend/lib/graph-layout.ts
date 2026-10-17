import type { NetworkEdge, NetworkGraphData, NetworkNode } from "@/lib/types";

export type PositionedNode = NetworkNode & {
  x: number;
  y: number;
};

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return result >>> 0;
}

function springDistance(edge: NetworkEdge, spacing: number) {
  if (edge.relation === "TRANSFER") return 148 * spacing;
  if (edge.relation === "USED_DEVICE" || edge.relation === "USED_IP") return 116 * spacing;
  return 132 * spacing;
}

/** Deterministic 2D force layout; no WebGL or per-frame physics dependency. */
export function createGraphLayout(data: NetworkGraphData, spacingPercent = 100, focusId?: string): PositionedNode[] {
  const spacing = Math.max(0.6, Math.min(1.6, spacingPercent / 100));
  const count = data.nodes.length;
  if (!count) return [];

  const orderedNodes = focusId
    ? [...data.nodes].sort((left, right) => Number(right.id === focusId) - Number(left.id === focusId))
    : data.nodes;
  const nodes: PositionedNode[] = orderedNodes.map((node, index) => {
    if (node.id === focusId) return { ...node, x: 0, y: 0 };
    const seed = hash(node.id);
    const angle = index * Math.PI * (3 - Math.sqrt(5)) + (seed % 997) / 997;
    const layer = node.type === "account" ? 112 : 194;
    const radial = layer + Math.sqrt((index + 1) / count) * (node.type === "account" ? 104 : 126);
    const jitter = ((seed % 31) - 15) * 1.4;
    return { ...node, x: Math.cos(angle) * (radial + jitter), y: Math.sin(angle) * (radial + jitter) };
  });

  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  const links = data.edges.flatMap((edge) => {
    const source = indices.get(edge.source);
    const target = indices.get(edge.target);
    return source === undefined || target === undefined || source === target
      ? []
      : [{ source, target, distance: springDistance(edge, spacing) }];
  });

  const ax = new Float64Array(count);
  const ay = new Float64Array(count);
  const focusIndex = focusId ? indices.get(focusId) : undefined;
  const iterations = count <= 48 ? 82 : 56;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    ax.fill(0);
    ay.fill(0);

    for (let left = 0; left < count; left += 1) {
      const a = nodes[left];
      for (let right = left + 1; right < count; right += 1) {
        const b = nodes[right];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < 16) {
          const nudge = ((hash(`${a.id}:${b.id}`) % 100) / 100) + 0.1;
          dx += nudge;
          dy -= nudge;
          distanceSquared = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distanceSquared);
        const force = Math.min(3.8, (14000 * spacing) / distanceSquared);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        ax[left] += fx;
        ay[left] += fy;
        ax[right] -= fx;
        ay[right] -= fy;
      }
    }

    for (const link of links) {
      const source = nodes[link.source];
      const target = nodes[link.target];
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = Math.max(-3.6, Math.min(3.6, (distance - link.distance) * 0.016));
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      ax[link.source] += fx;
      ay[link.source] += fy;
      ax[link.target] -= fx;
      ay[link.target] -= fy;
    }

    const cooling = 1 - iteration / (iterations + 18);
    for (let index = 0; index < count; index += 1) {
      const node = nodes[index];
      if (index === focusIndex) {
        node.x = 0;
        node.y = 0;
        continue;
      }
      node.x += Math.max(-12, Math.min(12, (ax[index] - node.x * 0.0008) * cooling));
      node.y += Math.max(-12, Math.min(12, (ay[index] - node.y * 0.0008) * cooling));
    }
  }

  return nodes;
}
