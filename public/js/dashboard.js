/**
 * dashboard.js — browser script for dashboard.html.
 *
 * Big picture:
 *   This page is a live feed. On load it calls the external sensors API with
 *   fetch() (the same pattern as api.js), maps each returned record into the
 *   internal "asset" shape the panels expect, then renders the live values
 *   into the header, alerts, and table. No local server is involved — the
 *   request goes straight from the browser to:
 *     https://digisolia3api.vercel.app/api/sensors
 *
 * Each asset carries a "data integrity" check. The API ships three SHA-256
 * hashes per record (All_Data_Hash, Location_Status_Hash, Env_Time_Hash),
 * each covering a known subset of the row's fields (see HASH_SPECS below).
 * We recompute all three in the browser with the Web Crypto API and flag an
 * asset as COMPROMISED if a hash is missing or doesn't match what we compute
 * — i.e. the record was altered (or corrupted) after the hash was made.
 */

// --- The live sensors API ---------------------------------------------------
// Same API the api.html demo page fetches. ?limit keeps the payload small;
// we fetch CHART_LIMIT records so the time-series charts have a full line,
// and cap the Asset Status table at ASSET_LIMIT.
var API_BASE = "https://digisolia3api.vercel.app/api/sensors";
var ASSET_LIMIT = 10;
var CHART_LIMIT = 50;

// Filled by loadData() once the API answers; consumed by render().
var ASSETS = [];

// Behavior switches carried over from the design's configurable props.
// This mockup has no on-page controls for them, so they're fixed here.
var SHOW_MAP_LEGEND = true;
var FILTER_DELAYED_ONLY = false;
var SORT_BY_WAIT_TIME = false;

// Safe operating ranges drawn as the shaded band behind each chart. These are
// illustrative defaults — adjust them to the operation's real tolerances.
var SAFE_TEMP = { min: 0, max: 30 };      // °C
var SAFE_HUMIDITY = { min: 30, max: 70 }; // % RH

// Chart colors, kept low-key to match the dashboard's ink/paper look. Each
// chart is a single series (warm = temperature, cool = humidity) with a pale
// tint for the safe band.
var TEMP_COLOR = "rgba(194, 65, 12, 1)";
var TEMP_BAND = "rgba(194, 65, 12, 0.12)";
var HUMIDITY_COLOR = "rgba(29, 78, 216, 1)";
var HUMIDITY_BAND = "rgba(29, 78, 216, 0.12)";

// --- Cached references to elements declared with id="..." in dashboard.html -
var updatedText = document.getElementById("updatedText");
var alertsBadge = document.getElementById("alertsBadge");
var mapLegend = document.getElementById("mapLegend");
var assetMapWrap = document.getElementById("assetMapWrap");
var alertsSummary = document.getElementById("alertsSummary");
var alertsList = document.getElementById("alertsList");
var tableCaption = document.getElementById("tableCaption");
var assetTable = document.getElementById("assetTable");
var tempChartWrap = document.getElementById("tempChartWrap");
var humidityChartWrap = document.getElementById("humidityChartWrap");

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

// --- Data integrity: recomputing the API's SHA-256 hashes ------------------
// Each hash covers a fixed, ordered set of fields concatenated with no
// separator. Latitude/Longitude are formatted to 4 decimal places and
// Temperature/Humidity/Asset_Utilization to 1 — the source dataset carries
// that many decimals but JSON drops trailing zeros (e.g. 27 instead of
// 27.0), so we restore them before hashing or the digest won't match.
var HASH_SPECS = [
  { field: "All_Data_Hash", fields: [
      "Timestamp", "Asset_ID", "Latitude", "Longitude", "Inventory_Level",
      "Shipment_Status", "Temperature", "Humidity", "Traffic_Status",
      "Waiting_Time", "User_Transaction_Amount", "User_Purchase_Frequency",
      "Logistics_Delay_Reason", "Asset_Utilization", "Demand_Forecast",
      "Logistics_Delay",
    ] },
  { field: "Location_Status_Hash", fields: [
      "Latitude", "Longitude", "Inventory_Level", "Shipment_Status",
    ] },
  { field: "Env_Time_Hash", fields: [
      "Temperature", "Humidity", "Waiting_Time",
    ] },
];
var FIXED4_FIELDS = { Latitude: true, Longitude: true };
var FIXED1_FIELDS = { Temperature: true, Humidity: true, Asset_Utilization: true };

function fieldToHashString(rec, field) {
  var v = rec[field];
  if (FIXED4_FIELDS[field]) return Number(v).toFixed(4);
  if (FIXED1_FIELDS[field]) return Number(v).toFixed(1);
  return String(v);
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(function (b) { return b.toString(16).padStart(2, "0"); })
    .join("");
}

function sha256Hex(text) {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then(bytesToHex);
}

// Recompute each of the three hashes for `rec` and compare against what the
// API sent. Returns a promise for the list of problems found (empty = all
// three verified).
function checkIntegrity(rec) {
  return Promise.all(
    HASH_SPECS.map(function (spec) {
      var provided = rec[spec.field];
      if (!provided) return "Missing " + spec.field;
      var input = spec.fields.map(function (f) {
        return fieldToHashString(rec, f);
      }).join("");
      return sha256Hex(input).then(function (computed) {
        return computed.toLowerCase() === String(provided).toLowerCase()
          ? null
          : spec.field + " mismatch";
      });
    })
  ).then(function (results) {
    return results.filter(Boolean);
  });
}

// --- Mapping API records into the internal "asset" shape -------------------
// Convert one raw API record into the shape the render functions expect.
// Values are normalized so the labels line up with the map legend and table
// (e.g. "In Transit" -> "IN TRANSIT").
function mapRecord(rec) {
  return checkIntegrity(rec).then(function (problems) {
    return {
      id: String(rec.Asset_ID),
      shipment: String(rec.Shipment_Status || "Unknown").toUpperCase(),
      traffic: String(rec.Traffic_Status || "Unknown").toUpperCase(),
      waitingMinutes: rec.Waiting_Time || 0,
      delay: Boolean(rec.Logistics_Delay),
      reason: rec.Logistics_Delay_Reason || "None",
      integrity: problems.length ? "COMPROMISED" : "VERIFIED",
      hashFail: problems.join(", "),
      // Chart inputs: the raw timestamp plus the environment readings. A null
      // (not 0) marks a reading the API didn't send so the charts can skip it.
      timestamp: rec.Timestamp || "",
      temperature: rec.Temperature == null ? null : Number(rec.Temperature),
      humidity: rec.Humidity == null ? null : Number(rec.Humidity),
      // Map inputs.
      latitude: rec.Latitude == null ? null : Number(rec.Latitude),
      longitude: rec.Longitude == null ? null : Number(rec.Longitude),
    };
  });
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

// --- Live asset map ---------------------------------------------------
// Plots each asset's Latitude/Longitude on a Leaflet map over CartoDB's
// "Positron" tiles (light, near-monochrome — the closest stock basemap to
// this dashboard's ink/paper look). Dot fill = Shipment Status, dot border
// style = Traffic Status (same encoding the legend describes); compromised
// assets get a heavier red ring so they stand out regardless of the other
// two. Clicking a dot opens a popup with the asset's full detail.
var assetMap = null;
var assetMarkerLayer = null;

var SHIPMENT_COLOR = {
  "IN TRANSIT": "rgba(0, 0, 0, 0.85)",
  "DELAYED": TEMP_COLOR,
  "DELIVERED": HUMIDITY_COLOR,
};
var TRAFFIC_DASH = {
  "CLEAR": null,
  "DETOUR": "6,4",
  "HEAVY": "1,4",
};
var COMPROMISED_COLOR = "rgba(220, 38, 38, 1)";

function initMap() {
  if (assetMap || !window.L) return;
  assetMap = L.map("assetMap", { scrollWheelZoom: false }).setView([20, 0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(assetMap);
  assetMarkerLayer = L.layerGroup().addTo(assetMap);
}

function popupHtml(a) {
  return (
    '<div class="ldash-popup-title">' +
    "<span>" + escapeHtml(a.id) + "</span>" +
    '<span class="ldash-popup-integrity">' + escapeHtml(a.integrity) + "</span>" +
    "</div>" +
    '<div class="ldash-popup-row"><span class="ldash-popup-key">Shipment</span><span>' + escapeHtml(a.shipment) + "</span></div>" +
    '<div class="ldash-popup-row"><span class="ldash-popup-key">Traffic</span><span>' + escapeHtml(a.traffic) + "</span></div>" +
    '<div class="ldash-popup-row"><span class="ldash-popup-key">Waiting</span><span>' + a.waitingMinutes + " min</span></div>" +
    '<div class="ldash-popup-row"><span class="ldash-popup-key">Delay reason</span><span>' + escapeHtml(delayReasonLabel(a.reason)) + "</span></div>" +
    '<div class="ldash-popup-row"><span class="ldash-popup-key">Temperature</span><span>' + (a.temperature == null ? "—" : a.temperature + " °C") + "</span></div>" +
    '<div class="ldash-popup-row"><span class="ldash-popup-key">Humidity</span><span>' + (a.humidity == null ? "—" : a.humidity + " % RH") + "</span></div>" +
    '<div class="ldash-popup-row"><span class="ldash-popup-key">Timestamp</span><span>' + escapeHtml(a.timestamp || "—") + "</span></div>" +
    '<div class="ldash-popup-row"><span class="ldash-popup-key">Lat, Lon</span><span>' + a.latitude.toFixed(4) + ", " + a.longitude.toFixed(4) + "</span></div>" +
    (a.integrity === "COMPROMISED"
      ? '<div class="ldash-popup-row"><span class="ldash-popup-key">Hash check</span><span>' + escapeHtml(a.hashFail) + "</span></div>"
      : "")
  );
}

function renderMap(assets) {
  if (!window.L) {
    assetMapWrap.classList.add("ldash-map-empty");
    assetMapWrap.textContent = "Map library failed to load";
    return;
  }
  initMap();
  if (!assetMap) return;

  assetMarkerLayer.clearLayers();

  var points = assets.filter(function (a) {
    return typeof a.latitude === "number" && typeof a.longitude === "number" &&
      !isNaN(a.latitude) && !isNaN(a.longitude);
  });

  points.forEach(function (a) {
    var compromised = a.integrity === "COMPROMISED";
    var marker = L.circleMarker([a.latitude, a.longitude], {
      radius: 7,
      weight: compromised ? 3 : 1.5,
      color: compromised ? COMPROMISED_COLOR : "rgba(0, 0, 0, 0.85)",
      dashArray: TRAFFIC_DASH[a.traffic] || null,
      fillColor: SHIPMENT_COLOR[a.shipment] || "rgba(0, 0, 0, 0.5)",
      fillOpacity: 0.85,
    });
    marker.bindPopup(popupHtml(a));
    marker.addTo(assetMarkerLayer);
  });

  if (points.length) {
    assetMap.invalidateSize();
  }
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

  // Cap the table at ASSET_LIMIT rows; the charts below use the full set.
  rows = rows.slice(0, ASSET_LIMIT);

  var captionParts = [];
  if (FILTER_DELAYED_ONLY) captionParts.push("delayed only");
  if (SORT_BY_WAIT_TIME) captionParts.push("sorted by wait time");
  // Say so when more records were fetched than the table shows.
  if (ASSETS.length > ASSET_LIMIT) {
    captionParts.push("top " + ASSET_LIMIT + " of " + ASSETS.length);
  }
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

// --- Time-series charts ---------------------------------------------------
// The two bottom panels are Chart.js line charts of the environment readings
// over time. The shaded band is the safe operating range: it is drawn with
// two extra datasets that hold a constant value at the band's lower and upper
// edge and fill the gap between them — no annotation plugin required.

// "2024-03-20 00:11:14" -> "Mar 20 00:11". Swapping the space for a "T" makes
// the string valid ISO 8601, which every browser can parse as a local time.
function formatTimestamp(str) {
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var d = new Date(str.replace(" ", "T"));
  if (isNaN(d.getTime())) return str; // unparseable -> show the raw string
  return MONTHS[d.getMonth()] + " " + d.getDate() + " " +
    ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}

// Replace a panel's chart with a plain message (offline, empty, library load
// failure). Destroys any chart on the canvas first so re-rendering is safe.
function showChartMessage(wrapEl, message) {
  var canvas = wrapEl.querySelector("canvas");
  if (canvas && window.Chart) {
    var existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
  }
  wrapEl.textContent = message;
  wrapEl.classList.add("ldash-chart-empty");
}

// Draw one metric as a time-series line chart into its panel. `metric` says
// how to read the data: { label, unit, field, safe, color, bandColor } where
// `field` is the asset property holding the numeric reading.
function renderTimeSeries(wrapEl, assets, metric) {
  // Drop any previous empty-state message and give the panel a fresh canvas
  // to draw into.
  wrapEl.classList.remove("ldash-chart-empty");
  wrapEl.textContent = "";
  var canvasEl = document.createElement("canvas");
  canvasEl.setAttribute("aria-label", metric.label + " readings over time");
  wrapEl.appendChild(canvasEl);

  // Keep readings that actually have a number, ordered oldest -> newest so
  // the x-axis reads left to right in time.
  var points = assets
    .filter(function (a) { return typeof a[metric.field] === "number" && a.timestamp; })
    .slice()
    .sort(function (a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });

  if (points.length === 0) {
    showChartMessage(wrapEl, "No " + metric.label.toLowerCase() + " readings yet");
    return;
  }

  var labels = points.map(function (a) { return formatTimestamp(a.timestamp); });
  var values = points.map(function (a) { return a[metric.field]; });
  // Constant lines at the band's edges. Same length as the data so the fill
  // spans the whole plot width.
  var bandMin = values.map(function () { return metric.safe.min; });
  var bandMax = values.map(function () { return metric.safe.max; });

  // y-axis range: the safe band and the data both fit, with a little air.
  var dataMin = Math.min.apply(null, values.concat([metric.safe.min]));
  var dataMax = Math.max.apply(null, values.concat([metric.safe.max]));
  var pad = (dataMax - dataMin) * 0.1 || 1;

  new Chart(canvasEl, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        // Lower edge of the safe band, filled down to the axis but invisible.
        { data: bandMin, fill: true, backgroundColor: "rgba(0,0,0,0)",
          borderWidth: 0, pointRadius: 0, pointHoverRadius: 0 },
        // Upper edge, filled back to the previous dataset -> the shaded band.
        { data: bandMax, fill: "-1", backgroundColor: metric.bandColor,
          borderWidth: 0, pointRadius: 0, pointHoverRadius: 0 },
        // The actual readings on top.
        { data: values, fill: false, borderColor: metric.color,
          backgroundColor: metric.color, borderWidth: 2,
          pointRadius: 3, pointHoverRadius: 6, tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        // One series per panel and the panel title already names it.
        legend: { display: false },
        tooltip: {
          // Only the reading line has points; ignore the band datasets.
          filter: function (item) { return item.datasetIndex === 2; },
          callbacks: {
            title: function (items) { return labels[items[0].dataIndex]; },
            label: function (item) {
              var asset = points[item.dataIndex];
              return asset.id + ": " + item.parsed.y + " " + metric.unit;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Timestamp", color: "rgba(0,0,0,0.55)" },
          ticks: { maxTicksLimit: 6, maxRotation: 0, color: "rgba(0,0,0,0.55)" },
          grid: { color: "rgba(0,0,0,0.1)" },
        },
        y: {
          title: { display: true, text: metric.unit, color: "rgba(0,0,0,0.55)" },
          min: dataMin - pad,
          max: dataMax + pad,
          ticks: { color: "rgba(0,0,0,0.55)" },
          grid: { color: "rgba(0,0,0,0.1)" },
        },
      },
    },
  });
}

function renderCharts(assets) {
  if (!window.Chart) {
    showChartMessage(tempChartWrap, "Chart library failed to load");
    showChartMessage(humidityChartWrap, "Chart library failed to load");
    return;
  }
  renderTimeSeries(tempChartWrap, assets, {
    label: "Temperature", unit: "°C", field: "temperature",
    safe: SAFE_TEMP, color: TEMP_COLOR, bandColor: TEMP_BAND,
  });
  renderTimeSeries(humidityChartWrap, assets, {
    label: "Humidity", unit: "% RH", field: "humidity",
    safe: SAFE_HUMIDITY, color: HUMIDITY_COLOR, bandColor: HUMIDITY_BAND,
  });
}

function render(assets) {
  ASSETS = assets;
  renderHeader();
  renderMapLegend();
  renderMap(ASSETS);
  renderAlerts();
  renderTable();
  renderUpdatedTime();
  renderCharts(ASSETS);
}

// --- Fetching live data -----------------------------------------------------
// Same shape as api.js: fetch the URL, throw on a bad HTTP status, parse the
// JSON, and check it has the expected "data" array before using it.
function fetchSensors() {
  return fetch(API_BASE + "?limit=" + CHART_LIMIT)
    .then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          var payload = {};
          try {
            payload = JSON.parse(text);
          } catch (_e) {
            // Not JSON — fall through with the empty payload.
          }
          throw new Error(
            payload.error || "Request failed (HTTP " + response.status + ")."
          );
        });
      }
      return response.json();
    })
    .then(function (payload) {
      if (!payload || !Array.isArray(payload.data)) {
        throw new Error("The API did not return a valid data array.");
      }
      return payload.data;
    });
}

function loadData() {
  fetchSensors()
    .then(function (records) {
      return Promise.all(records.map(mapRecord));
    })
    .then(function (assets) {
      render(assets);
    })
    .catch(function (e) {
      // Surface the failure in the panels so the dashboard doesn't look
      // "live" when it actually has nothing to show.
      alertsBadge.textContent = "OFFLINE";
      alertsSummary.textContent = "Could not load sensor data";
      alertsList.innerHTML =
        '<div class="ldash-alert-card">' +
        '<div class="ldash-alert-top">' +
        '<span class="ldash-alert-id">API error</span>' +
        '<span class="ldash-alert-integrity">OFFLINE</span>' +
        "</div>" +
        '<div class="ldash-alert-hash">' + escapeHtml(String(e.message || e)) + "</div>" +
        "</div>";
      updatedText.textContent = "Last updated — fetch failed";
      // The charts have nothing to draw — show the failure in both panels
      // instead of leaving stale placeholders.
      showChartMessage(tempChartWrap, "Could not load sensor data");
      showChartMessage(humidityChartWrap, "Could not load sensor data");
    });
}

// Kick off the first load as soon as the script runs.
loadData();
