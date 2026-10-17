"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, createChart, CrosshairMode, HistogramSeries, LineSeries, type IChartApi, type Time } from "lightweight-charts";
import { BarChart3, Maximize2 } from "lucide-react";
import type { Transaction } from "@/lib/types";

export function TerminalChart({ transactions }: { transactions: Transaction[] }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const flowRef = useRef<any>(null);
  const volumeRef = useRef<any>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: string } | null>(null);
  const chartData = useMemo(() => {
    const buckets = new Map<number, { value: number; count: number }>();
    for (const tx of transactions) {
      const epoch = Math.floor(new Date(tx.timestamp).getTime() / 1000);
      if (!Number.isFinite(epoch)) continue;
      const current = buckets.get(epoch) || { value: 0, count: 0 };
      current.value += typeof tx.amount_inr === "number" ? tx.amount_inr : (tx.currency || "INR").toUpperCase() === "INR" ? Number(tx.amount || 0) : 0;
      current.count += 1;
      buckets.set(epoch, current);
    }
    return [...buckets.entries()].sort(([a], [b]) => a - b).map(([time, item]) => ({
      time: time as Time,
      value: Math.round(item.value),
      transactions: item.count,
    }));
  }, [transactions]);

  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      width: host.current.clientWidth,
      height: host.current.clientHeight || 250,
      layout: { background: { type: ColorType.Solid, color: "#0d121b" }, textColor: "#738197", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: 10 },
      grid: { vertLines: { color: "rgba(143,164,188,.055)" }, horzLines: { color: "rgba(143,164,188,.055)" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "rgba(117,230,220,.45)", labelBackgroundColor: "#12383a" }, horzLine: { color: "rgba(117,230,220,.25)", labelBackgroundColor: "#12383a" } },
      rightPriceScale: { borderColor: "rgba(143,164,188,.12)", scaleMargins: { top: .12, bottom: .2 } },
      timeScale: { borderColor: "rgba(143,164,188,.12)", timeVisible: true, secondsVisible: false, rightOffset: 5 },
      localization: { priceFormatter: (value: number) => `₹${value.toLocaleString("en-IN")}` },
    });
    const flow = chart.addSeries(LineSeries, { color: "#75e6dc", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true, title: "TRANSFER VALUE" });
    const volume = chart.addSeries(HistogramSeries, { color: "rgba(117,230,220,.32)", priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false, title: "VOLUME" });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: .78, bottom: 0 }, visible: false });
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => {
      const point = param.point;
      if (!point || !param.time || point.x < 0 || point.y < 0) return setTooltip(null);
      const item = param.seriesData.get(flow) as { value?: number } | undefined;
      if (!item?.value) return setTooltip(null);
      const label = typeof param.time === "number" ? new Date(param.time * 1000).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : String(param.time);
      setTooltip({ x: Math.min(point.x + 12, (host.current?.clientWidth || 500) - 160), y: Math.max(4, point.y - 36), label, value: `₹${item.value.toLocaleString("en-IN")}` });
    });
    chartRef.current = chart;
    flowRef.current = flow;
    volumeRef.current = volume;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) chart.applyOptions({ width: Math.floor(box.width), height: Math.floor(box.height) });
    });
    observer.observe(host.current);
    return () => { observer.disconnect(); chart.remove(); chartRef.current = null; flowRef.current = null; volumeRef.current = null; };
  }, []);

  useEffect(() => {
    if (!flowRef.current || !volumeRef.current) return;
    flowRef.current.setData(chartData.map(({ time, value }) => ({ time, value })));
    volumeRef.current.setData(chartData.map((item) => ({ time: item.time, value: item.transactions, color: "rgba(117,230,220,.32)" })));
    chartRef.current?.timeScale().fitContent();
  }, [chartData]);

  return <div className="flex h-full min-h-[220px] flex-col">
    <div className="flex items-center justify-between border-b border-white/[.06] px-4 py-2.5"><div className="flex items-center gap-2"><BarChart3 size={13} className="text-cyan-200"/><span className="text-[10px] font-bold tracking-[.14em] text-slate-300">TRANSACTION FLOW / VOLUME</span><span className="rounded bg-white/[.04] px-1.5 py-0.5 font-mono text-[9px] text-slate-500">LIVE GRAPH</span></div><button className="rounded p-1 text-slate-600 hover:bg-white/5 hover:text-slate-300" title="Chart panel is resizable"><Maximize2 size={12}/></button></div>
    <div className="relative min-h-0 flex-1" ref={host}>{tooltip && <div className="chart-tooltip" style={{ left: tooltip.x, top: tooltip.y }}><div className="text-slate-500">{tooltip.label}</div><div className="mt-1 text-cyan-100">FLOW VALUE · {tooltip.value}</div></div>}{chartData.length === 0 && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center"><div className="text-center"><div className="text-xs text-slate-500">Waiting for transaction series</div><div className="mt-1 text-[10px] text-slate-700">Connect FastAPI to render live transfer telemetry</div></div></div>}</div>
    <div className="flex items-center gap-4 border-t border-white/[.05] px-4 py-2 text-[9px] text-slate-600"><span><i className="mr-1.5 inline-block h-1.5 w-3 rounded-sm bg-cyan-200"/>Transfer value</span><span><i className="mr-1.5 inline-block h-1.5 w-3 rounded-sm bg-cyan-200/40"/>Transfer volume</span><span className="ml-auto">{transactions.length.toLocaleString("en-IN")} events loaded</span></div>
  </div>;
}
