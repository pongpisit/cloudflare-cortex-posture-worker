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
      <div class="config-actions">
        <button type="button" id="load-lists">Load lists</button>
        <button type="button" id="save-config" class="primary">Save configuration</button>
      </div>
    </div>
    <div class="meta config-message" id="config-message"></div>
  </div>
  <div class="toolbar">
    <div class="filters" id="filters">
      <button type="button" data-status="all" class="active">All</button>
      <button type="button" data-status="noncompliant">Noncompliant</button>
      <button type="button" data-status="compliant">Compliant</button>
    </div>
    <div class="sub" id="count"></div>
  </div>
  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th>Hostname</th><th>Serial</th><th>MAC</th><th>Compliance</th>
          <th>Mapping</th><th>Score</th><th>Reason</th>
          <th>Content updated</th><th>Refreshed</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>
<script>
(function () {
  "use strict";
  var status = "all";
  var limit = 200;

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

  function renderDevices(payload) {
    var tbody = document.getElementById("rows");
    tbody.textContent = "";
    (payload.devices || []).forEach(function (row) {
      var tr = document.createElement("tr");
      function td(cls, text) {
        var c = el("td", cls, text);
        tr.appendChild(c);
        return c;
      }
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
      tbody.appendChild(tr);
    });
    document.getElementById("count").textContent =
      (payload.devices || []).length + " of max " + limit + " devices shown";
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
      listSyncEnabled: document.getElementById("sync-enabled").checked
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
        return fetch("/api/devices?status=" + status + "&limit=" + limit, {
          headers: { accept: "application/json" }
        });
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
  document.getElementById("account-select").addEventListener("change", fillListOptions);

  refresh();
  setInterval(refresh, 60000);
})();
</script>
</body>
</html>`;
