export function dashboardPage(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cortex Posture Dashboard</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; color: #1c2733; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #5b6b7b; font-size: 13px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .card { background: #fff; border: 1px solid #e2e8ee; border-radius: 10px; padding: 14px 16px; }
  .card .label { font-size: 12px; color: #5b6b7b; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 26px; font-weight: 700; margin-top: 4px; }
  .card.bad .value { color: #c0392b; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .pill { display: flex; gap: 10px; align-items: center; background: #fff; border: 1px solid #e2e8ee; border-radius: 999px; padding: 6px 14px; font-size: 13px; max-width: 100%; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #95a5b6; flex: none; }
  .dot.healthy { background: #27ae60; }
  .dot.degraded { background: #e67e22; }
  .pill .meta { color: #5b6b7b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
  .filters button { border: 1px solid #cbd6e0; background: #fff; padding: 6px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; color: #1c2733; }
  .filters button.active { background: #1c2733; color: #fff; border-color: #1c2733; }
  .tablewrap { background: #fff; border: 1px solid #e2e8ee; border-radius: 10px; overflow: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eef2f6; white-space: nowrap; }
  th { position: sticky; top: 0; background: #fafbfc; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #5b6b7b; }
  tr:last-child td { border-bottom: none; }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .chip.bad { background: #fdecea; color: #c0392b; }
  .chip.ok { background: #e8f6ef; color: #1e8e5a; }
  .chip.neutral { background: #eef2f6; color: #5b6b7b; }
  .error { background: #fdecea; border: 1px solid #f5b7b1; color: #922b21; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; display: none; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .row-check { border: 1px solid #cbd6e0; background: #fff; padding: 2px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; color: #1c2733; }
  .row-check:disabled { opacity: .5; cursor: default; }
  #search { flex: 1; min-width: 170px; max-width: 280px; padding: 7px 10px; border: 1px solid #cbd6e0; border-radius: 8px; font-size: 13px; background: #fff; color: #1c2733; }
  #refresh-status { min-height: 16px; max-width: 300px; text-align: right; }
  .row-select, #select-all { cursor: pointer; }
  .toolbar-right { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  tr.flash td { animation: rowflash 1.6s ease-out; }
  @keyframes rowflash { 0% { background: #fff3cd; } 100% { background: transparent; } }
  .chat-fab { position: fixed; right: 20px; bottom: 20px; z-index: 60; background: #1c2733; color: #fff; padding: 10px 18px; border-radius: 999px; font-size: 13px; cursor: pointer; box-shadow: 0 6px 18px rgba(28,39,51,.35); user-select: none; }
  .chat-fab:hover { background: #2c3e52; }
  .chat-popup { position: fixed; right: 20px; bottom: 70px; z-index: 61; width: min(520px, calc(100vw - 40px)); max-height: 62vh; background: #fff; border: 1px solid #e2e8ee; border-radius: 14px; box-shadow: 0 12px 32px rgba(28,39,51,.28); display: flex; flex-direction: column; overflow: hidden; animation: popup-in .18s ease-out; }
  .chat-popup[hidden] { display: none; }
  @keyframes popup-in { 0% { transform: translateY(10px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
  .chat-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #e2e8ee; background: #fafbfc; }
  .chat-title { font-size: 12px; color: #1c2733; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; display: flex; align-items: center; gap: 8px; }
  .live-dot { width: 9px; height: 9px; border-radius: 50%; background: #27ae60; display: inline-block; animation: pulse 1.6s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(39,174,96,.4); } 70% { box-shadow: 0 0 0 7px rgba(39,174,96,0); } 100% { box-shadow: 0 0 0 0 rgba(39,174,96,0); } }
  .overlay-actions { display: flex; gap: 6px; }
  .overlay-actions button { border: 1px solid #cbd6e0; background: #fff; padding: 4px 12px; border-radius: 8px; font-size: 12px; cursor: pointer; color: #1c2733; }
  .overlay-actions button.primary { background: #1c2733; color: #fff; border-color: #1c2733; }
  .chat-body { overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; scroll-behavior: smooth; }
  .chat-row { display: flex; }
  .chat-row.request { justify-content: flex-end; }
  .chat-row.response { justify-content: flex-start; }
  .chat-bubble { max-width: 88%; border-radius: 12px; padding: 7px 11px; font-size: 12px; border: 1px solid #e2e8ee; background: #fafbfc; }
  .chat-row.request .chat-bubble { background: #1c2733; color: #fff; border-color: #1c2733; }
  .chat-row.fresh .chat-bubble { animation: bubble-in .25s ease-out; }
  @keyframes bubble-in { 0% { transform: translateY(8px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
  .chat-bubble .chip { margin-right: 6px; }
  .chat-bubble-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .chat-row.request .chat-bubble-head { color: #fff; }
  .chat-meta { opacity: .75; font-size: 11px; }
  .chat-bubble pre { background: rgba(255,255,255,.9); color: #1c2733; border-radius: 8px; padding: 8px 10px; overflow: auto; max-height: 220px; margin: 6px 0 0; white-space: pre-wrap; word-break: break-all; font-size: 11px; }
  .chat-row.request .chat-bubble pre { background: rgba(255,255,255,.12); color: #e8edf3; }
  .debug-empty { color: #5b6b7b; font-size: 12px; text-align: center; padding: 14px 0; }
  .config { background: #fff; border: 1px solid #e2e8ee; border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  .config-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .config-head .label { font-size: 12px; color: #5b6b7b; text-transform: uppercase; letter-spacing: .04em; }
  .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; align-items: end; }
  .config-field label { display: block; font-size: 12px; color: #5b6b7b; margin-bottom: 4px; }
  .config-field select, .config-field input { width: 100%; padding: 7px 10px; border: 1px solid #cbd6e0; border-radius: 8px; font-size: 13px; background: #fff; color: #1c2733; box-sizing: border-box; }
  .config-field input[type="checkbox"] { width: auto; }
  .config-actions { display: flex; gap: 8px; }
  .config-actions button, button.primary { border: 1px solid #cbd6e0; background: #fff; padding: 7px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; color: #1c2733; }
  .config-actions button.primary { background: #1c2733; color: #fff; border-color: #1c2733; }
  .meta { font-size: 12px; color: #5b6b7b; }
  .config-message { margin-top: 10px; min-height: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Cortex Posture Dashboard</h1>
  <div class="sub" id="subtitle">Loading&hellip;</div>
  <div class="error" id="error"></div>
  <div class="cards" id="cards"></div>
  <div class="pills" id="pills"></div>
  <div class="config" id="config">
    <div class="config-head">
      <span class="label">Configuration</span>
      <span class="meta" id="config-status"></span>
    </div>
    <div class="config-grid">
      <div class="config-field">
        <label for="account-select">Cloudflare account</label>
        <select id="account-select" disabled><option value="">Load lists first</option></select>
      </div>
      <div class="config-field">
        <label for="list-select">Zero Trust SERIAL list</label>
        <select id="list-select" disabled><option value="">Load lists first</option></select>
      </div>
      <div class="config-field">
        <label for="threshold">Content age threshold (days)</label>
        <input id="threshold" type="number" min="1" max="365" value="7">
      </div>
      <div class="config-field">
        <label for="capacity">List capacity</label>
        <input id="capacity" type="number" min="1" max="100000" value="1000">
      </div>
      <div class="config-field">
        <label><input id="sync-enabled" type="checkbox"> Enable list synchronization</label>
      </div>
      <div class="config-field">
        <label><input id="debug-log-enabled" type="checkbox"> Log Cortex traffic</label>
      </div>
      <div class="config-actions">
        <button type="button" id="load-lists">Load lists</button>
        <button type="button" id="sync-now">Sync now</button>
        <button type="button" id="save-config" class="primary">Save configuration</button>
      </div>
    </div>
    <div class="meta config-message" id="config-message"></div>
  </div>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search hostname, serial, or MAC">
    <div class="filters" id="filters">
      <button type="button" data-status="all" class="active">All</button>
      <button type="button" data-status="noncompliant">Noncompliant</button>
      <button type="button" data-status="compliant">Compliant</button>
    </div>
    <button type="button" id="check-selected" class="row-check" disabled>Check selected</button>
    <div class="toolbar-right">
      <div class="sub" id="count"></div>
      <span class="meta" id="refresh-status"></span>
    </div>
  </div>
  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th><input type="checkbox" id="select-all" aria-label="Select all"></th>
          <th></th><th>Hostname</th><th>Serial</th><th>MAC</th><th>Compliance</th>
          <th>Mapping</th><th>Score</th><th>Reason</th>
          <th>Content updated</th><th>Refreshed</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>
<div class="chat-popup" id="chat-popup" hidden>
  <div class="chat-head">
    <span class="chat-title"><span class="live-dot"></span> Cortex request log</span>
    <div class="overlay-actions">
      <button type="button" id="debug-clear">Clear</button>
      <button type="button" id="debug-close" class="primary">Close</button>
    </div>
  </div>
  <div class="chat-body" id="debug-entries"></div>
</div>
<div class="chat-fab" id="chat-fab" role="button" tabindex="0">Debug log</div>
<script>
(function () {
  "use strict";
  var status = "all";
  var limit = 200;
  var search = "";
  var selectedIds = [];
  var renderedIds = [];

  function rel(ms) {
    if (!ms) return "never";
    var d = Date.now() - ms;
    if (d < 0) d = 0;
    var m = Math.round(d / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.round(m / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  }

  function mac(v) {
    if (!v) return "";
    return (v.match(/.{2}/g) || [v]).join(":");
  }

  function chip(row) {
    if (row.noncompliant) return ["bad", "noncompliant"];
    if (row.mappingStatus === "invalid") return ["neutral", "invalid"];
    if (row.mappingStatus === "verified") return ["ok", "compliant"];
    return ["neutral", row.mappingStatus || "unknown"];
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderOverview(o) {
    var cards = document.getElementById("cards");
    cards.textContent = "";
    var defs = [
      { label: "Noncompliant serials", value: o.noncompliant_serials, bad: true },
      { label: "Mapped devices", value: o.devices.total },
      { label: "Verified", value: o.devices.verified },
      { label: "Invalid mappings", value: o.devices.invalid }
    ];
    defs.forEach(function (d) {
      var c = el("div", "card" + (d.bad && d.value > 0 ? " bad" : ""));
      c.appendChild(el("div", "label", d.label));
      c.appendChild(el("div", "value", String(d.value)));
      cards.appendChild(c);
    });

    var pills = document.getElementById("pills");
    pills.textContent = "";
    (o.integrations || []).forEach(function (i) {
      var p = el("div", "pill");
      var dot = el("span", "dot" + (i.status === "healthy" ? " healthy" : i.status === "degraded" ? " degraded" : ""));
      p.appendChild(dot);
      p.appendChild(el("span", null, i.name));
      var meta = i.status;
      if (i.status === "healthy" && i.lastSuccessAt) meta += " \\u00b7 " + rel(i.lastSuccessAt);
      if (i.status === "degraded" && i.lastErrorAt) meta += " \\u00b7 " + rel(i.lastErrorAt);
      if (i.message) meta += " \\u00b7 " + i.message;
      p.appendChild(el("span", "meta", meta));
      pills.appendChild(p);
    });

    document.getElementById("subtitle").textContent =
      "Threshold: content older than " + o.maximum_content_age_days +
      " days is noncompliant \\u00b7 updated " + new Date(o.generated_at).toLocaleString();
  }

  function renderDeviceRow(row) {
    var tr = document.createElement("tr");
    function td(cls, text) {
      var c = el("td", cls, text);
      tr.appendChild(c);
      return c;
    }
    var selectCell = td(null);
    var box = el("input", "row-select");
    box.type = "checkbox";
    box.setAttribute("data-device-id", row.cloudflareDeviceId);
    box.checked = selectedIds.indexOf(row.cloudflareDeviceId) !== -1;
    selectCell.appendChild(box);
    var checkCell = td(null);
    var button = el("button", "row-check", "Check");
    button.type = "button";
    button.setAttribute("data-device-id", row.cloudflareDeviceId);
    checkCell.appendChild(button);
    td(null, row.hostname || "");
    td("mono", row.serialNumber || "");
    td("mono", mac(row.verifiedMac));
    var c = chip(row);
    td(null).appendChild(el("span", "chip " + c[0], c[1]));
    td(null, row.mappingStatus);
    td(null, row.score === null || row.score === undefined ? "\\u2014" : String(row.score));
    td(null, row.reason || "\\u2014");
    td(null, rel(row.lastContentUpdateTime));
    td(null, rel(row.cortexRefreshedAt));
    return tr;
  }

  function renderDevices(payload) {
    var tbody = document.getElementById("rows");
    tbody.textContent = "";
    renderedIds = (payload.devices || []).map(function (row) {
      return row.cloudflareDeviceId;
    });
    (payload.devices || []).forEach(function (row) {
      tbody.appendChild(renderDeviceRow(row));
    });
    var selectAll = document.getElementById("select-all");
    selectAll.checked =
      renderedIds.length > 0 &&
      renderedIds.every(function (id) {
        return selectedIds.indexOf(id) !== -1;
      });
    updateBulkButton();
    document.getElementById("count").textContent =
      (payload.devices || []).length + " of max " + limit + " devices shown" +
      (search ? " \\u00b7 matching \\u201c" + search + "\\u201d" : "");
  }

  function showError(msg) {
    var e = document.getElementById("error");
    e.textContent = msg;
    e.style.display = "block";
  }

  function hideError() {
    document.getElementById("error").style.display = "none";
  }

  var accountLists = [];
  var currentAccountId = "";
  var currentListId = "";

  function configMessage(text) {
    document.getElementById("config-message").textContent = text;
  }

  function renderSettings(payload) {
    var s = payload.settings || {};
    currentAccountId = s.cloudflareAccountId || "";
    currentListId = s.serialListId || "";
    document.getElementById("threshold").value = s.maxContentAgeDays;
    document.getElementById("capacity").value = s.listMaxItems;
    document.getElementById("sync-enabled").checked = !!s.listSyncEnabled;
    document.getElementById("debug-log-enabled").checked = s.debugLogEnabled !== false;

    var flags = [];
    if (payload.auth_mode === "none") {
      flags.push("AUTH DISABLED (development mode)");
    } else {
      flags.push("Auth: Cloudflare Access");
    }
    flags.push(payload.cloudflare_api_token_configured ? "Cloudflare API token configured" : "Cloudflare API token missing");
    flags.push(payload.cortex_configured ? "Cortex configured" : "Cortex not configured");
    if (s.serialListName) flags.push("List: " + s.serialListName);
    else if (s.serialListId) flags.push("List: " + s.serialListId);
    else flags.push("No list selected");
    document.getElementById("config-status").textContent = flags.join(" \\u00b7 ");
  }

  function fillListOptions() {
    var accountSelect = document.getElementById("account-select");
    var listSelect = document.getElementById("list-select");
    var account = null;
    for (var i = 0; i < accountLists.length; i++) {
      if (accountLists[i].accountId === accountSelect.value) account = accountLists[i];
    }
    listSelect.textContent = "";
    var placeholder = el(
      "option",
      null,
      account && account.lists.length ? "Select a list\\u2026" : "No SERIAL lists in this account"
    );
    placeholder.value = "";
    listSelect.appendChild(placeholder);
    var lists = account ? account.lists : [];
    for (var j = 0; j < lists.length; j++) {
      var option = el("option", null, lists[j].name + " (" + lists[j].count + " items)");
      option.value = lists[j].id;
      option.setAttribute("data-name", lists[j].name);
      option.selected = lists[j].id === currentListId;
      listSelect.appendChild(option);
    }
  }

  function loadLists() {
    configMessage("Loading accounts and lists\\u2026");
    fetch("/api/cloudflare/lists", { headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("list request failed (" + r.status + ")");
        return r.json();
      })
      .then(function (payload) {
        accountLists = payload.accounts || [];
        var accountSelect = document.getElementById("account-select");
        var listSelect = document.getElementById("list-select");
        accountSelect.textContent = "";
        var totalLists = 0;
        for (var i = 0; i < accountLists.length; i++) {
          totalLists += accountLists[i].lists.length;
          var option = el(
            "option",
            null,
            accountLists[i].accountName +
              (accountLists[i].lists.length ? " (" + accountLists[i].lists.length + " lists)" : "")
          );
          option.value = accountLists[i].accountId;
          option.selected = accountLists[i].accountId === currentAccountId;
          accountSelect.appendChild(option);
        }
        if (accountLists.length === 0) {
          configMessage("No accounts visible to the API token.");
          return;
        }
        accountSelect.disabled = accountLists.length < 2;
        listSelect.disabled = false;
        fillListOptions();
        configMessage(
          accountLists.length + " account(s) \\u00b7 " + totalLists + " SERIAL list(s) found"
        );
      })
      .catch(function (err) {
        configMessage("Error: " + String(err && err.message ? err.message : err));
      });
  }

  function saveConfig() {
    var accountSelect = document.getElementById("account-select");
    var listSelect = document.getElementById("list-select");
    var body = {
      maxContentAgeDays: parseInt(document.getElementById("threshold").value, 10),
      listMaxItems: parseInt(document.getElementById("capacity").value, 10),
      listSyncEnabled: document.getElementById("sync-enabled").checked,
      debugLogEnabled: document.getElementById("debug-log-enabled").checked
    };
    if (isNaN(body.maxContentAgeDays) || isNaN(body.listMaxItems)) {
      configMessage("Threshold and capacity must be numbers.");
      return;
    }
    if (accountSelect.value) body.cloudflareAccountId = accountSelect.value;
    if (listSelect.value) {
      body.serialListId = listSelect.value;
      var selected = listSelect.options[listSelect.selectedIndex];
      var name = selected ? selected.getAttribute("data-name") : null;
      if (name) body.serialListName = name;
    }
    configMessage("Saving\\u2026");
    fetch("/api/settings", {
      method: "PUT",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (!r.ok) throw new Error("save failed (" + r.status + ")");
        return r.json();
      })
      .then(function (payload) {
        renderSettings(payload);
        configMessage("Saved. Changes apply on the next Cron run.");
        refresh();
      })
      .catch(function (err) {
        configMessage("Error: " + String(err && err.message ? err.message : err));
      });
  }

  function syncNow() {
    configMessage("Syncing\\u2026");
    fetch("/api/sync", { method: "POST", headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("sync failed (" + r.status + ")");
        return r.json();
      })
      .then(function (payload) {
        configMessage(
          "Sync complete \\u00b7 changed=" + payload.changed + " \\u00b7 count=" + payload.count
        );
        refresh();
      })
      .catch(function (err) {
        configMessage("Error: " + String(err && err.message ? err.message : err));
      });
  }

  var debugTimer = null;
  var lastMaxDebugId = null;
  var pinnedToBottom = true;

  function openDebug() {
    document.getElementById("chat-popup").hidden = false;
    loadDebug();
    debugTimer = setInterval(loadDebug, 2000);
  }

  function closeDebug() {
    document.getElementById("chat-popup").hidden = true;
    if (debugTimer) {
      clearInterval(debugTimer);
      debugTimer = null;
    }
  }

  function loadDebug() {
    fetch("/api/debug-log?limit=100", { headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("debug log failed (" + r.status + ")");
        return r.json();
      })
      .then(function (payload) {
        renderDebug(payload.entries || []);
      })
      .catch(function () {});
  }

  function prettyJson(value) {
    if (!value) return "";
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch (e) {
      return value;
    }
  }

  function shortUrl(url) {
    return String(url || "").replace(/^https?:\\/\\/[^\\/]+/, "");
  }

  var DEBUG_DOM_CAP = 250;

  function appendDebugBubble(body, entry, fresh) {
    var isRequest = entry.direction === "request";
    var row = el("div", "chat-row " + (isRequest ? "request" : "response"));
    if (fresh) row.className += " fresh";
    var bubble = el("div", "chat-bubble");
    var head = el("div", "chat-bubble-head");
    head.appendChild(
      el(
        "span",
        "chip " + (isRequest ? "neutral" : entry.status && entry.status < 400 ? "ok" : "bad"),
        isRequest ? "REQ" : "RES"
      )
    );
    var detail =
      (entry.method || "POST") + " " + shortUrl(entry.url) +
      (entry.status ? " \\u00b7 " + entry.status : "") +
      (entry.durationMs !== null && entry.durationMs !== undefined
        ? " \\u00b7 " + entry.durationMs + " ms"
        : "");
    head.appendChild(el("span", "mono", detail));
    head.appendChild(
      el("span", "chat-meta", new Date(entry.createdAt).toLocaleTimeString())
    );
    bubble.appendChild(head);
    if (entry.headers) bubble.appendChild(el("pre", "mono", entry.headers));
    bubble.appendChild(el("pre", "mono", prettyJson(entry.body)));
    row.appendChild(bubble);
    body.appendChild(row);
    while (body.children.length > DEBUG_DOM_CAP) {
      body.removeChild(body.firstChild);
    }
  }

  function renderDebug(entries) {
    var body = document.getElementById("debug-entries");
    if (lastMaxDebugId === null) {
      // First load (or after Clear): render the recent transcript in full.
      body.textContent = "";
      if (!entries.length) {
        body.appendChild(
          el("div", "debug-empty", "No traffic yet. Use a Check button or wait for the next Cron refresh.")
        );
        lastMaxDebugId = 0;
        return;
      }
      var history = entries.slice().reverse();
      for (var i = 0; i < history.length; i++) {
        appendDebugBubble(body, history[i], false);
      }
      lastMaxDebugId = entries[0].id;
      pinnedToBottom = true;
      body.scrollTop = body.scrollHeight;
      return;
    }

    // Streaming: append only entries newer than what is already rendered, so
    // the scroll position of someone reading older traffic is never reset.
    var freshEntries = entries.filter(function (entry) {
      return entry.id > lastMaxDebugId;
    });
    if (!freshEntries.length) return;
    var empty = body.querySelector(".debug-empty");
    if (empty) empty.remove();
    for (var j = freshEntries.length - 1; j >= 0; j--) {
      appendDebugBubble(body, freshEntries[j], true);
    }
    lastMaxDebugId = entries[0].id;
    if (pinnedToBottom) body.scrollTop = body.scrollHeight;
  }

  document.getElementById("debug-entries").addEventListener("scroll", function (event) {
    var body = event.target;
    pinnedToBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  });

  document.getElementById("chat-fab").addEventListener("click", function () {
    if (document.getElementById("chat-popup").hidden) openDebug();
    else closeDebug();
  });
  document.getElementById("debug-close").addEventListener("click", closeDebug);
  document.getElementById("debug-clear").addEventListener("click", function () {
    fetch("/api/debug-log", { method: "DELETE" })
      .then(function () {
        lastMaxDebugId = null;
        loadDebug();
      })
      .catch(function () {});
  });

  var searchTimer = null;
  document.getElementById("search").addEventListener("input", function (event) {
    var value = event.target.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      search = value.trim().toLowerCase();
      refresh();
    }, 300);
  });

  document.getElementById("check-selected").addEventListener("click", checkSelected);
  document.getElementById("select-all").addEventListener("change", function (event) {
    var on = event.target.checked;
    for (var i = 0; i < renderedIds.length; i++) {
      toggleSelected(renderedIds[i], on);
    }
    var boxes = document.querySelectorAll("#rows .row-select");
    for (var j = 0; j < boxes.length; j++) boxes[j].checked = on;
    updateBulkButton();
  });

  document.getElementById("rows").addEventListener("change", function (event) {
    var box = event.target;
    if (box.tagName !== "INPUT" || !box.classList.contains("row-select")) return;
    toggleSelected(box.getAttribute("data-device-id"), box.checked);
    updateBulkButton();
  });

  function toggleSelected(id, on) {
    var index = selectedIds.indexOf(id);
    if (on && index === -1) selectedIds.push(id);
    if (!on && index !== -1) selectedIds.splice(index, 1);
  }

  function updateBulkButton() {
    var button = document.getElementById("check-selected");
    button.disabled = selectedIds.length === 0;
    button.textContent = selectedIds.length
      ? "Check selected (" + selectedIds.length + ")"
      : "Check selected";
  }

  var refreshStatusTimer = null;

  function setRefreshStatus(text) {
    document.getElementById("refresh-status").textContent = text;
    if (refreshStatusTimer) clearTimeout(refreshStatusTimer);
    refreshStatusTimer = setTimeout(function () {
      document.getElementById("refresh-status").textContent = "";
    }, 10000);
  }

  function checkSelected() {
    if (!selectedIds.length) return;
    var button = document.getElementById("check-selected");
    button.disabled = true;
    button.textContent = "Checking\\u2026";
    fetch("/api/devices/refresh", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ deviceIds: selectedIds })
    })
      .then(function (r) {
        if (!r.ok) throw new Error("bulk refresh failed (" + r.status + ")");
        return r.json();
      })
      .then(function (payload) {
        var message =
          "Refreshed " + (payload.devices || []).length + " device(s)";
        if (payload.notFound && payload.notFound.length) {
          message += " \\u00b7 " + payload.notFound.length + " not found";
        }
        if (payload.endpointNotFound && payload.endpointNotFound.length) {
          message += " \\u00b7 " + payload.endpointNotFound.length + " endpoint missing";
        }
        setRefreshStatus(message);
        selectedIds = [];
        refresh();
      })
      .catch(function (err) {
        setRefreshStatus("Error: " + String(err && err.message ? err.message : err));
      })
      .then(updateBulkButton);
  }

  function refresh() {
    fetch("/api/settings", { headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("settings request failed (" + r.status + ")");
        return r.json();
      })
      .then(function (payload) {
        renderSettings(payload);
        return fetch("/api/overview", { headers: { accept: "application/json" } });
      })
      .then(function (r) {
        if (!r.ok) throw new Error("overview request failed (" + r.status + ")");
        return r.json();
      })
      .then(function (o) {
        renderOverview(o);
        var url = "/api/devices?status=" + status + "&limit=" + limit;
        if (search) url += "&search=" + encodeURIComponent(search);
        return fetch(url, { headers: { accept: "application/json" } });
      })
      .then(function (r) {
        if (!r.ok) throw new Error("devices request failed (" + r.status + ")");
        return r.json();
      })
      .then(renderDevices)
      .then(hideError)
      .catch(function (err) {
        showError(String(err && err.message ? err.message : err));
      });
  }

  document.getElementById("filters").addEventListener("click", function (event) {
    var b = event.target;
    if (b.tagName !== "BUTTON") return;
    status = b.getAttribute("data-status");
    var buttons = document.querySelectorAll("#filters button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("active", buttons[i] === b);
    }
    refresh();
  });

  document.getElementById("load-lists").addEventListener("click", loadLists);
  document.getElementById("save-config").addEventListener("click", saveConfig);
  document.getElementById("sync-now").addEventListener("click", syncNow);
  document.getElementById("account-select").addEventListener("change", fillListOptions);

  document.getElementById("rows").addEventListener("click", function (event) {
    var button = event.target;
    if (button.tagName !== "BUTTON" || !button.classList.contains("row-check")) return;
    var deviceId = button.getAttribute("data-device-id");
    button.disabled = true;
    button.textContent = "\\u2026";
    fetch("/api/devices/refresh", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ deviceId: deviceId })
    })
      .then(function (r) {
        if (!r.ok) throw new Error("refresh failed (" + r.status + ")");
        return r.json();
      })
      .then(function (payload) {
        var device = payload.devices && payload.devices[0];
        if (!device) {
          if (payload.endpointNotFound && payload.endpointNotFound.length) {
            throw new Error("Cortex endpoint not found");
          }
          throw new Error("device not found");
        }
        var tr = button.closest("tr");
        var fresh = renderDeviceRow(device);
        fresh.classList.add("flash");
        if (tr && tr.parentNode) tr.parentNode.replaceChild(fresh, tr);
      })
      .catch(function (err) {
        button.disabled = false;
        button.textContent = "Check";
        showError(String(err && err.message ? err.message : err));
      });
  });

  refresh();
  setInterval(refresh, 60000);
})();
</script>
</body>
</html>`;
