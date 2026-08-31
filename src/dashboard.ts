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
</style>
</head>
<body>
<div class="wrap">
  <h1>Cortex Posture Dashboard</h1>
  <div class="sub" id="subtitle">Loading&hellip;</div>
  <div class="error" id="error"></div>
  <div class="cards" id="cards"></div>
  <div class="pills" id="pills"></div>
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

  function refresh() {
    fetch("/api/overview", { headers: { accept: "application/json" } })
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

  refresh();
  setInterval(refresh, 60000);
})();
</script>
</body>
</html>`;
