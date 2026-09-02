(() => {
  "use strict";

  const API = "";
  const state = {
    currentView: "overview",
    networkFilter: "all",
    networkFocus: "",
    networkMode: "alerts",
    currentAccount: "",
    currentScore: null,
    currentGraph: null,
    selectedCase: null,
    cases: [],
    alerts: [],
    networkGraph: null,
    pollTimer: null,
    loggedIn: false,
  };

  const $ = (id) => document.getElementById(id);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value == null ? "" : String(value);
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[c]));
  }

  function money(value) {
    return "₹" + Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }

  function time(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  function riskTier(status) {
    const value = String(status || "SAFE").toUpperCase();
    return value === "HIGH RISK" ? "high" : value === "WATCH" ? "watch" : "safe";
  }

  function toast(message) {
    const node = $("toast");
    if (!node) return;
    setText("toastText", message);
    node.style.opacity = "1";
    node.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(window.__finToastTimer);
    window.__finToastTimer = setTimeout(() => {
      node.style.opacity = "0";
      node.style.transform = "translateX(-50%) translateY(12px)";
    }, 2400);
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(API + path, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          message = payload.detail || payload.message || message;
        } catch (_) {}
        throw new Error(message);
      }
      return response.json();
    } catch (error) {
      console.error(`[FinSentinels] API ${path} failed:`, error);
      if (error.name === "AbortError") throw new Error("Request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  const get = (path) => api(path);
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
  const put = (path, body) => api(path, { method: "PUT", body: JSON.stringify(body) });
  const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body) });

  function setView(view) {
    const target = $("view-" + view);
    if (!target) {
      console.error("[FinSentinels] Missing view:", view);
      return;
    }
    state.currentView = view;
    qsa(".view").forEach((node) => node.classList.remove("active"));
    target.classList.add("active");
    qsa(".rail-btn[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));

    const labels = {
      overview: ["Overview", "Fraud network command center"],
      network: ["Transaction Network", "Accounts, devices, merchants and money flows"],
      investigations: ["Investigations", "Explainable account-level analysis"],
      alerts: ["Risk Alerts", "Prioritized accounts requiring attention"],
      cases: ["Cases", "Investigation lifecycle and analyst queue"],
      "case-detail": ["Case Detail", "Evidence, timeline and analyst actions"],
      analytics: ["Analytics", "Network patterns and case-management intelligence"],
      settings: ["Settings", "Risk thresholds and graph depth"],
    };
    const [title, subtitle] = labels[view] || labels.overview;
    setText("workspaceTitle", title);
    setText("workspaceSubtitle", subtitle);

    if (view === "overview") loadOverview();
    if (view === "network") loadNetwork();
    if (view === "investigations") {
      const existing = state.currentAccount;
      if (existing && state.currentScore) renderInvestigation(state.currentScore, state.currentGraph);
    }
    if (view === "alerts") loadAlerts();
    if (view === "cases") loadCases();
    if (view === "analytics") loadAnalytics();
    if (view === "settings") loadSettings();
  }

  async function loadOverview() {
    renderLoading("overviewAlerts", "Loading live risk alerts…");
    renderLoading("overviewFeed", "Loading transaction intelligence…");
    try {
      const [analyticsData, alertsData, casesData, networkData, recentData] = await Promise.all([
        get("/api/analytics"),
        get("/api/alerts"),
        get("/api/cases"),
        get("/api/network"),
        get("/api/transactions/recent?limit=8"),
      ]);
      console.info("[FinSentinels] Overview loaded", {
        accounts: analyticsData.network?.accounts,
        transactions: analyticsData.network?.transactions,
      });

      const n = analyticsData.network || {};
      const r = analyticsData.risk_distribution || {};
      const f = analyticsData.fraud_patterns || {};
      const t = analyticsData.transaction_metrics || {};
      const cm = analyticsData.case_metrics || {};

      setText("ovAccounts", n.accounts ?? 0);
      setText("ovFlagged", `${r.high_risk ?? 0} / ${r.watch ?? 0}`);
      setText("ovOpenCases", cm.open ?? casesData.cases?.filter((c) => ["OPEN", "INVESTIGATING"].includes(c.status)).length ?? 0);
      setText("ovVolume", money(t.total_volume ?? 0));
      setText("sideAccounts", n.accounts ?? 0);
      setText("sideFlagged", (r.high_risk ?? 0) + (r.watch ?? 0));
      setText("sideRings", f.active_cycles ?? 0);
      setText("sideDevices", f.shared_devices ?? 0);
      setText("sideTx", n.transactions ?? 0);

      state.alerts = Array.isArray(alertsData.alerts) ? alertsData.alerts : [];
      state.networkGraph = networkData.graph || networkData;
      state.currentGraph = state.currentGraph || state.networkGraph;
      renderOverviewAlerts(state.alerts.slice(0, 5));
      const recentRows = Array.isArray(recentData.transactions) ? recentData.transactions : getTransferEdges(state.networkGraph).slice(-8).reverse();
      renderTransactionFeed(recentRows, "overviewFeed");
      updateAlertCount(state.alerts.length);
    } catch (error) {
      console.error("[FinSentinels] Overview failed:", error);
      renderError("overviewAlerts", "Unable to load live alerts. Check the backend console.");
      renderError("overviewFeed", "Unable to load transaction intelligence.");
      toast("Overview data unavailable");
    }
  }

  function updateAlertCount(count) {
    const badge = $("alertCount");
    if (!badge) return;
    badge.textContent = count;
    badge.style.display = count ? "grid" : "none";
  }

  async function loadAlerts() {
    renderLoading("alertList", "Loading risk alerts…");
    try {
      const data = await get("/api/alerts");
      state.alerts = Array.isArray(data.alerts) ? data.alerts : [];
      updateAlertCount(state.alerts.length);
      setText("alertHeadingCount", state.alerts.length ? `· ${state.alerts.length} alerts` : "");
      const root = $("alertList");
      if (!root) return;
      if (!state.alerts.length) {
        root.innerHTML = '<div class="empty-state">No active risk alerts.</div>';
        return;
      }
      root.innerHTML = state.alerts.map(renderAlertItem).join("");
      qsa("[data-account]", root).forEach((node) => node.addEventListener("click", () => investigateAccount(node.dataset.account)));
    } catch (error) {
      console.error("[FinSentinels] Alerts failed:", error);
      renderError("alertList", `Unable to load risk alerts: ${error.message}`);
      updateAlertCount(0);
    }
  }

  function renderAlertItem(alert) {
    const flow = alert.flow_metrics || {};
    const extras = [
      alert.cycle_count ? `${alert.cycle_count} cycle` : null,
      alert.shared_device_count ? `${alert.shared_device_count} shared device` : null,
      alert.mule_account ? "mule pattern" : null,
    ].filter(Boolean).join(" · ");
    return `<div class="item" data-account="${esc(alert.account_id)}">
      <div class="item-main"><div class="item-title">${esc(alert.account_id)}</div>
      <div class="item-sub">${esc((alert.reasons || []).slice(0, 2).join(" · ") || extras || "Risk signal detected")}${extras ? ` · ${esc(extras)}` : ""}</div></div>
      <div class="item-actions"><span class="pill ${riskTier(alert.status)}">${esc(alert.status)} · ${alert.risk_score ?? 0}</span></div>
    </div>`;
  }

  function renderOverviewAlerts(alerts) {
    const root = $("overviewAlerts");
    if (!root) return;
    root.innerHTML = alerts.length ? alerts.map(renderAlertItem).join("") : '<div class="small">No active risk alerts.</div>';
    qsa("[data-account]", root).forEach((node) => node.addEventListener("click", () => investigateAccount(node.dataset.account)));
  }

  async function investigateAccount(accountId) {
    const account = String(accountId || "").trim().toUpperCase();
    if (!account) return toast("Enter an account ID");
    if (!/^ACC_\d{3}$/.test(account)) return toast("Use an account like ACC_001 or ACC_097");

    setView("investigations");
    setTextValue("globalSearch", account);
    setTextValue("investigationSearch", account);
    const root = $("investigationResult");
    if (root) root.innerHTML = `<div class="card"><div class="card-body"><div class="loading">Analyzing ${esc(account)}…</div></div></div>`;

    try {
      const [score, graphResponse] = await Promise.all([
        get(`/api/score/${encodeURIComponent(account)}`),
        get(`/api/graph/${encodeURIComponent(account)}`),
      ]);
      state.currentAccount = account;
      state.currentScore = score;
      state.currentGraph = graphResponse.graph || graphResponse;
      renderInvestigation(score, state.currentGraph);
      toast(`${account} analyzed successfully`);
    } catch (error) {
      console.error("[FinSentinels] Investigation failed:", error);
      renderError("investigationResult", `Investigation failed: ${error.message}`);
      toast(`Investigation failed: ${error.message}`);
    }
  }

  function setTextValue(id, value) {
    const node = $(id);
    if (node) node.value = value;
  }

  function renderInvestigation(data, graph) {
    const root = $("investigationResult");
    if (!root) return;
    const factors = data.factors || {};
    const reasons = data.reasons || [];
    const devices = (data.shared_devices || []).map((d) => d.device_id || d.device || d.id).filter(Boolean).join(", ") || "None detected";
    const status = data.status || "SAFE";
    const factorBlocks = [
      factor("Circular routing", factors.circular_routing ?? 0),
      factor("Device sharing", factors.device_sharing ?? 0),
      factor("Transaction velocity", factors.transaction_velocity ?? 0),
      factor("Network connectivity", factors.network_connectivity ?? 0),
      factor("Mule / pass-through flow", factors.mule_flow ?? 0),
      factor("High-value activity", factors.high_value_activity ?? 0),
    ].join("");

    root.innerHTML = `<div class="kpis">
      <div class="kpi"><label>Account</label><strong>${esc(data.account_id)}</strong></div>
      <div class="kpi"><label>Risk score</label><strong style="color:${status === "HIGH RISK" ? "var(--red)" : status === "WATCH" ? "var(--amber)" : "var(--green)"}">${data.risk_score ?? 0}</strong></div>
      <div class="kpi"><label>Status</label><strong><span class="pill ${riskTier(status)}">${esc(status)}</span></strong></div>
      <div class="kpi"><label>Entities</label><strong>${graph?.nodes?.length || 0}</strong></div>
    </div>
    <div class="result-grid">
      <div class="card"><div class="card-head"><h3>Explainable Risk Assessment</h3><span class="small">Graph evidence</span></div><div class="card-body">
        ${factorBlocks}
        <div class="note"><b>Why the engine flagged it</b><br>${esc(reasons.join(" · ") || "No significant suspicious indicators detected.")}</div>
        <div class="note"><b>Shared devices</b><br>${esc(devices)}</div>
        <div class="note"><b>Fund flow</b><br>${esc(formatFlow(data.flow_metrics || {}))}</div>
        ${status !== "SAFE" ? '<button class="primary" id="investigationCreateCase" style="margin-top:12px;width:100%">Create Case / Flag for Review</button>' : '<div class="note">This account is currently below the case-creation threshold.</div>'}
      </div></div>
      <div class="card"><div class="card-head"><h3>Connected Entities</h3><button class="secondary" id="openInvestigationNetwork" type="button">Open Network</button></div><div class="card-body"><div class="items">
        ${(graph?.nodes || []).map((node) => `<div class="item" data-node="${esc(node.id)}" data-node-type="${esc(node.type || "account")}"><div class="item-main"><div class="item-title">${esc(node.id)}</div><div class="item-sub">${node.type === "device" ? "Shared infrastructure" : node.type === "merchant" ? "Merchant relationship" : node.type === "location" ? "Geographic context" : "Account"}</div></div><div class="item-actions"><span class="pill ${node.type === "account" ? "neutral" : "watch"}">${esc(String(node.type || "account").toUpperCase())}</span></div></div>`).join("") || '<div class="small">No nearby entities.</div>'}
      </div></div></div>
    </div>
    <div class="card" style="margin-top:12px"><div class="card-head"><h3>Transaction Intelligence</h3><span class="small">${esc(data.account_id)}</span></div><div class="card-body" style="padding:0"><div id="investigationFeed" class="feed"></div></div></div>`;

    $("investigationCreateCase")?.addEventListener("click", createCase);
    $("openInvestigationNetwork")?.addEventListener("click", () => {
      state.networkFocus = data.account_id;
      setView("network");
    });
    qsa("[data-node]", root).forEach((node) => node.addEventListener("click", () => {
      if (node.dataset.nodeType === "account") inspectAccountNode(node.dataset.node);
      else showEntityInfo(node.dataset.node, node.dataset.nodeType);
    }));
    renderTransactionFeed(data.transactions || getTransferEdges(graph), "investigationFeed");
  }

  function formatFlow(flow) {
    if (!flow || !Object.keys(flow).length) return "No flow metrics available.";
    return `Inbound ${money(flow.inbound)} · Outbound ${money(flow.outbound)} · Pass-through ${(Number(flow.pass_through_ratio || 0) * 100).toFixed(0)}% · Retention ${(Number(flow.retention_ratio || 0) * 100).toFixed(0)}%`;
  }

  function factor(label, value) {
    const percentage = Math.max(0, Math.min(100, Number(value) || 0));
    return `<div class="factor"><div class="factor-row"><span>${esc(label)}</span><span>${percentage}%</span></div><div class="track"><div class="fill" style="width:${percentage}%"></div></div></div>`;
  }

  function getTransferEdges(graph) {
    return (graph?.edges || []).filter((edge) => edge.relation === "TRANSFER").map((edge) => ({
      transaction_id: edge.transaction_id,
      source: edge.source,
      target: edge.target,
      amount: edge.amount,
      timestamp: edge.timestamp,
      device_id: edge.device_id,
      merchant_id: edge.merchant_id,
      location: edge.location,
    }));
  }

  function renderTransactionFeed(rows, targetId) {
    const root = $(targetId);
    if (!root) return;
    if (!rows.length) {
      root.innerHTML = '<div class="small" style="padding:14px">No transactions found.</div>';
      return;
    }
    root.innerHTML = rows.map((tx) => {
      const amount = Number(tx.amount || 0);
      const risk = amount >= 20000 ? "HIGH RISK" : amount >= 5000 ? "WATCH" : "SAFE";
      const stamp = tx.timestamp ? new Date(tx.timestamp).toLocaleTimeString("en-IN", { hour12: false }) : "—";
      const context = [tx.device_id, tx.merchant_id, tx.location].filter(Boolean).join(" · ");
      return `<div class="feed-row"><div class="feed-time">${esc(stamp)}</div><div class="feed-flow"><b>${esc(tx.source || "—")}</b> → <b>${esc(tx.target || "—")}</b>${context ? ` · ${esc(context)}` : ""}</div><div class="feed-amount">${money(amount)}</div><span class="pill ${riskTier(risk)}">${risk}</span></div>`;
    }).join("");
  }

  async function createCase() {
    const account = state.currentAccount || state.currentScore?.account_id;
    if (!account || !state.currentScore) return toast("Investigate an account first");
    const button = $("investigationCreateCase") || $("btnFlag");
    if (button) {
      button.disabled = true;
      button.textContent = "Creating case…";
    }
    try {
      const result = await post("/api/cases", {
        account_id: account,
        priority: state.currentScore.status === "HIGH RISK" ? "HIGH" : "MEDIUM",
        note: (state.currentScore.reasons || []).join(" · "),
      });
      toast(result.existing ? `${result.case_id} already open` : `${result.case_id} created successfully`);
      if (button) button.textContent = `${result.case_id} Created`;
      state.selectedCase = result;
      await loadCases();
      await openCase(result.case_id);
    } catch (error) {
      console.error("[FinSentinels] Create case failed:", error);
      if (button) {
        button.disabled = false;
        button.textContent = "Create Case / Flag for Review";
      }
      toast(`Could not create case: ${error.message}`);
    }
  }

  async function loadCases() {
    renderLoading("caseList", "Loading investigation cases…");
    try {
      const data = await get("/api/cases");
      state.cases = Array.isArray(data.cases) ? data.cases : [];
      setText("caseCount", `${state.cases.length} cases`);
      const root = $("caseList");
      if (!root) return;
      if (!state.cases.length) {
        root.innerHTML = '<div class="empty-state">No cases yet. Investigate a risky account and create a case.</div>';
        return;
      }
      root.innerHTML = state.cases.map(renderCaseItem).join("");
      qsa("[data-open-case]", root).forEach((row) => row.addEventListener("click", () => openCase(row.dataset.openCase)));
      qsa("[data-close-case]", root).forEach((button) => button.addEventListener("click", (event) => {
        event.stopPropagation();
        closeCase(button.dataset.closeCase);
      }));
    } catch (error) {
      console.error("[FinSentinels] Cases failed:", error);
      renderError("caseList", `Unable to load cases: ${error.message}`);
    }
  }

  function renderCaseItem(caseItem) {
    const status = String(caseItem.status || "OPEN").toUpperCase();
    const risk = String(caseItem.risk_status || "SAFE").toUpperCase();
    return `<div class="item" data-open-case="${esc(caseItem.case_id)}">
      <div class="item-main"><div class="item-title">${esc(caseItem.case_id)} · ${esc(caseItem.account_id)}</div><div class="item-sub">${esc(caseItem.note || "No analyst note")} · ${esc(time(caseItem.created_at))}</div></div>
      <div class="item-actions"><span class="pill ${riskTier(risk)}">${esc(risk)} · ${caseItem.risk_score ?? 0}</span><span class="pill ${status === "CLOSED" || status === "DISMISSED" ? "safe" : "watch"}">${esc(status)}</span>${!["CLOSED", "DISMISSED"].includes(status) ? `<button class="secondary" data-close-case="${esc(caseItem.case_id)}" type="button">Close</button>` : ""}</div>
    </div>`;
  }

  async function openCase(caseId) {
    try {
      const detail = await get(`/api/cases/${encodeURIComponent(caseId)}`);
      state.selectedCase = detail;
      setView("case-detail");
      renderCaseDetail(detail);
    } catch (error) {
      console.error("[FinSentinels] Open case failed:", error);
      toast(`Could not open case: ${error.message}`);
    }
  }

  function renderCaseDetail(caseItem) {
    const analysis = caseItem.analysis || {};
    const evidence = Array.isArray(caseItem.evidence) ? caseItem.evidence : [];
    const timeline = Array.isArray(caseItem.timeline) ? caseItem.timeline : [];
    const risk = caseItem.risk_status || analysis.status || "SAFE";
    const status = caseItem.status || "OPEN";
    const root = $("caseDetail");
    if (!root) return;

    root.innerHTML = `<div class="case-header"><div><div class="case-id">${esc(caseItem.case_id)}</div><div class="case-account">${esc(caseItem.account_id)} · created ${esc(time(caseItem.created_at))}</div></div><div class="item-actions"><span class="pill ${riskTier(risk)}">${esc(risk)} · ${caseItem.risk_score ?? analysis.risk_score ?? 0}</span><span class="pill ${status === "CLOSED" ? "safe" : "watch"}">${esc(status)}</span></div></div>
      <div class="case-detail" style="margin-top:14px">
        <div>
          <div class="card"><div class="card-head"><h3>Case Summary</h3></div><div class="card-body"><div class="detail-grid"><div class="detail-box"><label>Account</label><strong>${esc(caseItem.account_id)}</strong></div><div class="detail-box"><label>Risk score</label><strong>${caseItem.risk_score ?? analysis.risk_score ?? 0}/100</strong></div><div class="detail-box"><label>Priority</label><strong>${esc(caseItem.priority || "MEDIUM")}</strong></div></div><div class="note"><b>Analyst note</b><br>${esc(caseItem.note || "No analyst note recorded.")}</div><div class="note"><b>Signals</b><br>${esc((caseItem.reasons || analysis.reasons || []).join(" · "))}</div></div></div>
          <div class="card"><div class="card-head"><h3>Evidence</h3><span class="small">${evidence.length} item(s)</span></div><div class="card-body"><div class="evidence">${evidence.map((item) => `<div class="evidence-item"><b>${esc(item.evidence_type)}</b><span>${esc(item.description)}</span><span class="small">${esc(time(item.timestamp))}</span></div>`).join("") || '<div class="small">No evidence yet.</div>'}</div><div class="card-body" style="border-top:1px solid var(--line)"><div class="search-big"><input id="evidenceType" class="input" placeholder="Evidence type"><input id="evidenceDescription" class="input" placeholder="Observation / supporting evidence"><button class="primary" id="addEvidenceBtn" type="button">Add</button></div></div></div>
        </div>
        <div>
          <div class="card"><div class="card-head"><h3>Case Actions</h3></div><div class="card-body"><div class="search-big"><select id="caseStatus" class="input"><option value="OPEN" ${status === "OPEN" ? "selected" : ""}>OPEN</option><option value="INVESTIGATING" ${status === "INVESTIGATING" ? "selected" : ""}>INVESTIGATING</option><option value="CLOSED" ${status === "CLOSED" ? "selected" : ""}>CLOSED</option><option value="DISMISSED" ${status === "DISMISSED" ? "selected" : ""}>DISMISSED</option></select><button class="primary" id="updateCaseBtn" type="button">Update</button></div><div class="case-actions"><button class="secondary" id="backCasesBtn" type="button">← Cases</button><button class="secondary" id="viewAccountBtn" type="button">Investigate Account</button></div></div></div>
          <div class="card"><div class="card-head"><h3>Investigation Timeline</h3></div><div class="card-body"><div class="timeline">${timeline.map((event) => `<div class="tl"><div class="tl-dot"></div><div class="tl-content"><div class="tl-title">${esc(event.title || event.type || "Event")}</div><div class="tl-desc">${esc(event.description || "")}</div><div class="tl-time">${esc(time(event.timestamp))}</div></div></div>`).join("") || '<div class="small">No timeline events.</div>'}</div></div></div>
          <div class="card"><div class="card-head"><h3>Explainable AI Summary</h3></div><div class="card-body"><div class="note">${esc(buildCaseSummary(caseItem))}</div></div></div>
        </div>
      </div>`;

    $("addEvidenceBtn")?.addEventListener("click", () => addEvidence(caseItem.case_id));
    $("updateCaseBtn")?.addEventListener("click", () => updateCase(caseItem.case_id));
    $("backCasesBtn")?.addEventListener("click", () => setView("cases"));
    $("viewAccountBtn")?.addEventListener("click", () => investigateAccount(caseItem.account_id));
  }

  function buildCaseSummary(caseItem) {
    const reasons = caseItem.reasons || caseItem.analysis?.reasons || [];
    const main = reasons[0] || "No major risk indicator recorded.";
    const secondary = reasons[1] || "The case remains under analyst review.";
    return `FinSentinels assigned ${caseItem.risk_score ?? caseItem.analysis?.risk_score ?? 0}/100 to ${caseItem.account_id}. Primary graph signal: ${main}. Secondary signal: ${secondary}. The explanation is generated from the same graph evidence used by the case record.`;
  }

  async function addEvidence(caseId) {
    const type = $("evidenceType")?.value.trim();
    const description = $("evidenceDescription")?.value.trim();
    if (!type || !description) return toast("Enter evidence type and description");
    try {
      await post(`/api/cases/${encodeURIComponent(caseId)}/evidence`, { evidence_type: type, description });
      toast("Evidence added");
      await openCase(caseId);
    } catch (error) {
      console.error("[FinSentinels] Evidence failed:", error);
      toast(`Could not add evidence: ${error.message}`);
    }
  }

  async function updateCase(caseId) {
    const status = $("caseStatus")?.value;
    if (!status) return toast("Choose a case status");
    try {
      await patch(`/api/cases/${encodeURIComponent(caseId)}`, { status });
      toast(`${caseId} updated`);
      await openCase(caseId);
    } catch (error) {
      console.error("[FinSentinels] Update case failed:", error);
      toast(`Could not update case: ${error.message}`);
    }
  }

  async function closeCase(caseId) {
    try {
      await patch(`/api/cases/${encodeURIComponent(caseId)}`, { status: "CLOSED" });
      toast(`${caseId} closed`);
      if (state.currentView === "cases") await loadCases();
    } catch (error) {
      console.error("[FinSentinels] Close case failed:", error);
      toast(`Could not close case: ${error.message}`);
    }
  }

  async function loadNetwork() {
    const edgeLayer = $("netEdges");
    const nodeLayer = $("netNodes");
    if (!edgeLayer || !nodeLayer) return;
    edgeLayer.innerHTML = "";
    nodeLayer.innerHTML = '<text x="600" y="350" text-anchor="middle" fill="#718098" font-size="13" font-family="Inter">Loading transaction network…</text>';
    try {
      const data = await get(`/api/network?scope=${encodeURIComponent(state.networkMode === "full" ? "full" : "alerts")}`);
      state.networkGraph = data.graph || data;
      state.currentGraph = state.networkGraph;
      await refreshAlertsForNetwork();
      drawNetwork(state.networkGraph);
    } catch (error) {
      console.error("[FinSentinels] Network failed:", error);
      nodeLayer.innerHTML = `<text x="600" y="340" text-anchor="middle" fill="#FF5C5C" font-size="13" font-family="Inter">Network unavailable: ${esc(error.message)}</text>`;
      toast(`Network unavailable: ${error.message}`);
    }
  }

  async function refreshAlertsForNetwork() {
    try {
      const data = await get("/api/alerts");
      state.alerts = Array.isArray(data.alerts) ? data.alerts : [];
      updateAlertCount(state.alerts.length);
    } catch (error) {
      console.error("[FinSentinels] Network alert enrichment failed:", error);
    }
  }

  function installNetworkViewport(svg) {
    if (!svg || svg.__finViewportInstalled) return;
    svg.__finViewportInstalled = true;
    const base = { x: 0, y: 0, w: 1200, h: 700 };
    state.networkView = state.networkView || { ...base, initialized: false };
    if (!state.networkView.initialized) Object.assign(state.networkView, base, { initialized: true });

    const apply = () => svg.setAttribute("viewBox", `${state.networkView.x} ${state.networkView.y} ${state.networkView.w} ${state.networkView.h}`);
    const point = (event) => {
      const rect = svg.getBoundingClientRect();
      const nx = (event.clientX - rect.left) / Math.max(rect.width, 1);
      const ny = (event.clientY - rect.top) / Math.max(rect.height, 1);
      return {
        x: state.networkView.x + nx * state.networkView.w,
        y: state.networkView.y + ny * state.networkView.h,
      };
    };

    svg.addEventListener("wheel", (event) => {
      event.preventDefault();
      const before = point(event);
      const factor = event.deltaY > 0 ? 1.12 : 0.89;
      const nextW = Math.max(250, Math.min(1400, state.networkView.w * factor));
      const nextH = Math.max(190, Math.min(1050, state.networkView.h * factor));
      const sx = nextW / state.networkView.w;
      const sy = nextH / state.networkView.h;
      state.networkView.x = before.x - (before.x - state.networkView.x) * sx;
      state.networkView.y = before.y - (before.y - state.networkView.y) * sy;
      state.networkView.w = nextW;
      state.networkView.h = nextH;
      apply();
    }, { passive: false });

    let pan = null;
    svg.addEventListener("pointerdown", (event) => {
      if (event.target.closest?.(".net-node")) return;
      pan = { x: event.clientX, y: event.clientY, viewX: state.networkView.x, viewY: state.networkView.y, pointerId: event.pointerId };
      svg.setPointerCapture?.(event.pointerId);
      svg.style.cursor = "grabbing";
    });
    svg.addEventListener("pointermove", (event) => {
      if (!pan) return;
      const rect = svg.getBoundingClientRect();
      const sx = state.networkView.w / Math.max(rect.width, 1);
      const sy = state.networkView.h / Math.max(rect.height, 1);
      state.networkView.x = pan.viewX - (event.clientX - pan.x) * sx;
      state.networkView.y = pan.viewY - (event.clientY - pan.y) * sy;
      apply();
    });
    const stopPan = () => { if (pan) { pan = null; svg.style.cursor = "grab"; } };
    svg.addEventListener("pointerup", stopPan);
    svg.addEventListener("pointercancel", stopPan);
    svg.addEventListener("pointerleave", (event) => { if (pan && event.buttons === 0) stopPan(); });
    svg.addEventListener("dblclick", (event) => {
      if (event.target.closest?.(".net-node")) return;
      Object.assign(state.networkView, base, { initialized: true });
      apply();
    });
    svg.style.cursor = "grab";
    apply();
  }

  function networkNodeRadius(node, risk, focus) {
    const type = String(node.type || "account").toLowerCase();
    if (type === "device") return 11;
    if (type === "merchant" || type === "location") return 14;
    if (focus) return 25;
    if (risk === "HIGH RISK") return 17;
    if (risk === "WATCH") return 15;
    return 13;
  }

  function hashString(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function normalizeNode(raw) {
    const node = raw || {};
    const rawType = String(node.type || node.node_type || node.entity_type || "account").toLowerCase();
    const type = ["account", "device", "merchant", "location"].includes(rawType) ? rawType : "account";
    const riskScore = Number(node.risk_score ?? node.score ?? 0);
    const tier = String(node.tier || node.risk_tier || (riskScore > 70 ? "high" : "" )).toLowerCase();
    return { ...node, id: String(node.id ?? node.node_id ?? node.name ?? "").trim(), label: String(node.label ?? node.name ?? node.id ?? "").trim(), type, risk_score: Number.isFinite(riskScore) ? riskScore : 0, tier };
  }

  function normalizeEdge(raw) {
    const edge = raw || {};
    return {
      ...edge,
      source: String(edge.source ?? edge.from ?? edge.source_account ?? "").trim(),
      target: String(edge.target ?? edge.to ?? edge.target_account ?? "").trim(),
      relation: String(edge.relation ?? edge.edge_type ?? edge.type ?? "LINK").toUpperCase(),
      amount: Number(edge.amount ?? edge.total_amount ?? edge.value ?? 0) || 0,
      total_amount: Number(edge.total_amount ?? edge.amount ?? edge.value ?? 0) || 0,
      transaction_count: Math.max(1, Number(edge.transaction_count ?? edge.count ?? 1) || 1),
      weight: Math.max(1, Number(edge.weight ?? edge.transaction_count ?? edge.count ?? 1) || 1),
      transaction_ids: Array.isArray(edge.transaction_ids) ? edge.transaction_ids.slice() : (edge.transaction_id ? [edge.transaction_id] : []),
    };
  }

  function dedupeGraphEdges(edges) {
    const result = new Map();
    for (const edge of edges) {
      if (!edge.source || !edge.target || edge.source === edge.target) continue;
      if (edge.relation !== "TRANSFER") {
        const key = `${edge.source}|${edge.target}|${edge.relation}`;
        if (!result.has(key)) result.set(key, { ...edge });
        continue;
      }
      const key = `${edge.source}|${edge.target}|TRANSFER`;
      const existing = result.get(key);
      if (!existing) {
        result.set(key, { ...edge, transaction_ids: [...edge.transaction_ids] });
        continue;
      }
      existing.transaction_count += edge.transaction_count;
      existing.total_amount += edge.total_amount;
      existing.amount = existing.total_amount;
      existing.weight = Math.min(8, Math.max(1, existing.transaction_count));
      existing.transaction_ids.push(...edge.transaction_ids);
      if (!existing.timestamp || (edge.timestamp && String(edge.timestamp) > String(existing.timestamp))) {
        existing.timestamp = edge.timestamp;
        existing.transaction_id = edge.transaction_id || existing.transaction_id;
      }
    }
    return [...result.values()];
  }

  function drawNetwork(graph) {
    const edgeLayer = $("netEdges");
    const nodeLayer = $("netNodes");
    const collateralRoot = $("collateralList");
    const collateralCount = $("collateralCount");
    const svg = $("networkSvg");
    if (!edgeLayer || !nodeLayer || !svg) return;
    installNetworkViewport(svg);

    // Preserve user positions between refreshes; only new nodes receive a fresh layout.
    const previous = state.networkLayout?.positions || {};
    edgeLayer.innerHTML = "";
    nodeLayer.innerHTML = "";
    if (collateralRoot) collateralRoot.innerHTML = "";
    if (collateralCount) collateralCount.textContent = "0";

    if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) {
      nodeLayer.innerHTML = '<text x="600" y="350" text-anchor="middle" fill="#718098" font-size="13" font-family="Inter">No network data available</text>';
      return;
    }

    const allNodes = (Array.isArray(graph.nodes) ? graph.nodes : (Array.isArray(graph.data?.nodes) ? graph.data.nodes : [])).map(normalizeNode);
    const rawEdges = Array.isArray(graph.edges) ? graph.edges : (Array.isArray(graph.links) ? graph.links : (Array.isArray(graph.data?.edges) ? graph.data.edges : (Array.isArray(graph.data?.links) ? graph.data.links : [])));
    const allEdges = dedupeGraphEdges(rawEdges.map(normalizeEdge));
    const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
    const riskMap = new Map((state.alerts || []).map((a) => [String(a.account_id || "").toUpperCase(), a]));
    const isHighRiskNode = (node) => {
      const alert = riskMap.get(String(node.id).toUpperCase());
      const score = Number(alert?.risk_score ?? node.risk_score ?? 0);
      const tier = String(alert?.tier ?? node.tier ?? "").toLowerCase();
      const status = String(alert?.status ?? "").toUpperCase();
      return score > 70 || tier === "high" || status === "HIGH RISK";
    };
    const riskAccounts = new Set(allNodes.filter((n) => isHighRiskNode(n)).map((n) => n.id));
    const ringAccounts = new Set((state.alerts || []).filter((a) => Number(a.cycle_count || 0) > 0).map((a) => a.account_id));
    const muleAccounts = new Set((state.alerts || []).filter((a) => Boolean(a.mule_account)).map((a) => a.account_id));
    const focusId = String(state.networkFocus || state.currentAccount || "").trim().toUpperCase();

    const adjacency = new Map(allNodes.map((node) => [node.id, new Set()]));
    for (const edge of allEdges) {
      if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
      adjacency.get(edge.source).add(edge.target);
      adjacency.get(edge.target).add(edge.source);
    }
    function bfsDistances(start, cutoff = 2) {
      const distances = new Map([[start, 0]]);
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        const distance = distances.get(current) || 0;
        if (distance >= cutoff) continue;
        for (const next of adjacency.get(current) || []) if (!distances.has(next)) { distances.set(next, distance + 1); queue.push(next); }
      }
      return distances;
    }

    let visibleNodes;
    let focused = false;
    let distances = null;
    if (focusId && nodeMap.has(focusId)) {
      focused = true;
      distances = bfsDistances(focusId, 2);
      visibleNodes = allNodes.filter((node) => distances.has(node.id));
      visibleNodes.sort((a, b) => {
        const da = distances.get(a.id) ?? 99, db = distances.get(b.id) ?? 99;
        const typePriority = (node) => {
          if (node.id === focusId) return 0;
          if (riskAccounts.has(node.id) || ringAccounts.has(node.id) || muleAccounts.has(node.id)) return 1;
          // Keep semantic relationship nodes visible during focused rendering.
          if (node.type === "location") return 2;
          if (node.type === "merchant") return 3;
          if (node.type === "account") return 4;
          return 5;
        };
        return da - db || typePriority(a) - typePriority(b) || String(a.id).localeCompare(String(b.id));
      });

      // Never truncate locations/merchants out of a focused graph. If the
      // account neighborhood is large, trim ordinary account/device nodes first.
      const semanticNodes = visibleNodes.filter((node) => ["location", "merchant"].includes(node.type));
      const priorityNodes = visibleNodes.filter((node) => !["location", "merchant"].includes(node.type));
      visibleNodes = priorityNodes.slice(0, Math.max(0, 76 - semanticNodes.length)).concat(semanticNodes);
    } else if (state.networkMode === "full") {
      visibleNodes = allNodes.slice();
    } else {
      // Compact default: HIGH RISK alert accounts + direct 1-hop neighbors.
      // Falls back to WATCH alerts when no HIGH RISK accounts are present.
      const seeds = allNodes.filter((n) => n.type === "account" && riskMap.get(n.id)?.status === "HIGH RISK");
      const fallbackSeeds = seeds.length
        ? seeds
        : allNodes.filter((n) => n.type === "account" && riskMap.get(n.id)?.status === "WATCH");
      const keep = new Set(fallbackSeeds.map((n) => n.id));
      for (const seed of fallbackSeeds) {
        for (const neighbor of adjacency.get(seed.id) || []) keep.add(neighbor);
      }
      // Semantic nodes are part of the relationship evidence and must never be
      // dropped just because the renderer is in its compact alert mode.
      for (const node of allNodes) {
        if (node.type !== "location" && node.type !== "merchant") continue;
        const linkedToSeed = fallbackSeeds.some((seed) => (adjacency.get(seed.id) || new Set()).has(node.id));
        if (linkedToSeed) keep.add(node.id);
      }
      visibleNodes = allNodes.filter((n) => keep.has(n.id));
    }

    if (state.networkFilter === "high") visibleNodes = visibleNodes.filter((node) => node.type !== "account" || riskMap.get(node.id)?.status === "HIGH RISK");
    if (state.networkFilter === "ring") {
      const keep = new Set(); for (const id of ringAccounts) { keep.add(id); for (const n of adjacency.get(id) || []) keep.add(n); }
      visibleNodes = visibleNodes.filter((node) => keep.has(node.id));
    }
    if (state.networkFilter === "mule") {
      const keep = new Set(muleAccounts); for (const id of muleAccounts) for (const n of adjacency.get(id) || []) keep.add(n);
      visibleNodes = visibleNodes.filter((node) => keep.has(node.id));
    }

    if (!visibleNodes.length) {
      nodeLayer.innerHTML = '<text x="600" y="350" text-anchor="middle" fill="#718098" font-size="13" font-family="Inter">No nodes match this filter</text>';
      if (collateralRoot) collateralRoot.innerHTML = '<div class="collateral-empty">No device collateral for this filter.</div>';
      return;
    }

    const visibleIds = new Set(visibleNodes.map((n) => n.id));

    // Risk-aware edge filtering: the default view suppresses routine
    // background traffic. The existing "Full Network" toggle restores all
    // edges for inspection. High-risk status OR risk score > 70 keeps an edge
    // visible; relationship edges attached to those nodes remain as evidence.
    const riskScore = (nodeId) => {
      const alert = riskMap.get(nodeId);
      if (alert && Number.isFinite(Number(alert.risk_score))) return Number(alert.risk_score);
      if (nodeId === state.currentScore?.account_id) return Number(state.currentScore?.risk_score || 0);
      const node = nodeMap.get(nodeId);
      return Number(node?.risk_score || 0);
    };
    const highRiskIds = new Set(visibleNodes.filter(isHighRiskNode).map((node) => node.id));

    let visibleEdges = allEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    if (state.networkMode !== 'full') {
      visibleEdges = visibleEdges.filter((edge) => highRiskIds.has(edge.source) || highRiskIds.has(edge.target));
    }

    // Collapse repeated directed transfers between the same two nodes into a
    // single visual edge. The backend already performs this compaction for
    // serialized data, but keeping a frontend guard makes live updates safe.
    const collapsed = new Map();
    const passthrough = [];
    for (const edge of visibleEdges) {
      if (String(edge.relation || '').toUpperCase() !== 'TRANSFER') {
        passthrough.push(edge);
        continue;
      }
      const key = `${edge.source}|${edge.target}|TRANSFER`;
      const existing = collapsed.get(key);
      const amount = Number(edge.amount || 0);
      const count = Number(edge.transaction_count || 1);
      if (!existing) {
        collapsed.set(key, {
          ...edge,
          transaction_count: count,
          transaction_ids: Array.isArray(edge.transaction_ids) ? [...edge.transaction_ids] : (edge.transaction_id ? [edge.transaction_id] : []),
          total_amount: Number(edge.total_amount ?? amount),
          max_amount: Number(edge.max_amount ?? amount),
          weight: Number(edge.weight ?? Math.max(1, Math.min(6, count))),
        });
      } else {
        existing.transaction_count += count;
        existing.total_amount = Number(existing.total_amount || 0) + Number(edge.total_amount ?? amount);
        existing.max_amount = Math.max(Number(existing.max_amount || 0), Number(edge.max_amount ?? amount));
        existing.weight = Math.max(1, Math.min(6, existing.transaction_count));
        if (Array.isArray(edge.transaction_ids)) existing.transaction_ids.push(...edge.transaction_ids);
        else if (edge.transaction_id) existing.transaction_ids.push(edge.transaction_id);
        if (!existing.timestamp || (edge.timestamp && String(edge.timestamp) > String(existing.timestamp))) {
          existing.timestamp = edge.timestamp;
          existing.transaction_id = edge.transaction_id || existing.transaction_id;
        }
      }
    }
    visibleEdges = [...collapsed.values(), ...passthrough];

    const deviceDegree = new Map();
    for (const edge of allEdges) {
      const s = nodeMap.get(edge.source), t = nodeMap.get(edge.target);
      if (s?.type === "account" && t?.type === "device") deviceDegree.set(edge.target, (deviceDegree.get(edge.target) || 0) + 1);
    }
    const graphDevices = new Set();
    const collateralDevices = [];
    for (const node of allNodes.filter((n) => n.type === "device")) {
      const degree = deviceDegree.get(node.id) || 0;
      const important = degree > 1 && (!focused || node.id === focusId || visibleEdges.some((e) => e.target === node.id && (e.source === focusId || riskAccounts.has(e.source) || ringAccounts.has(e.source))));
      if (important && visibleIds.has(node.id)) graphDevices.add(node.id);
      else if (degree > 0 && (!focused || visibleIds.has(node.id))) collateralDevices.push({ node, degree });
    }

    const mainNodes = visibleNodes.filter((node) => node.type !== "device" || graphDevices.has(node.id));
    const mainIds = new Set(mainNodes.map((node) => node.id));
    visibleEdges = visibleEdges.filter((edge) => mainIds.has(edge.source) && mainIds.has(edge.target));
    visibleEdges.sort((a, b) => {
      const score = (e) => e.relation === "TRANSFER" && (e.source === focusId || e.target === focusId || riskAccounts.has(e.source) || riskAccounts.has(e.target) || ringAccounts.has(e.source) || ringAccounts.has(e.target)) ? 0 : e.relation === "TRANSFER" ? 1 : 2;
      return score(a) - score(b);
    });
    visibleEdges = visibleEdges.slice(0, focused ? 180 : 160);

    // Force-style layout: no hard bounding-box clamping.
    const W = 1200, H = 700, cx = W / 2, cy = H / 2;
    const positions = {};
    const hotAccounts = mainNodes.filter((n) => n.type === "account" && (riskAccounts.has(n.id) || ringAccounts.has(n.id) || muleAccounts.has(n.id)));

    let seedIndex = 0;
    for (const node of mainNodes) {
      if (previous[node.id] && Number.isFinite(previous[node.id].x) && Number.isFinite(previous[node.id].y)) {
        positions[node.id] = { ...previous[node.id] };
        continue;
      }
      const golden = 2.399963229728653;
      const radius = 70 + Math.sqrt(seedIndex + 1) * 34;
      const angle = seedIndex * golden;
      const jitter = ((hashString(String(node.id)) % 31) - 15) * 1.2;
      positions[node.id] = {
        x: cx + Math.cos(angle) * (radius + jitter),
        y: cy + Math.sin(angle) * (radius + jitter),
      };
      seedIndex += 1;
    }

    // High-risk accounts start near the center but are free to move under physics.
    hotAccounts.forEach((node, i) => {
      if (previous[node.id]) return;
      const angle = -Math.PI / 2 + (i / Math.max(hotAccounts.length, 1)) * Math.PI * 2;
      const r = hotAccounts.length === 1 ? 0 : 58;
      positions[node.id] = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
    });

    const work = mainNodes.map((node) => ({
      node, x: positions[node.id]?.x ?? cx, y: positions[node.id]?.y ?? cy, vx: 0, vy: 0,
    }));
    const index = new Map(work.map((item, i) => [item.node.id, i]));
    const pairs = visibleEdges.map((edge) => ({ a: index.get(edge.source), b: index.get(edge.target), edge }))
      .filter((p) => Number.isInteger(p.a) && Number.isInteger(p.b));

    const iterations = state.networkMode === "full" ? 110 : (focused ? 95 : 85);
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < work.length; i++) {
        for (let j = i + 1; j < work.length; j++) {
          const a = work[i], b = work[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.max(0.01, Math.hypot(dx, dy));
          const ux = dx / d, uy = dy / d;
          const ra = networkNodeRadius(a.node, riskMap.get(a.node.id)?.status, a.node.id === focusId);
          const rb = networkNodeRadius(b.node, riskMap.get(b.node.id)?.status, b.node.id === focusId);
          const minD = ra + rb + 56;

          // Strong repulsion: roughly equivalent to a ForceAtlas2
          // gravitationalConstant around -250 for this lightweight solver.
          const repel = Math.min(30, 72000 / Math.max(d * d, 500));
          a.vx += ux * repel; a.vy += uy * repel;
          b.vx -= ux * repel; b.vy -= uy * repel;

          // Collision padding keeps labels/nodes from sitting on top of each other.
          if (d < minD) {
            const push = (minD - d) * 0.32;
            a.vx += ux * push; a.vy += uy * push;
            b.vx -= ux * push; b.vy -= uy * push;
          }
        }
      }

      for (const pair of pairs) {
        const a = work[pair.a], b = work[pair.b];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        // Minimum link distance target.
        const target = pair.edge.relation === "TRANSFER" ? 140 : 160;
        const spring = (d - target) * 0.012;
        const fx = dx / d * spring, fy = dy / d * spring;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }

      for (const item of work) {
        // Soft gravity only; there are NO x/y min/max clamps.
        item.vx += (cx - item.x) * 0.0009;
        item.vy += (cy - item.y) * 0.0009;
        if (riskAccounts.has(item.node.id) || ringAccounts.has(item.node.id) || muleAccounts.has(item.node.id)) {
          item.vx += (cx - item.x) * 0.0012;
          item.vy += (cy - item.y) * 0.0012;
        }
        item.vx *= 0.82; item.vy *= 0.82;
        item.x += item.vx; item.y += item.vy;
      }
    }
    for (const item of work) positions[item.node.id] = { x: item.x, y: item.y };

    // Remaining parallel relationship edges get mild curvature. Transfers are
    // already deduplicated, so we never draw a stack of 4–5 identical arcs.
    const pairCounts = new Map();
    for (const edge of visibleEdges) {
      const key = [edge.source, edge.target, edge.relation].join("|");
      const idx = pairCounts.get(key) || 0; pairCounts.set(key, idx + 1);
      edge._parallelIndex = idx; edge._parallelCount = idx + 1;
    }
    const makePath = (a, b, bend) => {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / len, ny = dx / len;
      const curve = bend * Math.min(70, 18 + len * 0.06);
      const qx = mx + nx * curve, qy = my + ny * curve;
      return { d: `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`, lx: qx, ly: qy };
    };

    const edgeRefs = [];
    for (const edge of visibleEdges) {
      const a = positions[edge.source], b = positions[edge.target]; if (!a || !b) continue;
      const relation = String(edge.relation || "").toUpperCase();
      const hot = relation === "TRANSFER" && (edge.source === focusId || edge.target === focusId || riskAccounts.has(edge.source) || riskAccounts.has(edge.target) || ringAccounts.has(edge.source) || ringAccounts.has(edge.target));
      const offset = edge._parallelCount > 1 ? (edge._parallelIndex % 2 === 0 ? 1 : -1) * Math.ceil((edge._parallelCount + 1) / 2) : 0.45;
      const pathData = makePath(a, b, offset);
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.classList.add("net-edge"); group.dataset.edgeId = String(edge.id || `${edge.source}-${edge.target}`); if (hot) group.classList.add("edge-hot");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathData.d); path.setAttribute("fill", "none");
      const stroke = hot ? "#FF5C5C" : relation === "USED_DEVICE" ? "#A57A2B" : relation.includes("MERCHANT") ? "#9B7BEB" : relation.includes("LOCATION") || relation === "OCCURRED_AT" ? "#69AEE8" : "#344254";
      path.setAttribute("stroke", stroke); path.setAttribute("stroke-width", hot ? String(Math.min(4.5, 1.8 + Number(edge.weight || 1) * 0.45)) : relation === "TRANSFER" ? "1.1" : "0.9"); path.setAttribute("stroke-dasharray", relation === "TRANSFER" ? "" : "5 5"); path.setAttribute("marker-end", `url(#${hot ? "arrowRed" : "arrow"})`); path.setAttribute("opacity", hot ? "0.98" : "0.66"); group.appendChild(path);
      const hit = document.createElementNS("http://www.w3.org/2000/svg", "path"); hit.setAttribute("d", pathData.d); hit.setAttribute("fill", "none"); hit.setAttribute("stroke", "transparent"); hit.setAttribute("stroke-width", "16"); hit.style.cursor = "pointer"; group.appendChild(hit);
      if (relation === "TRANSFER" && edge.amount != null) {
        const lg = document.createElementNS("http://www.w3.org/2000/svg", "g"); lg.classList.add("net-edge-label");
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text"); text.setAttribute("x", pathData.lx); text.setAttribute("y", pathData.ly - 2); text.setAttribute("text-anchor", "middle"); text.setAttribute("fill", hot ? "#FFD0D0" : "#A9B3C2"); text.setAttribute("font-size", hot ? "9" : "8.2"); text.setAttribute("font-family", "JetBrains Mono, monospace");
        const labelAmount = Number(edge.total_amount ?? edge.amount ?? 0);
        text.textContent = edge.transaction_count > 1 ? `${money(labelAmount)} · ${edge.transaction_count} tx` : money(labelAmount);
        const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect"); const labelText = edge.transaction_count > 1 ? `${money(labelAmount)} · ${edge.transaction_count} tx` : money(labelAmount); const width = Math.max(44, labelText.length * 6 + 10); bg.setAttribute("x", pathData.lx - width/2); bg.setAttribute("y", pathData.ly - 12); bg.setAttribute("width", width); bg.setAttribute("height", 14); bg.setAttribute("rx", 4); bg.classList.add("net-edge-label-bg"); lg.appendChild(bg); lg.appendChild(text); group.appendChild(lg);
        hit.addEventListener("mouseenter", () => group.classList.add("edge-show-label")); hit.addEventListener("mouseleave", () => { if (!group.classList.contains("edge-pinned")) group.classList.remove("edge-show-label"); }); hit.addEventListener("click", (event) => { event.stopPropagation(); group.classList.toggle("edge-pinned"); });
      }
      edgeLayer.appendChild(group); edgeRefs.push({ edge, path, hit, labelGroup: group.querySelector(".net-edge-label"), curve: offset });
    }

    const nodeRefs = [];
    for (const node of mainNodes) {
      const p = positions[node.id]; if (!p) continue;
      const type = String(node.type || "account").toLowerCase();
      const alert = riskMap.get(node.id); const isFocus = node.id === focusId;
      const risk = isHighRiskNode(node) ? "HIGH RISK" : String(alert?.status || (node.id === state.currentScore?.account_id ? state.currentScore?.status : "SAFE")).toUpperCase();
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g"); group.classList.add("net-node"); if (isFocus) group.classList.add("node-focus"); group.setAttribute("tabindex", "0"); group.dataset.nodeId = node.id;
      const fill = type === "device" ? "#F0A93A" : type === "merchant" ? "#9B7BEB" : type === "location" ? "#69AEE8" : risk === "HIGH RISK" ? "#FF5C5C" : risk === "WATCH" ? "#F0A93A" : "#4F7CFF";
      const stroke = isFocus ? "#FFFFFF" : risk === "HIGH RISK" ? "#FFB1B1" : "#263955";
      if (isFocus && type === "account") { const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle"); halo.setAttribute("cx", p.x); halo.setAttribute("cy", p.y); halo.setAttribute("r", "38"); halo.setAttribute("fill", "none"); halo.setAttribute("stroke", risk === "HIGH RISK" ? "#FF5C5C" : "#F0A93A"); halo.setAttribute("stroke-width", "1.5"); halo.setAttribute("stroke-dasharray", "4 6"); halo.setAttribute("opacity", ".9"); group.appendChild(halo); }
      let shape;
      if (type === "device") { shape = document.createElementNS("http://www.w3.org/2000/svg", "rect"); shape.setAttribute("x", p.x-11); shape.setAttribute("y", p.y-11); shape.setAttribute("width", "22"); shape.setAttribute("height", "22"); shape.setAttribute("rx", "4"); }
      else if (type === "merchant") { shape = document.createElementNS("http://www.w3.org/2000/svg", "polygon"); shape.setAttribute("points", `${p.x},${p.y-13} ${p.x+13},${p.y} ${p.x},${p.y+13} ${p.x-13},${p.y}`); }
      else if (type === "location") { shape = document.createElementNS("http://www.w3.org/2000/svg", "polygon"); shape.setAttribute("points", `${p.x},${p.y-14} ${p.x+12},${p.y+10} ${p.x-12},${p.y+10}`); }
      else { shape = document.createElementNS("http://www.w3.org/2000/svg", "circle"); shape.setAttribute("cx", p.x); shape.setAttribute("cy", p.y); shape.setAttribute("r", String(networkNodeRadius(node, risk, isFocus))); }
      shape.setAttribute("fill", fill); shape.setAttribute("stroke", stroke); shape.setAttribute("stroke-width", isFocus ? "2.7" : "1.5"); group.appendChild(shape);
      const important = isFocus || type !== "account" || risk !== "SAFE" || mainNodes.length <= 34;
      let label = null, labelBg = null;
      if (important) {
        label = document.createElementNS("http://www.w3.org/2000/svg", "text"); label.setAttribute("x", p.x); label.setAttribute("y", p.y - (isFocus ? 34 : 21)); label.setAttribute("text-anchor", "middle"); label.setAttribute("fill", isFocus ? "#F4F7FB" : "#A7B0C3"); label.setAttribute("font-size", isFocus ? "11.8" : "8.3"); label.setAttribute("font-family", "JetBrains Mono, monospace"); label.textContent = node.label || node.id; group.appendChild(label);
      }
      const connectedEdgeGroups = () => qsa(".net-edge").filter((eg) => visibleEdges.some((e) => String(e.id || `${e.source}-${e.target}`) === eg.dataset.edgeId && (e.source === node.id || e.target === node.id)));
      const openNode = () => type === "account" ? inspectAccountNode(node.id) : showEntityInfo(node.id, type);
      group.addEventListener("click", (event) => { if (!group.__dragged) openNode(); group.__dragged = false; });
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openNode(); } });
      group.addEventListener("mouseenter", () => { for (const eg of qsa(".net-edge")) eg.classList.add("edge-dim"); for (const eg of connectedEdgeGroups()) { eg.classList.remove("edge-dim"); eg.classList.add("edge-show-label"); } });
      group.addEventListener("mouseleave", () => { for (const eg of qsa(".net-edge")) eg.classList.remove("edge-dim"); for (const eg of connectedEdgeGroups()) if (!eg.classList.contains("edge-pinned")) eg.classList.remove("edge-show-label"); });
      group.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        const rect = svg.getBoundingClientRect(); const nx = (event.clientX - rect.left) / Math.max(rect.width,1); const ny = (event.clientY - rect.top) / Math.max(rect.height,1);
        const sx = state.networkView.w / Math.max(rect.width,1), sy = state.networkView.h / Math.max(rect.height,1);
        group.setPointerCapture?.(event.pointerId);
        group.__drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, offsetX: p.x - (state.networkView.x + nx * state.networkView.w), offsetY: p.y - (state.networkView.y + ny * state.networkView.h), sx, sy };
      });
      group.addEventListener("pointermove", (event) => {
        const d = group.__drag; if (!d) return; if (Math.hypot(event.clientX-d.startX,event.clientY-d.startY) > 3) group.__dragged = true;
        const rect = svg.getBoundingClientRect(); const nx = (event.clientX - rect.left) / Math.max(rect.width,1); const ny = (event.clientY - rect.top) / Math.max(rect.height,1);
        p.x = state.networkView.x + nx * state.networkView.w + d.offsetX; p.y = state.networkView.y + ny * state.networkView.h + d.offsetY;
        positions[node.id] = { x:p.x, y:p.y }; updateNetworkGeometry();
      });
      const endDrag = () => { if (group.__drag) { group.__drag = null; state.networkLayout = state.networkLayout || {}; state.networkLayout.positions = { ...(state.networkLayout.positions || {}), [node.id]: { ...p } }; } };
      group.addEventListener("pointerup", endDrag); group.addEventListener("pointercancel", endDrag);
      nodeLayer.appendChild(group); nodeRefs.push({ node, group, position:p, shape, label });
    }

    function updateNetworkGeometry() {
      for (const ref of nodeRefs) {
        const p = positions[ref.node.id]; if (!p) continue; ref.position.x = p.x; ref.position.y = p.y;
        const type = String(ref.node.type || "account").toLowerCase();
        if (type === "device") ref.shape.setAttribute("x", p.x-11), ref.shape.setAttribute("y", p.y-11);
        else if (type === "merchant") ref.shape.setAttribute("points", `${p.x},${p.y-13} ${p.x+13},${p.y} ${p.x},${p.y+13} ${p.x-13},${p.y}`);
        else if (type === "location") ref.shape.setAttribute("points", `${p.x},${p.y-14} ${p.x+12},${p.y+10} ${p.x-12},${p.y+10}`);
        else ref.shape.setAttribute("cx", p.x), ref.shape.setAttribute("cy", p.y);
        if (ref.label) { const focus = ref.node.id === focusId; ref.label.setAttribute("x", p.x); ref.label.setAttribute("y", p.y - (focus ? 34 : 21)); }
      }
      for (const er of edgeRefs) {
        const a = positions[er.edge.source], b = positions[er.edge.target]; if (!a || !b) continue;
        const d = makePath(a,b,er.curve); er.path.setAttribute("d",d.d); er.hit.setAttribute("d",d.d);
        if (er.labelGroup) { const text = er.labelGroup.querySelector("text"), bg = er.labelGroup.querySelector("rect"); if (text) text.setAttribute("x",d.lx), text.setAttribute("y",d.ly-2); if (bg) { const width = Number(bg.getAttribute("width") || 44); bg.setAttribute("x",d.lx-width/2); bg.setAttribute("y",d.ly-12); } }
      }
    }

    // Keep positions for the next live refresh.
    state.networkLayout = { positions: { ...positions }, nodes: mainNodes, edges: visibleEdges, focused };
    updateNetworkGeometry();

    if (collateralRoot) {
      collateralDevices.sort((a,b) => b.degree-a.degree || String(a.node.id).localeCompare(String(b.node.id)));
      for (const item of collateralDevices.slice(0,32)) {
        const box=document.createElement("div"); box.className="collateral-item";
        const title=document.createElement("strong"); title.textContent=item.node.label || item.node.id;
        const subtitle=document.createElement("span"); subtitle.textContent=`${item.degree} linked account${item.degree===1?"":"s"} · collateral only`;
        box.appendChild(title); box.appendChild(subtitle); box.addEventListener("click",()=>showEntityInfo(item.node.id,"device")); collateralRoot.appendChild(box);
      }
      if (!collateralRoot.children.length) collateralRoot.innerHTML='<div class="collateral-empty">No low-connectivity devices are outside the main graph.</div>';
    }
    if (collateralCount) collateralCount.textContent=String(Math.min(collateralDevices.length,32));
  }

  async function inspectAccountNode(accountId) {
    const aid = String(accountId || "").trim().toUpperCase();
    if (!/^ACC_\d{3}$/.test(aid)) {
      toast("Invalid account ID");
      return;
    }
    try {
      const data = await get("/api/score/" + encodeURIComponent(aid));
      state.currentAccount = aid;
      state.currentScore = data;
      state.currentGraph = data.graph || state.currentGraph;
      setText("insType", "ACCOUNT");
      setText("insId", aid);
      setText("insScore", data.risk_score ?? 0);
      const scoreNode = $("insScore");
      if (scoreNode) scoreNode.style.color = data.status === "HIGH RISK" ? "var(--risk-high)" : data.status === "WATCH" ? "var(--risk-watch)" : "var(--risk-safe)";
      setText("insNote", (data.reasons || []).join(" · ") || "No significant suspicious graph indicators detected.");
      setText("insDevices", (data.shared_devices || []).map((d) => d.device_id || d.device || d.id).filter(Boolean).join(", ") || "None detected");
      const factors = data.factors || {};
      const factorRoot = $("insFactors");
      if (factorRoot) factorRoot.innerHTML = [
        factor("Circular routing", factors.circular_routing ?? 0),
        factor("Device sharing", factors.device_sharing ?? 0),
        factor("Transaction velocity", factors.transaction_velocity ?? 0),
        factor("Network connectivity", factors.network_connectivity ?? 0),
        factor("Mule-account signal", factors.mule_account_signal ?? 0),
      ].join("");
      const flag = $("btnFlag");
      if (flag) {
        flag.style.display = data.status === "SAFE" ? "none" : "block";
        flag.disabled = false;
        flag.textContent = "Flag for review";
      }
      $("inspector")?.classList.add("open");
      $("backdrop")?.classList.add("open");
    } catch (error) {
      console.error("[FinSentinels] Account inspection failed:", error);
      toast(`Could not inspect ${aid}: ${error.message}`);
    }
  }

  function showEntityInfo(entityId, type) {
    setText("insType", String(type || "entity").toUpperCase());
    setText("insId", entityId);
    setText("insScore", "—");
    setText("insNote", `${String(type || "Entity")} node used as relationship evidence. It is not an account and cannot be opened as a case.`);
    setText("insDevices", entityId);
    const flag = $("btnFlag");
    if (flag) flag.style.display = "none";
    $("inspector")?.classList.add("open");
    $("backdrop")?.classList.add("open");
  }

  // The inspector contains the case action as a second, redundant entry point.
  async function openInspectorCaseAction() {
    await createCase();
  }

  async function loadAnalytics() {
    try {
      const data = await get("/api/analytics");
      const network = data.network || {};
      const risk = data.risk_distribution || {};
      const fraud = data.fraud_patterns || {};
      const tx = data.transaction_metrics || {};
      const cases = data.case_metrics || {};
      setText("anAvgRisk", Number(data.average_risk_score ?? 0).toFixed(1));
      setText("anCases", cases.total ?? 0);
      setText("anConnections", network.connections ?? 0);
      setText("anShared", fraud.shared_devices ?? 0);
      setText("anCycles", fraud.active_cycles ?? 0);
      setText("anMules", fraud.mule_accounts ?? 0);
      setText("anTx", network.transactions ?? 0);
      setText("caseClosedVal", cases.closed ?? 0);
      setText("caseOpenVal", (cases.open ?? 0));
      const counts = { high: risk.high_risk || 0, watch: risk.watch || 0, safe: risk.safe || 0 };
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1;
      for (const key of ["high", "watch", "safe"]) {
        const label = key[0].toUpperCase() + key.slice(1);
        setText(`risk${label}Val`, counts[key]);
        const bar = $(`risk${label}Bar`);
        if (bar) bar.style.width = `${(counts[key] / total) * 100}%`;
      }
      const openBar = $("caseOpenBar");
      if (openBar) openBar.style.width = `${Math.min(100, ((cases.open || 0) / Math.max(cases.total || 1, 1)) * 100)}%`;
      setText("anVolume", money(tx.total_volume || 0));
    } catch (error) {
      console.error("[FinSentinels] Analytics failed:", error);
      toast(`Analytics unavailable: ${error.message}`);
    }
  }

  async function loadSettings() {
    try {
      const settings = await get("/api/settings");
      setTextValue("highThreshold", settings.high_threshold);
      setTextValue("watchThreshold", settings.watch_threshold);
      setTextValue("graphDepth", settings.graph_depth);
    } catch (error) {
      console.error("[FinSentinels] Settings load failed:", error);
      toast(`Settings unavailable: ${error.message}`);
    }
  }

  async function saveSettings() {
    const high = Number($("highThreshold")?.value);
    const watch = Number($("watchThreshold")?.value);
    const depth = Number($("graphDepth")?.value);
    if (![high, watch, depth].every(Number.isFinite)) return toast("Enter valid settings");
    if (watch >= high) return toast("Watch threshold must be lower than high-risk threshold");
    try {
      await put("/api/settings", { high_threshold: high, watch_threshold: watch, graph_depth: depth });
      setText("settingsMessage", "Saved");
      toast("Settings saved; risk classifications refreshed");
      await loadOverview();
    } catch (error) {
      console.error("[FinSentinels] Settings save failed:", error);
      toast(`Could not save settings: ${error.message}`);
    }
  }

  async function openProfile() {
    try {
      const profile = await get("/api/profile");
      setText("profileModalName", profile.name || "R. Kulkarni");
      setText("profileOpen", profile.active_cases ?? 0);
      setText("profileTotal", profile.total_cases ?? 0);
      setText("profileSystem", profile.system || "Online");
      setText("profileModalAvatar", initials(profile.name || "RK"));
      $("profileModal")?.classList.add("open");
    } catch (error) {
      console.error("[FinSentinels] Profile failed:", error);
      toast(`Profile unavailable: ${error.message}`);
    }
  }

  function initials(name) {
    return String(name || "RK").split(/\s+/).filter(Boolean).map((part) => part[0]).join("").toUpperCase().slice(0, 2);
  }

  async function login() {
    const name = ($( "loginName")?.value || "R. Kulkarni").trim() || "R. Kulkarni";
    const code = ($( "loginCode")?.value || "").trim().toUpperCase();
    if (code !== "FINSENTINELS") {
      setText("loginError", "Invalid access code. Use FINSENTINELS.");
      $("loginCode")?.focus();
      return;
    }
    try {
      localStorage.setItem("finSentinelsAnalyst", name);
      state.loggedIn = true;
      $("login")?.classList.add("hidden");
      $("app")?.classList.remove("hidden");
      $("app")?.style && ($("app").style.display = "grid");
      setText("topProfileName", name);
      setText("profileAvatar", initials(name));
      setText("loginError", "");
      setView("overview");
      startPolling();
      toast(`Access granted. Welcome, ${name}.`);
    } catch (error) {
      console.error("[FinSentinels] Login failed:", error);
      setText("loginError", `Could not open workspace: ${error.message}`);
    }
  }

  function bind() {
    $("loginForm")?.addEventListener("submit", (event) => { event.preventDefault(); login(); });
    $("loginBtn")?.addEventListener("click", (event) => { event.preventDefault(); login(); });
    $("loginCode")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); login(); } });
    $("profileBtn")?.addEventListener("click", openProfile);
    $("profileClose")?.addEventListener("click", () => $("profileModal")?.classList.remove("open"));
    $("profileModal")?.addEventListener("click", (event) => { if (event.target.id === "profileModal") $("profileModal")?.classList.remove("open"); });
    $("overviewInvestigate")?.addEventListener("click", () => investigateAccount($("overviewSearch")?.value));
    $("investigateBtn")?.addEventListener("click", () => investigateAccount($("investigationSearch")?.value));
    $("globalSearch")?.addEventListener("keydown", (event) => { if (event.key === "Enter") investigateAccount(event.target.value); });
    $("networkSearch")?.addEventListener("keydown", (event) => { if (event.key === "Enter") { state.networkFocus = event.target.value.trim().toUpperCase(); setView("network"); drawNetwork(state.networkGraph); } });
    $("networkRefresh")?.addEventListener("click", loadNetwork);
    qsa("[data-network-mode]").forEach((button) => button.addEventListener("click", () => {
      qsa("[data-network-mode]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.networkMode = button.dataset.networkMode || "alerts";
      drawNetwork(state.networkGraph);
    }));
    qsa(".net-filter").forEach((button) => button.addEventListener("click", () => {
      qsa(".net-filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.networkFilter = button.dataset.filter;
      drawNetwork(state.networkGraph);
    }));
    $("saveSettings")?.addEventListener("click", saveSettings);
    qsa(".rail-btn[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
    qsa("[data-view-link]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewLink)));
    $("insClose")?.addEventListener("click", closeInspector);
    $("btnDismiss")?.addEventListener("click", closeInspector);
    $("btnFlag")?.addEventListener("click", openInspectorCaseAction);
    $("backdrop")?.addEventListener("click", closeInspector);
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") { $("profileModal")?.classList.remove("open"); closeInspector(); } });
  }

  function closeInspector() {
    $("inspector")?.classList.remove("open");
    $("backdrop")?.classList.remove("open");
  }

  function renderLoading(id, message) {
    const root = $(id);
    if (root) root.innerHTML = `<div class="loading">${esc(message)}</div>`;
  }

  function renderError(id, message) {
    const root = $(id);
    if (root) root.innerHTML = `<div class="empty-state">${esc(message)}</div>`;
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (!state.loggedIn) return;
      try {
        const [analyticsData, alertsData, recentData] = await Promise.all([get("/api/analytics"), get("/api/alerts"), get("/api/transactions/recent?limit=8")]);
        const n = analyticsData.network || {};
        const r = analyticsData.risk_distribution || {};
        const f = analyticsData.fraud_patterns || {};
        setText("sideAccounts", n.accounts ?? 0);
        setText("sideFlagged", (r.high_risk ?? 0) + (r.watch ?? 0));
        setText("sideRings", f.active_cycles ?? 0);
        setText("sideDevices", f.shared_devices ?? 0);
        setText("sideTx", n.transactions ?? 0);
        state.alerts = alertsData.alerts || [];
        updateAlertCount(state.alerts.length);
        if (state.currentView === "overview") {
          renderTransactionFeed(recentData.transactions || [], "overviewFeed");
          renderOverviewAlerts(state.alerts.slice(0, 5));
        } else if (state.currentView === "network") {
          // Refresh graph data without throwing away the user's pan/zoom or dragged node positions.
          const networkData = await get("/api/network");
          state.networkGraph = networkData.graph || networkData;
          drawNetwork(state.networkGraph);
        }
      } catch (error) {
        console.error("[FinSentinels] Polling failed:", error);
      }
    }, 5000);
  }

  window.investigate = investigateAccount;
  window.investigateAccount = investigateAccount;
  window.createCase = createCase;
  window.openCase = openCase;
  window.closeCase = closeCase;
  window.loadCases = loadCases;
  window.loadAlerts = loadAlerts;
  window.loadAnalytics = loadAnalytics;
  window.loadNetwork = loadNetwork;
  window.saveSettings = saveSettings;
  window.switchView = setView;
  window.openInvestigationGraph = () => { setView("network"); };

  window.addEventListener("error", (event) => console.error("[FinSentinels] Unhandled frontend error:", event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => console.error("[FinSentinels] Unhandled promise rejection:", event.reason));

  document.addEventListener("DOMContentLoaded", () => {
    console.log("🛡️ FinSentinels frontend online");
    bind();
    const analyst = localStorage.getItem("finSentinelsAnalyst");
    if (analyst) {
      setTextValue("loginName", analyst);
      $("login")?.classList.add("hidden");
      $("app")?.classList.remove("hidden");
      $("app")?.style && ($("app").style.display = "grid");
      setText("topProfileName", analyst);
      setText("profileAvatar", initials(analyst));
      state.loggedIn = true;
      setView("overview");
      startPolling();
    } else {
      $("app")?.classList.remove("hidden");
      $("app") && ($("app").style.display = "none");
    }
  });
})();
