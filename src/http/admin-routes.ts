import http from "node:http";
import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import type { AdminService } from "../services/admin-service.js";
import { readJsonBody, respondJson } from "./common.js";

export async function handleAdminRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly adminService: AdminService;
    readonly config: AppConfig;
  }
): Promise<boolean> {
  if (method === "GET" && url.pathname === "/admin") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(renderAdminPage({
      tokenConfigured: Boolean(options.config.brokerAdminToken),
      serviceName: options.config.serviceName
    }));
    return true;
  }

  if (!url.pathname.startsWith("/admin/api/")) {
    return false;
  }

  if (!isAuthorizedAdminRequest(request, options.config)) {
    respondJson(response, 401, {
      ok: false,
      error: "admin_auth_required"
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/admin/api/status") {
    respondJson(response, 200, await options.adminService.getStatus());
    return true;
  }

  if (method === "POST" && url.pathname === "/admin/api/replace-auth") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      respondJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
      return true;
    }

    const authJsonContent = typeof body.auth_json_content === "string" ? body.auth_json_content : undefined;
    const credentialsJsonContent =
      typeof body.credentials_json_content === "string" ? body.credentials_json_content : undefined;
    const configTomlContent = typeof body.config_toml_content === "string" ? body.config_toml_content : undefined;
    const allowActive = body.allow_active === true;

    if (!authJsonContent?.trim() && !credentialsJsonContent?.trim() && !configTomlContent?.trim()) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["auth_json_content | credentials_json_content | config_toml_content"]
      });
      return true;
    }

    try {
      respondJson(
        response,
        200,
        await options.adminService.replaceAuthFiles({
          authJsonContent,
          credentialsJsonContent,
          configTomlContent,
          allowActive
        })
      );
    } catch (error) {
      respondJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return true;
  }

  return false;
}

function isAuthorizedAdminRequest(request: http.IncomingMessage, config: AppConfig): boolean {
  if (!config.brokerAdminToken) {
    return true;
  }

  const fromHeader = request.headers["x-admin-token"];
  if (typeof fromHeader === "string" && fromHeader === config.brokerAdminToken) {
    return true;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length) === config.brokerAdminToken;
  }

  return false;
}

function renderAdminPage(options: {
  readonly tokenConfigured: boolean;
  readonly serviceName: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.serviceName)} 控制台</title>
  <style>
    :root {
      color-scheme: dark;
      --accent: #ff962d;
      --accent-soft: rgba(255, 150, 45, 0.1);
      --bg: #050505;
      --panel: #0a0a0a;
      --border: rgba(255, 150, 45, 0.2);
      --border-strong: rgba(255, 150, 45, 0.4);
      --text: #eee;
      --muted: #888;
      --good: #34dd93;
      --warn: #ffcb63;
      --danger: #ff7458;
      --mono: "IBM Plex Mono", "SF Mono", "JetBrains Mono", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.4;
    }
    .wrap {
      max-width: 1600px;
      margin: 0 auto;
      padding: 16px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 2px solid var(--accent);
      padding-bottom: 8px;
      margin-bottom: 16px;
    }
    h1 { margin: 0; font-size: 18px; text-transform: uppercase; color: var(--accent); }
    .header-meta { display: flex; gap: 12px; }
    
    .grid-summary {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1px;
      background: var(--border);
      border: 1px solid var(--border);
      margin-bottom: 16px;
    }
    .summary-item {
      background: var(--panel);
      padding: 12px;
    }
    .summary-label { font-size: 10px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
    .summary-value { font-size: 20px; font-weight: bold; color: var(--accent); }
    .summary-detail { font-size: 11px; color: var(--muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .main-layout {
      display: grid;
      grid-template-columns: 1fr 400px;
      gap: 16px;
      align-items: start;
    }
    section {
      border: 1px solid var(--border);
      background: var(--panel);
      margin-bottom: 16px;
    }
    .section-head {
      background: var(--accent-soft);
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .section-title { font-size: 12px; font-weight: bold; text-transform: uppercase; color: var(--accent); }
    
    .toolbar { display: flex; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); }
    .toolbar input, .toolbar select { 
      background: #000; border: 1px solid var(--border); color: var(--text); 
      padding: 6px 10px; font-family: inherit; font-size: 12px; 
    }
    .toolbar input[type="search"] { flex: 1; }

    .session-table-header {
      display: grid;
      grid-template-columns: 1.5fr 1fr 1.2fr 1fr 80px;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }
    .session-list { display: grid; }
    .session-row { border-bottom: 1px solid var(--border); }
    .session-summary {
      display: grid;
      grid-template-columns: 1.5fr 1fr 1.2fr 1fr 80px;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
      align-items: center;
    }
    .session-summary:hover { background: rgba(255,150,45,0.05); }
    .session-key { color: var(--accent); font-weight: bold; overflow: hidden; text-overflow: ellipsis; }
    .session-body { padding: 12px; background: #000; border-top: 1px solid var(--border); }

    .tui-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .tui-table th { text-align: left; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--border); font-size: 10px; text-transform: uppercase; }
    .tui-table td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }

    .auth-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      padding: 12px;
      border-bottom: 1px solid var(--border);
      align-items: center;
    }
    .auth-info { display: grid; gap: 2px; }
    .auth-path { font-size: 11px; color: var(--muted); word-break: break-all; }
    
    .badge {
      display: inline-block; padding: 2px 6px; font-size: 10px; font-weight: bold;
      text-transform: uppercase; border: 1px solid currentColor;
    }
    .badge.good { color: var(--good); }
    .badge.warn { color: var(--warn); }
    .badge.danger { color: var(--danger); }

    button {
      background: var(--accent); color: #000; border: none; padding: 6px 12px;
      font-family: inherit; font-size: 11px; font-weight: bold; cursor: pointer;
      text-transform: uppercase;
    }
    button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
    button:disabled { opacity: 0.5; cursor: default; }
    
    textarea, input[type="password"], input[type="file"] {
      width: 100%; background: #000; border: 1px solid var(--border); color: var(--text);
      padding: 8px; font-family: inherit; font-size: 12px;
    }
    textarea { min-height: 120px; }
    
    dialog {
      background: var(--panel); border: 2px solid var(--accent); color: var(--text);
      padding: 0; width: 600px; max-width: 90vw;
    }
    dialog::backdrop { background: rgba(0,0,0,0.8); backdrop-filter: blur(2px); }
    .modal-content { padding: 20px; display: grid; gap: 16px; }
    
    .log-list { max-height: 400px; overflow-y: auto; font-size: 11px; }
    .log-entry { padding: 4px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .log-entry.warn { color: var(--warn); background: rgba(255, 203, 99, 0.05); }
    .log-entry.error { color: var(--danger); background: rgba(255, 116, 88, 0.05); }

    .quota-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px; }
    .quota-box { border: 1px solid var(--border); padding: 8px; }
    
    @media (max-width: 1000px) {
      .main-layout { grid-template-columns: 1fr; }
      .grid-summary { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${escapeHtml(options.serviceName)} ADMIN</h1>
      <div class="header-meta">
        <span class="badge ${options.tokenConfigured ? "good" : "warn"}">${options.tokenConfigured ? "AUTH: ON" : "AUTH: OFF"}</span>
        <span class="badge">REFRESH: 10S</span>
      </div>
    </header>

    <div class="grid-summary">
      <div class="summary-item">
        <div class="summary-label">SERVICE</div>
        <div class="summary-value" id="summary-service">--</div>
        <div class="summary-detail" id="summary-service-detail">...</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">ACCOUNT</div>
        <div class="summary-value" id="summary-account">--</div>
        <div class="summary-detail" id="summary-account-detail">...</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">SESSIONS</div>
        <div class="summary-value" id="summary-sessions">--</div>
        <div class="summary-detail" id="summary-sessions-detail">...</div>
      </div>
      <div class="summary-item">
        <div class="summary-label">JOBS</div>
        <div class="summary-value" id="summary-jobs">--</div>
        <div class="summary-detail" id="summary-jobs-detail">...</div>
      </div>
    </div>

    <div class="main-layout">
      <div class="stack-main">
        <section>
          <div class="section-head">
            <div class="section-title">Sessions</div>
            <div id="last-refresh" style="font-size:10px; color:var(--muted)">READY</div>
          </div>
          <div class="toolbar">
            <input id="session-search" type="search" placeholder="FILTER SESSIONS..." />
            <select id="session-filter">
              <option value="all">ALL</option>
              <option value="active">ACTIVE</option>
              <option value="inbound">INBOUND</option>
              <option value="jobs">JOBS</option>
              <option value="issues">ISSUES</option>
            </select>
          </div>
          <div class="session-table-header">
            <div>Session Key / Channel</div>
            <div>Status / Slack</div>
            <div>Inbound / Jobs</div>
            <div>Current Lead</div>
            <div>Action</div>
          </div>
          <div id="sessions-panel" class="session-list"></div>
        </section>

        <section>
          <div class="section-head">
            <div class="section-title">System Logs</div>
          </div>
          <div id="logs-panel" class="log-list"></div>
        </section>
      </div>

      <div class="stack-side">
        <section>
          <div class="section-head">
            <div class="section-title">Control</div>
          </div>
          <div style="padding:12px; display:grid; gap:8px;">
            <input id="token-input" type="password" placeholder="ADMIN TOKEN" />
            <button id="refresh-button">REFRESH STATUS</button>
            <div id="token-status" style="font-size:10px; text-align:center"></div>
          </div>
        </section>

        <section>
          <div class="section-head">
            <div class="section-title">Account Quota</div>
          </div>
          <div id="account-card"></div>
        </section>

        <section>
          <div class="section-head">
            <div class="section-title">Auth Files</div>
          </div>
          <div id="auth-files-list">
            <div class="auth-row">
              <div class="auth-info">
                <div style="font-weight:bold">auth.json <span id="auth-file-auth-badge"></span></div>
                <div class="auth-path" id="auth-file-auth-path"></div>
                <div class="auth-path" id="auth-file-auth-meta"></div>
              </div>
              <button id="open-auth-dialog">REPLACE</button>
            </div>
            <div class="auth-row">
              <div class="auth-info">
                <div style="font-weight:bold">.credentials.json <span id="auth-file-credentials-badge"></span></div>
                <div class="auth-path" id="auth-file-credentials-path"></div>
                <div class="auth-path" id="auth-file-credentials-meta"></div>
              </div>
              <button id="open-credentials-dialog" class="secondary">REPLACE</button>
            </div>
            <div class="auth-row">
              <div class="auth-info">
                <div style="font-weight:bold">config.toml <span id="auth-file-config-badge"></span></div>
                <div class="auth-path" id="auth-file-config-path"></div>
                <div class="auth-path" id="auth-file-config-meta"></div>
              </div>
              <button id="open-config-dialog" class="secondary">REPLACE</button>
            </div>
          </div>
          <div id="replace-status" style="padding:8px; font-size:10px;"></div>
        </section>

        <section>
          <div class="section-head">
            <div class="section-title">Runtime Info</div>
          </div>
          <div id="service-card" style="padding:12px; font-size:11px;"></div>
        </section>
      </div>
    </div>
  </div>

  <dialog id="auth-dialog"><div class="modal-content">
    <div class="section-title">Replace auth.json</div>
    <input id="auth-json-file" type="file" />
    <textarea id="auth-json-text" placeholder="PASTE JSON HERE..."></textarea>
    <label style="font-size:11px; display:flex; gap:8px; align-items:center;">
      <input id="allow-active-auth" type="checkbox" /> FORCE REPLACE (INTERRUPT SESSIONS)
    </label>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button id="close-auth-dialog" class="secondary">CANCEL</button>
      <button id="submit-auth-dialog">APPLY</button>
    </div>
    <div id="auth-dialog-status" style="font-size:10px;"></div>
  </div></dialog>

  <dialog id="credentials-dialog"><div class="modal-content">
    <div class="section-title">Replace .credentials.json</div>
    <input id="credentials-json-file" type="file" />
    <textarea id="credentials-json-text" placeholder="PASTE JSON HERE..."></textarea>
    <label style="font-size:11px; display:flex; gap:8px; align-items:center;">
      <input id="allow-active-credentials" type="checkbox" /> FORCE REPLACE
    </label>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button id="close-credentials-dialog" class="secondary">CANCEL</button>
      <button id="submit-credentials-dialog">APPLY</button>
    </div>
    <div id="credentials-dialog-status" style="font-size:10px;"></div>
  </div></dialog>

  <dialog id="config-dialog"><div class="modal-content">
    <div class="section-title">Replace config.toml</div>
    <input id="config-toml-file" type="file" />
    <textarea id="config-toml-text" placeholder="PASTE TOML HERE..."></textarea>
    <label style="font-size:11px; display:flex; gap:8px; align-items:center;">
      <input id="allow-active-config" type="checkbox" /> FORCE REPLACE
    </label>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button id="close-config-dialog" class="secondary">CANCEL</button>
      <button id="submit-config-dialog">APPLY</button>
    </div>
    <div id="config-dialog-status" style="font-size:10px;"></div>
  </div></dialog>

  <script>
    const tokenKey = "broker-admin-token";
    const tokenConfigured = ${options.tokenConfigured ? "true" : "false"};
    const tokenInput = document.getElementById("token-input");
    const tokenStatus = document.getElementById("token-status");
    const refreshButton = document.getElementById("refresh-button");
    const replaceStatus = document.getElementById("replace-status");
    const lastRefresh = document.getElementById("last-refresh");
    const sessionSearch = document.getElementById("session-search");
    const sessionFilter = document.getElementById("session-filter");
    let latestStatus = null;
    const dialogs = [
      ["auth-dialog", "open-auth-dialog", "close-auth-dialog"],
      ["credentials-dialog", "open-credentials-dialog", "close-credentials-dialog"],
      ["config-dialog", "open-config-dialog", "close-config-dialog"]
    ];

    tokenInput.value = localStorage.getItem(tokenKey) || "";

    function esc(value) {
      return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }

    function fmtTime(value) {
      if (!value) return "—";
      try { return new Date(value).toLocaleTimeString(); } catch { return String(value); }
    }

    function clampPercent(value) {
      const number = Number(value);
      return Math.max(0, Math.min(100, Math.round(number || 0)));
    }

    function formatWindowLabel(mins) {
      const m = Number(mins);
      if (m === 300) return "5h";
      if (m === 10080) return "weekly";
      if (m % 1440 === 0) return (m/1440) + "d";
      if (m % 60 === 0) return (m/60) + "h";
      return m + "m";
    }

    function formatRelativeDuration(ms) {
      const absMs = Math.abs(ms);
      const m = Math.round(absMs / 60000);
      if (m < 60) return m + "m";
      const h = Math.round(absMs / 3600000);
      if (h < 48) return h + "h";
      return Math.round(absMs / 86400000) + "d";
    }

    function formatResetTime(sec) {
      if (sec == null) return "unknown reset";
      const delta = (Number(sec) * 1000) - Date.now();
      const rel = formatRelativeDuration(delta);
      return delta > 0 ? "in " + rel : rel + " ago";
    }

    function fmtDuration(sec) {
      const s = Number(sec || 0);
      if (s <= 0) return "JUST STARTED";
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return (h > 0 ? h + "h " : "") + m + "m";
    }

    function statusTone(status) {
      const v = String(status || "").toLowerCase();
      if (["running", "active", "ok", "completed"].includes(v)) return "good";
      if (["pending", "inflight", "starting"].includes(v)) return "warn";
      if (["failed", "error", "stopped"].includes(v)) return "danger";
      return "";
    }

    function renderBadge(label, tone) {
      return '<span class="badge ' + (tone || "") + '">' + esc(label) + "</span>";
    }

    function authHeaders(extra) {
      const h = Object.assign({}, extra || {});
      const t = tokenInput.value.trim();
      if (t) h["x-admin-token"] = t;
      return h;
    }

    function persistToken() {
      localStorage.setItem(tokenKey, tokenInput.value.trim());
      if (tokenConfigured && !tokenInput.value.trim()) {
        tokenStatus.innerHTML = '<span style="color:var(--warn)">MISSING TOKEN</span>';
      } else if (!tokenConfigured) {
        tokenStatus.innerHTML = '<span style="color:var(--warn)">UNPROTECTED</span>';
      } else {
        tokenStatus.innerHTML = '<span style="color:var(--good)">TOKEN READY</span>';
      }
    }

    tokenInput.addEventListener("input", persistToken);
    persistToken();

    function renderSummary(data) {
      const s = data.service || {};
      const st = data.state || {};
      const a = data.account || {};
      const rl = data.rateLimits || {};
      
      document.getElementById("summary-service").textContent = "ONLINE";
      document.getElementById("summary-service-detail").textContent = "PID " + (s.pid || "-") + " · UP " + fmtDuration(s.uptimeSeconds);
      
      document.getElementById("summary-account").textContent = a.ok ? (a.account?.planType || "LOGGED") : "ERROR";
      document.getElementById("summary-account-detail").textContent = a.ok ? (a.account?.email || "NO EMAIL") : (a.error || "ERR");
      
      document.getElementById("summary-sessions").textContent = (st.activeCount || 0) + "/" + (st.sessionCount || 0);
      document.getElementById("summary-sessions-detail").textContent = "INBOUND: " + (st.openInboundCount || 0);
      
      document.getElementById("summary-jobs").textContent = st.runningBackgroundJobCount || 0;
      document.getElementById("summary-jobs-detail").textContent = "FAILED: " + (st.failedBackgroundJobCount || 0);
    }

    function renderService(data) {
      const s = data.service || {};
      document.getElementById("service-card").innerHTML = 
        '<div style="display:grid; gap:4px;">' +
        '<div>NAME: ' + esc(s.name) + '</div>' +
        '<div>PORT: ' + esc(s.port) + '</div>' +
        '<div>START: ' + esc(new Date(s.startedAt).toLocaleString()) + '</div>' +
        '<div style="margin-top:8px; color:var(--muted); font-size:10px;">ROOTS:</div>' +
        '<div style="word-break:break-all;">' + esc(s.sessionsRoot) + '</div>' +
        '</div>';
    }

    function renderAccount(data) {
      const panel = document.getElementById("account-card");
      const a = data.account || {};
      if (!a.ok) {
        panel.innerHTML = '<div style="padding:12px; color:var(--danger)">' + esc(a.error || "ACCOUNT ERR") + '</div>';
        return;
      }
      const rl = data.rateLimits || {};
      const snap = rl.ok ? rl.rateLimits : null;
      
      let html = '<div style="padding:12px; border-bottom:1px solid var(--border);">';
      html += '<div>' + esc(a.account?.email) + '</div>';
      html += '<div style="font-size:11px; color:var(--muted)">' + esc(a.account?.planType) + ' · ' + esc(a.account?.type) + '</div>';
      html += '</div>';

      if (snap) {
        html += '<div class="quota-grid">';
        if (snap.primary) {
          html += '<div class="quota-box"><div class="summary-label">' + formatWindowLabel(snap.primary.windowDurationMins) + '</div>' +
                  '<div>' + (100 - clampPercent(snap.primary.usedPercent)) + '% LEFT</div>' +
                  '<div style="font-size:9px; color:var(--muted)">RESET ' + formatResetTime(snap.primary.resetsAt) + '</div></div>';
        }
        if (snap.secondary) {
          html += '<div class="quota-box"><div class="summary-label">' + formatWindowLabel(snap.secondary.windowDurationMins) + '</div>' +
                  '<div>' + (100 - clampPercent(snap.secondary.usedPercent)) + '% LEFT</div>' +
                  '<div style="font-size:9px; color:var(--muted)">RESET ' + formatResetTime(snap.secondary.resetsAt) + '</div></div>';
        }
        html += '</div>';
        if (snap.credits) {
          html += '<div style="padding:0 12px 12px; font-size:11px; color:var(--muted)">CREDITS: ' + 
                  (snap.credits.unlimited ? "UNLIMITED" : (snap.credits.balance || "0")) + '</div>';
        }
      } else {
        html += '<div style="padding:12px; font-size:11px; color:var(--muted)">' + (rl.error || "NO QUOTA DATA") + '</div>';
      }
      panel.innerHTML = html;
    }

    function renderAuthFiles(data) {
      const map = { auth: data.authFiles.authJson, credentials: data.authFiles.credentialsJson, config: data.authFiles.configToml };
      for (const [k, f] of Object.entries(map)) {
        document.getElementById("auth-file-" + k + "-badge").innerHTML = renderBadge(f.exists ? "OK" : "MISSING", f.exists ? "good" : "warn");
        document.getElementById("auth-file-" + k + "-path").textContent = f.path || "-";
        document.getElementById("auth-file-" + k + "-meta").textContent = f.exists ? (f.size + " bytes · " + fmtTime(f.mtime)) : "NOT FOUND";
      }
    }

    function summarizeSessionLead(s) {
      if (s.openInbound?.length) return s.openInbound[0].textPreview || "NEW MSG";
      if (s.backgroundJobs?.length) {
        const r = s.backgroundJobs.find(j => j.status === "running") || s.backgroundJobs[0];
        return (r.kind || "JOB") + " (" + (r.status || "?") + ")";
      }
      return "IDLE";
    }

    function renderSessions(data) {
      const panel = document.getElementById("sessions-panel");
      const list = data.state?.sessions || [];
      const query = (sessionSearch.value || "").toLowerCase();
      const mode = sessionFilter.value;
      
      const filtered = list.filter(s => {
        if (mode === "active" && !s.activeTurnId) return false;
        if (mode === "inbound" && !s.openInboundCount) return false;
        if (mode === "jobs" && !s.runningBackgroundJobCount) return false;
        if (mode === "issues" && !s.failedBackgroundJobCount) return false;
        if (!query) return true;
        return [s.key, s.channelId, s.workspacePath].some(v => String(v).toLowerCase().includes(query));
      });

      if (!filtered.length) {
        panel.innerHTML = '<div style="padding:20px; text-align:center; color:var(--muted)">NO SESSIONS FOUND</div>';
        return;
      }

      panel.innerHTML = filtered.map(s => {
        const lead = summarizeSessionLead(s);
        const isActive = !!s.activeTurnId;
        return '<details class="session-row">' +
          '<summary class="session-summary">' +
            '<div class="session-key">' + esc(s.key) + '<div style="font-size:10px; font-weight:normal; color:var(--muted)">' + esc(s.channelId) + '</div></div>' +
            '<div>' + renderBadge(isActive ? "ACTIVE" : "IDLE", isActive ? "good" : "warn") + '<div style="font-size:10px; color:var(--muted)">UP: ' + fmtTime(s.updatedAt) + '</div></div>' +
            '<div>MSG: ' + (s.openInboundCount || 0) + ' / JOB: ' + (s.runningBackgroundJobCount || 0) + '</div>' +
            '<div style="font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + esc(lead) + '">' + esc(lead) + '</div>' +
            '<div><span style="color:var(--accent); font-size:10px;">EXPAND</span></div>' +
          '</summary>' +
          '<div class="session-body">' +
            '<div style="margin-bottom:12px; font-size:11px; color:var(--muted)">CWD: ' + esc(s.workspacePath) + '</div>' +
            '<div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">' +
              '<div><div class="summary-label">INBOUND</div>' + renderInboundTable(s.openInbound) + '</div>' +
              '<div><div class="summary-label">JOBS</div>' + renderJobsTable(s.backgroundJobs) + '</div>' +
            '</div>' +
          '</div>' +
        '</details>';
      }).join("");
    }

    function renderInboundTable(items) {
      if (!items?.length) return '<div style="color:var(--muted); font-size:11px;">EMPTY</div>';
      return '<table class="tui-table"><thead><tr><th>SRC</th><th>MSG</th></tr></thead><tbody>' +
        items.map(i => '<tr><td>' + esc(i.source) + '</td><td>' + esc(i.textPreview) + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function renderJobsTable(jobs) {
      if (!jobs?.length) return '<div style="color:var(--muted); font-size:11px;">EMPTY</div>';
      return '<table class="tui-table"><thead><tr><th>STATUS</th><th>KIND</th></tr></thead><tbody>' +
        jobs.slice(0, 5).map(j => '<tr><td>' + renderBadge(j.status, statusTone(j.status)) + '</td><td>' + esc(j.kind) + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function renderLogs(data) {
      const logs = data.state?.recentBrokerLogs || [];
      const panel = document.getElementById("logs-panel");
      if (!logs.length) {
        panel.innerHTML = '<div style="padding:12px; color:var(--muted)">NO LOGS</div>';
        return;
      }
      panel.innerHTML = logs.map(e => {
        const tone = statusTone(e.level);
        return '<div class="log-entry ' + tone + '">[' + fmtTime(e.ts) + '] ' + esc(e.message || e.raw) + '</div>';
      }).join("");
    }

    function render(data) {
      latestStatus = data;
      renderSummary(data);
      renderService(data);
      renderAccount(data);
      renderAuthFiles(data);
      renderSessions(data);
      renderLogs(data);
    }

    function bindDialog(did, oid, cid) {
      const d = document.getElementById(did);
      document.getElementById(oid).onclick = () => d.showModal();
      document.getElementById(cid).onclick = () => d.close();
      d.onclick = (e) => { if (e.target === d) d.close(); };
    }

    async function replaceSingleFile(opts) {
      const btn = document.getElementById(opts.buttonId);
      const st = document.getElementById(opts.statusId);
      btn.disabled = true; st.textContent = "WRITING...";
      try {
        const text = document.getElementById(opts.textareaId).value.trim();
        const fileInput = document.getElementById(opts.fileInputId);
        const content = text || (fileInput.files[0] ? await fileInput.files[0].text() : null);
        if (!content) throw new Error("NO CONTENT");
        const payload = { allow_active: document.getElementById(opts.allowActiveId).checked };
        payload[opts.payloadKey] = content;
        const res = await fetch("/admin/api/replace-auth", {
          method: "POST", headers: authHeaders({"content-type":"application/json"}),
          body: JSON.stringify(payload)
        });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error || "FAILED");
        st.innerHTML = '<span style="color:var(--good)">SUCCESS</span>';
        render(r.status);
        document.getElementById(opts.dialogId).close();
      } catch (e) { st.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + '</span>'; }
      finally { btn.disabled = false; }
    }

    async function refresh() {
      refreshButton.disabled = true;
      try {
        const res = await fetch("/admin/api/status", { headers: authHeaders() });
        const p = await res.json();
        if (!res.ok) throw new Error(p.error || "ERR");
        render(p);
        lastRefresh.textContent = "SYNCED: " + new Date().toLocaleTimeString();
      } catch (e) { lastRefresh.textContent = "ERROR: " + e.message; }
      finally { refreshButton.disabled = false; }
    }

    refreshButton.onclick = refresh;
    sessionSearch.oninput = () => { if (latestStatus) renderSessions(latestStatus); };
    sessionFilter.onchange = () => { if (latestStatus) renderSessions(latestStatus); };
    dialogs.forEach(([d, o, c]) => bindDialog(d, o, c));

    document.getElementById("submit-auth-dialog").onclick = () => replaceSingleFile({
      dialogId: "auth-dialog", buttonId: "submit-auth-dialog", statusId: "auth-dialog-status",
      textareaId: "auth-json-text", fileInputId: "auth-json-file", allowActiveId: "allow-active-auth",
      payloadKey: "auth_json_content"
    });
    document.getElementById("submit-credentials-dialog").onclick = () => replaceSingleFile({
      dialogId: "credentials-dialog", buttonId: "submit-credentials-dialog", statusId: "credentials-dialog-status",
      textareaId: "credentials-json-text", fileInputId: "credentials-json-file", allowActiveId: "allow-active-credentials",
      payloadKey: "credentials_json_content"
    });
    document.getElementById("submit-config-dialog").onclick = () => replaceSingleFile({
      dialogId: "config-dialog", buttonId: "submit-config-dialog", statusId: "config-dialog-status",
      textareaId: "config-toml-text", fileInputId: "config-toml-file", allowActiveId: "allow-active-config",
      payloadKey: "config_toml_content"
    });

    refresh(); setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
