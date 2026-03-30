#!/usr/bin/env node

const { createCanvas, registerFont } = require("canvas");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const https = require("https");
const readline = require("readline");
const zlib = require("zlib");

// Load .env from script directory
require("dotenv").config({ path: path.join(__dirname, ".env") });

const WIDTH = 296;
const HEIGHT = 152;
const STATUS_DIR = path.join(
  process.env.HOME,
  ".claude",
  "dot-status"
);
const STALE_MS = {
  working: 10 * 60 * 1000, // 10 min — active session should get frequent hook events
  perm:    15 * 60 * 1000, // 15 min — waiting for user, but not forever
  done:     5 * 60 * 1000, // 5 min  — scheduleExpire handles most, this is fallback
};

const FONT_DIR = path.join(__dirname, "fonts");
registerFont(path.join(FONT_DIR, "FiraCode-Medium.ttf"), { family: "FiraCode", weight: "normal" });
registerFont(path.join(FONT_DIR, "FiraCode-Bold.ttf"), { family: "FiraCode", weight: "bold" });
const FONT = '"FiraCode"';

const CONFIG = {
  apiKey: process.env.DOT_API_KEY,
  deviceId: process.env.DOT_DEVICE_ID,
  baseUrl: process.env.DOT_BASE_URL || "https://dot.mindreset.tech",
};

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const CACHE_DIR = path.join(__dirname, ".cache");
const DEFAULT_TIME_ZONE = process.env.TZ || "Asia/Shanghai";
const REQUEST_TIMEOUT_MS = 15000;

// --- Bitmap Font & PNG Encoding (for usage display) ---

const BITMAP_FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  6: ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
};

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function encodeGrayscalePng(width, height, pixels) {
  const scanlineLength = width + 1;
  const raw = Buffer.alloc(scanlineLength * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * scanlineLength;
    raw[rowOffset] = 0;
    pixels.copy(raw, rowOffset + 1, y * width, (y + 1) * width);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", zlib.deflateSync(raw)),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeCanvasToPngBase64(canvas) {
  return encodeGrayscalePng(canvas.width, canvas.height, canvas.pixels).toString("base64");
}

// --- Bitmap Canvas Primitives (for usage display) ---

function createBitmapCanvas(width, height) {
  return {
    width,
    height,
    pixels: Buffer.alloc(width * height, 255),
  };
}

function bitmapSetPixel(canvas, x, y, color = 0) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) {
    return;
  }
  canvas.pixels[y * canvas.width + x] = color;
}

function bitmapFillRect(canvas, x, y, width, height, color = 0) {
  for (let offsetY = 0; offsetY < height; offsetY += 1) {
    for (let offsetX = 0; offsetX < width; offsetX += 1) {
      bitmapSetPixel(canvas, x + offsetX, y + offsetY, color);
    }
  }
}

function bitmapStrokeRect(canvas, x, y, width, height, color = 0) {
  bitmapFillRect(canvas, x, y, width, 1, color);
  bitmapFillRect(canvas, x, y + height - 1, width, 1, color);
  bitmapFillRect(canvas, x, y, 1, height, color);
  bitmapFillRect(canvas, x + width - 1, y, 1, height, color);
}

function bitmapDrawText(canvas, x, y, text, scale = 1, color = 0) {
  let currentX = x;
  const letterSpacing = scale;

  for (const rawChar of String(text).toUpperCase()) {
    const glyph = BITMAP_FONT[rawChar] || BITMAP_FONT[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] !== "1") {
          continue;
        }
        bitmapFillRect(canvas, currentX + column * scale, y + row * scale, scale, scale, color);
      }
    }
    currentX += 5 * scale + letterSpacing;
  }

  return currentX - x - letterSpacing;
}

function bitmapMeasureText(text, scale = 1) {
  if (!text) {
    return 0;
  }
  return String(text).length * (5 * scale + scale) - scale;
}

// --- Bitmap Usage Rendering ---

function bitmapDrawProgressBar(canvas, x, y, width, height, value) {
  bitmapStrokeRect(canvas, x, y, width, height, 0);
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }

  const innerWidth = width - 2;
  const innerHeight = height - 2;
  const clamped = Math.max(0, Math.min(100, value));
  let fillWidth = Math.round((clamped / 100) * innerWidth);
  if (clamped > 0 && fillWidth === 0) {
    fillWidth = 1;
  }
  bitmapFillRect(canvas, x + 1, y + 1, fillWidth, innerHeight, 0);
}

function drawProgressRow(canvas, options) {
  const metricX = 12;
  const barX = 46;
  const barWidth = 186;
  const barHeight = 12;
  const scale = 2;
  const valueText = formatImagePercent(options.value);
  const valueX = WIDTH - 12 - bitmapMeasureText(valueText, scale);

  bitmapDrawText(canvas, metricX, options.y, options.label, scale);
  bitmapDrawProgressBar(canvas, barX, options.y + 1, barWidth, barHeight, options.value);
  bitmapDrawText(canvas, valueX, options.y, valueText, scale);
}

function drawUsageSection(canvas, name, data, topY, now) {
  const headerY = topY + 2;
  drawSectionHeader(canvas, name, formatRemainingDuration(data?.sevenDay?.resetsAt, now), headerY);
  drawProgressRow(canvas, {
    label: "5H",
    value: data?.fiveHour?.utilization,
    y: topY + 17,
  });
  drawProgressRow(canvas, {
    label: "7D",
    value: data?.sevenDay?.utilization,
    y: topY + 36,
  });
}

function drawSectionHeader(canvas, name, resetText, y) {
  const nameX = 12;
  const scale = 1;
  bitmapDrawText(canvas, nameX, y, name, scale);

  const dividerX = nameX + bitmapMeasureText(name, scale) + 8;
  let dividerEndX = WIDTH - 12;
  if (resetText) {
    const resetX = WIDTH - 12 - bitmapMeasureText(resetText, scale);
    bitmapDrawText(canvas, resetX, y, resetText, scale);
    dividerEndX = resetX - 6;
  }
  const dividerY = y + 4;
  const dividerWidth = dividerEndX - dividerX;
  if (dividerWidth > 0) {
    drawDashedLine(canvas, dividerX, dividerY, dividerWidth, 4, 3, 0);
  }
}

function drawDashedLine(canvas, x, y, width, dashWidth = 4, gapWidth = 3, color = 0) {
  for (let offset = 0; offset < width; offset += dashWidth + gapWidth) {
    const currentDashWidth = Math.min(dashWidth, width - offset);
    bitmapFillRect(canvas, x + offset, y, currentDashWidth, 1, color);
  }
}

function formatImagePercent(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(value)}%`;
}

function formatRemainingDuration(resetsAt, now) {
  const resetAtMs = Date.parse(resetsAt || "");
  if (!Number.isFinite(resetAtMs)) {
    return "--";
  }

  const totalMinutes = Math.max(0, Math.ceil((resetAtMs - now.getTime()) / 60000));
  if (totalMinutes < 60) {
    return "1H";
  }

  let days = Math.floor(totalMinutes / (24 * 60));
  let hours = Math.ceil((totalMinutes - days * 24 * 60) / 60);
  if (hours === 24) {
    days += 1;
    hours = 0;
  }

  if (days > 0 && hours > 0) {
    return `${days}D ${hours}H`;
  }
  if (days > 0) {
    return `${days}D`;
  }
  return `${Math.max(1, hours)}H`;
}

function formatDisplayTime(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const mapped = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${mapped.hour}:${mapped.minute}`;
}

function buildUsageImageBase64(codexData, claudeData, now, timeZone) {
  const canvas = createBitmapCanvas(WIDTH, HEIGHT);

  bitmapDrawText(canvas, 12, 10, "AI USAGE", 2);
  const timeText = formatDisplayTime(now, timeZone);
  const timeScale = 1;
  const timeX = WIDTH - 12 - bitmapMeasureText(timeText, timeScale);
  bitmapDrawText(canvas, timeX, 15, timeText, timeScale);

  drawUsageSection(canvas, "CODEX", codexData, 36, now);
  drawUsageSection(canvas, "CLAUDE", claudeData, 94, now);

  return encodeCanvasToPngBase64(canvas);
}

// --- Data Fetching ---

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, text, json };
  } finally {
    clearTimeout(timeout);
  }
}

function discoverOAuthTokenFromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

async function fetchClaudeUsage() {
  // Priority 1: Direct Anthropic OAuth API (env var or auto-discovered from Keychain)
  const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN || discoverOAuthTokenFromKeychain();
  if (oauthToken) {
    return fetchClaudeUsageFromAnthropic(oauthToken);
  }
  // Priority 2: Custom API endpoint (compatible with sub2api etc.)
  const apiUrl = process.env.CLAUDE_USAGE_API_URL;
  const apiKey = process.env.CLAUDE_USAGE_API_KEY;
  if (apiUrl && apiKey) {
    return fetchClaudeUsageFromCustomAPI(apiUrl, apiKey);
  }
  return null;
}

async function fetchClaudeUsageFromAnthropic(token) {
  const res = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (!res.ok || !res.json) return null;
  return normalizeUsageData(res.json);
}

async function fetchClaudeUsageFromCustomAPI(baseUrl, apiKey) {
  const accountId = process.env.CLAUDE_USAGE_ACCOUNT_ID || "1";
  const url = new URL(`/api/v1/admin/accounts/${accountId}/usage`, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  url.searchParams.set("source", "passive");
  url.searchParams.set("timezone", DEFAULT_TIME_ZONE);
  const res = await fetchJson(url, {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok || !res.json) return null;
  const data = res.json.code === 0 ? res.json.data : res.json;
  return normalizeUsageData(data);
}

function normalizeUsageData(data) {
  if (!data) return null;
  const usesCamel = 'fiveHour' in data || 'sevenDay' in data;
  return {
    fiveHour: normalizeWindow(usesCamel ? data.fiveHour : data.five_hour),
    sevenDay: normalizeWindow(usesCamel ? data.sevenDay : data.seven_day),
  };
}

function normalizeWindow(w) {
  if (!w) return null;
  const util = Number(w.utilization ?? w.used_percent);
  if (!Number.isFinite(util)) return null;
  return { utilization: util, resetsAt: w.resets_at || w.resetsAt || null };
}

// --- Codex Usage Scanning ---

async function walkJsonlFiles(rootDir) {
  const files = [];

  if (!fs.existsSync(rootDir)) {
    return files;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

async function scanJsonlFileForLatestTokenCount(filePath, best) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let currentBest = best;
  let lineNumber = 0;

  try {
    for await (const line of rl) {
      lineNumber += 1;
      if (!line) {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed?.type !== "event_msg" || parsed?.payload?.type !== "token_count") {
        continue;
      }

      const timestamp = parsed.timestamp;
      const timestampMs = Date.parse(timestamp);
      if (!Number.isFinite(timestampMs)) {
        continue;
      }

      if (!currentBest || timestampMs > currentBest.timestampMs) {
        currentBest = {
          filePath,
          lineNumber,
          timestamp,
          timestampMs,
          event: parsed,
        };
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return currentBest;
}

async function findLatestCodexSnapshot(rootDir = CODEX_SESSIONS_DIR) {
  const files = await walkJsonlFiles(rootDir);
  let best = null;

  for (const filePath of files) {
    best = await scanJsonlFileForLatestTokenCount(filePath, best);
  }

  if (!best) {
    throw new Error("No Codex token_count event found");
  }

  return best;
}

function mapCodexWindows(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const result = { fiveHour: null, sevenDay: null };
  for (const key of ["primary", "secondary"]) {
    const item = rateLimits[key];
    if (!item) continue;
    const minutes = Number(item.window_minutes);
    const util = Number(item.used_percent);
    if (!Number.isFinite(util)) continue;
    const norm = { utilization: util, resetsAt: item.resets_at ? new Date(item.resets_at * 1000).toISOString() : null };
    if (minutes === 300) result.fiveHour = norm;
    if (minutes === 10080) result.sevenDay = norm;
  }
  return (result.fiveHour || result.sevenDay) ? result : null;
}

async function fetchCodexUsage() {
  try {
    const snapshot = await findLatestCodexSnapshot();
    return mapCodexWindows(snapshot.event?.payload?.rate_limits);
  } catch { return null; }
}

async function fetchAllUsage() {
  const [claude, codex] = await Promise.all([
    fetchClaudeUsage().catch(() => null),
    fetchCodexUsage().catch(() => null),
  ]);
  return { claude, codex };
}

// --- Status Management ---

function ensureStatusDir() {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
}

function readAllSessions() {
  ensureStatusDir();
  const files = fs.readdirSync(STATUS_DIR).filter((f) => f.endsWith(".json"));
  const now = Date.now();
  const sessions = [];

  for (const file of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(STATUS_DIR, file), "utf8")
      );
      // Clean up invalid sessions
      const ageMs = now - new Date(data.updated).getTime();
      const threshold = STALE_MS[data.status] || STALE_MS.working;
      if (ageMs > threshold || !fs.existsSync(data.cwd)) {
        fs.unlinkSync(path.join(STATUS_DIR, file));
        continue;
      }
      sessions.push(data);
    } catch {
      // Corrupted file, remove
      try { fs.unlinkSync(path.join(STATUS_DIR, file)); } catch {}
    }
  }

  // Sort: done first (needs attention), then perm, then working
  const order = { done: 0, perm: 1, working: 2 };
  sessions.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return sessions;
}

function updateSession(sessionId, cwd, status) {
  ensureStatusDir();
  const filePath = path.join(STATUS_DIR, `${sessionId}.json`);

  // Debounce: skip render if working→working, but keep timestamp fresh
  if (status === "working") {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (existing.status === "working") {
        existing.updated = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(existing));
        return false;
      }
    } catch {}
  }

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      sessionId,
      cwd,
      status,
      updated: new Date().toISOString(),
    })
  );
  return true;
}

function removeSession(sessionId) {
  const filePath = path.join(STATUS_DIR, `${sessionId}.json`);
  try { fs.unlinkSync(filePath); } catch {}
}

// --- Rendering ---

function abbreviate(cwdPath, maxLen = 12) {
  const name = path.basename(cwdPath);
  return name.length > maxLen ? name.slice(0, maxLen - 1) + "…" : name;
}


function renderPNG(sessions) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  if (sessions.length === 0) {
    // Should not be reached — usage display handles empty state
    return canvas.toBuffer("image/png");
  }

  const PX = 10;
  const ICON_X = WIDTH - 18;  // right side for icon, symmetric with PX
  const ROW_H = 44;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const y = i * ROW_H;
    const cy = y + ROW_H / 2;
    const proj = abbreviate(s.cwd, 18);
    ctx.textBaseline = "middle";

    if (s.status === "done") {
      // DONE: inverted row + checkmark
      ctx.fillStyle = "#000";
      ctx.fillRect(0, y, WIDTH, ROW_H);
      ctx.fillStyle = "#fff";
      ctx.font = `bold 18px ${FONT}`;
      ctx.fillText(proj, PX, cy);
      drawCheck(ctx, ICON_X, cy, "#fff");

    } else if (s.status === "perm") {
      // PERM: bold + exclamation circle
      ctx.fillStyle = "#000";
      ctx.font = `bold 18px ${FONT}`;
      ctx.fillText(proj, PX, cy);
      drawAlert(ctx, ICON_X, cy, "#000");

    } else {
      // RUN: normal + spinning dots
      ctx.fillStyle = "#000";
      ctx.font = `18px ${FONT}`;
      ctx.fillText(proj, PX, cy);
      drawSpinner(ctx, ICON_X, cy, "#000");
    }
  }

  // Small timestamp bottom-right
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  ctx.fillStyle = "#000";
  ctx.font = `12px ${FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(ts, WIDTH - PX, HEIGHT - 3);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}

// ── Status Icons (drawn as canvas paths) ──

function drawCheck(ctx, x, y, color) {
  // SF Symbols: checkmark.circle
  const r = 9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  // Checkmark inside
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x - 4, y);
  ctx.lineTo(x - 1, y + 4);
  ctx.lineTo(x + 5, y - 4);
  ctx.stroke();
}

function drawAlert(ctx, x, y, color) {
  // SF Symbols: exclamationmark.triangle
  const h = 18, w = 20;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x, y - h / 2 + 1);
  ctx.lineTo(x - w / 2, y + h / 2 - 1);
  ctx.lineTo(x + w / 2, y + h / 2 - 1);
  ctx.closePath();
  ctx.stroke();
  // Exclamation line
  ctx.lineCap = "round";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(x, y - 3);
  ctx.lineTo(x, y + 3);
  ctx.stroke();
  // Dot
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y + 6, 1.3, 0, Math.PI * 2);
  ctx.fill();
}

function drawSpinner(ctx, x, y, color) {
  // iOS-style arc spinner: 3/4 arc that fades from opaque to transparent
  const r = 7;
  const lineW = 2.5;
  const steps = 32;
  const startAngle = -Math.PI / 2;
  const totalArc = Math.PI * 1.5; // 3/4 circle
  const cr = parseInt(color.slice(1, 3) || "00", 16);
  const cg = parseInt(color.slice(3, 5) || "00", 16);
  const cb = parseInt(color.slice(5, 7) || "00", 16);
  ctx.lineCap = "round";
  ctx.lineWidth = lineW;
  for (let i = 0; i < steps; i++) {
    const a0 = startAngle + (i / steps) * totalArc;
    const a1 = startAngle + ((i + 1) / steps) * totalArc;
    const opacity = (i / steps);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${opacity})`;
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a1);
    ctx.stroke();
  }
}


// --- Dot API ---

async function pushToDot(imageData) {
  const base64 = Buffer.isBuffer(imageData) ? imageData.toString("base64") : imageData;
  const body = JSON.stringify({
    image: base64,
    refreshNow: true,
    ditherType: "DIFFUSION",
    ditherKernel: "ATKINSON",
    border: 1,
  });

  const url = new URL(
    `/api/authV2/open/device/${CONFIG.deviceId}/image`,
    CONFIG.baseUrl
  );

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Dot API ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- Hook Event Handler ---

function mapEventToStatus(eventName) {
  switch (eventName) {
    case "PreToolUse":
    case "PostToolUse":
    case "UserPromptSubmit":
      return "working";
    case "Notification":
      return "perm"; // only permission_prompt via matcher
    case "Stop":
      return "done";
    case "SessionEnd":
      return null; // remove
    default:
      return "working";
  }
}

const DONE_EXPIRE_SEC = 180; // 3 minutes

function scheduleExpire(sessionId) {
  const child = spawn("bash", [
    "-c",
    `sleep ${DONE_EXPIRE_SEC} && node "${__filename}" --expire "${sessionId}"`,
  ], { detached: true, stdio: "ignore" });
  child.unref();
}

async function handleExpire(sessionId) {
  const filePath = path.join(STATUS_DIR, `${sessionId}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if ((data.status === "done" || data.status === "perm") &&
        Date.now() - new Date(data.updated).getTime() > (DONE_EXPIRE_SEC - 10) * 1000) {
      fs.unlinkSync(filePath);
      const sessions = readAllSessions();
      if (sessions.length === 0) {
        // No sessions left, switch to usage display
        try {
          const usage = await fetchAllUsage();
          const usageBase64 = buildUsageImageBase64(usage.codex, usage.claude, new Date(), DEFAULT_TIME_ZONE);
          await pushToDot(usageBase64);
        } catch {}
      } else {
        const png = renderPNG(sessions);
        await pushToDot(png);
      }
    }
  } catch {}
}

async function handleHookEvent(event) {
  const { session_id, cwd, hook_event_name } = event;
  if (!session_id) return;

  const status = mapEventToStatus(hook_event_name);

  if (status === null) {
    removeSession(session_id);
    const remaining = readAllSessions();
    if (remaining.length === 0) {
      // No sessions left, switch to usage display
      try {
        const usage = await fetchAllUsage();
        const usageBase64 = buildUsageImageBase64(usage.codex, usage.claude, new Date(), DEFAULT_TIME_ZONE);
        await pushToDot(usageBase64);
      } catch {}
      return;
    }
  } else {
    const changed = updateSession(session_id, cwd || "unknown", status);
    if (!changed) return; // debounced
    // Schedule auto-expire for done/waiting
    if (status === "done" || status === "perm") {
      scheduleExpire(session_id);
    }
  }

  const sessions = readAllSessions();
  const png = renderPNG(sessions);
  await pushToDot(png);
}

// --- Test Mode ---

const TEST_CASES = {
  mix: [
    { sessionId: "a1", cwd: "/Users/test/workspace/dot-ai-monitor", status: "working", updated: new Date().toISOString() },
    { sessionId: "b2", cwd: "/Users/test/workspace/my-api-server", status: "perm", updated: new Date().toISOString() },
    { sessionId: "c3", cwd: "/Users/test/workspace/tests", status: "done", updated: new Date().toISOString() },
  ],
  "all-run": [
    { sessionId: "a1", cwd: "/Users/test/workspace/dot-ai-monitor", status: "working", updated: new Date().toISOString() },
    { sessionId: "b2", cwd: "/Users/test/workspace/poly-edge-lab", status: "working", updated: new Date().toISOString() },
  ],
  "all-done": [
    { sessionId: "a1", cwd: "/Users/test/workspace/dot-ai-monitor", status: "done", updated: new Date().toISOString() },
    { sessionId: "b2", cwd: "/Users/test/workspace/my-api-server", status: "done", updated: new Date().toISOString() },
    { sessionId: "c3", cwd: "/Users/test/workspace/poly-edge-lab", status: "done", updated: new Date().toISOString() },
  ],
  single: [
    { sessionId: "a1", cwd: "/Users/test/workspace/dot-ai-monitor", status: "done", updated: new Date().toISOString() },
  ],
  empty: [],
};

async function runTest(caseName) {
  const name = caseName || "mix";

  if (name === "usage") {
    const usage = await fetchAllUsage();
    const base64 = buildUsageImageBase64(usage.codex, usage.claude, new Date(), DEFAULT_TIME_ZONE);
    const pngBuf = Buffer.from(base64, "base64");
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const usageFile = path.join(CACHE_DIR, "test-usage.png");
    fs.writeFileSync(usageFile, pngBuf);
    console.log(`Saved ${usageFile}`);
    try {
      await pushToDot(base64);
      console.log("Pushed usage to Dot");
    } catch (err) {
      console.error("Push failed:", err.message);
    }
    return;
  }

  const testSessions = TEST_CASES[name];
  if (!testSessions) {
    console.log("Cases:", Object.keys(TEST_CASES).join(", ") + ", usage");
    return;
  }

  console.log(`Test: ${name} (${testSessions.length} sessions)`);
  const png = renderPNG(testSessions);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `test-${name}.png`);
  fs.writeFileSync(file, png);
  console.log(`Saved ${file}`);

  try {
    const result = await pushToDot(png);
    console.log("Pushed:", result.message);
  } catch (err) {
    console.error("Push failed:", err.message);
  }
}

// --- Main ---

async function main() {
  const testIdx = process.argv.indexOf("--test");
  if (testIdx !== -1) {
    return runTest(process.argv[testIdx + 1]);
  }

  // Expire mode: delayed cleanup of done/waiting sessions
  const expireIdx = process.argv.indexOf("--expire");
  if (expireIdx !== -1) {
    const sid = process.argv[expireIdx + 1];
    if (sid) return handleExpire(sid);
    return;
  }

  // Usage mode: show usage when no active sessions
  if (process.argv.includes("--usage")) {
    const sessions = readAllSessions();
    const now = new Date();
    const status = { lastRunAt: now.toISOString(), activeSessions: sessions.length };
    if (sessions.length > 0) {
      status.result = "skipped";
      status.reason = "active sessions exist";
    } else {
      try {
        const usage = await fetchAllUsage();
        const base64 = buildUsageImageBase64(usage.codex, usage.claude, now, DEFAULT_TIME_ZONE);
        await pushToDot(base64);
        status.result = "pushed";
      } catch (err) {
        status.result = "error";
        status.error = err.message;
      }
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, "last_usage_push.json"), JSON.stringify(status, null, 2));
    return;
  }

  // Read hook event from stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) return;

  try {
    const event = JSON.parse(input);
    await handleHookEvent(event);
  } catch (err) {
    // Silent fail for hooks - don't interfere with Claude
    process.stderr.write(`dot-notify error: ${err.message}\n`);
  }
}

main();
