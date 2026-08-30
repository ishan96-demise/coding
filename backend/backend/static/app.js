(() => {
  "use strict";

  // ============================================================
  // FinSentinels — Frontend Controller
  // ============================================================

  const API_BASE = "";

  const state = {
    currentView: "overview",
    networkFilter: "all",

    currentAccount: "",
    currentScore: null,
    currentGraph: null,

    selectedCase: null,

    cases: [],
    alerts: [],

    loggedIn: false,
    selectedNodeType: "account",

    initialized: false,
    loading: false
  };

  const $ = (id) => document.getElementById(id);

  const qsa = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));

  // ============================================================
  // BASIC HELPERS
  // ============================================================

  function setText(id, value) {
    const node = $(id);
    if (node) {
      node.textContent =
        value === null || value === undefined
          ? ""
          : String(value);
    }
  }

  function setValue(id, value) {
    const node = $(id);
    if (node && value !== undefined && value !== null) {
      node.value = value;
    }
  }

  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;"
        }[char])
    );
  }

  function money(value) {
    const number = Number(value || 0);

    return (
      "₹" +
      number.toLocaleString("en-IN", {
        maximumFractionDigits: 2
      })
    );
  }

  function number(value) {
    return Number(value || 0).toLocaleString("en-IN");
  }

  function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short"
    });
  }

  function formatTime(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  }

  function riskTier(status) {
    const value = String(status || "SAFE")
      .trim()
      .toUpperCase();

    if (value === "HIGH RISK") return "high";
    if (value === "WATCH") return "watch";

    return "safe";
  }

  function riskColor(status) {
    const value = String(status || "SAFE")
      .trim()
      .toUpperCase();

    if (value === "HIGH RISK") return "var(--red)";
    if (value === "WATCH") return "var(--amber)";

    return "var(--green)";
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  // ============================================================
  // TOAST
  // ============================================================

  let toastTimer = null;

  function toast(message) {
    const node = $("toast");
    const text = $("toastText");

    if (!node || !text) {
      console.log("[FinSentinels]", message);
      return;
    }

    text.textContent = String(message);
    node.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      node.classList.remove("show");
    }, 2600);
  }

  // ============================================================
  // API
  // ============================================================

  async function apiRequest(path, options = {}) {
    const url = API_BASE + path;

    console.log(
      "[FinSentinels] API:",
      options.method || "GET",
      url
    );

    let response;

    try {
      response = await fetch(url, {
        ...options,

        headers: {
          Accept: "application/json",
          ...(options.body
            ? {
                "Content-Type": "application/json"
              }
            : {}),
          ...(options.headers || {})
        }
      });
    } catch (error) {
      console.error(
        "[FinSentinels] Network error:",
        url,
        error
      );

      throw new Error(
        "Unable to connect to the FastAPI backend. Make sure Uvicorn is running on port 8000."
      );
    }

    let payload = null;

    const contentType =
      response.headers.get("content-type") || "";

    try {
      if (contentType.includes("application/json")) {
        payload = await response.json();
      } else {
        payload = await response.text();
      }
    } catch (error) {
      console.error(
        "[FinSentinels] Response parsing error:",
        url,
        error
      );
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;

      if (payload && typeof payload === "object") {
        message =
          payload.detail ||
          payload.message ||
          payload.error ||
          message;
      } else if (
        typeof payload === "string" &&
        payload.trim()
      ) {
        message = payload;
      }

      console.error(
        "[FinSentinels] API failure:",
        response.status,
        url,
        message
      );

      throw new Error(message);
    }

    return payload;
  }

  function apiGet(path) {
    return apiRequest(path);
  }

  function apiPost(path, body) {
    return apiRequest(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  function apiPut(path, body) {
    return apiRequest(path, {
      method: "PUT",
      body: JSON.stringify(body)
    });
  }

  function apiPatch(path, body) {
    return apiRequest(path, {
      method: "PATCH",
      body: JSON.stringify(body)
    });
  }

  // ============================================================
  // VIEW MANAGEMENT
  // ============================================================

  const VIEW_META = {
    overview: [
      "Overview",
      "Fraud network command center"
    ],

    network: [
      "Transaction Network",
      "Accounts, devices and money flows"
    ],

    investigations: [
      "Investigations",
      "Explainable account-level analysis"
    ],

    alerts: [
      "Risk Alerts",
      "Prioritized accounts requiring attention"
    ],

    cases: [
      "Cases",
      "Investigation lifecycle and analyst queue"
    ],

    analytics: [
      "Analytics",
      "Network and case-management intelligence"
    ],

    settings: [
      "Settings",
      "Investigation thresholds and graph depth"
    ],

    "case-detail": [
      "Case Detail",
      "Evidence, timeline and analyst actions"
    ]
  };

  async function setView(view) {
    const target = $(`view-${view}`);

    if (!target) {
      console.error(
        "[FinSentinels] Missing view container:",
        `view-${view}`
      );

      toast(`View "${view}" is unavailable.`);
      return false;
    }

    state.currentView = view;

    qsa(".view").forEach((panel) => {
      panel.classList.remove("active");
    });

    target.classList.add("active");

    qsa(".nav-btn[data-view]").forEach((button) => {
      button.classList.toggle(
        "active",
        button.dataset.view === view
      );
    });

    const meta =
      VIEW_META[view] ||
      VIEW_META.overview;

    setText(
      "workspaceTitle",
      meta[0]
    );

    setText(
      "workspaceSubtitle",
      meta[1]
    );

    switch (view) {
      case "overview":
        await loadOverview();
        break;

      case "network":
        await loadNetwork();
        break;

      case "investigations":
        prepareInvestigationView();
        break;

      case "alerts":
        await loadAlerts(false);
        break;

      case "cases":
        await loadCases();
        break;

      case "analytics":
        await loadAnalytics();
        break;

      case "settings":
        await loadSettings();
        break;

      case "case-detail":
        break;

      default:
        break;
    }

    return true;
  }

  // ============================================================
  // OVERVIEW
  // ============================================================

  async function loadOverview() {
    try {
      const [
        analyticsData,
        alertsData,
        casesData,
        networkData
      ] = await Promise.all([
        apiGet("/api/analytics"),
        apiGet("/api/alerts"),
        apiGet("/api/cases"),
        apiGet("/api/network")
      ]);

      const network =
        analyticsData?.network || {};

      const risk =
        analyticsData?.risk_distribution || {};

      const patterns =
        analyticsData?.fraud_patterns || {};

      const transactionMetrics =
        analyticsData?.transaction_metrics || {};

      const caseMetrics =
        analyticsData?.case_metrics || {};

      const cases =
        safeArray(casesData?.cases);

      setText(
        "ovAccounts",
        network.accounts ?? 0
      );

      setText(
        "ovHigh",
        risk.high_risk ?? 0
      );

      const calculatedOpenCases =
        cases.filter(
          (item) =>
            ["OPEN", "INVESTIGATING"].includes(
              String(item.status || "")
                .trim()
                .toUpperCase()
            )
        ).length;

      setText(
        "ovOpenCases",
        caseMetrics.open ??
          calculatedOpenCases
      );

      setText(
        "ovVolume",
        money(
          transactionMetrics.total_volume ?? 0
        )
      );

      setText(
        "sideAccounts",
        network.accounts ?? 0
      );

      setText(
        "sideFlagged",
        (risk.high_risk ?? 0) +
          (risk.watch ?? 0)
      );

      setText(
        "sideRings",
        patterns.active_cycles ?? 0
      );

      setText(
        "sideDevices",
        patterns.shared_devices ?? 0
      );

      setText(
        "sideTx",
        network.transactions ?? 0
      );

      state.alerts =
        safeArray(alertsData?.alerts);

      state.cases = cases;

      state.currentGraph =
        networkData?.graph ||
        networkData;

      updateAlertCount(
        state.alerts.length
      );

      renderOverviewAlerts(
        state.alerts.slice(0, 5)
      );

      renderTransactionFeed(
        getTransferEdges(
          state.currentGraph
        )
          .sort(
            sortByTimestampDescending
          )
          .slice(0, 8),
        "overviewFeed"
      );

      console.log(
        "[FinSentinels] Overview loaded",
        {
          accounts: network.accounts,
          transactions: network.transactions,
          alerts: state.alerts.length,
          cases: cases.length
        }
      );
    } catch (error) {
      console.error(
        "[FinSentinels] Overview failed:",
        error
      );

      renderOverviewAlerts([]);

      const feed =
        $("overviewFeed");

      if (feed) {
        feed.innerHTML = `
          <div class="small" style="padding:14px">
            Unable to load transaction activity.
            <br>
            ${esc(error.message)}
          </div>
        `;
      }

      toast(
        `Overview unavailable: ${error.message}`
      );
    }
  }

  function renderOverviewAlerts(
    alerts
  ) {
    const root =
      $("overviewAlerts");

    if (!root) {
      return;
    }

    if (!alerts.length) {
      root.innerHTML = `
        <div class="small">
          No active risk alerts.
        </div>
      `;

      return;
    }

    root.innerHTML = alerts
      .map(
        (alert) => `
          <div
            class="item"
            data-overview-account="${esc(
              alert.account_id
            )}"
            role="button"
            tabindex="0"
          >

            <div class="item-main">

              <div class="item-title">
                ${esc(
                  alert.account_id
                )}
              </div>

              <div class="item-sub">
                ${esc(
                  safeArray(
                    alert.reasons
                  )
                    .slice(0, 2)
                    .join(" · ") ||
                    "Risk signal detected"
                )}
              </div>

            </div>

            <div class="item-actions">

              <span class="pill ${riskTier(
                alert.status
              )}">
                ${esc(
                  alert.status ||
                    "WATCH"
                )}
                ·
                ${number(
                  alert.risk_score ??
                    0
                )}
              </span>

            </div>

          </div>
        `
      )
      .join("");

    qsa(
      "[data-overview-account]",
      root
    ).forEach((item) => {
      const open = () =>
        investigateAccount(
          item.dataset.overviewAccount
        );

      item.addEventListener(
        "click",
        open
      );

      item.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key === "Enter" ||
            event.key === " "
          ) {
            event.preventDefault();
            open();
          }
        }
      );
    });
  }

  // ============================================================
  // ALERTS
  // ============================================================

  async function loadAlerts(
    overviewOnly = false
  ) {
    try {
      const data =
        await apiGet(
          "/api/alerts"
        );

      state.alerts =
        safeArray(data?.alerts);

      updateAlertCount(
        state.alerts.length
      );

      setText(
        "alertHeadingCount",
        state.alerts.length
          ? `· ${state.alerts.length} alerts`
          : ""
      );

      if (overviewOnly) {
        renderOverviewAlerts(
          state.alerts.slice(0, 5)
        );

        return state.alerts;
      }

      const root =
        $("alertList");

      if (!root) {
        return state.alerts;
      }

      if (!state.alerts.length) {
        root.innerHTML = `
          <div class="empty-state">
            No active risk alerts.
          </div>
        `;

        return state.alerts;
      }

      root.innerHTML =
        state.alerts
          .map(
            (alert) => `
              <div
                class="item"
                data-alert-account="${esc(
                  alert.account_id
                )}"
                role="button"
                tabindex="0"
              >

                <div class="item-main">

                  <div class="item-title">
                    ${esc(
                      alert.account_id
                    )}
                  </div>

                  <div class="item-sub">
                    ${esc(
                      safeArray(
                        alert.reasons
                      ).join(" · ") ||
                        "Risk signal detected"
                    )}
                  </div>

                </div>

                <div class="item-actions">

                  <span class="pill ${riskTier(
                    alert.status
                  )}">
                    ${esc(
                      alert.status ||
                        "WATCH"
                    )}
                    ·
                    ${number(
                      alert.risk_score ??
                        0
                    )}
                  </span>

                </div>

              </div>
            `
          )
          .join("");

      qsa(
        "[data-alert-account]",
        root
      ).forEach(
        (item) => {
          const open = () =>
            investigateAccount(
              item.dataset.alertAccount
            );

          item.addEventListener(
            "click",
            open
          );

          item.addEventListener(
            "keydown",
            (event) => {
              if (
                event.key ===
                  "Enter" ||
                event.key === " "
              ) {
                event.preventDefault();
                open();
              }
            }
          );
        }
      );

      return state.alerts;
    } catch (error) {
      console.error(
        "[FinSentinels] Alerts failed:",
        error
      );

      updateAlertCount(0);

      const root =
        $(
          overviewOnly
            ? "overviewAlerts"
            : "alertList"
        );

      if (root) {
        root.innerHTML = `
          <div class="small">
            Unable to load alerts.
            <br>
            ${esc(error.message)}
          </div>
        `;
      }

      if (!overviewOnly) {
        toast(
          `Alerts unavailable: ${error.message}`
        );
      }

      return [];
    }
  }

  function updateAlertCount(
    count
  ) {
    const badge =
      $("alertCount");

    if (!badge) {
      return;
    }

    badge.textContent =
      String(count);

    badge.classList.toggle(
      "hidden",
      !count
    );

    badge.style.display =
      count
        ? "inline-block"
        : "none";
  }

  // ============================================================
  // INVESTIGATION
  // ============================================================

  function prepareInvestigationView() {
    const root =
      $("investigationResult");

    if (!root) {
      return;
    }

    if (
      root.innerHTML.trim()
    ) {
      return;
    }

    root.innerHTML = `
      <div class="card">

        <div class="empty-state">

          Search an account to
          begin an investigation.

          <br>

          <span class="small">
            Example:
            <strong>ACC_097</strong>
          </span>

        </div>

      </div>
    `;
  }

  async function investigateAccount(
    accountId
  ) {
    const account =
      String(
        accountId || ""
      )
        .trim()
        .toUpperCase();

    if (!account) {
      toast(
        "Enter an account ID."
      );

      return;
    }

    await setView(
      "investigations"
    );

    setValue(
      "investigationSearch",
      account
    );

    setValue(
      "globalSearch",
      account
    );

    const root =
      $("investigationResult");

    if (root) {
      root.innerHTML = `
        <div class="card">

          <div class="small">
            Analyzing
            <strong>${esc(account)}</strong>…
          </div>

        </div>
      `;
    }

    try {
      const [
        score,
        graphResponse
      ] = await Promise.all([
        apiGet(
          `/api/score/${encodeURIComponent(
            account
          )}`
        ),

        apiGet(
          `/api/graph/${encodeURIComponent(
            account
          )}`
        )
      ]);

      state.currentAccount =
        account;

      state.currentScore =
        score;

      state.currentGraph =
        graphResponse?.graph ||
        graphResponse;

      state.selectedNodeType =
        "account";

      renderInvestigation(
        score,
        state.currentGraph
      );

      toast(
        `${account} analyzed successfully.`
      );
    } catch (error) {
      console.error(
        "[FinSentinels] Investigation failed:",
        {
          account,
          error
        }
      );

      if (root) {
        root.innerHTML = `
          <div class="card">

            <div class="card-head">
              <h3>
                Investigation unavailable
              </h3>
            </div>

            <div class="small">
              ${esc(error.message)}
            </div>

          </div>
        `;
      }

      toast(
        `Investigation failed: ${error.message}`
      );
    }
  }

  function renderInvestigation(
    data,
    graph
  ) {
    const root =
      $("investigationResult");

    if (!root) {
      return;
    }

    const factors =
      data?.factors || {};

    const reasons =
      safeArray(
        data?.reasons
      );

    const devices =
      safeArray(
        data?.shared_devices
      )
        .map(
          (device) =>
            device.device_id ||
            device.device ||
            device.id
        )
        .filter(Boolean)
        .join(", ");

    const status =
      data?.status ||
      "SAFE";

    const nodes =
      safeArray(
        graph?.nodes
      );

    root.innerHTML = `
      <div class="kpis">

        <div class="kpi">
          <label>Account</label>
          <strong>
            ${esc(
              data?.account_id
            )}
          </strong>
        </div>

        <div class="kpi">
          <label>Risk Score</label>
          <strong style="color:${riskColor(
            status
          )}">
            ${number(
              data?.risk_score ??
                0
            )}
          </strong>
        </div>

        <div class="kpi">
          <label>Status</label>
          <strong>
            <span class="pill ${riskTier(
              status
            )}">
              ${esc(status)}
            </span>
          </strong>
        </div>

        <div class="kpi">
          <label>Connected Entities</label>
          <strong>
            ${nodes.length}
          </strong>
        </div>

      </div>

      <div class="result-grid">

        <div class="card">

          <div class="card-head">
            <h3>
              Explainable Risk
            </h3>

            <span class="pill ${riskTier(
              status
            )}">
              ${esc(status)}
            </span>
          </div>

          <div class="card-body">

            ${factor(
              "Circular routing",
              factors.circular_routing ??
                0
            )}

            ${factor(
              "Device sharing",
              factors.device_sharing ??
                0
            )}

            ${factor(
              "Transaction velocity",
              factors.transaction_velocity ??
                0
            )}

            ${factor(
              "Network connectivity",
              factors.network_connectivity ??
                0
            )}

            <div class="note">
              <b>Evidence</b>
              <br>
              ${esc(
                reasons.join(" · ") ||
                  "No significant suspicious graph indicators detected."
              )}
            </div>

            <div class="note">
              <b>
                Connected devices
              </b>
              <br>
              ${esc(
                devices ||
                  "None detected."
              )}
            </div>

            ${
              status !== "SAFE"
                ? `
                  <button
                    class="primary"
                    id="investigationCreateCase"
                    type="button"
                    style="
                      margin-top:14px;
                      width:100%;
                      min-height:42px;
                    "
                  >
                    Create Case / Flag for Review
                  </button>
                `
                : `
                  <div
                    class="small"
                    style="margin-top:14px"
                  >
                    Account currently has no
                    case-triggering risk status.
                  </div>
                `
            }

          </div>

        </div>

        <div class="card">

          <div class="card-head">

            <h3>
              Connected Entities
            </h3>

            <button
              class="secondary"
              id="openCaseNetwork"
              type="button"
            >
              Open Network
            </button>

          </div>

          <div class="card-body">

            <div class="items">

              ${
                nodes.length
                  ? renderEntityItems(
                      nodes
                    )
                  : `
                    <div class="small">
                      No connected entities.
                    </div>
                  `
              }

            </div>

          </div>

        </div>

      </div>

      <div
        class="card"
        style="margin-top:12px"
      >

        <div class="card-head">

          <h3>
            Transaction Intelligence
          </h3>

          <span class="small">
            ${esc(
              data?.account_id
            )}
          </span>

        </div>

        <div
          id="investigationFeed"
          class="feed"
        ></div>

      </div>
    `;

    $("investigationCreateCase")
      ?.addEventListener(
        "click",
        createCase
      );

    $("openCaseNetwork")
      ?.addEventListener(
        "click",
        async () => {
          if (!state.currentGraph) {
            toast(
              "Network data is unavailable."
            );

            return;
          }

          await setView(
            "network"
          );

          requestAnimationFrame(
            () => {
              drawNetwork(
                state.currentGraph
              );
            }
          );
        }
      );

    qsa(
      "[data-investigation-node]"
    ).forEach(
      (item) => {
        const id =
          item.dataset
            .investigationNode;

        const type =
          item.dataset
            .nodeType;

        item.addEventListener(
          "click",
          () => {
            if (type === "device") {
              showDeviceInfo(
                id
              );

              return;
            }

            if (type === "merchant") {
              showGenericEntityInfo(
                "Merchant",
                id
              );

              return;
            }

            if (type === "location") {
              showGenericEntityInfo(
                "Location",
                id
              );

              return;
            }

            inspectAccountNode(
              id
            );
          }
        );
      }
    );

    renderTransactionFeed(
      safeArray(
        data?.transactions
      ).length
        ? data.transactions
        : getTransferEdges(
            graph
          ),
      "investigationFeed"
    );
  }

  function renderEntityItems(
    nodes
  ) {
    return nodes
      .map(
        (node) => {
          const type =
            String(
              node?.type ||
                "account"
            ).toLowerCase();

          let label =
            "ACCOUNT";

          let pill =
            "safe";

          let subtitle =
            "Financial account";

          if (
            type ===
            "device"
          ) {
            label =
              "DEVICE";

            pill =
              "watch";

            subtitle =
              "Shared infrastructure";
          }

          if (
            type ===
            "merchant"
          ) {
            label =
              "MERCHANT";

            pill =
              "watch";

            subtitle =
              "Merchant relationship";
          }

          if (
            type ===
            "location"
          ) {
            label =
              "LOCATION";

            pill =
              "watch";

            subtitle =
              "Location context";
          }

          return `
            <div
              class="item"
              data-investigation-node="${esc(
                node.id
              )}"
              data-node-type="${esc(
                type
              )}"
              role="button"
              tabindex="0"
            >

              <div class="item-main">

                <div class="item-title">
                  ${esc(
                    node.label ||
                      node.id
                  )}
                </div>

                <div class="item-sub">
                  ${subtitle}
                </div>

              </div>

              <div class="item-actions">

                <span class="pill ${pill}">
                  ${label}
                </span>

              </div>

            </div>
          `;
        }
      )
      .join("");
  }

  function factor(
    label,
    value
  ) {
    const amount =
      Math.max(
        0,
        Math.min(
          100,
          Number(value) || 0
        )
      );

    return `
      <div class="factor">

        <div class="factor-row">

          <span>
            ${esc(label)}
          </span>

          <span>
            ${amount}%
          </span>

        </div>

        <div class="track">

          <div
            class="fill"
            style="width:${amount}%"
          ></div>

        </div>

      </div>
    `;
  }

  // ============================================================
  // TRANSACTIONS
  // ============================================================

  function getTransferEdges(
    graph
  ) {
    return safeArray(
      graph?.edges
    )
      .filter(
        (edge) =>
          String(
            edge?.relation ||
              ""
          ).toUpperCase() ===
          "TRANSFER"
      )
      .map(
        (edge) => ({
          transaction_id:
            edge.transaction_id ||
            edge.id,

          source:
            edge.source,

          target:
            edge.target,

          amount:
            edge.amount ??
            0,

          timestamp:
            edge.timestamp,

          device_id:
            edge.device_id,

          ip_address:
            edge.ip_address
        })
      );
  }

  function sortByTimestampDescending(
    a,
    b
  ) {
    return (
      new Date(
        b?.timestamp || 0
      ).getTime() -
      new Date(
        a?.timestamp || 0
      ).getTime()
    );
  }

  function renderTransactionFeed(
    rows,
    targetId
  ) {
    const root =
      $(targetId);

    if (!root) {
      return;
    }

    const transactions =
      safeArray(
        rows
      )
        .slice()
        .sort(
          sortByTimestampDescending
        );

    if (!transactions.length) {
      root.innerHTML = `
        <div
          class="small"
          style="padding:14px"
        >
          No transactions found.
        </div>
      `;

      return;
    }

    root.innerHTML =
      transactions
        .slice(0, 15)
        .map(
          (tx) => {
            const amount =
              Number(
                tx?.amount ||
                  0
              );

            let status =
              "SAFE";

            if (
              amount >=
              20000
            ) {
              status =
                "HIGH RISK";
            } else if (
              amount >=
              5000
            ) {
              status =
                "WATCH";
            }

            return `
              <div
                class="feed-row"
              >

                <div
                  class="feed-time"
                >
                  ${esc(
                    formatTime(
                      tx?.timestamp
                    )
                  )}
                </div>

                <div
                  class="feed-flow"
                >
                  <b>
                    ${esc(
                      tx?.source ||
                        "—"
                    )}
                  </b>

                  →

                  <b>
                    ${esc(
                      tx?.target ||
                        "—"
                    )}
                  </b>
                </div>

                <div
                  class="feed-amount"
                >
                  ${money(
                    amount
                  )}
                </div>

                <span class="pill ${riskTier(
                  status
                )}">
                  ${status}
                </span>

              </div>
            `;
          }
        )
        .join("");
  }

  // ============================================================
  // CASE CREATION
  // ============================================================

  async function createCase() {
    const account =
      state.currentAccount ||
      state.currentScore?.account_id;

    if (!account) {
      toast(
        "Investigate an account first."
      );

      return;
    }

    const button =
      $("investigationCreateCase");

    if (button) {
      button.disabled =
        true;

      button.textContent =
        "Creating Case…";
    }

    try {
      const result =
        await apiPost(
          "/api/cases",
          {
            account_id:
              account,

            priority:
              state.currentScore
                ?.status ===
              "HIGH RISK"
                ? "HIGH"
                : "MEDIUM",

            note:
              safeArray(
                state.currentScore
                  ?.reasons
              ).join(
                " · "
              )
          }
        );

      const caseId =
        result?.case_id;

      toast(
        caseId
          ? `${caseId} created successfully.`
          : "Case created successfully."
      );

      await loadCases();

      // Open the actual case immediately.
      if (caseId) {
        await openCase(
          caseId
        );
      }
    } catch (error) {
      console.error(
        "[FinSentinels] Create case failed:",
        error
      );

      if (button) {
        button.disabled =
          false;

        button.textContent =
          "Create Case / Flag for Review";
      }

      toast(
        `Could not create case: ${error.message}`
      );
    }
  }

  // ============================================================
  // CASE LIST
  // ============================================================

  async function loadCases() {
    const root =
      $("caseList");

    if (!root) {
      return;
    }

    root.innerHTML =
      '<div class="small">Loading cases…</div>';

    try {
      const data =
        await apiGet(
          "/api/cases"
        );

      state.cases =
        safeArray(
          data?.cases
        );

      setText(
        "caseCount",
        `${state.cases.length} cases`
      );

      if (!state.cases.length) {
        root.innerHTML = `
          <div class="empty-state">
            No cases yet.
            <br>
            Investigate a risky account and create a case.
          </div>
        `;

        return;
      }

      root.innerHTML =
        state.cases
          .map(
            renderCaseItem
          )
          .join("");

      qsa(
        "[data-open-case]",
        root
      ).forEach(
        (row) => {
          row.addEventListener(
            "click",
            () =>
              openCase(
                row.dataset
                  .openCase
              )
          );
        }
      );

      qsa(
        "[data-close-case]",
        root
      ).forEach(
        (button) => {
          button.addEventListener(
            "click",
            (event) => {
              event.stopPropagation();

              closeCase(
                button.dataset
                  .closeCase
              );
            }
          );
        }
      );
    } catch (error) {
      console.error(
        "[FinSentinels] Load cases failed:",
        error
      );

      root.innerHTML = `
        <div class="small">
          Unable to load cases:
          ${esc(error.message)}
        </div>
      `;

      toast(
        `Cases unavailable: ${error.message}`
      );
    }
  }

  function renderCaseItem(
    caseItem
  ) {
    const status =
      String(
        caseItem?.status ||
          "OPEN"
      ).toUpperCase();

    const risk =
      String(
        caseItem?.risk_status ||
          "SAFE"
      ).toUpperCase();

    const closed =
      status ===
        "CLOSED" ||
      status ===
        "DISMISSED";

    return `
      <div
        class="item"
        data-open-case="${esc(
          caseItem?.case_id
        )}"
        role="button"
        tabindex="0"
      >

        <div class="item-main">

          <div class="item-title">
            ${esc(
              caseItem?.case_id
            )}
            ·
            ${esc(
              caseItem?.account_id
            )}
          </div>

          <div class="item-sub">
            ${esc(
              caseItem?.note ||
                "No analyst note"
            )}

            ·

            ${esc(
              formatDate(
                caseItem?.created_at
              )
            )}
          </div>

        </div>

        <div class="item-actions">

          <span class="pill ${riskTier(
            risk
          )}">
            ${esc(risk)}
          </span>

          <span class="pill ${
            closed
              ? "safe"
              : "watch"
          }">
            ${esc(status)}
          </span>

          ${
            !closed
              ? `
                <button
                  class="secondary"
                  type="button"
                  data-close-case="${esc(
                    caseItem?.case_id
                  )}"
                >
                  Close
                </button>
              `
              : ""
          }

        </div>

      </div>
    `;
  }

  // ============================================================
  // OPEN CASE
  // ============================================================

  async function openCase(
    caseId
  ) {
    const normalized =
      String(
        caseId || ""
      ).trim();

    if (!normalized) {
      toast(
        "Invalid case ID."
      );

      return;
    }

    // Your current main.py has /api/cases but does not
    // currently have GET /api/cases/{case_id}.
    // Therefore we fetch the case collection and locate it.
    try {
      let caseItem =
        state.cases.find(
          (item) =>
            String(
              item.case_id
            ) === normalized
        );

      if (!caseItem) {
        const data =
          await apiGet(
            "/api/cases"
          );

        const cases =
          safeArray(
            data?.cases
          );

        state.cases =
          cases;

        caseItem =
          cases.find(
            (item) =>
              String(
                item.case_id
              ) === normalized
          );
      }

      if (!caseItem) {
        throw new Error(
          `Case '${normalized}' was not found.`
        );
      }

      state.selectedCase =
        caseItem;

      await setView(
        "case-detail"
      );

      renderCaseDetail(
        caseItem
      );
    } catch (error) {
      console.error(
        "[FinSentinels] Open case failed:",
        {
          caseId: normalized,
          error
        }
      );

      toast(
        `Could not open case: ${error.message}`
      );
    }
  }

  function renderCaseDetail(
    caseItem
  ) {
    const root =
      $("caseDetail");

    if (!root) {
      return;
    }

    const risk =
      caseItem?.risk_status ||
      "SAFE";

    const status =
      caseItem?.status ||
      "OPEN";

    const reasons =
      safeArray(
        caseItem?.reasons
      );

    const evidence =
      safeArray(
        caseItem?.evidence
      );

    const timeline =
      safeArray(
        caseItem?.timeline
      );

    root.innerHTML = `
      <div class="view-heading">
        ${esc(
          caseItem?.case_id
        )}
      </div>

      <div class="view-sub">
        ${esc(
          caseItem?.account_id
        )}
        ·

        <span class="pill ${riskTier(
          risk
        )}">
          ${esc(risk)}
        </span>

        ·

        ${esc(status)}
      </div>

      <div class="case-detail">

        <div>

          <div class="card">

            <div class="card-head">

              <h3>
                Case Summary
              </h3>

              <span class="pill ${riskTier(
                risk
              )}">
                ${esc(risk)}
              </span>

            </div>

            <div class="card-body">

              <div class="detail-grid">

                <div class="detail-box">

                  <label>
                    Account
                  </label>

                  <strong>
                    ${esc(
                      caseItem?.account_id
                    )}
                  </strong>

                </div>

                <div class="detail-box">

                  <label>
                    Risk Score
                  </label>

                  <strong>
                    ${number(
                      caseItem
                        ?.risk_score ??
                        0
                    )}/100
                  </strong>

                </div>

                <div class="detail-box">

                  <label>
                    Priority
                  </label>

                  <strong>
                    ${esc(
                      caseItem
                        ?.priority ||
                        "MEDIUM"
                    )}
                  </strong>

                </div>

              </div>

              <div class="note">

                <b>
                  Analyst Note
                </b>

                <br>

                ${esc(
                  caseItem?.note ||
                    "No analyst note recorded."
                )}

              </div>

              <div
                class="note"
                style="margin-top:10px"
              >

                <b>
                  Detection Evidence
                </b>

                <br>

                ${esc(
                  reasons.join(
                    " · "
                  ) ||
                    "No recorded risk indicators."
                )}

              </div>

            </div>

          </div>

          <div
            class="card"
            style="margin-top:12px"
          >

            <div class="card-head">

              <h3>
                Evidence
              </h3>

              <span class="small">
                ${evidence.length}
                item${
                  evidence.length ===
                  1
                    ? ""
                    : "s"
                }
              </span>

            </div>

            <div class="card-body">

              ${
                evidence.length
                  ? evidence
                      .map(
                        (item) => `
                          <div class="evidence-item">

                            <b>
                              ${esc(
                                item.evidence_type ||
                                "Evidence"
                              )}
                            </b>

                            <span>
                              ${esc(
                                item.description ||
                                ""
                              )}
                            </span>

                            <span>
                              ${esc(
                                formatDate(
                                  item.timestamp
                                )
                              )}
                            </span>

                          </div>
                        `
                      )
                      .join("")
                  : `
                    <div class="small">
                      Evidence management is available
                      once the backend evidence endpoint
                      is enabled.
                    </div>
                  `
              }

            </div>

          </div>

        </div>

        <div>

          <div class="card">

            <div class="card-head">

              <h3>
                Case Actions
              </h3>

            </div>

            <div class="card-body">

              <div class="form-row">

                <select
                  id="caseStatus"
                  class="input"
                >

                  <option
                    value="OPEN"
                    ${
                      status ===
                      "OPEN"
                        ? "selected"
                        : ""
                    }
                  >
                    OPEN
                  </option>

                  <option
                    value="INVESTIGATING"
                    ${
                      status ===
                      "INVESTIGATING"
                        ? "selected"
                        : ""
                    }
                  >
                    INVESTIGATING
                  </option>

                  <option
                    value="CLOSED"
                    ${
                      status ===
                      "CLOSED"
                        ? "selected"
                        : ""
                    }
                  >
                    CLOSED
                  </option>

                  <option
                    value="DISMISSED"
                    ${
                      status ===
                      "DISMISSED"
                        ? "selected"
                        : ""
                    }
                  >
                    DISMISSED
                  </option>

                </select>

                <button
                  class="primary"
                  id="updateCaseBtn"
                  type="button"
                >
                  Update
                </button>

              </div>

              <div
                class="case-actions"
                style="
                  display:flex;
                  gap:8px;
                  margin-top:10px;
                "
              >

                <button
                  class="secondary"
                  id="backCasesBtn"
                  type="button"
                >
                  Back to Cases
                </button>

                <button
                  class="secondary"
                  id="viewAccountBtn"
                  type="button"
                >
                  Investigate Account
                </button>

              </div>

            </div>

          </div>

          <div
            class="card"
            style="margin-top:12px"
          >

            <div class="card-head">

              <h3>
                Investigation Timeline
              </h3>

            </div>

            <div class="card-body">

              <div class="timeline">

                ${
                  timeline.length
                    ? timeline
                        .map(
                          (event) => `
                            <div class="tl">

                              <div
                                class="tl-dot"
                              ></div>

                              <div
                                class="tl-content"
                              >

                                <div
                                  class="tl-title"
                                >
                                  ${esc(
                                    event.title ||
                                    "Investigation event"
                                  )}
                                </div>

                                <div
                                  class="tl-desc"
                                >
                                  ${esc(
                                    event.description ||
                                    ""
                                  )}
                                </div>

                                <div
                                  class="tl-time"
                                >
                                  ${esc(
                                    formatDate(
                                      event.timestamp
                                    )
                                  )}
                                </div>

                              </div>

                            </div>
                          `
                        )
                        .join("")
                    : `
                      <div class="small">
                        Case created
                        ${caseItem.created_at
                          ? `· ${esc(
                              formatDate(
                                caseItem.created_at
                              )
                            )}`
                          : ""}
                        <br>
                        Continue investigation from
                        the case actions above.
                      </div>
                    `
                }

              </div>

            </div>

          </div>

          <div
            class="card"
            style="margin-top:12px"
          >

            <div class="card-head">

              <h3>
                Explainable Summary
              </h3>

            </div>

            <div class="card-body">

              <div class="note">
                ${esc(
                  buildCaseSummary(
                    caseItem
                  )
                )}
              </div>

            </div>

          </div>

        </div>

      </div>
    `;

    $("updateCaseBtn")
      ?.addEventListener(
        "click",
        () =>
          updateCase(
            caseItem.case_id
          )
      );

    $("backCasesBtn")
      ?.addEventListener(
        "click",
        () =>
          setView(
            "cases"
          )
      );

    $("viewAccountBtn")
      ?.addEventListener(
        "click",
        () =>
          investigateAccount(
            caseItem.account_id
          )
      );
  }

  function buildCaseSummary(
    caseItem
  ) {
    const reasons =
      safeArray(
        caseItem?.reasons
      );

    const first =
      reasons[0] ||
      "No major risk indicator recorded.";

    const second =
      reasons[1] ||
      "The account remains under analyst review.";

    const score =
      caseItem?.risk_score ??
      0;

    return (
      `FinSentinels assigned ${score}/100 to ` +
      `${caseItem?.account_id}. ` +
      `Primary signal: ${first}. ` +
      `Secondary signal: ${second}. ` +
      `Case status is ${caseItem?.status || "OPEN"}.`
    );
  }

  // ============================================================
  // UPDATE / CLOSE CASE
  // ============================================================

  async function updateCase(
    caseId
  ) {
    const status =
      $("caseStatus")
        ?.value;

    if (!status) {
      toast(
        "Select a case status."
      );

      return;
    }

    const button =
      $("updateCaseBtn");

    if (button) {
      button.disabled =
        true;

      button.textContent =
        "Updating…";
    }

    try {
      const updated =
        await apiPatch(
          `/api/cases/${encodeURIComponent(
            caseId
          )}`,
          {
            status:
              String(
                status
              ).toUpperCase()
          }
        );

      // Update local cache.
      const index =
        state.cases.findIndex(
          (item) =>
            item.case_id ===
            caseId
        );

      if (index >= 0) {
        state.cases[index] =
          {
            ...state.cases[index],
            ...(updated || {}),
            status
          };
      }

      toast(
        `${caseId} updated.`
      );

      await loadCases();

      // Re-open using local case data.
      await openCase(
        caseId
      );
    } catch (error) {
      console.error(
        "[FinSentinels] Update case failed:",
        error
      );

      toast(
        `Could not update case: ${error.message}`
      );
    } finally {
      if (button) {
        button.disabled =
          false;

        button.textContent =
          "Update";
      }
    }
  }

  async function closeCase(
    caseId
  ) {
    try {
      await apiPatch(
        `/api/cases/${encodeURIComponent(
          caseId
        )}`,
        {
          status:
            "CLOSED"
        }
      );

      toast(
        `${caseId} closed.`
      );

      await loadCases();

      if (
        state.currentView ===
        "case-detail"
      ) {
        await openCase(
          caseId
        );
      }
    } catch (error) {
      console.error(
        "[FinSentinels] Close case failed:",
        error
      );

      toast(
        `Could not close case: ${error.message}`
      );
    }
  }

  // ============================================================
  // NETWORK
  // ============================================================

  async function loadNetwork() {
    const edgeLayer =
      $("netEdges");

    const nodeLayer =
      $("netNodes");

    if (!edgeLayer || !nodeLayer) {
      console.error(
        "[FinSentinels] Network SVG layers missing."
      );

      toast(
        "Network view is unavailable."
      );

      return;
    }

    edgeLayer.innerHTML = `
      <text
        x="550"
        y="300"
        text-anchor="middle"
        fill="#64748B"
        font-size="14"
        font-family="system-ui,sans-serif"
      >
        Loading network…
      </text>
    `;

    nodeLayer.innerHTML =
      "";

    try {
      const data =
        await apiGet(
          "/api/network"
        );

      state.currentGraph =
        data?.graph ||
        data;

      if (
        !safeArray(
          state.currentGraph
            ?.nodes
        ).length
      ) {
        renderNetworkMessage(
          "No network data available."
        );

        return;
      }

      if (!state.alerts.length) {
        await loadAlerts(
          true
        );
      }

      drawNetwork(
        state.currentGraph
      );
    } catch (error) {
      console.error(
        "[FinSentinels] Network failed:",
        error
      );

      renderNetworkMessage(
        `Network unavailable: ${error.message}`
      );

      toast(
        `Network unavailable: ${error.message}`
      );
    }
  }

  function renderNetworkMessage(
    message
  ) {
    const edgeLayer =
      $("netEdges");

    const nodeLayer =
      $("netNodes");

    if (nodeLayer) {
      nodeLayer.innerHTML =
        "";
    }

    if (edgeLayer) {
      edgeLayer.innerHTML = `
        <text
          x="550"
          y="300"
          text-anchor="middle"
          fill="#64748B"
          font-size="14"
          font-family="system-ui,sans-serif"
        >
          ${esc(message)}
        </text>
      `;
    }
  }

  function drawNetwork(
    graph
  ) {
    const edgeLayer =
      $("netEdges");

    const nodeLayer =
      $("netNodes");

    if (!edgeLayer || !nodeLayer) {
      return;
    }

    edgeLayer.innerHTML =
      "";

    nodeLayer.innerHTML =
      "";

    const sourceNodes =
      safeArray(
        graph?.nodes
      );

    const sourceEdges =
      safeArray(
        graph?.edges
      );

    if (!sourceNodes.length) {
      renderNetworkMessage(
        "No nodes available."
      );

      return;
    }

    // ----------------------------------------------------------
    // SVG setup
    // ----------------------------------------------------------

    const WIDTH = 1100;
    const HEIGHT = 600;

    edgeLayer.setAttribute(
      "viewBox",
      `0 0 ${WIDTH} ${HEIGHT}`
    );

    nodeLayer.setAttribute(
      "viewBox",
      `0 0 ${WIDTH} ${HEIGHT}`
    );

    // ----------------------------------------------------------
    // Filter
    // ----------------------------------------------------------

    let nodes =
      sourceNodes.slice();

    let edges =
      sourceEdges.slice();

    const alertsByAccount =
      new Map(
        state.alerts.map(
          (alert) => [
            alert.account_id,
            alert
          ]
        )
      );

    if (
      state.networkFilter ===
      "high"
    ) {
      nodes =
        nodes.filter(
          (node) => {
            const alert =
              alertsByAccount.get(
                node.id
              );

            return (
              alert?.status ===
              "HIGH RISK"
            );
          }
        );
    }

    if (
      state.networkFilter ===
      "mule"
    ) {
      nodes =
        nodes.filter(
          (node) =>
            node.type ===
              "device" ||
            Boolean(
              alertsByAccount.get(
                node.id
              )
            )
        );
    }

    if (
      state.networkFilter ===
      "ring"
    ) {
      nodes =
        nodes.filter(
          (node) => {
            const alert =
              alertsByAccount.get(
                node.id
              );

            return (
              Boolean(
                alert
              ) &&
              Number(
                alert.cycle_count ||
                  0
              ) > 0
            );
          }
        );
    }

    if (!nodes.length) {
      renderNetworkMessage(
        "No nodes match this filter."
      );

      return;
    }

    const allowed =
      new Set(
        nodes.map(
          (node) =>
            node.id
        )
      );

    edges =
      edges.filter(
        (edge) =>
          allowed.has(
            edge.source
          ) &&
          allowed.has(
            edge.target
          )
      );

    // ----------------------------------------------------------
    // Positions
    // ----------------------------------------------------------

    const cx =
      WIDTH / 2;

    const cy =
      HEIGHT / 2;

    const positions =
      {};

    const targetId =
      state.currentAccount;

    const focus =
      nodes.find(
        (node) =>
          node.id ===
          targetId
      );

    const rest =
      nodes.filter(
        (node) =>
          node.id !==
          targetId
      );

    if (focus) {
      positions[
        focus.id
      ] = {
        x: cx,
        y: cy
      };
    }

    const radius =
      Math.min(
        245,
        Math.max(
          120,
          95 +
            rest.length *
              8
        )
      );

    rest.forEach(
      (node, index) => {
        const angle =
          (index /
            Math.max(
              rest.length,
              1
            )) *
            Math.PI *
            2 -
          Math.PI / 2;

        positions[
          node.id
        ] = {
          x:
            cx +
            Math.cos(
              angle
            ) *
              radius,

          y:
            cy +
            Math.sin(
              angle
            ) *
              radius
        };
      }
    );

    // ----------------------------------------------------------
    // Arrow definitions
    // ----------------------------------------------------------

    const defs =
      document.createElementNS(
        "http://www.w3.org/2000/svg",
        "defs"
      );

    defs.innerHTML = `
      <marker
        id="arrow"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path
          d="M 0 0 L 10 5 L 0 10 z"
          fill="#455468"
        />
      </marker>

      <marker
        id="arrowHigh"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path
          d="M 0 0 L 10 5 L 0 10 z"
          fill="#FF5C5C"
        />
      </marker>
    `;

    edgeLayer.appendChild(
      defs
    );

    // ----------------------------------------------------------
    // Edges
    // ----------------------------------------------------------

    edges.forEach(
      (edge) => {
        const from =
          positions[
            edge.source
          ];

        const to =
          positions[
            edge.target
          ];

        if (!from || !to) {
          return;
        }

        const relation =
          String(
            edge.relation ||
              ""
          ).toUpperCase();

        const transfer =
          relation ===
          "TRANSFER";

        const hot =
          transfer &&
          state.currentAccount &&
          (
            edge.source ===
              state.currentAccount ||
            edge.target ===
              state.currentAccount
          ) &&
          state.currentScore
            ?.status ===
            "HIGH RISK";

        const line =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            "line"
          );

        line.setAttribute(
          "x1",
          from.x
        );

        line.setAttribute(
          "y1",
          from.y
        );

        line.setAttribute(
          "x2",
          to.x
        );

        line.setAttribute(
          "y2",
          to.y
        );

        if (
          relation ===
          "USED_DEVICE"
        ) {
          line.setAttribute(
            "stroke",
            "#8B6727"
          );

          line.setAttribute(
            "stroke-width",
            "1.4"
          );

          line.setAttribute(
            "stroke-dasharray",
            "5 5"
          );

          line.setAttribute(
            "marker-end",
            "url(#arrow)"
          );
        } else if (
          relation ===
          "USED_MERCHANT"
        ) {
          line.setAttribute(
            "stroke",
            "#8B5CF6"
          );

          line.setAttribute(
            "stroke-width",
            "1.5"
          );

          line.setAttribute(
            "stroke-dasharray",
            "3 4"
          );

          line.setAttribute(
            "marker-end",
            "url(#arrow)"
          );
        } else if (
          relation ===
          "OCCURRED_AT"
        ) {
          line.setAttribute(
            "stroke",
            "#3B82F6"
          );

          line.setAttribute(
            "stroke-width",
            "1.5"
          );

          line.setAttribute(
            "stroke-dasharray",
            "3 5"
          );

          line.setAttribute(
            "marker-end",
            "url(#arrow)"
          );
        } else {
          line.setAttribute(
            "stroke",
            hot
              ? "#FF5C5C"
              : "#2D394B"
          );

          line.setAttribute(
            "stroke-width",
            hot
              ? "2.4"
              : "1.4"
          );

          line.setAttribute(
            "marker-end",
            hot
              ? "url(#arrowHigh)"
              : "url(#arrow)"
          );
        }

        edgeLayer.appendChild(
          line
        );

        if (
          transfer &&
          edge.amount !==
            undefined
        ) {
          const label =
            document.createElementNS(
              "http://www.w3.org/2000/svg",
              "text"
            );

          label.setAttribute(
            "x",
            (from.x +
              to.x) /
              2
          );

          label.setAttribute(
            "y",
            (from.y +
              to.y) /
              2 -
              7
          );

          label.setAttribute(
            "fill",
            hot
              ? "#FF8C8C"
              : "#8290A5"
          );

          label.setAttribute(
            "font-size",
            "9"
          );

          label.setAttribute(
            "font-family",
            "monospace"
          );

          label.setAttribute(
            "text-anchor",
            "middle"
          );

          label.textContent =
            money(
              edge.amount
            );

          edgeLayer.appendChild(
            label
          );
        }
      }
    );

    // ----------------------------------------------------------
    // Nodes
    // ----------------------------------------------------------

    nodes.forEach(
      (node) => {
        const position =
          positions[
            node.id
          ];

        if (!position) {
          return;
        }

        const group =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            "g"
          );

        const type =
          String(
            node.type ||
              "account"
          ).toLowerCase();

        const focused =
          node.id ===
          targetId;

        const alert =
          alertsByAccount.get(
            node.id
          );

        let shapeName =
          "circle";

        let fill =
          "#4F7CFF";

        let stroke =
          "#283C70";

        if (
          type ===
          "device"
        ) {
          shapeName =
            "rect";

          fill =
            "#F0A93A";

          stroke =
            "#7A5410";
        }

        if (
          type ===
          "merchant"
        ) {
          shapeName =
            "rect";

          fill =
            "#8B5CF6";

          stroke =
            "#5E3AA5";
        }

        if (
          type ===
          "location"
        ) {
          shapeName =
            "polygon";

          fill =
            "#3B82F6";

          stroke =
            "#2457A6";
        }

        if (
          type ===
          "account" &&
          alert?.status ===
            "HIGH RISK"
        ) {
          fill =
            "#FF5C5C";

          stroke =
            "#7A1616";
        }

        if (
          type ===
          "account" &&
          alert?.status ===
            "WATCH"
        ) {
          fill =
            "#F0A93A";

          stroke =
            "#7A5410";
        }

        if (
          focused &&
          state.currentScore
        ) {
          fill =
            riskTier(
              state.currentScore
                .status
            ) ===
            "high"
              ? "#FF5C5C"
              : riskTier(
                  state.currentScore
                    .status
                ) ===
                "watch"
              ? "#F0A93A"
              : "#10B981";

          stroke =
            "#FFFFFF";
        }

        const shape =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            shapeName
          );

        if (
          type ===
          "account"
        ) {
          shape.setAttribute(
            "cx",
            position.x
          );

          shape.setAttribute(
            "cy",
            position.y
          );

          shape.setAttribute(
            "r",
            focused
              ? "23"
              : "16"
          );
        }

        if (
          type ===
          "device"
        ) {
          shape.setAttribute(
            "x",
            position.x -
              13
          );

          shape.setAttribute(
            "y",
            position.y -
              13
          );

          shape.setAttribute(
            "width",
            "26"
          );

          shape.setAttribute(
            "height",
            "26"
          );

          shape.setAttribute(
            "rx",
            "5"
          );
        }

        if (
          type ===
          "merchant"
        ) {
          shape.setAttribute(
            "x",
            position.x -
              12
          );

          shape.setAttribute(
            "y",
            position.y -
              12
          );

          shape.setAttribute(
            "width",
            "24"
          );

          shape.setAttribute(
            "height",
            "24"
          );

          shape.setAttribute(
            "rx",
            "3"
          );
        }

        if (
          type ===
          "location"
        ) {
          shape.setAttribute(
            "points",
            [
              `${position.x},${
                position.y -
                16
              }`,

              `${position.x + 16},${
                position.y
              }`,

              `${position.x},${
                position.y +
                16
              }`,

              `${position.x - 16},${
                position.y
              }`
            ].join(" ")
          );
        }

        shape.setAttribute(
          "fill",
          fill
        );

        shape.setAttribute(
          "stroke",
          stroke
        );

        shape.setAttribute(
          "stroke-width",
          "2"
        );

        group.appendChild(
          shape
        );

        const label =
          document.createElementNS(
            "http://www.w3.org/2000/svg",
            "text"
          );

        label.setAttribute(
          "x",
          position.x
        );

        label.setAttribute(
          "y",
          position.y -
            (
              focused
                ? 31
                : 22
            )
        );

        label.setAttribute(
          "fill",
          "#A7B0C3"
        );

        label.setAttribute(
          "font-size",
          focused
            ? "10.5"
            : "9"
        );

        label.setAttribute(
          "font-family",
          "monospace"
        );

        label.setAttribute(
          "text-anchor",
          "middle"
        );

        label.textContent =
          node.label ||
          node.id;

        group.appendChild(
          label
        );

        group.style.cursor =
          "pointer";

        group.addEventListener(
          "click",
          () => {
            if (
              type ===
              "device"
            ) {
              showDeviceInfo(
                node.id
              );

              return;
            }

            if (
              type ===
              "merchant"
            ) {
              showGenericEntityInfo(
                "Merchant",
                node.id
              );

              return;
            }

            if (
              type ===
              "location"
            ) {
              showGenericEntityInfo(
                "Location",
                node.id
              );

              return;
            }

            inspectAccountNode(
              node.id
            );
          }
        );

        nodeLayer.appendChild(
          group
        );
      }
    );
  }

  // ============================================================
  // INSPECTOR
  // ============================================================

  async function inspectAccountNode(
    accountId
  ) {
    try {
      const data =
        await apiGet(
          `/api/score/${encodeURIComponent(
            accountId
          )}`
        );

      state.currentAccount =
        String(
          accountId
        )
          .trim()
          .toUpperCase();

      state.currentScore =
        data;

      state.selectedNodeType =
        "account";

      setText(
        "insType",
        "Account"
      );

      setText(
        "insId",
        state.currentAccount
      );

      setText(
        "insScore",
        data?.risk_score ??
          0
      );

      const scoreNode =
        $("insScore");

      if (scoreNode) {
        scoreNode.style.color =
          riskColor(
            data?.status
          );
      }

      setText(
        "insNote",
        safeArray(
          data?.reasons
        ).join(
          " · "
        ) ||
          "No suspicious indicators detected."
      );

      setText(
        "insDevices",
        safeArray(
          data?.shared_devices
        )
          .map(
            (device) =>
              device.device_id ||
              device.device ||
              device.id
          )
          .filter(Boolean)
          .join(
            ", "
          ) ||
          "None detected."
      );

      const factors =
        $("insFactors");

      if (factors) {
        factors.innerHTML = [
          factor(
            "Circular routing",
            data?.factors
              ?.circular_routing ||
              0
          ),

          factor(
            "Device sharing",
            data?.factors
              ?.device_sharing ||
              0
          ),

          factor(
            "Transaction velocity",
            data?.factors
              ?.transaction_velocity ||
              0
          ),

          factor(
            "Network connectivity",
            data?.factors
              ?.network_connectivity ||
              0
          )
        ].join("");
      }

      const flag =
        $("btnFlag");

      if (flag) {
        flag.style.display =
          data?.status ===
          "SAFE"
            ? "none"
            : "block";
      }

      openInspector();
    } catch (error) {
      console.error(
        "[FinSentinels] Inspect account failed:",
        error
      );

      toast(
        `Could not inspect account: ${error.message}`
      );
    }
  }

  function showDeviceInfo(
    deviceId
  ) {
    state.selectedNodeType =
      "device";

    setText(
      "insType",
      "Device"
    );

    setText(
      "insId",
      deviceId
    );

    setText(
      "insScore",
      "—"
    );

    setText(
      "insNote",
      "Shared infrastructure node used as evidence. Devices cannot themselves be converted into financial cases."
    );

    setText(
      "insDevices",
      deviceId
    );

    const factors =
      $("insFactors");

    if (factors) {
      factors.innerHTML =
        "";
    }

    hideElement(
      "btnFlag"
    );

    openInspector();
  }

  function showGenericEntityInfo(
    type,
    id
  ) {
    state.selectedNodeType =
      String(
        type
      ).toLowerCase();

    setText(
      "insType",
      type
    );

    setText(
      "insId",
      id
    );

    setText(
      "insScore",
      "—"
    );

    setText(
      "insNote",
      `${type} entity connected to the financial fraud network. It is contextual evidence rather than a financial account.`
    );

    setText(
      "insDevices",
      "—"
    );

    const factors =
      $("insFactors");

    if (factors) {
      factors.innerHTML =
        "";
    }

    hideElement(
      "btnFlag"
    );

    openInspector();
  }

  function hideElement(
    id
  ) {
    const node =
      $(id);

    if (node) {
      node.style.display =
        "none";
    }
  }

  function openInspector() {
    $("inspector")?.classList.add(
      "open"
    );

    $("backdrop")?.classList.add(
      "open"
    );
  }

  function closeInspector() {
    $("inspector")?.classList.remove(
      "open"
    );

    $("inspector")?.classList.remove(
      "is-open"
    );

    $("backdrop")?.classList.remove(
      "open"
    );

    $("backdrop")?.classList.remove(
      "is-open"
    );
  }

  // ============================================================
  // ANALYTICS
  // ============================================================

  async function loadAnalytics() {
    try {
      const data =
        await apiGet(
          "/api/analytics"
        );

      const network =
        data?.network || {};

      const risk =
        data?.risk_distribution ||
        {};

      const patterns =
        data?.fraud_patterns ||
        {};

      const transactionMetrics =
        data?.transaction_metrics ||
        {};

      const cases =
        data?.case_metrics ||
        {};

      setText(
        "anAvgRisk",
        Number(
          data?.average_risk_score ??
            0
        ).toFixed(1)
      );

      setText(
        "anCases",
        cases.total ??
          state.cases.length
      );

      setText(
        "anConnections",
        network.connections ??
          0
      );

      setText(
        "anShared",
        patterns.shared_devices ??
          0
      );

      setText(
        "anCycles",
        patterns.active_cycles ??
          0
      );

      setText(
        "anSharedDevices",
        patterns.shared_devices ??
          0
      );

      setText(
        "anVolume",
        money(
          transactionMetrics.total_volume ??
            0
        )
      );

      const values = {
        high:
          Number(
            risk.high_risk ||
              0
          ),

        watch:
          Number(
            risk.watch ||
              0
          ),

        safe:
          Number(
            risk.safe ||
              0
          )
      };

      const total =
        Object.values(
          values
        ).reduce(
          (sum, value) =>
            sum + value,
          0
        ) || 1;

      [
        "high",
        "watch",
        "safe"
      ].forEach(
        (key) => {
          const label =
            key
              .charAt(0)
              .toUpperCase() +
            key.slice(1);

          setText(
            `risk${label}Val`,
            values[key]
          );

          const bar =
            $(
              `risk${label}Bar`
            );

          if (bar) {
            bar.style.width =
              `${
                (
                  values[key] /
                  total
                ) *
                100
              }%`;
          }
        }
      );
    } catch (error) {
      console.error(
        "[FinSentinels] Analytics failed:",
        error
      );

      toast(
        `Analytics unavailable: ${error.message}`
      );
    }
  }

  // ============================================================
  // SETTINGS
  // ============================================================

  async function loadSettings() {
    try {
      const settings =
        await apiGet(
          "/api/settings"
        );

      setValue(
        "highThreshold",
        settings?.high_threshold
      );

      setValue(
        "watchThreshold",
        settings?.watch_threshold
      );

      setValue(
        "graphDepth",
        settings?.graph_depth
      );

      try {
        await apiGet(
          "/api/health"
        );

        setText(
          "backendStatus",
          "CONNECTED"
        );

        const status =
          $("backendStatus");

        if (status) {
          status.style.color =
            "var(--green)";
        }
      } catch (healthError) {
        console.error(
          "[FinSentinels] Health check failed:",
          healthError
        );

        setText(
          "backendStatus",
          "DISCONNECTED"
        );

        const status =
          $("backendStatus");

        if (status) {
          status.style.color =
            "var(--red)";
        }
      }
    } catch (error) {
      console.error(
        "[FinSentinels] Settings failed:",
        error
      );

      toast(
        `Settings unavailable: ${error.message}`
      );
    }
  }

  async function saveSettings() {
    const high =
      Number(
        $("highThreshold")
          ?.value
      );

    const watch =
      Number(
        $("watchThreshold")
          ?.value
      );

    const depth =
      Number(
        $("graphDepth")
          ?.value
      );

    if (
      !Number.isFinite(
        high
      ) ||
      !Number.isFinite(
        watch
      ) ||
      !Number.isFinite(
        depth
      )
    ) {
      toast(
        "Enter valid numeric settings."
      );

      return;
    }

    if (
      watch >= high
    ) {
      toast(
        "Watch threshold must be lower than high-risk threshold."
      );

      return;
    }

    try {
      await apiPut(
        "/api/settings",
        {
          high_threshold:
            high,

          watch_threshold:
            watch,

          graph_depth:
            depth
        }
      );

      toast(
        "Settings saved successfully."
      );

      await loadOverview();
    } catch (error) {
      console.error(
        "[FinSentinels] Save settings failed:",
        error
      );

      toast(
        `Could not save settings: ${error.message}`
      );
    }
  }

  // ============================================================
  // PROFILE
  // ============================================================

  async function openProfile() {
    try {
      const profile =
        await apiGet(
          "/api/profile"
        );

      const name =
        profile?.name ||
        "R. Kulkarni";

      setText(
        "profileModalName",
        name
      );

      setText(
        "profileOpen",
        profile?.active_cases ??
          0
      );

      setText(
        "profileTotal",
        profile?.total_cases ??
          0
      );

      setText(
        "profileSystem",
        profile?.system ||
          "Online"
      );

      const initials =
        name
          .split(
            /\s+/
          )
          .map(
            (part) =>
              part[0]
          )
          .join("")
          .toUpperCase()
          .slice(
            0,
            2
          );

      setText(
        "profileAvatar",
        initials
      );

      setText(
        "profileModalAvatar",
        initials
      );
    } catch (error) {
      console.error(
        "[FinSentinels] Profile load failed:",
        error
      );

      toast(
        `Profile unavailable: ${error.message}`
      );
    }

    $("profileModal")?.classList.add(
      "open"
    );
  }

  function closeProfile() {
    $("profileModal")?.classList.remove(
      "open"
    );
  }

  // ============================================================
  // LOGIN
  // ============================================================

  async function login() {
    const name =
      String(
        $("loginName")
          ?.value ||
          ""
      ).trim();

    const code =
      String(
        $("loginCode")
          ?.value ||
          ""
      ).trim().toUpperCase();

    const button =
      $("loginBtn");

    const error =
      $("loginError");

    if (error) {
      error.textContent =
        "";
    }

    if (!name) {
      if (error) {
        error.textContent =
          "Enter an analyst name.";
      }

      $("loginName")
        ?.focus();

      return false;
    }

    if (!code) {
      if (error) {
        error.textContent =
          "Enter the access code.";
      }

      $("loginCode")
        ?.focus();

      return false;
    }

    if (
      code !==
      "FINSENTINELS"
    ) {
      if (error) {
        error.textContent =
          "Invalid access code.";
      }

      $("loginCode")
        ?.focus();

      $("loginCode")
        ?.select();

      return false;
    }

    if (button) {
      button.disabled =
        true;

      button.textContent =
        "Opening Workspace…";
    }

    try {
      localStorage.setItem(
        "finSentinelsAnalyst",
        name
      );

      state.loggedIn =
        true;

      $("login")
        ?.classList.add(
          "hidden"
        );

      const app =
        $("app");

      if (!app) {
        throw new Error(
          "Application container not found."
        );
      }

      app.classList.remove(
        "hidden"
      );

      app.style.display =
        "grid";

      setText(
        "topProfileName",
        name
      );

      const initials =
        name
          .split(
            /\s+/
          )
          .map(
            (part) =>
              part[0]
          )
          .join("")
          .toUpperCase()
          .slice(
            0,
            2
          );

      setText(
        "profileAvatar",
        initials
      );

      await setView(
        "overview"
      );

      toast(
        `Access granted. Welcome, ${name}.`
      );

      return true;
    } catch (errorValue) {
      console.error(
        "[FinSentinels] Login failed:",
        errorValue
      );

      if (error) {
        error.textContent =
          errorValue.message;
      }

      toast(
        `Login failed: ${errorValue.message}`
      );

      return false;
    } finally {
      if (button) {
        button.disabled =
          false;

        button.textContent =
          "Enter Workspace";
      }
    }
  }

  function logout() {
    localStorage.removeItem(
      "finSentinelsAnalyst"
    );

    state.loggedIn =
      false;

    state.currentAccount =
      "";

    state.currentScore =
      null;

    state.currentGraph =
      null;

    state.selectedCase =
      null;

    const app =
      $("app");

    const login =
      $("login");

    app?.classList.add(
      "hidden"
    );

    if (app) {
      app.style.display =
        "none";
    }

    login?.classList.remove(
      "hidden"
    );

    $("loginCode")
      ?.focus();
  }

  // ============================================================
  // EVENT BINDING
  // ============================================================

  function bind() {
    // ----------------------------------------------------------
    // Login
    // ----------------------------------------------------------

    $("loginBtn")
      ?.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          login();
        }
      );

    $("loginCode")
      ?.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key ===
            "Enter"
          ) {
            event.preventDefault();
            login();
          }
        }
      );

    $("loginName")
      ?.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key ===
            "Enter"
          ) {
            event.preventDefault();
            login();
          }
        }
      );

    // ----------------------------------------------------------
    // Sidebar
    // ----------------------------------------------------------

    qsa(
      ".nav-btn[data-view]"
    ).forEach(
      (button) => {
        button.addEventListener(
          "click",
          () =>
            setView(
              button.dataset
                .view
            )
        );
      }
    );

    // ----------------------------------------------------------
    // View links
    // ----------------------------------------------------------

    qsa(
      "[data-view-link]"
    ).forEach(
      (button) => {
        button.addEventListener(
          "click",
          () =>
            setView(
              button.dataset
                .viewLink
            )
        );
      }
    );

    // ----------------------------------------------------------
    // Search
    // ----------------------------------------------------------

    $("globalSearch")
      ?.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key ===
            "Enter"
          ) {
            event.preventDefault();

            investigateAccount(
              event.target.value
            );
          }
        }
      );

    $("investigationSearch")
      ?.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key ===
            "Enter"
          ) {
            event.preventDefault();

            investigateAccount(
              event.target.value
            );
          }
        }
      );

    // ----------------------------------------------------------
    // Investigation button
    // ----------------------------------------------------------

    $("investigateBtn")
      ?.addEventListener(
        "click",
        () =>
          investigateAccount(
            $("investigationSearch")
              ?.value
          )
      );

    // ----------------------------------------------------------
    // Network refresh
    // ----------------------------------------------------------

    $("networkRefresh")
      ?.addEventListener(
        "click",
        loadNetwork
      );

    // ----------------------------------------------------------
    // Network filters
    // Your HTML uses .net-filter buttons.
    // ----------------------------------------------------------

    qsa(
      ".net-filter"
    ).forEach(
      (button) => {
        button.addEventListener(
          "click",
          () => {
            qsa(
              ".net-filter"
            ).forEach(
              (other) =>
                other.classList.remove(
                  "active"
                )
            );

            button.classList.add(
              "active"
            );

            state.networkFilter =
              button.dataset
                .filter ||
              "all";

            drawNetwork(
              state.currentGraph
            );
          }
        );
      }
    );

    // ----------------------------------------------------------
    // Settings
    // ----------------------------------------------------------

    $("saveSettings")
      ?.addEventListener(
        "click",
        saveSettings
      );

    // ----------------------------------------------------------
    // Profile
    // ----------------------------------------------------------

    $("profileBtn")
      ?.addEventListener(
        "click",
        openProfile
      );

    $("profileClose")
      ?.addEventListener(
        "click",
        closeProfile
      );

    $("profileModal")
      ?.addEventListener(
        "click",
        (event) => {
          if (
            event.target ===
            $("profileModal")
          ) {
            closeProfile();
          }
        }
      );

    // ----------------------------------------------------------
    // Inspector
    // ----------------------------------------------------------

    $("insClose")
      ?.addEventListener(
        "click",
        closeInspector
      );

    $("btnDismiss")
      ?.addEventListener(
        "click",
        closeInspector
      );

    $("backdrop")
      ?.addEventListener(
        "click",
        closeInspector
      );

    $("btnFlag")
      ?.addEventListener(
        "click",
        createCase
      );

    // ----------------------------------------------------------
    // Escape
    // ----------------------------------------------------------

    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key ===
          "Escape"
        ) {
          closeProfile();
          closeInspector();
        }
      }
    );

    console.log(
      "[FinSentinels] Event handlers bound."
    );
  }

  // ============================================================
  // INITIALIZATION
  // ============================================================

  async function initialize() {
    if (state.initialized) {
      return;
    }

    state.initialized =
      true;

    console.log(
      "🛡️ FinSentinels frontend online"
    );

    bind();

    const savedAnalyst =
      localStorage.getItem(
        "finSentinelsAnalyst"
      );

    if (!savedAnalyst) {
      $("login")
        ?.classList.remove(
          "hidden"
        );

      $("app")
        ?.classList.add(
          "hidden"
        );

      $("loginName")
        ?.focus();

      return;
    }

    state.loggedIn =
      true;

    setValue(
      "loginName",
      savedAnalyst
    );

    $("login")
      ?.classList.add(
        "hidden"
      );

    const app =
      $("app");

    app?.classList.remove(
      "hidden"
    );

    if (app) {
      app.style.display =
        "grid";
    }

    setText(
      "topProfileName",
      savedAnalyst
    );

    const initials =
      savedAnalyst
        .split(
          /\s+/
        )
        .map(
          (part) =>
            part[0]
        )
        .join("")
        .toUpperCase()
        .slice(
          0,
          2
        );

    setText(
      "profileAvatar",
      initials
    );

    await setView(
      "overview"
    );
  }

  // ============================================================
  // GLOBAL FUNCTIONS
  // ============================================================

  window.investigate =
    investigateAccount;

  window.investigateAccount =
    investigateAccount;

  window.createCase =
    createCase;

  window.openCase =
    openCase;

  window.closeCase =
    closeCase;

  window.loadCases =
    loadCases;

  window.loadAlerts =
    loadAlerts;

  window.loadAnalytics =
    loadAnalytics;

  window.loadNetwork =
    loadNetwork;

  window.saveSettings =
    saveSettings;

  window.setView =
    setView;

  window.switchView =
    setView;

  window.logout =
    logout;

  window.openInvestigationGraph =
    async () => {
      if (!state.currentGraph) {
        await loadNetwork();
        return;
      }

      await setView(
        "network"
      );

      requestAnimationFrame(
        () =>
          drawNetwork(
            state.currentGraph
          )
      );
    };

  // ============================================================
  // START
  // ============================================================

  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      {
        once: true
      }
    );
  } else {
    initialize();
  }
})();