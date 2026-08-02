"use strict";

const state = {
  data: null,
  materials: new Set(),
  axes: [],
  colors: {},
};

async function init() {
  const [materialsResponse, referencesResponse] = await Promise.all([
    fetch("../json_table/materials.json"),
    fetch("../json_table/references.json"),
  ]);
  state.data = await materialsResponse.json();
  state.data.references = await referencesResponse.json();

  state.data.materials.forEach(material => {
    if (material.color) state.colors[material.id] = material.color;
  });

  const defaults = state.data.default_materials ?? state.data.materials.map(material => material.id);
  defaults
    .filter(id => state.data.materials.some(material => material.id === id))
    .forEach(id => selectMaterial(id));

  state.axes = Object.keys(state.data.properties).filter(id => state.data.properties[id].default_axis);

  buildMaterialControls();
  buildAxisControls();
  buildTabs();
  document.getElementById("download").addEventListener("click", downloadPng);
  render();
}

function materialById(id) {
  return state.data.materials.find(material => material.id === id);
}

// Selection order is the draw order: first in the list sits at the back, last on top.
function selectedMaterials() {
  return [...state.materials].map(materialById).filter(Boolean);
}

function randomColor() {
  const hue = Math.random() * 360;
  const chroma = 0.52;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const [r, g, b] =
    hue < 60 ? [chroma, x, 0] :
    hue < 120 ? [x, chroma, 0] :
    hue < 180 ? [0, chroma, x] :
    hue < 240 ? [0, x, chroma] :
    hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  const offset = 0.45 - chroma / 2;
  const channel = value => Math.round((value + offset) * 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

// A colour is picked once, at the moment a material is added, and kept from then on.
function selectMaterial(id) {
  state.materials.add(id);
  if (!state.colors[id]) state.colors[id] = randomColor();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function buildMaterialControls() {
  const search = document.getElementById("material-search");
  const options = document.getElementById("material-options");
  const chips = document.getElementById("material-chips");

  function closeOptions() {
    options.hidden = true;
    search.setAttribute("aria-expanded", "false");
  }

  function renderOptions() {
    const query = search.value.trim().toLowerCase();
    const available = state.data.materials.filter(material => !state.materials.has(material.id));
    const matches = available.filter(material =>
      [material.id, material.label, ...(material.aliases ?? [])]
        .some(text => text.toLowerCase().includes(query)));

    options.innerHTML = matches.length
      ? matches.map(material => `
        <li role="option" data-add="${material.id}">
          <span>${escapeHtml(material.label)}</span>
          <small>${escapeHtml((material.aliases ?? [])[0] ?? "")}</small>
        </li>`).join("")
      : `<li class="empty">${available.length ? "No match" : "All materials added"}</li>`;

    options.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }

  function renderChips() {
    chips.innerHTML = [...state.materials].map(id => {
      const material = materialById(id);
      return `
        <li>
          <input type="color" data-color="${id}" value="${state.colors[id]}" aria-label="Colour for ${escapeHtml(material.label)}">
          <span>${escapeHtml(material.label)}</span>
          <button type="button" data-remove="${id}" aria-label="Remove ${escapeHtml(material.label)}">&times;</button>
        </li>`;
    }).join("");
  }

  search.addEventListener("focus", renderOptions);
  search.addEventListener("input", renderOptions);
  search.addEventListener("keydown", event => {
    if (event.key === "Escape") closeOptions();
  });

  options.addEventListener("mousedown", event => {
    const option = event.target.closest("[data-add]");
    if (!option) return;
    event.preventDefault();
    selectMaterial(option.dataset.add);
    search.value = "";
    renderChips();
    renderOptions();
    render();
  });

  chips.addEventListener("click", event => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    state.materials.delete(button.dataset.remove);
    renderChips();
    if (!options.hidden) renderOptions();
    render();
  });

  chips.addEventListener("input", event => {
    const swatch = event.target.closest("[data-color]");
    if (!swatch) return;
    state.colors[swatch.dataset.color] = swatch.value;
    render();
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".picker")) closeOptions();
  });

  renderChips();
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
  if (property.ticks) {
    const ticks = property.ticks;
    if (value <= 0) return 0;
    for (let i = 0; i < ticks.length; i++) {
      const lo = i === 0 ? 0 : ticks[i - 1];
      if (value <= ticks[i]) return clamp((i + (value - lo) / (ticks[i] - lo)) / ticks.length);
    }
    return 1;
  }
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
  if (property.ticks) return property.ticks[ring - 1];
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

  // break marker where a segmented axis jumps scale
  axes.forEach((axisId, i) => {
    const property = state.data.properties[axisId];
    if (property.tick_break) drawAxisBreak(ctx, cx, cy, radius, angles[i], property.tick_break, scale);
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

  // material polygons, drawn back to front in selection order
  selectedMaterials()
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
        // Rotate so drawing starts on a gap; runs that wrap past the last axis
        // are then contiguous and get stroked like any other run.
        const gap = points.findIndex(p => !p);
        const ordered = points.slice(gap).concat(points.slice(0, gap));
        ctx.beginPath();
        let started = false;
        ordered.forEach(p => {
          if (!p) { started = false; return; }
          started ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
          started = true;
        });
        ctx.stroke();
        // a vertex with no available neighbour would otherwise draw nothing at all
        ctx.fillStyle = color;
        points.forEach((p, i) => {
          if (!p) return;
          const prev = points[(i - 1 + points.length) % points.length];
          const next = points[(i + 1) % points.length];
          if (prev || next) return;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5 * scale, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    });

  drawLegend(ctx, cx, height * 0.955, scale);
}

// Cuts the spoke midway between the two rings that jump, then draws the two
// slanted strokes used to denote a broken axis.
function drawAxisBreak(ctx, cx, cy, radius, angle, breakRing, scale) {
  const r = radius * (breakRing + 0.5) / 5;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const px = -uy;
  const py = ux;
  const x = cx + ux * r;
  const y = cy + uy * r;
  const reach = 7 * scale;
  const gap = 6 * scale;
  const lean = 5 * scale;

  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 5 * scale;
  ctx.beginPath();
  ctx.moveTo(x - ux * gap, y - uy * gap);
  ctx.lineTo(x + ux * gap, y + uy * gap);
  ctx.stroke();

  ctx.strokeStyle = "#9aa0a6";
  ctx.lineWidth = 1.7 * scale;
  ctx.lineCap = "round";
  [-gap / 2, gap / 2].forEach(offset => {
    ctx.beginPath();
    ctx.moveTo(x + ux * (offset - lean / 2) - px * reach, y + uy * (offset - lean / 2) - py * reach);
    ctx.lineTo(x + ux * (offset + lean / 2) + px * reach, y + uy * (offset + lean / 2) + py * reach);
    ctx.stroke();
  });
  ctx.restore();
}

function drawLegend(ctx, cx, y, scale) {
  const items = selectedMaterials();
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

function axisNote(property) {
  return [property.note, property.tick_note].filter(Boolean).join(" ");
}

// Calculated estimates and simulations are visually distinct from measurements.
function isCalculated(observation) {
  return observation.calculated === true || observation.simulated === true;
}

function renderTable() {
  const materials = selectedMaterials();
  const order = [];
  const refIndex = {};
  let anySimulated = false;
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
      const calculated = entry.observations.filter(o => o.in_mean !== false).some(isCalculated);
      if (calculated) anySimulated = true;
      const star = calculated ? `<span class="simmark" title="Calculated or simulated, not directly measured">*</span>` : "";
      return `<td>${entry.value}${star}${refs}</td>`;
    }).join("");
    const mark = axisNote(property) ? ` <span class="notemark">&dagger;</span>` : "";
    return `<tr><td>${property.name}${mark}<span class="unit">${property.unit || ""}</span></td>${cells}</tr>`;
  }).join("");

  const head = `<tr><th>Property</th>${materials.map(m => `<th>${m.label}</th>`).join("")}</tr>`;
  document.getElementById("table").innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;

  const notes = Object.values(state.data.properties)
    .filter(axisNote)
    .map(property => `<p><span class="notemark">&dagger;</span> <b>${property.name}.</b> ${escapeHtml(axisNote(property))}</p>`)
    .join("");
  const simNote = anySimulated
    ? `<p><span class="simmark">*</span> <b>Calculated or simulated value.</b> Derived from measured coefficients, ` +
      `an empirical model, Monte Carlo, or first-principles calculations rather than directly measured.</p>`
    : "";
  document.getElementById("axisnotes").innerHTML =
    notes || simNote ? `<h3>How to read these numbers</h3>${notes}${simNote}` : "";

  document.getElementById("refnotes").innerHTML = "<h3>References</h3>" + order.map((referenceId, i) => {
    const r = state.data.references[referenceId];
    const link = r.doi ? `https://doi.org/${r.doi}` : r.url;
    const tail = link
      ? ` <a href="${link}" target="_blank" rel="noreferrer">${link}</a>.`
      : r.isbn ? ` ISBN ${escapeHtml(r.isbn)}.` : "";
    const cited = r.doi || r.url
      ? `${r.authors}. &ldquo;${r.title}.&rdquo; <i>${r.journal}</i> (${r.year}).`
      : `${r.authors}. <i>${r.title}</i>. ${r.journal}, ${r.year}.`;
    return `<p>[${i + 1}] ${cited}${tail}</p>`;
  }).join("");
}

function mathText(text) {
  return escapeHtml(text)
    .replace(/_\{([^}]*)\}/g, "<sub>$1</sub>")
    .replace(/\^\{([^}]*)\}/g, "<sup>$1</sup>")
    .replace(/_([A-Za-z0-9])/g, "<sub>$1</sub>")
    .replace(/\^([A-Za-z0-9])/g, "<sup>$1</sup>");
}

// Terms are written as {symbol} placeholders, or {^symbol} to raise them, so a
// single-letter term can never be matched inside markup an earlier term produced.
// The lookbehind keeps LaTeX-style subscripts such as v_{sat} out of the match.
function renderExpression(expression, displays) {
  const pattern = /(?<![_^])\{(\^?)([A-Za-z0-9_]+)\}/g;
  let html = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(expression)) !== null) {
    html += mathText(expression.slice(last, match.index));
    const term = `<b class="term">${mathText(displays.get(match[2]) ?? match[2])}</b>`;
    html += match[1] === "^" ? `<sup>${term}</sup>` : term;
    last = pattern.lastIndex;
  }
  return html + mathText(expression.slice(last));
}

function renderFunctions() {
  const materials = selectedMaterials();
  const models = state.data.functions ?? {};

  const rows = Object.entries(state.data.properties)
    .filter(([axisId]) => models[axisId])
    .map(([axisId, property]) => {
      const model = models[axisId];
      const displays = new Map(model.terms.map(term => [term.symbol, term.display ?? term.symbol]));
      const expression = renderExpression(model.expression, displays);

      const termRows = model.terms.map((term, index) => {
        const cells = materials.map(material => {
          const coefficients = material.properties[axisId]?.temperature_model?.coefficients;
          const value = coefficients?.[term.symbol];
          return value == null
            ? `<td class="missing">&mdash;</td>`
            : `<td>${formatCoefficient(value)}</td>`;
        }).join("");
        const label = `<td class="term-cell"><b class="term">${mathText(term.display ?? term.symbol)}</b>` +
          `<span class="unit">${escapeHtml(term.unit || "")}</span></td>`;
        return index === 0
          ? `<tr class="first-term"><td rowspan="${model.terms.length}" class="fn-name">` +
            `${escapeHtml(property.name)}<span class="fn-expr">${expression}</span></td>${label}${cells}</tr>`
          : `<tr>${label}${cells}</tr>`;
      }).join("");

      return termRows;
    }).join("");

  const head = `<tr><th>Property</th><th>Term</th>` +
    `${materials.map(m => `<th>${escapeHtml(m.label)}</th>`).join("")}</tr>`;
  document.getElementById("functions-table").innerHTML =
    `<thead>${head}</thead><tbody>${rows}</tbody>`;

  document.getElementById("functions-note").innerHTML =
    `<p>${escapeHtml(models.note ?? "")}</p>`;
}

function formatCoefficient(value) {
  const magnitude = Math.abs(value);
  if (value !== 0 && (magnitude >= 1e4 || magnitude < 1e-3)) {
    const exponent = Math.floor(Math.log10(magnitude));
    const mantissa = value / Math.pow(10, exponent);
    return `${parseFloat(mantissa.toFixed(3))}\u00d710${superscript(exponent)}`;
  }
  return String(value);
}

function buildTabs() {
  const tabs = [
    { tab: "tab-values", panel: "panel-values" },
    { tab: "tab-functions", panel: "panel-functions" },
  ];
  tabs.forEach(({ tab }) => {
    document.getElementById(tab).addEventListener("click", () => {
      tabs.forEach(entry => {
        const active = entry.tab === tab;
        const button = document.getElementById(entry.tab);
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
        document.getElementById(entry.panel).hidden = !active;
      });
    });
  });
}

function render() {
  const canvas = document.getElementById("radar");
  drawRadar(canvas, canvas.width / 1200);
  renderTable();
  renderFunctions();
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
