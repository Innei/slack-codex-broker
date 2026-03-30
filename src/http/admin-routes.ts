import http from "node:http";
import { URL } from "node:url";

import type { AppConfig } from "../config.js";
import type { AdminService } from "../services/admin-service.js";
import { readJsonBody, readString, respondJson } from "./common.js";

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
    response.end(
      renderAdminPage({
        tokenConfigured: Boolean(options.config.brokerAdminToken),
        serviceName: options.config.serviceName
      })
    );
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

  if (method === "POST" && url.pathname === "/admin/api/auth-profiles") {
    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    const name = readString(body.name);
    const authJsonContent = readString(body.auth_json_content);
    if (!name || !authJsonContent) {
      respondJson(response, 400, {
        ok: false,
        error: "missing_required_body",
        required: ["name", "auth_json_content"]
      });
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.addAuthProfile({
        name,
        authJsonContent
      })
    );
    return true;
  }

  if (method === "POST" && url.pathname.startsWith("/admin/api/auth-profiles/") && url.pathname.endsWith("/activate")) {
    const profileName = decodeURIComponent(url.pathname.slice("/admin/api/auth-profiles/".length, -"/activate".length));
    const body = await readAdminBody(request, response);
    if (!body) {
      return true;
    }

    await runAdminOperation(response, () =>
      options.adminService.activateAuthProfile({
        name: profileName,
        allowActive: body.allow_active === true
      })
    );
    return true;
  }

  if (method === "DELETE" && url.pathname.startsWith("/admin/api/auth-profiles/")) {
    const profileName = decodeURIComponent(url.pathname.slice("/admin/api/auth-profiles/".length));
    if (!profileName || profileName.includes("/")) {
      return false;
    }

    await runAdminOperation(response, () =>
      options.adminService.deleteAuthProfile({
        name: profileName
      })
    );
    return true;
  }

  return false;
}

async function readAdminBody(
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function runAdminOperation(
  response: http.ServerResponse,
  operation: () => Promise<Record<string, unknown>>
): Promise<void> {
  try {
    respondJson(response, 200, await operation());
  } catch (error) {
    respondJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
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
  <title>${escapeHtml(options.serviceName)} Admin</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #ff962d;
      --bg-deep: #d97414;
      --panel: #070707;
      --panel-soft: #0a0a0a;
      --panel-strong: #030303;
      --line: rgba(255, 154, 47, 0.15);
      --line-strong: rgba(255, 154, 47, 0.34);
      --text: #fff1de;
      --muted: #a48f75;
      --accent: #ff9a2f;
      --accent-soft: rgba(255, 154, 47, 0.12);
      --good: #34dd93;
      --good-soft: rgba(52, 221, 147, 0.12);
      --warn: #ffcb63;
      --warn-soft: rgba(255, 203, 99, 0.14);
      --danger: #ff7458;
      --danger-soft: rgba(255, 116, 88, 0.14);
      --mono: "IBM Plex Mono", "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Monaco, Consolas, monospace;
      --sans: "IBM Plex Mono", "SF Mono", "JetBrains Mono", ui-monospace, Menlo, Monaco, Consolas, monospace;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 14% 12%, rgba(255, 198, 122, 0.32), transparent 18%),
        radial-gradient(circle at 86% 10%, rgba(255, 206, 139, 0.22), transparent 16%),
        linear-gradient(135deg, rgba(255,255,255,0.05) 0 4%, transparent 4% 14%, rgba(255,255,255,0.03) 14% 17%, transparent 17% 31%, rgba(255,255,255,0.04) 31% 35%, transparent 35% 100%),
        linear-gradient(180deg, var(--bg) 0%, var(--bg-deep) 100%);
      color: var(--text);
      font-family: var(--sans);
      letter-spacing: 0.01em;
      line-height: 1.45;
    }
    .shell,
    .wrap {
      max-width: 1720px;
      margin: 0 auto;
      padding: 24px;
    }
    .frame,
    .dashboard {
      border: 1px solid rgba(255, 154, 47, 0.24);
      border-radius: 18px;
      background:
        linear-gradient(180deg, rgba(10, 10, 10, 0.995), rgba(3, 3, 3, 0.995));
      box-shadow:
        0 30px 70px rgba(92, 34, 0, 0.28),
        inset 0 0 0 1px rgba(255,255,255,0.015);
      padding: 16px;
    }
    h1,
    h2,
    h3 {
      margin: 0;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    h1 {
      font-size: 22px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    h3 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .topbar,
    .headerbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      padding: 14px 16px;
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255, 154, 47, 0.03), rgba(255, 154, 47, 0.01));
    }
    .title,
    .header-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .title {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .subtitle,
    .header-subtitle {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
      text-transform: uppercase;
    }
    .topbar-actions,
    .header-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.75fr) minmax(380px, 0.95fr);
      gap: 12px;
      align-items: start;
    }
    .stack,
    .main-stack,
    .side-stack,
    .overview-stack {
      display: grid;
      gap: 12px;
    }
    .summary-grid,
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .summary-item,
    .summary-pill {
      display: grid;
      gap: 4px;
      min-height: 82px;
      padding: 10px 12px;
      background: var(--panel-soft);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .summary-label,
    .summary-pill-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .summary-value,
    .summary-pill-value {
      color: var(--accent);
      font-size: 22px;
      font-weight: 800;
      line-height: 1.05;
    }
    .summary-detail,
    .summary-pill-detail {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }
    .card,
    .panel {
      background: rgba(7, 7, 7, 0.96);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.01);
    }
    .panel-head,
    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .panel-title,
    .subpanel-title {
      font-weight: 700;
      word-break: break-word;
      text-transform: uppercase;
    }
    .panel-body {
      padding: 14px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border: 1px solid currentColor;
      border-radius: 999px;
      font-size: 11px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .good { color: var(--good); }
    .warn { color: var(--warn); }
    .danger { color: var(--danger); }
    .muted { color: var(--muted); }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 180px auto;
      gap: 10px;
      align-items: center;
      margin-bottom: 12px;
    }
    .control-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
    }
    input[type="password"], input[type="search"], input[type="text"], textarea, input[type="file"], select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #060606;
      color: var(--text);
      font: inherit;
    }
    textarea {
      min-height: 180px;
      resize: vertical;
    }
    button {
      border: 1px solid var(--accent);
      border-radius: 10px;
      background: var(--accent);
      color: #111;
      padding: 10px 14px;
      font: inherit;
      font-weight: 700;
      text-transform: uppercase;
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--accent);
    }
    button.danger {
      border-color: var(--danger);
      background: transparent;
      color: var(--danger);
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .quota-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 14px;
    }
    .quota-box {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: rgba(255, 151, 47, 0.03);
    }
    .quota-header {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 8px;
    }
    .quota-name {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
    }
    .quota-reset {
      color: var(--muted);
      font-size: 11px;
    }
    .profile-list, .file-list, .logs-list {
      display: grid;
      gap: 10px;
    }
    .profile-row, .file-row, .log-entry {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: var(--panel-soft);
    }
    .profile-head, .file-head {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 12px;
      margin-bottom: 10px;
    }
    .profile-name, .file-name {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      font-size: 18px;
      font-weight: 700;
    }
    .profile-path, .file-meta {
      color: var(--muted);
      font-size: 11px;
      word-break: break-word;
    }
    .profile-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.2fr) auto;
      gap: 12px;
      align-items: start;
    }
    .label {
      display: block;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .profile-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .session-table, .mini-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      table-layout: fixed;
    }
    .session-table th, .session-table td,
    .mini-table th, .mini-table td {
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255, 151, 47, 0.08);
      text-align: left;
      vertical-align: top;
    }
    .session-table th, .mini-table th {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .session-key {
      color: var(--accent);
      font-weight: 700;
      word-break: break-all;
    }
    .cell-stack {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .cell-lead {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    details.session-row {
      border-top: 1px solid rgba(255, 151, 47, 0.12);
    }
    details.session-row:first-child {
      border-top: 0;
    }
    details.session-row summary {
      list-style: none;
      cursor: pointer;
    }
    details.session-row summary::-webkit-details-marker {
      display: none;
    }
    .session-detail {
      padding: 0 10px 12px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .log-entry.warn {
      border-color: rgba(255, 193, 79, 0.22);
    }
    .log-entry.error {
      border-color: rgba(255, 113, 88, 0.22);
    }
    dialog {
      border: 1px solid var(--line-strong);
      border-radius: 14px;
      background: #0b0b0b;
      color: var(--text);
      width: min(760px, calc(100vw - 32px));
      padding: 0;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.72);
      backdrop-filter: blur(2px);
    }
    .dialog-body {
      display: grid;
      gap: 14px;
      padding: 18px;
    }
    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }
    .checkbox {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 12px;
      color: var(--muted);
    }
    @media (max-width: 1220px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .profile-grid {
        grid-template-columns: 1fr 1fr;
      }
    }
    @media (max-width: 760px) {
      .summary-grid, .quota-grid, .detail-grid, .profile-grid, .toolbar, .control-row {
        grid-template-columns: 1fr;
      }
      .topbar {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="frame">
      <div class="topbar">
        <div>
          <h1 class="title">${escapeHtml(options.serviceName)} Admin</h1>
          <div class="subtitle">runtime, quota, auth profiles, sessions, logs</div>
        </div>
        <div class="topbar-actions">
          <span class="badge ${options.tokenConfigured ? "warn" : "good"}">${options.tokenConfigured ? "admin token enabled" : "cloudflare access"}</span>
          <button id="refresh-button" class="secondary">refresh</button>
          <span id="last-refresh" class="badge muted">not synced</span>
        </div>
      </div>
      <div class="layout">
        <div class="stack">
          <section class="panel">
            <div class="panel-head"><div class="panel-title">Overview</div></div>
            <div class="panel-body">
              <div class="summary-grid">
                <div class="summary-item">
                  <div class="summary-label">Service</div>
                  <div id="summary-service" class="summary-value">--</div>
                  <div id="summary-service-detail" class="summary-detail">...</div>
                </div>
                <div class="summary-item">
                  <div class="summary-label">Account</div>
                  <div id="summary-account" class="summary-value">--</div>
                  <div id="summary-account-detail" class="summary-detail">...</div>
                </div>
                <div class="summary-item">
                  <div class="summary-label">Sessions</div>
                  <div id="summary-sessions" class="summary-value">--</div>
                  <div id="summary-sessions-detail" class="summary-detail">...</div>
                </div>
                <div class="summary-item">
                  <div class="summary-label">Jobs</div>
                  <div id="summary-jobs" class="summary-value">--</div>
                  <div id="summary-jobs-detail" class="summary-detail">...</div>
                </div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">Sessions</div>
              <span id="sessions-caption" class="badge muted">0 shown</span>
            </div>
            <div class="panel-body">
              <div class="toolbar">
                <input id="session-search" type="search" placeholder="search session / channel / workspace" />
                <select id="session-filter">
                  <option value="all">all</option>
                  <option value="active">active</option>
                  <option value="inbound">open inbound</option>
                  <option value="jobs">running jobs</option>
                  <option value="issues">failed jobs</option>
                </select>
              </div>
              <div id="sessions-panel"></div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><div class="panel-title">System Logs</div></div>
            <div class="panel-body">
              <div id="logs-panel" class="logs-list"></div>
            </div>
          </section>
        </div>

        <div class="stack">
          <section class="panel">
            <div class="panel-head"><div class="panel-title">Account Quota</div></div>
            <div id="account-card" class="panel-body"></div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">Auth Profiles</div>
              <button id="open-add-profile-dialog">add profile</button>
            </div>
            <div class="panel-body">
              <div id="token-status" class="summary-detail"></div>
              <div id="replace-status" class="summary-detail"></div>
              <div id="auth-profiles-panel" class="profile-list"></div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><div class="panel-title">Runtime Info</div></div>
            <div id="service-card" class="panel-body"></div>
          </section>
        </div>
      </div>
    </div>
  </div>

  <dialog id="add-profile-dialog">
    <div class="dialog-body">
      <div class="panel-title">Add auth profile</div>
      <input id="profile-name-input" type="text" placeholder="profile name" />
      <input id="profile-auth-file" type="file" accept="application/json,.json" />
      <textarea id="profile-auth-text" placeholder="paste auth.json"></textarea>
      <div class="dialog-actions">
        <button id="close-add-profile-dialog" class="secondary">cancel</button>
        <button id="submit-add-profile-dialog">save profile</button>
      </div>
      <div id="add-profile-status" class="summary-detail"></div>
    </div>
  </dialog>
  <script>
    const tokenKey = "broker-admin-token";
    const tokenConfigured = ${options.tokenConfigured ? "true" : "false"};
    const tokenStatus = document.getElementById("token-status");
    const lastRefresh = document.getElementById("last-refresh");
    const replaceStatus = document.getElementById("replace-status");
    const sessionSearch = document.getElementById("session-search");
    const sessionFilter = document.getElementById("session-filter");
    const refreshButton = document.getElementById("refresh-button");
    const addProfileDialog = document.getElementById("add-profile-dialog");
    let latestStatus = null;

    function esc(value) {
      return String(value == null ? "" : value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function authHeaders(extra) {
      return Object.assign({}, extra || {});
    }

    function persistToken() {
      if (!tokenConfigured) {
        tokenStatus.innerHTML = '<span class="good">protected by cloudflare access</span>';
      } else {
        tokenStatus.innerHTML = '<span class="warn">admin token enabled on this runtime</span>';
      }
    }

    function clampPercent(value) {
      const number = Number(value);
      return Math.max(0, Math.min(100, Math.round(Number.isFinite(number) ? number : 0)));
    }

    function remainingPercent(window) {
      if (!window) {
        return null;
      }
      return 100 - clampPercent(window.usedPercent);
    }

    function formatWindowName(window) {
      const mins = Number(window && window.windowDurationMins ? window.windowDurationMins : 0);
      if (mins === 300) return "5h";
      if (mins === 10080) return "weekly";
      if (mins && mins % 1440 === 0) return String(mins / 1440) + "d";
      if (mins && mins % 60 === 0) return String(mins / 60) + "h";
      if (mins) return String(mins) + "m";
      return "window";
    }

    function formatDateTime(value) {
      if (!value) return "—";
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    function formatResetTime(seconds) {
      if (seconds == null) {
        return "reset unknown";
      }
      const target = Number(seconds) * 1000;
      const delta = target - Date.now();
      const abs = Math.abs(delta);
      const mins = Math.round(abs / 60000);
      const rel = mins < 60 ? String(mins) + "m" : (mins < 2880 ? String(Math.round(mins / 60)) + "h" : String(Math.round(mins / 1440)) + "d");
      const relative = delta >= 0 ? "resets in " + rel : "reset " + rel + " ago";
      return relative + " · " + new Date(target).toLocaleString();
    }

    function statusTone(status) {
      const value = String(status || "").toLowerCase();
      if (["ok", "active", "running", "completed"].includes(value)) return "good";
      if (["pending", "inflight", "starting", "idle"].includes(value)) return "warn";
      if (["error", "failed", "stopped"].includes(value)) return "danger";
      return "muted";
    }

    function renderBadge(label, tone) {
      return '<span class="badge ' + (tone || "") + '">' + esc(label) + "</span>";
    }

    function formatDuration(seconds) {
      const total = Math.max(0, Number(seconds || 0));
      const hours = Math.floor(total / 3600);
      const mins = Math.floor((total % 3600) / 60);
      return hours > 0 ? String(hours) + "h " + String(mins) + "m" : String(mins) + "m";
    }

    function renderSummary(data) {
      const service = data.service || {};
      const state = data.state || {};
      const account = data.account || {};
      const rateLimits = data.rateLimits || {};
      document.getElementById("summary-service").textContent = "online";
      document.getElementById("summary-service-detail").textContent = "pid " + (service.pid || "-") + " · uptime " + formatDuration(service.uptimeSeconds);
      document.getElementById("summary-account").textContent = account.ok ? (account.account && account.account.planType ? account.account.planType : "chatgpt") : "error";
      document.getElementById("summary-account-detail").textContent = account.ok ? (account.account && account.account.email ? account.account.email : "unknown account") : (account.error || "account unavailable");
      document.getElementById("summary-sessions").textContent = String(state.activeCount || 0) + "/" + String(state.sessionCount || 0);
      document.getElementById("summary-sessions-detail").textContent = "open inbound " + String(state.openInboundCount || 0);
      document.getElementById("summary-jobs").textContent = String(state.runningBackgroundJobCount || 0);
      document.getElementById("summary-jobs-detail").textContent = rateLimits.ok ? "quota synced" : (rateLimits.error || "quota unavailable");
    }

    function renderService(data) {
      const service = data.service || {};
      const items = [
        ["name", service.name],
        ["port", service.port],
        ["started", formatDateTime(service.startedAt)],
        ["broker", service.brokerHttpBaseUrl],
        ["sessions root", service.sessionsRoot],
        ["repos root", service.reposRoot],
        ["codex home", service.codexHome]
      ];
      document.getElementById("service-card").innerHTML = items
        .map(function (entry) {
          return '<div class="summary-detail"><strong style="color:var(--text)">' + esc(entry[0]) + ":</strong> " + esc(entry[1] || "—") + "</div>";
        })
        .join("");
    }

    function renderQuotaWindow(window, fallbackLabel) {
      if (!window) {
        return '<div class="quota-box"><div class="quota-name">' + esc(fallbackLabel) + '</div><div class="quota-reset">window unavailable</div></div>';
      }
      return '<div class="quota-box">' +
        '<div class="quota-header"><span class="quota-name">' + esc(formatWindowName(window)) + '</span><span>' + esc(String(remainingPercent(window))) + '% left</span></div>' +
        '<div class="quota-reset">' + esc(formatResetTime(window.resetsAt)) + "</div>" +
      "</div>";
    }

    function renderAccount(data) {
      const panel = document.getElementById("account-card");
      const account = data.account || {};
      const rateLimits = data.rateLimits || {};
      if (!account.ok) {
        panel.innerHTML = '<div class="summary-detail danger">' + esc(account.error || "account unavailable") + "</div>";
        return;
      }

      let html = "";
      html += '<div><div style="font-size:22px; font-weight:700">' + esc(account.account && account.account.email ? account.account.email : "unknown account") + "</div>";
      html += '<div class="summary-detail">' + esc(account.account && account.account.planType ? account.account.planType : "unknown plan") + " · " + esc(account.account && account.account.type ? account.account.type : "chatgpt") + "</div></div>";
      if (rateLimits.ok) {
        const snapshot = rateLimits.rateLimits || {};
        html += '<div class="quota-grid">';
        html += renderQuotaWindow(snapshot.primary, "5h");
        html += renderQuotaWindow(snapshot.secondary, "weekly");
        html += "</div>";
      } else {
        html += '<div class="summary-detail warn">' + esc(rateLimits.error || "rate limits unavailable") + "</div>";
      }
      panel.innerHTML = html;
    }

    function renderProfileQuota(rateLimits) {
      if (!rateLimits || !rateLimits.ok) {
        return '<div class="summary-detail danger">' + esc(rateLimits && rateLimits.error ? rateLimits.error : "quota unavailable") + "</div>";
      }
      const snapshot = rateLimits.rateLimits || {};
      const primary = snapshot.primary;
      const secondary = snapshot.secondary;
      return '<div class="cell-stack">' +
        '<div><span class="label">5h</span>' + (primary ? esc(String(remainingPercent(primary))) + "% left" : "—") + "</div>" +
        '<div class="summary-detail">' + esc(primary ? formatResetTime(primary.resetsAt) : "reset unknown") + "</div>" +
        '<div><span class="label">weekly</span>' + (secondary ? esc(String(remainingPercent(secondary))) + "% left" : "—") + "</div>" +
        '<div class="summary-detail">' + esc(secondary ? formatResetTime(secondary.resetsAt) : "reset unknown") + "</div>" +
      "</div>";
    }

    function renderAuthProfiles(data) {
      const authProfiles = data.authProfiles || {};
      const profiles = authProfiles.profiles || [];
      const panel = document.getElementById("auth-profiles-panel");
      if (!profiles.length) {
        panel.innerHTML = '<div class="summary-detail">no auth profiles</div>';
        return;
      }

      panel.innerHTML = profiles
        .map(function (profile) {
          const account = profile.account || {};
          const email = account.ok && account.account && account.account.email ? account.account.email : "account unavailable";
          const plan = account.ok && account.account && account.account.planType ? account.account.planType : "error";
          return '<div class="profile-row">' +
            '<div class="profile-head">' +
              '<div>' +
                '<div class="profile-name">' + esc(profile.name) + " " +
                  (profile.active ? renderBadge("active", "good") : renderBadge("standby", "muted")) + " " +
                  renderBadge(profile.source || "probe", profile.source === "runtime" ? "good" : "warn") +
                "</div>" +
                '<div class="profile-path">' + esc(profile.path || "—") + "</div>" +
                '<div class="profile-path">checked ' + esc(formatDateTime(profile.checkedAt)) + "</div>" +
              "</div>" +
            "</div>" +
            '<div class="profile-grid">' +
              '<div class="cell-stack">' +
                '<span class="label">account</span>' +
                "<div>" + esc(email) + "</div>" +
                '<div class="summary-detail">' + esc(plan) + "</div>" +
              "</div>" +
              '<div class="cell-stack">' +
                '<span class="label">status</span>' +
                "<div>" + (account.ok ? renderBadge("account ok", "good") : renderBadge("account error", "danger")) + "</div>" +
                '<div class="summary-detail">' + (account.ok ? esc(String(profile.size || 0) + " bytes · " + formatDateTime(profile.mtime)) : esc(account.error || "account unavailable")) + "</div>" +
              "</div>" +
              "<div>" + renderProfileQuota(profile.rateLimits) + "</div>" +
              '<div class="profile-actions">' +
                '<button class="secondary" data-activate-profile="' + esc(profile.name) + '"' + (profile.active ? " disabled" : "") + ">use</button>" +
                '<button class="danger" data-delete-profile="' + esc(profile.name) + '"' + (profile.active ? " disabled" : "") + ">delete</button>" +
              "</div>" +
            "</div>" +
          "</div>";
        })
        .join("");

      document.querySelectorAll("[data-activate-profile]").forEach(function (button) {
        button.addEventListener("click", async function () {
          const name = button.getAttribute("data-activate-profile");
          if (!name) {
            return;
          }
          const activeCount = Number(latestStatus && latestStatus.state ? latestStatus.state.activeCount || 0 : 0);
          const allowActive = activeCount > 0 ? window.confirm("active sessions exist. switching profiles will interrupt them. continue?") : false;
          if (activeCount > 0 && !allowActive) {
            return;
          }
          await activateProfile(name, allowActive);
        });
      });

      document.querySelectorAll("[data-delete-profile]").forEach(function (button) {
        button.addEventListener("click", async function () {
          const name = button.getAttribute("data-delete-profile");
          if (!name) {
            return;
          }
          if (!window.confirm("delete auth profile " + name + "?")) {
            return;
          }
          await deleteProfile(name);
        });
      });
    }

    function summarizeSessionLead(session) {
      if (session.openInbound && session.openInbound.length) {
        return session.openInbound[0].textPreview || "pending inbound";
      }
      if (session.backgroundJobs && session.backgroundJobs.length) {
        const running = session.backgroundJobs.find(function (job) { return job.status === "running"; }) || session.backgroundJobs[0];
        return (running.kind || "job") + " · " + (running.status || "unknown");
      }
      return "idle";
    }

    function renderInboundTable(items) {
      if (!items || !items.length) {
        return '<div class="summary-detail">no open inbound</div>';
      }
      return '<table class="mini-table"><thead><tr><th>status</th><th>source</th><th>preview</th></tr></thead><tbody>' +
        items.map(function (item) {
          return "<tr><td>" + renderBadge(item.status || "unknown", statusTone(item.status)) + "</td><td>" + esc(item.source || "—") + "</td><td>" + esc(item.textPreview || "—") + "</td></tr>";
        }).join("") +
      "</tbody></table>";
    }

    function renderJobsTable(items) {
      if (!items || !items.length) {
        return '<div class="summary-detail">no jobs</div>';
      }
      return '<table class="mini-table"><thead><tr><th>status</th><th>kind</th><th>error</th></tr></thead><tbody>' +
        items.map(function (item) {
          return "<tr><td>" + renderBadge(item.status || "unknown", statusTone(item.status)) + "</td><td>" + esc(item.kind || "—") + "</td><td>" + esc(item.error || "—") + "</td></tr>";
        }).join("") +
      "</tbody></table>";
    }

    function renderSessions(data) {
      const list = data.state && data.state.sessions ? data.state.sessions : [];
      const panel = document.getElementById("sessions-panel");
      const query = sessionSearch.value.trim().toLowerCase();
      const filter = sessionFilter.value;
      const filtered = list.filter(function (session) {
        if (filter === "active" && !session.activeTurnId) return false;
        if (filter === "inbound" && !session.openInboundCount) return false;
        if (filter === "jobs" && !session.runningBackgroundJobCount) return false;
        if (filter === "issues" && !session.failedBackgroundJobCount) return false;
        if (!query) return true;
        return [session.key, session.channelId, session.workspacePath, summarizeSessionLead(session)].some(function (value) {
          return String(value || "").toLowerCase().includes(query);
        });
      });

      document.getElementById("sessions-caption").textContent = String(filtered.length) + " shown";

      if (!filtered.length) {
        panel.innerHTML = '<div class="summary-detail">no sessions match the current filter</div>';
        return;
      }

      panel.innerHTML = '<table class="session-table"><thead><tr><th style="width:28%">session</th><th style="width:18%">status</th><th style="width:20%">inbound/jobs</th><th style="width:24%">lead</th><th style="width:10%"></th></tr></thead><tbody>' +
        filtered.map(function (session) {
          const lead = summarizeSessionLead(session);
          return '<tr>' +
            '<td><div class="cell-stack"><div class="session-key">' + esc(session.key) + '</div><div class="summary-detail">' + esc(session.channelId || "—") + '</div><div class="summary-detail">' + esc(session.workspacePath || "—") + '</div></div></td>' +
            '<td><div class="cell-stack">' + renderBadge(session.activeTurnId ? "active" : "idle", session.activeTurnId ? "good" : "warn") + '<div class="summary-detail">reply ' + esc(formatDateTime(session.lastSlackReplyAt)) + '</div><div class="summary-detail">updated ' + esc(formatDateTime(session.updatedAt)) + '</div></div></td>' +
            '<td><div class="cell-stack"><div>inbound ' + esc(String(session.openInboundCount || 0)) + '</div><div>running jobs ' + esc(String(session.runningBackgroundJobCount || 0)) + '</div><div>failed jobs ' + esc(String(session.failedBackgroundJobCount || 0)) + '</div></div></td>' +
            '<td><div class="cell-stack"><div class="cell-lead" title="' + esc(lead) + '">' + esc(lead) + '</div><div class="summary-detail">observed ' + esc(session.lastObservedMessageTs || "—") + '</div><div class="summary-detail">delivered ' + esc(session.lastDeliveredMessageTs || "—") + '</div></div></td>' +
            '<td><details class="session-row"><summary>' + renderBadge("detail", "muted") + '</summary><div class="session-detail"><div class="detail-grid"><div>' + renderInboundTable(session.openInbound || []) + '</div><div>' + renderJobsTable(session.backgroundJobs || []) + '</div></div></div></details></td>' +
          '</tr>';
        }).join("") +
      "</tbody></table>";
    }

    function renderLogs(data) {
      const logs = data.state && data.state.recentBrokerLogs ? data.state.recentBrokerLogs : [];
      const panel = document.getElementById("logs-panel");
      if (!logs.length) {
        panel.innerHTML = '<div class="summary-detail">no recent logs</div>';
        return;
      }
      panel.innerHTML = logs
        .map(function (entry) {
          const tone = statusTone(entry.level);
          const message = entry.message || entry.raw || "log";
          return '<div class="log-entry ' + tone + '"><div style="display:flex; justify-content:space-between; gap:10px"><span>' + esc(formatDateTime(entry.ts)) + '</span><span class="muted">' + esc(String(entry.level || "info")) + '</span></div><div style="margin-top:4px">' + esc(message) + '</div></div>';
        })
        .join("");
    }

    function render(data) {
      latestStatus = data;
      renderSummary(data);
      renderService(data);
      renderAccount(data);
      renderAuthProfiles(data);
      renderSessions(data);
      renderLogs(data);
    }

    async function parseResponse(response) {
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(payload.error || response.statusText || "request_failed");
      }
      return payload;
    }

    async function refresh() {
      refreshButton.disabled = true;
      try {
        const response = await fetch("/admin/api/status", { headers: authHeaders() });
        const payload = await parseResponse(response);
        render(payload);
        lastRefresh.textContent = "synced " + new Date().toLocaleTimeString();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastRefresh.textContent = "error: " + message;
      } finally {
        refreshButton.disabled = false;
      }
    }

    async function activateProfile(name, allowActive) {
      replaceStatus.textContent = "switching profile " + name + "...";
      try {
        const response = await fetch("/admin/api/auth-profiles/" + encodeURIComponent(name) + "/activate", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ allow_active: allowActive })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        replaceStatus.innerHTML = '<span class="good">active profile switched to ' + esc(name) + "</span>";
      } catch (error) {
        replaceStatus.innerHTML = '<span class="danger">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      }
    }

    async function deleteProfile(name) {
      replaceStatus.textContent = "deleting profile " + name + "...";
      try {
        const response = await fetch("/admin/api/auth-profiles/" + encodeURIComponent(name), {
          method: "DELETE",
          headers: authHeaders()
        });
        const payload = await parseResponse(response);
        render(payload.status);
        replaceStatus.innerHTML = '<span class="good">deleted profile ' + esc(name) + "</span>";
      } catch (error) {
        replaceStatus.innerHTML = '<span class="danger">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      }
    }

    async function submitAddProfile() {
      const status = document.getElementById("add-profile-status");
      const nameInput = document.getElementById("profile-name-input");
      const fileInput = document.getElementById("profile-auth-file");
      const textArea = document.getElementById("profile-auth-text");
      status.textContent = "saving...";
      try {
        const content = textArea.value.trim() || (fileInput.files[0] ? await fileInput.files[0].text() : "");
        if (!nameInput.value.trim() || !content) {
          throw new Error("profile name and auth.json are required");
        }
        const response = await fetch("/admin/api/auth-profiles", {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({
            name: nameInput.value.trim(),
            auth_json_content: content
          })
        });
        const payload = await parseResponse(response);
        render(payload.status);
        status.innerHTML = '<span class="good">profile saved</span>';
        addProfileDialog.close();
        nameInput.value = "";
        fileInput.value = "";
        textArea.value = "";
      } catch (error) {
        status.innerHTML = '<span class="danger">' + esc(error instanceof Error ? error.message : String(error)) + "</span>";
      }
    }

    sessionSearch.addEventListener("input", function () {
      if (latestStatus) {
        renderSessions(latestStatus);
      }
    });
    sessionFilter.addEventListener("change", function () {
      if (latestStatus) {
        renderSessions(latestStatus);
      }
    });
    refreshButton.addEventListener("click", refresh);

    document.getElementById("open-add-profile-dialog").addEventListener("click", function () {
      document.getElementById("add-profile-status").textContent = "";
      addProfileDialog.showModal();
    });
    document.getElementById("close-add-profile-dialog").addEventListener("click", function () {
      addProfileDialog.close();
    });
    document.getElementById("submit-add-profile-dialog").addEventListener("click", submitAddProfile);
    addProfileDialog.addEventListener("click", function (event) {
      if (event.target === addProfileDialog) {
        addProfileDialog.close();
      }
    });

    persistToken();
    refresh();
    setInterval(refresh, 10000);
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
