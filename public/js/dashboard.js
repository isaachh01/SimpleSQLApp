/**
 * dashboard.js — browser script for dashboard.html.
 *
 * Big picture:
 *   This page is a fixed mockup, not a live feed — the truck data below is a
 *   small hard-coded sample (mirrors the sample data baked into the imported
 *   design). There is nothing to fetch from the server; we just compute a
 *   few derived values (which assets are flagged, how many, sorted/filtered
 *   table order) and draw them into the page.
 *
 * Each asset carries a "data integrity" check: a hash of its reported
 * status/location that either matches ("VERIFIED") or doesn't
 * ("COMPROMISED"), which would flag that its sensor readings may have been
 * tampered with in transit.
 */

// --- Sample fleet data --------------------------------------------------
// Values below mirror the sample rows baked into the imported design.
var ASSETS = [
  { id: "Truck_7", shipment: "DELAYED", traffic: "DETOUR", waitingMinutes: 38, delay: true, reason: "None", integrity: "COMPROMISED", hashFail: "Location_Status_Hash mismatch" },
  { id: "Truck_6", shipment: "IN TRANSIT", traffic: "HEAVY", waitingMinutes: 16, delay: true, reason: "Weather", integrity: "VERIFIED", hashFail: "" },
  { id: "Truck_10", shipment: "IN TRANSIT", traffic: "DETOUR", waitingMinutes: 34, delay: false, reason: "None", integrity: "VERIFIED", hashFail: "" },
  { id: "Truck_9", shipment: "DELIVERED", traffic: "HEAVY", waitingMinutes: 37, delay: true, reason: "Traffic", integrity: "COMPROMISED", hashFail: "Env_Time_Hash mismatch" },
  { id: "Truck_7", shipment: "DELAYED", traffic: "CLEAR", waitingMinutes: 56, delay: true, reason: "None", integrity: "VERIFIED", hashFail: "" },
];

// Behavior switches carried over from the design's configurable props.
// This mockup has no on-page controls for them, so they're fixed here.
var SHOW_MAP_LEGEND = true;
var FILTER_DELAYED_ONLY = false;
var SORT_BY_WAIT_TIME = false;

// --- Cached references to elements declared with id="..." in dashboard.html -
var updatedText = document.getElementById("updatedText");
var alertsBadge = document.getElementById("alertsBadge");
var mapLegend = document.getElementById("mapLegend");
var alertsSummary = document.getElementById("alertsSummary");
var alertsList = document.getElementById("alertsList");
var tableCaption = document.getElementById("tableCaption");
var assetTable = document.getElementById("assetTable");

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A delay reason of "None" means the server didn't record a specific cause.
function delayReasonLabel(reason) {
  return reason === "None" ? "Not specified" : reason;
}

// --- Rendering ---------------------------------------------------------

function renderHeader() {
  var compromised = ASSETS.filter(function (a) {
    return a.integrity === "COMPROMISED";
  }).length;

  alertsBadge.textContent =
    compromised > 0 ? compromised + " ALERTS" : "ALL SYSTEMS VERIFIED";
}

function renderMapLegend() {
  mapLegend.hidden = !SHOW_MAP_LEGEND;
}

function renderAlerts() {
  var compromised = ASSETS.filter(function (a) {
    return a.integrity === "COMPROMISED";
  }).length;

  alertsSummary.textContent =
    compromised + " of " + ASSETS.length + " assets flagged";

  var html = "";
  for (var i = 0; i < ASSETS.length; i++) {
    var a = ASSETS[i];
    html +=
      '<div class="ldash-alert-card">' +
      '<div class="ldash-alert-top">' +
      '<span class="ldash-alert-id">' + escapeHtml(a.id) + "</span>" +
      '<span class="ldash-alert-integrity">' + escapeHtml(a.integrity) + "</span>" +
      "</div>";
    if (a.integrity === "COMPROMISED") {
      html +=
        '<div class="ldash-alert-hash">' + escapeHtml(a.hashFail) + "</div>";
    }
    html += "</div>";
  }
  alertsList.innerHTML = html;
}

function renderTable() {
  var rows = FILTER_DELAYED_ONLY
    ? ASSETS.filter(function (a) { return a.delay; })
    : ASSETS.slice();

  if (SORT_BY_WAIT_TIME) {
    rows = rows.slice().sort(function (a, b) {
      return b.waitingMinutes - a.waitingMinutes;
    });
  }

  var captionParts = [];
  if (FILTER_DELAYED_ONLY) captionParts.push("delayed only");
  if (SORT_BY_WAIT_TIME) captionParts.push("sorted by wait time");
  tableCaption.textContent = captionParts.length
    ? "(" + captionParts.join(", ") + ")"
    : "";

  // Keep the header row, drop any previously rendered body cells.
  var headerCells = assetTable.querySelectorAll(".ldash-th");
  assetTable.innerHTML = "";
  headerCells.forEach(function (cell) {
    assetTable.appendChild(cell);
  });

  var html = "";
  for (var i = 0; i < rows.length; i++) {
    var a = rows[i];
    var delayCell = a.delay
      ? '<div class="ldash-delay-flag" title="' + escapeHtml(delayReasonLabel(a.reason)) + '">!</div>' +
        '<span class="ldash-delay-reason">' + escapeHtml(delayReasonLabel(a.reason)) + "</span>"
      : '<span class="ldash-delay-reason">—</span>';

    html +=
      '<div class="ldash-td ldash-td-id">' + escapeHtml(a.id) + "</div>" +
      '<div class="ldash-td"><span class="ldash-shipment-tag">' + escapeHtml(a.shipment) + "</span></div>" +
      '<div class="ldash-td ldash-delay-cell">' + delayCell + "</div>" +
      '<div class="ldash-td ldash-td-right">' + a.waitingMinutes + " min</div>" +
      '<div class="ldash-td ldash-td-small">' + escapeHtml(a.traffic) + "</div>";
  }
  assetTable.insertAdjacentHTML("beforeend", html);
}

function renderUpdatedTime() {
  var now = new Date();
  updatedText.textContent = "Last updated " + now.toLocaleTimeString();
}

function render() {
  renderHeader();
  renderMapLegend();
  renderAlerts();
  renderTable();
  renderUpdatedTime();
}

render();
// The "last updated" clock ticks even though the underlying data is fixed,
// same as the spinner in the original design implies a live connection.
setInterval(renderUpdatedTime, 1000);
