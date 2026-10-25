"use client";

import dynamic from "next/dynamic";
import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, MutableRefObject, ReactElement, ReactNode } from "react";
import * as THREE from "three";
import { forceCollide } from "d3-force-3d";
import { Activity, AlertCircle, Crosshair, Fingerprint, Globe2, LoaderCircle, MapPin, Network, RefreshCw, Smartphone, Store, X, ZoomIn, ZoomOut } from "lucide-react";
import type { ForceGraphMethods } from "react-force-graph-3d";
import { NodeInspector } from "@/components/node-inspector";
import { Slider } from "@/components/ui/slider";
import { apiUrl } from "@/lib/api";
import type { AccountRiskSignal, NetworkEdge, NetworkGraphData, NetworkNode } from "@/lib/types";

type Scope = "full" | "account";
type NationalViewMode = "focused" | "full";
type Filters = { transfers: boolean; infrastructure: boolean; context: boolean };
type RiskBand = "high" | "watch" | "safe";
type GraphNode = NetworkNode & { x?: number; y?: number; z?: number };
type GraphLink = NetworkEdge & { source: string | GraphNode; target: string | GraphNode };
type ForceRef = ForceGraphMethods<GraphNode, GraphLink>;
type ForceData = { nodes: GraphNode[]; links: GraphLink[] };
type ForceRendererProps = {
  ref?: MutableRefObject<ForceRef | undefined>;
  graphData: ForceData;
  width: number;
  height: number;
  backgroundColor: string;
  controlType: "orbit";
  enableNavigationControls: boolean;
  enableNodeDrag: boolean;
  showNavInfo: boolean;
  nodeId: string;
  nodeLabel: (node: GraphNode) => string;
  nodeColor: (node: GraphNode) => string;
  nodeThreeObject: (node: GraphNode) => THREE.Object3D;
  nodeVal: (node: GraphNode) => number;
  nodeRelSize: number;
  nodeResolution: number;
  nodeOpacity: number;
  linkColor: (link: GraphLink) => string;
  linkLabel: (link: GraphLink) => string;
  linkWidth: (link: GraphLink) => number;
  linkOpacity: number;
  linkResolution: number;
  linkDirectionalArrowLength: (link: GraphLink) => number;
  linkDirectionalArrowRelPos: number;
  linkDirectionalArrowColor: (link: GraphLink) => string;
  linkDirectionalParticles: (link: GraphLink) => number;
  linkDirectionalParticleWidth: number;
  linkDirectionalParticleSpeed: number;
  linkDirectionalParticleColor: () => string;
  warmupTicks: number;
  cooldownTicks: number;
  cooldownTime: number;
  d3AlphaDecay: number;
  d3VelocityDecay: number;
  onNodeClick: (node: GraphNode) => void;
  onNodeHover: (node: GraphNode | null) => void;
  onLinkClick: (link: GraphLink) => void;
  onEngineStop: () => void;
};

const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-[10px] text-slate-500"><LoaderCircle size={15} className="mr-2 inline animate-spin text-cyan-300" />Starting 3D renderer…</div>,
}) as unknown as ComponentType<ForceRendererProps & { ref?: MutableRefObject<ForceRef | undefined> }>;

const colors = {
  safe: "#06B6D4",
  watch: "#F59E0B",
  high: "#EF4444",
  device: "#718096",
  ip: "#60A5FA",
  merchant: "#64748B",
  location: "#7890A4",
  transfer: "#38BDF8",
  infrastructure: "#667C91",
  context: "#718096",
};

const nodeSphereGeometry = new THREE.SphereGeometry(1, 14, 10);
const nodeSphereMaterials = new Map<string, THREE.MeshStandardMaterial>();

function sphereMaterial(color: string, selected: boolean) {
  const key = `${color}:${selected ? "selected" : "normal"}`;
  let material = nodeSphereMaterials.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: selected ? 0.82 : 0.48,
      metalness: 0.18,
      roughness: 0.34,
    });
    nodeSphereMaterials.set(key, material);
  }
  return material;
}

function nodeSphere(node: GraphNode, signals: Map<string, AccountRiskSignal>, emphasized: boolean) {
  const color = entityColor(node, signals);
  const radius = node.type === "account"
    ? riskBand(signals.get(node.id)) === "high" ? 4.5 : 3.8
    : node.type === "ip_address" ? 2.8 : node.type === "device" ? 2.5 : 2.9;
  const sphere = new THREE.Mesh(nodeSphereGeometry, sphereMaterial(color, emphasized));
  sphere.scale.setScalar(radius * (emphasized ? 1.28 : 1));
  return sphere;
}

function riskBand(signal?: AccountRiskSignal): RiskBand {
  const status = (signal?.status || "").toUpperCase();
  if (status.includes("HIGH")) return "high";
  if (status.includes("WATCH") || status.includes("MEDIUM") || signal?.in_fraud_ring || signal?.mule_account) return "watch";
  return "safe";
}

function accountColor(signal?: AccountRiskSignal) {
  const band = riskBand(signal);
  return band === "high" ? colors.high : band === "watch" ? colors.watch : colors.safe;
}

function entityColor(node: NetworkNode, signals: Map<string, AccountRiskSignal>) {
  if (node.type === "account") return accountColor(signals.get(node.id));
  if (node.type === "device") return colors.device;
  if (node.type === "ip_address") return colors.ip;
  if (node.type === "merchant") return colors.merchant;
  return colors.location;
}

function edgeColor(edge: NetworkEdge, isSelected: boolean) {
  if (isSelected) return "#70F4EA";
  if (edge.relation === "TRANSFER") return colors.transfer;
  if (edge.relation === "USED_DEVICE" || edge.relation === "USED_IP") return colors.infrastructure;
  return colors.context;
}

function endpointId(endpoint: string | GraphNode) {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function linkTouches(link: GraphLink | NetworkEdge, nodeId: string) {
  return endpointId(link.source) === nodeId || endpointId(link.target) === nodeId;
}

function stableHash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

function unitNoise(seed: number, offset: number) {
  const value = Math.sin((seed + offset * 97.13) * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

/** Stable 3D seed positions keep each investigation legible before force settling. */
function seedPositions(nodes: NetworkNode[], edges: NetworkEdge[], focusId?: string, spacing = 100, priorPositions = new Map<string, { x: number; y: number; z: number }>()) {
  const positions = new Map<string, { x: number; y: number; z: number }>();
  const scale = spacing / 100;
  const accounts = nodes.filter((node) => node.type === "account").sort((left, right) => left.id.localeCompare(right.id));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  accounts.forEach((node, index) => {
    const seed = stableHash(node.id);
    if (node.id === focusId) {
      positions.set(node.id, { x: 0, y: 0, z: 0 });
      return;
    }
    const prior = priorPositions.get(node.id);
    if (prior) {
      positions.set(node.id, prior);
      return;
    }
    const angle = index * goldenAngle + unitNoise(seed, 1) * 0.72;
    const vertical = unitNoise(seed, 2) * 0.82;
    const planar = Math.sqrt(Math.max(0.05, 1 - vertical * vertical));
    const radius = (190 + Math.abs(unitNoise(seed, 3)) * 210) * scale;
    positions.set(node.id, {
      x: Math.cos(angle) * planar * radius,
      y: vertical * radius,
      z: Math.sin(angle) * planar * radius,
    });
  });

  for (const node of nodes.filter((item) => item.type !== "account").sort((left, right) => left.id.localeCompare(right.id))) {
    const prior = priorPositions.get(node.id);
    if (prior) {
      positions.set(node.id, prior);
      continue;
    }
    const seed = stableHash(node.id);
    const linkedAccounts = new Set<string>();
    for (const edge of edges) {
      if (edge.source === node.id && positions.has(edge.target)) linkedAccounts.add(edge.target);
      if (edge.target === node.id && positions.has(edge.source)) linkedAccounts.add(edge.source);
    }
    const neighbors = [...linkedAccounts].map((id) => positions.get(id)).filter((position): position is { x: number; y: number; z: number } => Boolean(position));
    const center = neighbors.length
      ? neighbors.reduce((sum, position) => ({ x: sum.x + position.x / neighbors.length, y: sum.y + position.y / neighbors.length, z: sum.z + position.z / neighbors.length }), { x: 0, y: 0, z: 0 })
      : { x: unitNoise(seed, 4) * 220 * scale, y: unitNoise(seed, 5) * 220 * scale, z: unitNoise(seed, 6) * 220 * scale };
    const baseSpread = node.type === "ip_address" ? 88 : node.type === "device" ? 74 : 62;
    const sharedSpread = Math.min(72, node.shared_account_count * 7);
    const spread = (baseSpread + sharedSpread + Math.abs(unitNoise(seed, 7)) * 38) * scale;
    const vertical = unitNoise(seed, 8);
    const planar = Math.sqrt(Math.max(0.05, 1 - vertical * vertical));
    const angle = unitNoise(seed, 9) * Math.PI;
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * planar * spread,
      y: center.y + vertical * spread,
      z: center.z + Math.sin(angle) * planar * spread,
    });
  }

  return nodes.map((node) => ({ ...node, ...(positions.get(node.id) || { x: 0, y: 0, z: 0 }) }));
}

function seedPositions2D(nodes: NetworkNode[], edges: NetworkEdge[], focusId?: string, spacing = 100) {
  const positions = new Map<string, { x: number; y: number }>();
  const scale = spacing / 100;
  const accounts = nodes.filter((node) => node.type === "account").sort((left, right) => left.id.localeCompare(right.id));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  accounts.forEach((node, index) => {
    if (node.id === focusId) {
      positions.set(node.id, { x: 0, y: 0 });
      return;
    }
    const seed = stableHash(node.id);
    const angle = index * goldenAngle + unitNoise(seed, 1) * 0.28;
    const progress = accounts.length > 1 ? Math.sqrt(index / (accounts.length - 1)) : 0;
    const radius = (focusId ? 145 : 48) + progress * 248 + Math.abs(unitNoise(seed, 3)) * 20;
    positions.set(node.id, { x: Math.cos(angle) * radius * scale, y: Math.sin(angle) * radius * scale });
  });

  for (const node of nodes.filter((item) => item.type !== "account").sort((left, right) => left.id.localeCompare(right.id))) {
    const seed = stableHash(node.id);
    const linkedAccounts = new Set<string>();
    for (const edge of edges) {
      if (edge.source === node.id && positions.has(edge.target)) linkedAccounts.add(edge.target);
      if (edge.target === node.id && positions.has(edge.source)) linkedAccounts.add(edge.source);
    }
    const neighbors = [...linkedAccounts].map((id) => positions.get(id)).filter((point): point is { x: number; y: number } => Boolean(point));
    const center = neighbors.length
      ? neighbors.reduce((sum, point) => ({ x: sum.x + point.x / neighbors.length, y: sum.y + point.y / neighbors.length }), { x: 0, y: 0 })
      : { x: unitNoise(seed, 4) * 120 * scale, y: unitNoise(seed, 5) * 120 * scale };
    const baseSpread = node.type === "ip_address" ? 78 : node.type === "device" ? 66 : 54;
    const spread = (baseSpread + Math.min(54, node.shared_account_count * 5) + Math.abs(unitNoise(seed, 7)) * 24) * scale;
    const angle = unitNoise(seed, 9) * Math.PI;
    positions.set(node.id, { x: center.x + Math.cos(angle) * spread, y: center.y + Math.sin(angle) * spread });
  }

  return nodes.map((node) => ({ ...node, ...(positions.get(node.id) || { x: 0, y: 0 }) }));
}

type RendererBoundaryProps = { children: ReactNode; fallback: ReactNode; onError: () => void };
class WebGLRendererBoundary extends Component<RendererBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type GraphNode2D = NetworkNode & { x: number; y: number };
function TwoDimensionalNetworkGraph({
  nodes,
  edges,
  signals,
  selectedId,
  selectedEdgeId,
  hoverId,
  zoom,
  onNodeSelect,
  onNodeHover,
  onEdgeSelect,
}: {
  nodes: GraphNode2D[];
  edges: NetworkEdge[];
  signals: Map<string, AccountRiskSignal>;
  selectedId: string;
  selectedEdgeId?: string;
  hoverId: string;
  zoom: number;
  onNodeSelect: (node: NetworkNode) => void;
  onNodeHover: (node: NetworkNode | null) => void;
  onEdgeSelect: (edge: NetworkEdge) => void;
}) {
  const positions = new Map(nodes.map((node) => [node.id, node]));
  const accountCount = nodes.filter((node) => node.type === "account").length;

  return <svg className="absolute inset-0 h-full w-full" viewBox={`${-500 / zoom} ${-350 / zoom} ${1000 / zoom} ${700 / zoom}`} role="img" aria-label="Interactive two-dimensional account network">
    <g>
      {edges.map((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return null;
        const emphasized = edge.id === selectedEdgeId || linkTouches(edge, selectedId) || Boolean(hoverId && linkTouches(edge, hoverId));
        const stroke = edgeColor(edge, emphasized);
        return <g key={edge.id} onClick={() => onEdgeSelect(edge)} className="cursor-pointer">
          <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke={stroke} strokeWidth={emphasized ? 1.8 : 0.9} strokeOpacity={emphasized ? 0.88 : 0.28} />
          <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="transparent" strokeWidth={10} />
          <title>{linkEvidenceLabel(edge)}</title>
        </g>;
      })}
      {nodes.map((node) => {
        const selected = node.id === selectedId;
        const hovered = node.id === hoverId;
        const account = node.type === "account";
        const radius = account ? (selected || hovered ? 8 : 5.8) : node.type === "ip_address" ? 4.3 : node.type === "device" ? 4 : 3.7;
        const fill = entityColor(node, signals);
        const signal = signals.get(node.id);
        const label = `${node.label || node.id}${account && signal ? ` · ${signal.status} ${signal.risk_score}/100` : ""} · ${node.connection_count} links`;
        return <g
          key={node.id}
          role="button"
          tabIndex={0}
          aria-label={`Inspect ${label}`}
          aria-pressed={selected}
          className="cursor-pointer outline-none"
          onClick={() => onNodeSelect(node)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onNodeSelect(node); } }}
          onMouseEnter={() => onNodeHover(node)}
          onMouseLeave={() => onNodeHover(null)}
        >
          {(selected || hovered) && <circle cx={node.x} cy={node.y} r={radius + 6} fill={fill} fillOpacity={0.12} stroke={fill} strokeOpacity={0.65} strokeWidth={1} />}
          <circle cx={node.x} cy={node.y} r={radius} fill={fill} stroke={selected ? "#E6FCFF" : "#09111A"} strokeWidth={selected ? 2 : 1.3} />
          {(accountCount <= 42 || selected || hovered) && <text x={node.x + radius + 5} y={node.y + 3} fill={selected || hovered ? "#E2F7FA" : "#91A4B8"} fontSize={8} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">{node.label || node.id}</text>}
          <title>{label}</title>
        </g>;
      })}
    </g>
  </svg>;
}

function isInfrastructure(relation: string) {
  return relation === "USED_DEVICE" || relation === "USED_IP";
}

export const NetworkGraph = memo(function NetworkGraph({
  scope,
  account,
  onAnalyze,
  sourceState = "connecting",
}: {
  scope: Scope;
  account?: string;
  onAnalyze: (account: string) => void;
  sourceState?: "connecting" | "live" | "offline";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceRef | undefined>(undefined);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [rendererMode, setRendererMode] = useState<"checking" | "3d" | "2d">("checking");
  const [svgZoom, setSvgZoom] = useState(1);
  const [graph, setGraph] = useState<NetworkGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [signals, setSignals] = useState<Map<string, AccountRiskSignal>>(() => new Map());
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(account || "ACC_097");
  const [selectedEdge, setSelectedEdge] = useState<NetworkEdge | null>(null);
  const [hoverId, setHoverId] = useState("");
  const [filters, setFilters] = useState<Filters>({ transfers: true, infrastructure: true, context: false });
  const [nationalView, setNationalView] = useState<NationalViewMode>("full");
  const [spacing, setSpacing] = useState(100);
  const [reloadKey, setReloadKey] = useState(0);
  const [lastIngest, setLastIngest] = useState("");
  const hasSettledFitRef = useRef(false);
  const positionsRef = useRef(new Map<string, { x: number; y: number; z: number }>());
  const activeFocusId = scope === "account"
    ? account || "ACC_097"
    : scope === "full" && nationalView === "focused"
      ? selectedId || account || "ACC_097"
      : undefined;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setDimensions((current) => current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let webglAvailable = false;
    try {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2", { antialias: false }) || canvas.getContext("webgl", { antialias: false });
      webglAvailable = Boolean(context);
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webglAvailable = false;
    }
    setRendererMode(webglAvailable ? "3d" : "2d");
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let connected = true;
    const graphPath = scope === "full"
      ? "/api/network?scope=full"
      : `/api/graph/${encodeURIComponent(account || "ACC_097")}?depth=1`;

    if (!graph) setLoading(true);
    else setRefreshing(true);
    setError("");

    fetch(apiUrl(graphPath), { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.detail || `Graph API returned ${response.status}`);
        }
        return response.json();
      })
      .then((payload: { graph?: NetworkGraphData; account_id?: string }) => {
        if (!payload.graph || !Array.isArray(payload.graph.nodes) || !Array.isArray(payload.graph.edges)) {
          throw new Error("The API returned an invalid graph payload.");
        }
        if (!connected) return;
        setGraph(payload.graph);
        setSelectedId((current) => current || account || payload.account_id || "ACC_097");
      })
      .catch((reason: unknown) => {
        if (connected && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Network graph unavailable");
      })
      .finally(() => {
        if (connected) {
          setLoading(false);
          setRefreshing(false);
        }
      });

    fetch(apiUrl("/api/accounts"), { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Risk signal API returned ${response.status}`);
        return response.json();
      })
      .then((payload: { accounts?: AccountRiskSignal[] }) => {
        if (!connected) return;
        const rows = Array.isArray(payload.accounts) ? payload.accounts : [];
        setSignals(new Map(rows.map((row) => [row.account_id, row])));
      })
      .catch(() => { if (connected) setSignals(new Map()); });

    return () => {
      connected = false;
      controller.abort();
    };
    // `reloadKey` is raised by the shared FastAPI transaction stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, account, reloadKey]);

  useEffect(() => {
    let refreshTimer: number | undefined;
    const onTransaction = () => {
      setLastIngest(new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }));
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => setReloadKey((current) => current + 1), 1800);
    };
    window.addEventListener("fin-sentinels:transaction", onTransaction);
    return () => {
      window.removeEventListener("fin-sentinels:transaction", onTransaction);
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, []);

  const visible = useMemo(() => {
    if (!graph) return { nodes: [] as NetworkNode[], edges: [] as NetworkEdge[], ids: new Set<string>() };
    const allowedEdges = graph.edges.filter((edge) => {
      if (edge.relation === "TRANSFER") return filters.transfers;
      if (isInfrastructure(edge.relation)) return filters.infrastructure;
      return filters.context;
    });
    const ids = new Set<string>();
    if (scope === "full" && nationalView === "full") {
      graph.nodes.forEach((node) => { if (node.type === "account") ids.add(node.id); });
      for (const edge of allowedEdges) {
        ids.add(edge.source);
        ids.add(edge.target);
      }
    } else {
      const focusId = activeFocusId || account || "ACC_097";
      ids.add(focusId);
      for (const edge of allowedEdges) {
        if (edge.source === focusId || edge.target === focusId) {
          ids.add(edge.source);
          ids.add(edge.target);
        }
      }
    }
    const edges = allowedEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    return { nodes: graph.nodes.filter((node) => ids.has(node.id)), edges, ids };
  }, [graph, filters, scope, account, nationalView, activeFocusId]);

  const graphData = useMemo<ForceData>(() => {
    const nodes = seedPositions(visible.nodes, visible.edges, activeFocusId, spacing, positionsRef.current);
    const links = visible.edges.map((edge) => ({ ...edge, source: edge.source, target: edge.target }));
    return { nodes, links };
  }, [visible, activeFocusId, spacing]);
  const graphData2D = useMemo(
    () => seedPositions2D(visible.nodes, visible.edges, activeFocusId, spacing),
    [visible, activeFocusId, spacing],
  );

  const selectedNode = visible.nodes.find((node) => node.id === selectedId) || null;
  const selectedSignal = selectedNode?.type === "account" ? signals.get(selectedNode.id) : undefined;
  const selectedAccountCount = visible.nodes.filter((node) => node.type === "account").length;
  const highRiskCount = visible.nodes.filter((node) => node.type === "account" && riskBand(signals.get(node.id)) === "high").length;

  useEffect(() => {
    hasSettledFitRef.current = false;
    const instance = graphRef.current;
    if (!instance) return;
    const charge = instance.d3Force("charge");
    charge?.strength(-Math.min(210, 110 + graphData.nodes.length * 0.22));
    charge?.distanceMax(740);
    const linkForce = instance.d3Force("link");
    linkForce?.distance((link: GraphLink) => {
      const base = link.relation === "TRANSFER" ? 116 : isInfrastructure(link.relation) ? 94 : 102;
      return base * (spacing / 100);
    });
    linkForce?.strength(0.24);
    instance.d3Force("collision", forceCollide<GraphNode>((node) => {
      if (node.type === "account") return 16;
      if (node.type === "ip_address") return 13.5;
      return 12.5;
    }).strength(0.86).iterations(2));
    instance.d3ReheatSimulation();
  }, [graphData, spacing]);

  useEffect(() => {
    if (!graphData.nodes.length || dimensions.width < 80 || dimensions.height < 80 || !hasSettledFitRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      graphRef.current?.zoomToFit(700, 58);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [graphData, dimensions.width, dimensions.height]);

  const fitToScreen = useCallback(() => {
    const instance = graphRef.current;
    if (instance) instance.zoomToFit(650, 54);
    else setSvgZoom(1);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const instance = graphRef.current;
    if (!instance) {
      setSvgZoom((current) => Math.min(2.6, Math.max(0.55, current / factor)));
      return;
    }
    const position = instance.camera().position;
    instance.cameraPosition({ x: position.x * factor, y: position.y * factor, z: position.z * factor }, undefined, 280);
  }, []);

  const use2DFallback = useCallback(() => setRendererMode("2d"), []);

  const toggleFilter = (key: keyof Filters) => setFilters((current) => ({ ...current, [key]: !current[key] }));
  const chooseNationalView = (mode: NationalViewMode) => {
    setNationalView(mode);
    if (mode === "focused" && !selectedId) setSelectedId(account || "ACC_097");
  };

  const onSelectNode = (node: GraphNode) => { setSelectedId(node.id); setSelectedEdge(null); };
  const onNodeHover = (node: GraphNode | null) => setHoverId(node?.id || "");
  const onSelectLink = (link: GraphLink) => setSelectedEdge({ ...link, source: endpointId(link.source), target: endpointId(link.target) });
  const fallbackGraph = <TwoDimensionalNetworkGraph
    nodes={graphData2D}
    edges={visible.edges}
    signals={signals}
    selectedId={selectedId}
    selectedEdgeId={selectedEdge?.id}
    hoverId={hoverId}
    zoom={svgZoom}
    onNodeSelect={onSelectNode}
    onNodeHover={onNodeHover}
    onEdgeSelect={(edge) => onSelectLink({ ...edge, source: edge.source, target: edge.target })}
  />;
  const onEngineStop = useCallback(() => {
    for (const node of graphData.nodes) {
      if (Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)) {
        positionsRef.current.set(node.id, { x: node.x as number, y: node.y as number, z: node.z as number });
      }
    }
    if (!hasSettledFitRef.current) {
      graphRef.current?.zoomToFit(750, 58);
      hasSettledFitRef.current = true;
    }
  }, [graphData]);

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[.07] bg-[#0c131c]/72 px-4 py-2.5 backdrop-blur-xl">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="grid h-6 w-6 place-items-center rounded-md border border-cyan-300/15 bg-cyan-300/[.06] text-cyan-200"><Network size={13} /></div>
          <span className="text-[10px] font-bold tracking-[.14em] text-slate-100">{scope === "full" ? nationalView === "full" ? "NATIONAL FRAUD INTELLIGENCE GRAPH" : `FOCUSED NETWORK · ${selectedId || account || "ACC_097"}` : `ACCOUNT NETWORK · ${account || "ACC_097"}`}</span>
          <span className="rounded border border-white/[.07] bg-black/20 px-1.5 py-1 font-mono text-[8px] text-slate-500">{loading ? "SYNCING" : `${visible.nodes.length} NODES · ${visible.edges.length} LINKS`}</span>
          <span className="rounded border border-cyan-400/15 bg-cyan-400/[.05] px-1.5 py-1 font-mono text-[7px] tracking-wider text-cyan-200">{rendererMode === "2d" ? "2D · SVG COMPATIBILITY" : rendererMode === "checking" ? "CHECKING GRAPH SUPPORT" : "3D · WEBGL"}</span>
          <span className={`flex items-center gap-1 rounded border px-1.5 py-1 font-mono text-[7px] tracking-wider ${sourceState === "live" ? "border-emerald-300/15 bg-emerald-300/[.05] text-emerald-200" : sourceState === "connecting" ? "border-amber-300/15 bg-amber-300/[.05] text-amber-200" : "border-rose-300/15 bg-rose-300/[.05] text-rose-200"}`}><i className={`h-1.5 w-1.5 rounded-full ${sourceState === "live" ? "bg-emerald-300" : sourceState === "connecting" ? "bg-amber-300" : "bg-rose-300"}`} />FASTAPI {sourceState === "live" ? "STREAM" : sourceState === "connecting" ? "LOADING" : "OFFLINE"}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {scope === "full" && <>
            <FilterButton label="NATIONAL LAYER" active={nationalView === "full"} onClick={() => chooseNationalView("full")} />
            <FilterButton label={`FOCUS ${selectedId || "ACCOUNT"}`} active={nationalView === "focused"} onClick={() => chooseNationalView("focused")} />
            <span className="mx-0.5 h-4 w-px bg-white/[.07]" />
          </>}
          <div className="hidden w-28 items-center gap-1.5 md:flex"><span className="whitespace-nowrap text-[7px] tracking-wider text-slate-600">SPACING</span><Slider aria-label="Graph spacing" min={65} max={150} step={5} value={[spacing]} onValueChange={(next) => { if (next[0] !== undefined) setSpacing(next[0]); }} /><span className="w-6 text-right font-mono text-[8px] text-slate-500">{spacing}%</span></div>
          <FilterButton label="TRANSFERS" active={filters.transfers} onClick={() => toggleFilter("transfers")} />
          <FilterButton label="DEVICE / IP" active={filters.infrastructure} onClick={() => toggleFilter("infrastructure")} />
          <FilterButton label="MERCHANT / GEO" active={filters.context} onClick={() => toggleFilter("context")} />
        </div>
      </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_220px] lg:grid-cols-[minmax(0,1fr)_250px]">
        <div ref={hostRef} className="graph-grid-overlay relative min-h-[340px] min-w-0 overflow-hidden border-r border-white/[.06] bg-[#070b12]">
          {rendererMode === "checking" && graph && dimensions.width > 80 && dimensions.height > 80 && <div className="absolute inset-0 grid place-items-center text-[10px] text-slate-500"><LoaderCircle size={14} className="mr-2 inline animate-spin text-cyan-300" />Checking graphics support…</div>}
          {rendererMode === "2d" && graph && dimensions.width > 80 && dimensions.height > 80 && fallbackGraph}
          {rendererMode === "3d" && graph && dimensions.width > 80 && dimensions.height > 80 && <WebGLRendererBoundary fallback={fallbackGraph} onError={use2DFallback}><ForceGraph3D
            ref={graphRef}
            graphData={graphData}
            width={dimensions.width}
            height={dimensions.height}
            backgroundColor="#070b12"
            controlType="orbit"
            enableNavigationControls
            enableNodeDrag
            showNavInfo={false}
            nodeId="id"
            nodeLabel={(node) => {
              const signal = signals.get(node.id);
              const risk = node.type === "account" && signal ? ` · ${signal.status} ${signal.risk_score}/100` : "";
              return `${node.label || node.id}${risk} · ${node.connection_count} links`;
            }}
            nodeColor={(node) => {
              const base = entityColor(node, signals);
              if (node.id !== selectedId && node.id !== hoverId) return base;
              return riskBand(signals.get(node.id)) === "high" ? colors.high : base;
            }}
            nodeThreeObject={(node) => nodeSphere(node, signals, node.id === selectedId || node.id === hoverId)}
            nodeVal={(node) => {
              const isAccount = node.type === "account";
              const high = isAccount && riskBand(signals.get(node.id)) === "high";
              const selected = node.id === selectedId || node.id === hoverId;
              return isAccount ? (high ? 4.3 : 3.2) * (selected ? 1.32 : 1) : (node.type === "device" || node.type === "ip_address" ? 1.55 : 1.85) * (selected ? 1.25 : 1);
            }}
            nodeRelSize={4.7}
            nodeResolution={10}
            nodeOpacity={0.96}
            linkColor={(link) => edgeColor(link, link.id === selectedEdge?.id || linkTouches(link, selectedId) || Boolean(hoverId && linkTouches(link, hoverId)))}
            linkLabel={(link) => linkEvidenceLabel(link)}
            linkWidth={() => 0}
            linkOpacity={0.28}
            linkResolution={2}
            linkDirectionalArrowLength={(link) => link.relation === "TRANSFER" ? 2.2 : 0}
            linkDirectionalArrowRelPos={0.87}
            linkDirectionalArrowColor={(link) => edgeColor(link, link.id === selectedEdge?.id || linkTouches(link, selectedId))}
            linkDirectionalParticles={(link) => link.relation === "TRANSFER" && (linkTouches(link, selectedId) || link.id === selectedEdge?.id) ? 1 : 0}
            linkDirectionalParticleWidth={1.8}
            linkDirectionalParticleSpeed={0.004}
            linkDirectionalParticleColor={() => "#A5F3FC"}
            warmupTicks={14}
            cooldownTicks={55}
            cooldownTime={3200}
            d3AlphaDecay={0.065}
            d3VelocityDecay={0.44}
            onNodeClick={onSelectNode}
            onNodeHover={onNodeHover}
            onLinkClick={onSelectLink}
            onEngineStop={onEngineStop}
          /></WebGLRendererBoundary>}

          {loading && <div className="absolute inset-0 z-10 grid place-items-center bg-[#070b12]/88"><span className="flex items-center gap-2 text-[10px] text-slate-400"><LoaderCircle size={15} className="animate-spin text-cyan-300" />Loading national graph from FastAPI…</span></div>}
          {!loading && error && <div className="absolute inset-0 z-10 grid place-items-center bg-[#070b12]/90"><div className="max-w-sm px-6 text-center"><AlertCircle size={20} className="mx-auto mb-2 text-amber-300" /><div className="text-[11px] text-slate-200">Unable to load the network graph</div><div className="mt-1 text-[9px] text-slate-500">{error}</div><button type="button" onClick={() => setReloadKey((current) => current + 1)} className="mt-3 inline-flex items-center gap-1.5 rounded border border-cyan-300/15 px-2.5 py-1.5 text-[9px] text-cyan-200 hover:bg-cyan-300/[.06]"><RefreshCw size={11} />Retry connection</button></div></div>}
          {!loading && !error && visible.nodes.length === 0 && <div className="absolute inset-0 z-10 grid place-items-center px-6 text-center text-[10px] leading-relaxed text-slate-500">No linked entities were returned for {account || "this selection"}. Switch to the national layer or select another account.</div>}

          <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-md border border-white/[.09] bg-[#0a0f17]/88 p-1.5 shadow-lg shadow-black/30 backdrop-blur-md">
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1.2)} className="grid h-7 w-7 place-items-center rounded text-slate-400 transition hover:bg-white/[.07] hover:text-slate-100"><ZoomOut size={13} /></button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomBy(0.82)} className="grid h-7 w-7 place-items-center rounded text-slate-400 transition hover:bg-white/[.07] hover:text-slate-100"><ZoomIn size={13} /></button>
            <span className="mx-1 h-4 w-px bg-white/[.08]" />
            <button type="button" aria-label="Fit graph to screen" onClick={fitToScreen} className="grid h-7 w-7 place-items-center rounded text-slate-400 transition hover:bg-white/[.07] hover:text-cyan-200"><Crosshair size={13} /></button>
          </div>
          <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-md border border-white/[.08] bg-[#0a0f17]/85 px-2.5 py-1.5 font-mono text-[7px] tracking-wider text-slate-400 backdrop-blur-md"><span className="text-red-300">{highRiskCount} HIGH-RISK</span><span className="text-slate-700">/</span>{selectedAccountCount} ACCOUNTS{refreshing && <LoaderCircle size={10} className="animate-spin text-cyan-300" />}</div>
          <div className="absolute bottom-4 right-3 z-10 hidden text-right text-[7px] leading-relaxed tracking-wider text-slate-500/75 md:block">{rendererMode === "2d" ? "SELECT NODES TO INSPECT · SELECT LINKS FOR EVIDENCE" : "DRAG TO ORBIT · RIGHT-DRAG TO PAN · SCROLL TO ZOOM"}<br />{lastIngest ? `LAST INGEST ${lastIngest} IST` : "WAITING FOR NEXT TRANSACTION EVENT"}</div>
        </div>

          <div className="flex min-h-0 flex-col overflow-hidden bg-[#0a1018]/90">
          <div className="terminal-scroll min-h-0 flex-1 overflow-y-auto">
            {selectedEdge && <EdgeEvidence edge={selectedEdge} onClose={() => setSelectedEdge(null)} />}
            <NodeInspector node={selectedNode} signal={selectedSignal} onInvestigate={onAnalyze} />
          </div>
          <div className="shrink-0 space-y-1.5 border-t border-white/[.07] bg-[#0a1018] px-3 py-2.5">
            <Legend color={colors.safe} label="Safe account" />
            <Legend color={colors.watch} label="Watch · mule / ring evidence" />
            <Legend color={colors.high} label="High-risk account" />
            <Legend color={colors.device} label="Shared device" />
            <Legend color={colors.ip} label="Shared IP address" />
            <Legend color={colors.merchant} label="Merchant" />
            <Legend color={colors.location} label="Location" />
            <div className="mt-2 flex items-center justify-between border-t border-white/[.05] pt-2 text-[7px] text-slate-600"><span>NETWORK SCOPE</span><span className="font-mono text-cyan-200/70">{scope === "full" && nationalView === "full" ? "NATIONAL" : "FOCUSED"}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
});

function FilterButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`rounded border px-2 py-1 font-mono text-[7px] tracking-wider transition ${active ? "border-white/[.1] bg-white/[.055] text-cyan-200" : "border-transparent text-slate-600 hover:text-slate-400"}`}>{label}</button>;
}

function Legend({ color, label }: { color: string; label: string }) {
  const Icon = label.includes("device") ? Smartphone : label.includes("IP") ? Fingerprint : label.includes("Merchant") ? Store : label.includes("Location") ? MapPin : label.includes("Safe") ? Activity : label.includes("Watch") ? Globe2 : Network;
  return <div className="flex items-center gap-2 text-[7px] text-slate-500"><Icon size={10} style={{ color }} aria-hidden="true" /><span className="h-1 w-1 rounded-full shadow-[0_0_8px_currentColor]" style={{ backgroundColor: color, color }} />{label}</div>;
}

function linkEvidenceLabel(edge: NetworkEdge) {
  const count = edge.transaction_count || edge.transaction_ids?.length || 1;
  const span = [edge.first_timestamp, edge.last_timestamp || edge.timestamp].filter(Boolean).join(" → ");
  const tx = edge.transaction_ids?.slice(0, 3).join(", ");
  return [
    `${endpointId(edge.source as string | GraphNode)} → ${endpointId(edge.target as string | GraphNode)}`,
    edge.relation,
    `${count} observed record${count === 1 ? "" : "s"}`,
    span,
    tx ? `Transaction IDs: ${tx}${(edge.transaction_ids?.length || 0) > 3 ? "…" : ""}` : "",
  ].filter(Boolean).join(" · ");
}

function EdgeEvidence({ edge, onClose }: { edge: NetworkEdge; onClose: () => void }) {
  const transactionIds = edge.transaction_ids || (edge.transaction_id ? [edge.transaction_id] : []);
  const firstSeen = edge.first_timestamp || edge.timestamp || "Not supplied by source";
  const lastSeen = edge.last_timestamp || edge.timestamp || "Not supplied by source";
  const location = [edge.source_country && edge.target_country ? `${edge.source_country} → ${edge.target_country}` : null, edge.location, edge.location_country].filter(Boolean).join(" · ");
  const amount = edge.relation === "TRANSFER" && edge.total_amount !== undefined
    ? `₹${Number(edge.total_amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
    : "—";

  return <section className="m-2 rounded-lg border border-cyan-200/15 bg-cyan-200/[.035] p-2.5">
    <div className="flex items-center justify-between gap-2"><div className="text-[8px] font-bold tracking-[.14em] text-cyan-100/75">LINK EVIDENCE</div><button type="button" aria-label="Close link evidence" onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-white/[.06] hover:text-white"><X size={11}/></button></div>
    <div className="mt-2 break-all font-mono text-[9px] text-slate-200">{edge.source} <span className="text-cyan-200">→</span> {edge.target}</div>
    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
      <EvidenceValue label="RELATION" value={edge.relation}/>
      <EvidenceValue label="TRANSFER TOTAL" value={amount}/>
      <EvidenceValue label="FIRST OBSERVED" value={firstSeen}/>
      <EvidenceValue label="LAST OBSERVED" value={lastSeen}/>
      <EvidenceValue label="RECORDS" value={edge.transaction_count || transactionIds.length || 1}/>
      <EvidenceValue label="SOURCE" value={edge.evidence_source === "transaction_feed" ? "TRANSACTION FEED" : "OBSERVED EDGE RECORD"}/>
      {edge.device_id && <EvidenceValue label="DEVICE" value={edge.device_id} />}
      {edge.ip_address && <EvidenceValue label="IP ADDRESS" value={edge.ip_address} />}
      {location && <div className="col-span-2"><EvidenceValue label="GEO CONTEXT" value={location}/></div>}
    </div>
    {transactionIds.length > 0 && <div className="mt-2 border-t border-white/[.06] pt-2"><div className="text-[7px] font-bold tracking-wider text-slate-600">SOURCE TRANSACTION IDS</div><div className="mt-1 break-all font-mono text-[8px] leading-relaxed text-slate-400">{transactionIds.slice(0, 8).join(" · ")}{transactionIds.length > 8 ? ` · +${transactionIds.length - 8} more` : ""}</div></div>}
  </section>;
}

function EvidenceValue({ label, value }: { label: string; value: string | number }) {
  return <div className="min-w-0"><div className="text-[6px] font-semibold tracking-[.1em] text-slate-600">{label}</div><div className="mt-0.5 break-all font-mono text-[8px] leading-relaxed text-slate-400">{value}</div></div>;
}
