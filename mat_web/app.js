"use strict";

const state = {
  data: null,
  materials: new Set(),
  axes: [],
  colors: {},
};

async function init() {
  const response = await fetch("../json_table/materials.json");
  state.data = await response.json();

  state.data.materials.forEach(material => {
    state.materials.add(material.id);
    state.colors[material.id] = material.color;
  });
  state.axes = Object.keys(state.data.properties).filter(id => state.data.properties[id].default_axis);

  buildMaterialControls();
  buildAxisControls();
  document.getElementById("download").addEventListener("click", downloadPng);
  render();
}

function buildMaterialControls() {
  const host = document.getElementById("materials");
  host.innerHTML = state.data.materials.map(material => `
    <label>
      <input type="checkbox" data-material="${material.id}" checked>
      <input type="color" data-color="${material.id}" value="${material.color}">
      <span>${material.label}</span>
    </label>`).join("");

  host.querySelectorAll("[data-material]").forEach(input =>
    input.addEventListener("change", event => {
      const id = event.target.dataset.material;
      event.target.checked ? state.materials.add(id) : state.materials.delete(id);
      render();
    }));
  host.querySelectorAll("[data-color]").forEach(input =>
    input.addEventListener("input", event => {
      state.colors[event.target.dataset.color] = event.target.value;
      render();
    }));
}

function buildAxisControls() {
  const host = document.getElementById("axes");
  host.innerHTML = Object.entries(state.data.properties).map(([id, property]) => `
    <label>
      <input type="checkbox" data-axis="${id}" ${property.default_axis ? "checked" : ""}>
      <span>${property.name}</span>
    </label>`).join("");

  host.querySelectorAll("[data-axis]").forEach(input =>
    input.addEventListener("change", () => {
      state.axes = Object.keys(state.data.properties)
        .filter(id => host.querySelector(`[data-axis="${id}"]`).checked);
      render();
    }));
}

function propertyValue(material, axisId) {
  const property = material.properties[axisId];
  return property && typeof property.value === "number" ? property.value : null;
}

function normalize(axisId, value) {
  if (value == null) return null;
  const property = state.data.properties[axisId];
  if (property.scale === "log") {
    const min = property.axis_min ?? 1;
    const lo = Math.log10(min);
    const hi = Math.log10(property.axis_max);
    return clamp((Math.log10(Math.max(value, min)) - lo) / (hi - lo));
  }
  return clamp(value / property.axis_max);
}

function clamp(x) { return Math.max(0, Math.min(1, x)); }

function tickValue(property, ring) {
  if (property.scale === "log") {
    const min = property.axis_min ?? 1;
    const lo = Math.log10(min);
    const hi = Math.log10(property.axis_max);
    return Math.pow(10, lo + (hi - lo) * ring / 5);
  }
  return property.axis_max * ring / 5;
}

function superscript(n) {
  const map = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  return String(n).split("").map(c => map[c] || c).join("");
}

function polygon(cx, cy, r, angles) {
  return angles.map(a => ({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r }));
}

function tracePath(ctx, points, close) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (close) ctx.closePath();
}

function unitLabel(property) {
  return property.unit;
}

function drawRadar(canvas, scale) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const cx = width / 2;
  const cy = height * 0.52;
  const radius = Math.min(width, height) * 0.25;
  const axes = state.axes;

  if (axes.length < 3) {
    ctx.fillStyle = "#6b6b6b";
    ctx.font = `${18 * scale}px Arial`;
    ctx.fillText("Select at least three axes", cx, cy);
    return;
  }

  const angles = axes.map((_, i) => -Math.PI / 2 + i * 2 * Math.PI / axes.length);

  // pseudo-3D outer frame
  const frame = polygon(cx, cy, radius * 1.2, angles);
  ctx.fillStyle = "#f7f8f9";
  ctx.strokeStyle = "#dfe1e4";
  ctx.lineWidth = 1.5 * scale;
  tracePath(ctx, frame, true);
  ctx.fill();
  ctx.stroke();

  // connectors from frame corners toward the outer ring (subtle depth cue)
  ctx.strokeStyle = "#ebedef";
  ctx.lineWidth = 1 * scale;
  const outer = polygon(cx, cy, radius, angles);
  frame.forEach((corner, i) => {
    ctx.beginPath();
    ctx.moveTo(corner.x, corner.y);
    ctx.lineTo(outer[i].x, outer[i].y);
    ctx.stroke();
  });

  // grid rings
  ctx.strokeStyle = "#d5d8dc";
  ctx.lineWidth = 1.3 * scale;
  for (let ring = 1; ring <= 5; ring++) {
    tracePath(ctx, polygon(cx, cy, radius * ring / 5, angles), true);
    ctx.stroke();
  }

  // spokes
  angles.forEach(a => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    ctx.stroke();
  });

  // per-axis value ticks at each ring (so plotted positions match reported values)
  ctx.fillStyle = "#9aa0a6";
  ctx.font = `${18 * scale}px Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  axes.forEach((axisId, i) => {
    const property = state.data.properties[axisId];
    const a = angles[i];
    const perpX = Math.cos(a + Math.PI / 2);
    const perpY = Math.sin(a + Math.PI / 2);
    for (let ring = 1; ring <= 5; ring++) {
      const rr = radius * ring / 5;
      const x = cx + Math.cos(a) * rr + perpX * 16 * scale;
      const y = cy + Math.sin(a) * rr + perpY * 16 * scale;
      const v = tickValue(property, ring);
      const label = property.scale === "log"
        ? "10" + superscript(Math.round(Math.log10(v)))
        : String(Math.round(v));
      ctx.fillText(label, x, y);
    }
  });

  // axis labels (name words stacked, unit below), Arial
  axes.forEach((axisId, i) => {
    const property = state.data.properties[axisId];
    const a = angles[i];
    const lx = cx + Math.cos(a) * radius * 1.3;
    const ly = cy + Math.sin(a) * radius * 1.3;
    ctx.textAlign = Math.cos(a) > 0.25 ? "left" : Math.cos(a) < -0.25 ? "right" : "center";
    ctx.textBaseline = "middle";
    const unit = unitLabel(property);
    const lines = property.name.split(" ");
    if (unit) lines.push(`[${unit}]`);
    const lineGap = 34 * scale;
    const startY = ly - (lines.length - 1) * lineGap / 2;
    lines.forEach((line, li) => {
      const isUnit = unit && li === lines.length - 1;
      ctx.fillStyle = isUnit ? "#6b6b6b" : "#1a1a1a";
      ctx.font = isUnit ? `${22 * scale}px Arial` : `700 ${30 * scale}px Arial`;
      ctx.fillText(line, lx, startY + li * lineGap);
    });
  });

  // material polygons
  state.data.materials
    .filter(material => state.materials.has(material.id))
    .forEach(material => {
      const color = state.colors[material.id];
      const points = axes.map((axisId, i) => {
        const n = normalize(axisId, propertyValue(material, axisId));
        if (n == null) return null;
        const r = radius * n;
        return { x: cx + Math.cos(angles[i]) * r, y: cy + Math.sin(angles[i]) * r };
      });
      const allPresent = points.every(Boolean);

      ctx.strokeStyle = color;
      ctx.lineWidth = 3.4 * scale;
      ctx.lineJoin = "round";

      if (allPresent) {
        tracePath(ctx, points, true);
        ctx.fillStyle = hexToRgba(color, 0.11);
        ctx.fill();
        ctx.stroke();
      } else {
        // draw only across consecutive available vertices
        ctx.beginPath();
        let started = false;
        points.forEach(p => {
          if (!p) { started = false; return; }
          started ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
          started = true;
        });
        ctx.stroke();
      }
    });

  drawLegend(ctx, cx, height * 0.955, scale);
}

function drawLegend(ctx, cx, y, scale) {
  const items = state.data.materials.filter(m => state.materials.has(m.id));
  if (!items.length) return;
  ctx.font = `${22 * scale}px Arial`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const sw = 30 * scale, gap = 9 * scale, itemGap = 30 * scale;
  const widths = items.map(m => sw + gap + ctx.measureText(m.label).width);
  const total = widths.reduce((a, b) => a + b, 0) + itemGap * (items.length - 1);
  let x = cx - total / 2;
  items.forEach((m, i) => {
    ctx.fillStyle = state.colors[m.id];
    ctx.fillRect(x, y - 3 * scale, sw, 6 * scale);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText(m.label, x + sw + gap, y);
    x += widths[i] + itemGap;
  });
}

function hexToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const r = parseInt(value.substring(0, 2), 16);
  const g = parseInt(value.substring(2, 4), 16);
  const b = parseInt(value.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function renderTable() {
  const materials = state.data.materials.filter(material => state.materials.has(material.id));
  const order = [];
  const refIndex = {};
  const cite = referenceId => {
    if (!(referenceId in refIndex)) { refIndex[referenceId] = order.length + 1; order.push(referenceId); }
    const n = refIndex[referenceId];
    const reference = state.data.references[referenceId];
    const href = reference.doi ? `https://doi.org/${reference.doi}` : reference.url;
    return href
      ? `<sup><a href="${href}" title="${reference.authors} (${reference.year})" target="_blank" rel="noreferrer">[${n}]</a></sup>`
      : `<sup title="${reference.authors} (${reference.year})">[${n}]</sup>`;
  };

  const body = Object.entries(state.data.properties).map(([axisId, property]) => {
    const cells = materials.map(material => {
      const entry = material.properties[axisId];
      if (!entry || typeof entry.value !== "number") return `<td class="missing">&mdash;</td>`;
      const refs = [...new Set(entry.observations.map(o => o.reference))].map(cite).join("");
      return `<td>${entry.value}${refs}</td>`;
    }).join("");
    return `<tr><td>${property.name}<span class="unit">${property.unit || ""}</span></td>${cells}</tr>`;
  }).join("");

  const head = `<tr><th>Property</th>${materials.map(m => `<th>${m.label}</th>`).join("")}</tr>`;
  document.getElementById("table").innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;

  document.getElementById("refnotes").innerHTML = "<h3>References (Chicago)</h3>" + order.map((referenceId, i) => {
    const r = state.data.references[referenceId];
    const link = r.doi ? `https://doi.org/${r.doi}` : r.url;
    const tail = link ? ` <a href="${link}" target="_blank" rel="noreferrer">${link}</a>.` : "";
    const cited = r.doi || r.url
      ? `${r.authors}. &ldquo;${r.title}.&rdquo; <i>${r.journal}</i> (${r.year}).`
      : `${r.authors}. <i>${r.title}</i>. ${r.journal}, ${r.year}.`;
    return `<p>[${i + 1}] ${cited}${tail}</p>`;
  }).join("");
}

function render() {
  const canvas = document.getElementById("radar");
  drawRadar(canvas, canvas.width / 1200);
  renderTable();
}

function downloadPng() {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = 3000;
  exportCanvas.height = Math.round(3000 * 1000 / 1200);
  drawRadar(exportCanvas, exportCanvas.width / 1200);
  const link = document.createElement("a");
  link.download = "material-tradeoff-web-300K.png";
  link.href = exportCanvas.toDataURL("image/png");
  link.click();
}

init().catch(error => {
  document.body.insertAdjacentHTML("afterbegin",
    `<p style="color:#b00">Could not load materials.json: ${error.message}</p>`);
});
