#!/usr/bin/env node

const { spawn, spawnSync, execSync } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const https = require("https");
const readline = require("readline");
const zlib = require("zlib");

// Optional: canvas for font-based fallback rendering of unknown characters
let canvasModule = null;
try { canvasModule = require("canvas"); } catch {}
// System fonts with CJK support (no bundling needed)
const FALLBACK_FONT = '"PingFang SC", "Noto Sans CJK SC", "Hiragino Sans", "Microsoft YaHei", sans-serif';

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


const CONFIG = {
  apiKey: process.env.DOT_API_KEY,
  deviceId: process.env.DOT_DEVICE_ID,
  baseUrl: process.env.DOT_BASE_URL || "https://dot.mindreset.tech",
};

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_RUNTIME_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const CACHE_DIR = process.env.DOT_MONITOR_CACHE_DIR || path.join(__dirname, ".cache");
const LAST_RENDER_STATE_FILE = path.join(CACHE_DIR, "last_render_state.json");
const DEFAULT_TIME_ZONE = process.env.TZ || "Asia/Shanghai";
const REQUEST_TIMEOUT_MS = 15000;
const WORKING_REFRESH_MS = 60 * 1000;

// --- Bitmap Font & PNG Encoding (for usage display) ---

const BITMAP_FONT = {
  // Fallback glyph for unknown characters (□ hollow box)
  "\x00": ["11111", "10001", "10001", "10001", "10001", "10001", "11111"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  '"': ["01010", "01010", "00000", "00000", "00000", "00000", "00000"],
  "#": ["01010", "11111", "01010", "01010", "01010", "11111", "01010"],
  "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"],
  "'": ["00100", "00100", "00000", "00000", "00000", "00000", "00000"],
  "(": ["00010", "00100", "00100", "00100", "00100", "00100", "00010"],
  ")": ["01000", "00100", "00100", "00100", "00100", "00100", "01000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  ",": ["00000", "00000", "00000", "00000", "00000", "00100", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00000", "00100"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ";": ["00000", "00100", "00100", "00000", "00100", "00100", "01000"],
  "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00110", "00100", "00000", "00100"],
  "@": ["01110", "10001", "10111", "10101", "10110", "10000", "01110"],
  "[": ["00110", "00100", "00100", "00100", "00100", "00100", "00110"],
  "]": ["01100", "00100", "00100", "00100", "00100", "00100", "01100"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "~": ["00000", "00000", "01000", "10101", "00010", "00000", "00000"],
  // Digits
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
  // Uppercase
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00001", "00001", "00001", "00001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10101", "10011", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  // Lowercase
  a: ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
  b: ["10000", "10000", "11110", "10001", "10001", "10001", "11110"],
  c: ["00000", "00000", "01110", "10000", "10000", "10000", "01110"],
  d: ["00001", "00001", "01111", "10001", "10001", "10001", "01111"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
  f: ["00110", "01000", "01000", "11100", "01000", "01000", "01000"],
  g: ["00000", "00000", "01111", "10001", "10001", "01111", "01110"],
  h: ["10000", "10000", "10110", "11001", "10001", "10001", "10001"],
  i: ["00100", "00000", "01100", "00100", "00100", "00100", "01110"],
  j: ["00010", "00000", "00010", "00010", "00010", "10010", "01100"],
  k: ["10000", "10000", "10010", "10100", "11000", "10100", "10010"],
  l: ["01100", "00100", "00100", "00100", "00100", "00100", "01110"],
  m: ["00000", "00000", "11010", "10101", "10101", "10101", "10001"],
  n: ["00000", "00000", "10110", "11001", "10001", "10001", "10001"],
  o: ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
  p: ["00000", "00000", "11110", "10001", "10001", "11110", "10000"],
  q: ["00000", "00000", "01111", "10001", "10001", "01111", "00001"],
  r: ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
  s: ["00000", "00000", "01110", "10000", "01110", "00001", "11110"],
  t: ["00100", "00100", "01110", "00100", "00100", "00100", "00011"],
  u: ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
  v: ["00000", "00000", "10001", "10001", "10001", "01010", "00100"],
  w: ["00000", "00000", "10001", "10101", "10101", "10101", "01010"],
  x: ["00000", "00000", "10001", "01010", "00100", "01010", "10001"],
  y: ["00000", "00000", "10001", "10001", "01111", "00001", "01110"],
  z: ["00000", "00000", "11111", "00010", "00100", "01000", "11111"],
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

// Cache for font-rendered glyphs (unknown chars rendered via canvas)
const fontGlyphCache = new Map();

// Detect if a character is full-width (CJK, emoji, etc.)
function isFullWidth(char) {
  const cp = char.codePointAt(0);
  if (cp > 0xffff) return true; // surrogate pairs (emoji, etc.)
  if (cp >= 0x1100 && cp <= 0x115f) return true; // Hangul Jamo
  if (cp >= 0x2e80 && cp <= 0x9fff) return true; // CJK
  if (cp >= 0xac00 && cp <= 0xd7af) return true; // Hangul Syllables
  if (cp >= 0xf900 && cp <= 0xfaff) return true; // CJK Compatibility
  if (cp >= 0xfe30 && cp <= 0xfe6f) return true; // CJK Compatibility Forms
  if (cp >= 0xff01 && cp <= 0xff60) return true; // Fullwidth Forms
  return false;
}

// Render unknown char via canvas font at high resolution, then area-sample
// down to target pixel size. Area sampling preserves thin strokes that
// point sampling would miss.
// Returns { rows: string[], preScaled: true } or null
function renderGlyphViaFont(char, scale) {
  const cacheKey = `${char}:${scale}`;
  if (fontGlyphCache.has(cacheKey)) return fontGlyphCache.get(cacheKey);
  if (!canvasModule) return null;

  // Render at 4x target size for quality area sampling
  const targetH = 7 * scale;
  const superScale = 4;
  const fontSize = targetH * superScale;
  const cw = Math.ceil(fontSize * 1.2);
  const ch = Math.ceil(fontSize * 1.3);
  const cvs = canvasModule.createCanvas(cw, ch);
  const ctx = cvs.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = "#000";
  ctx.font = `${fontSize}px ${FALLBACK_FONT}`;
  ctx.textBaseline = "bottom";
  ctx.fillText(char, 1, ch - 1);

  // Find bounding box
  const imgData = ctx.getImageData(0, 0, cw, ch).data;
  let minX = cw, maxX = 0, minY = ch, maxY = 0;
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      if (imgData[(py * cw + px) * 4] < 128) {
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
  }
  if (minX > maxX) {
    fontGlyphCache.set(cacheKey, null);
    return null;
  }

  // Scale ink region to targetH, preserving aspect ratio
  const inkW = maxX - minX + 1;
  const inkH = maxY - minY + 1;
  const outH = targetH;
  const outW = Math.round(inkW * (targetH / inkH));

  // Area sampling: for each output pixel, check if any source pixel
  // in the corresponding region is dark. Preserves thin strokes.
  const rows = [];
  for (let oy = 0; oy < outH; oy++) {
    let bits = "";
    const sy0 = minY + Math.floor(oy * inkH / outH);
    const sy1 = minY + Math.floor((oy + 1) * inkH / outH);
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = minX + Math.floor(ox * inkW / outW);
      const sx1 = minX + Math.floor((ox + 1) * inkW / outW);
      // Count dark pixels in this cell
      let dark = 0, total = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          total++;
          if (imgData[(sy * cw + sx) * 4] < 128) dark++;
        }
      }
      // Mark as ink if >=15% of area is dark (low threshold to keep strokes)
      bits += (total > 0 && dark / total >= 0.15) ? "1" : "0";
    }
    rows.push(bits);
  }

  const result = { rows, preScaled: true };
  fontGlyphCache.set(cacheKey, result);
  return result;
}

function bitmapDrawText(canvas, x, y, text, scale = 1, color = 0) {
  let currentX = x;
  const letterSpacing = scale;

  for (const rawChar of String(text)) {
    const builtIn = BITMAP_FONT[rawChar];
    if (builtIn) {
      // Built-in glyph: draw at requested scale
      for (let row = 0; row < builtIn.length; row++) {
        for (let col = 0; col < builtIn[row].length; col++) {
          if (builtIn[row][col] === "1") {
            bitmapFillRect(canvas, currentX + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
      currentX += 5 * scale + letterSpacing;
    } else {
      // Font-rendered glyph: already at pixel size, draw at scale=1
      const fontGlyph = renderGlyphViaFont(rawChar, scale);
      if (fontGlyph) {
        const { rows } = fontGlyph;
        for (let row = 0; row < rows.length; row++) {
          for (let col = 0; col < rows[row].length; col++) {
            if (rows[row][col] === "1") {
              bitmapSetPixel(canvas, currentX + col, y + row, color);
            }
          }
        }
        currentX += rows[0].length + letterSpacing;
      } else {
        // No canvas, draw fallback box
        const fb = BITMAP_FONT["\x00"];
        for (let row = 0; row < fb.length; row++) {
          for (let col = 0; col < fb[row].length; col++) {
            if (fb[row][col] === "1") {
              bitmapFillRect(canvas, currentX + col * scale, y + row * scale, scale, scale, color);
            }
          }
        }
        currentX += 5 * scale + letterSpacing;
      }
    }
  }

  return currentX - x - letterSpacing;
}

function bitmapMeasureText(text, scale = 1) {
  if (!text) {
    return 0;
  }
  const letterSpacing = scale;
  let width = 0;
  for (const rawChar of String(text)) {
    if (width > 0) width += letterSpacing;
    if (BITMAP_FONT[rawChar]) {
      width += 5 * scale;
    } else {
      const fontGlyph = renderGlyphViaFont(rawChar, scale);
      width += fontGlyph ? fontGlyph.rows[0].length : 5 * scale;
    }
  }
  return width;
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

function hasUsableCwdString(value) {
  return typeof value === "string" && value.trim() && value !== "unknown";
}

function isExistingDirectory(dirPath) {
  if (!hasUsableCwdString(dirPath)) {
    return false;
  }
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function lookupClaudeRuntimeSessionCwd(sessionId) {
  if (!sessionId || !fs.existsSync(CLAUDE_RUNTIME_SESSIONS_DIR)) {
    return null;
  }

  const files = fs.readdirSync(CLAUDE_RUNTIME_SESSIONS_DIR).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CLAUDE_RUNTIME_SESSIONS_DIR, file), "utf8"));
      if (data?.sessionId === sessionId && isExistingDirectory(data.cwd)) {
        return data.cwd;
      }
    } catch {}
  }

  return null;
}

function appendHookDebugLog(record) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.appendFileSync(path.join(CACHE_DIR, "hook_event_debug.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {}
}

function readLastRenderState() {
  try {
    return JSON.parse(fs.readFileSync(LAST_RENDER_STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeLastRenderState(state) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(LAST_RENDER_STATE_FILE, JSON.stringify({
      ...state,
      pushedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

function buildSessionRenderState(sessions) {
  return {
    mode: "sessions",
    key: JSON.stringify(
      sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        status: session.status,
      }))
    ),
  };
}

function buildUsageRenderState(usage) {
  return {
    mode: "usage",
    key: JSON.stringify({
      codex: usage?.codex || null,
      claude: usage?.claude || null,
    }),
  };
}

function shouldPushRenderState(nextState, maxAgeMs = 0) {
  const lastState = readLastRenderState();
  if (!lastState) {
    return true;
  }

  if (lastState.mode !== nextState.mode || lastState.key !== nextState.key) {
    return true;
  }

  if (!maxAgeMs) {
    return false;
  }

  const pushedAtMs = Date.parse(lastState.pushedAt || "");
  if (!Number.isFinite(pushedAtMs)) {
    return true;
  }

  return Date.now() - pushedAtMs >= maxAgeMs;
}

async function pushUsageDisplay(usage, options = {}) {
  const state = buildUsageRenderState(usage);
  if (!options.force && !shouldPushRenderState(state, options.maxAgeMs || 0)) {
    return false;
  }

  const usageBase64 = buildUsageImageBase64(usage.codex, usage.claude, new Date(), DEFAULT_TIME_ZONE);
  await pushToDot(usageBase64);
  writeLastRenderState(state);
  return true;
}

async function pushSessionsDisplay(sessions, options = {}) {
  const state = buildSessionRenderState(sessions);
  if (!options.force && !shouldPushRenderState(state, options.maxAgeMs || 0)) {
    return false;
  }

  const png = renderPNG(sessions);
  await pushToDot(png);
  writeLastRenderState(state);
  return true;
}

function resolveSessionCwd(sessionId, incomingCwd, existingCwd) {
  if (isExistingDirectory(incomingCwd)) {
    return { cwd: incomingCwd, source: "event.cwd" };
  }

  if (isExistingDirectory(process.env.CLAUDE_PROJECT_DIR)) {
    return { cwd: process.env.CLAUDE_PROJECT_DIR, source: "env.CLAUDE_PROJECT_DIR" };
  }

  if (hasUsableCwdString(existingCwd)) {
    return { cwd: existingCwd, source: "session-cache" };
  }

  const runtimeSessionCwd = lookupClaudeRuntimeSessionCwd(sessionId);
  if (runtimeSessionCwd) {
    return { cwd: runtimeSessionCwd, source: "claude-runtime-session" };
  }

  return { cwd: "unknown", source: "unknown" };
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
      const hasKnownCwd = hasUsableCwdString(data.cwd);
      if (ageMs > threshold || (hasKnownCwd && !fs.existsSync(data.cwd))) {
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
  let existing = null;

  try {
    existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {}

  const resolved = resolveSessionCwd(sessionId, cwd, existing?.cwd);

  if (!hasUsableCwdString(cwd) || cwd === "unknown") {
    appendHookDebugLog({
      timestamp: new Date().toISOString(),
      sessionId,
      hookStatus: status,
      cwdSource: resolved.source,
      resolvedCwd: resolved.cwd,
      claudeProjectDir: process.env.CLAUDE_PROJECT_DIR || null,
    });
  }

  // Debounce: skip render if working→working, but keep timestamp fresh
  if (status === "working") {
    if (existing?.status === "working") {
      existing.cwd = resolved.cwd;
      existing.updated = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(existing));
      return false;
    }
  }

  fs.writeFileSync(
    filePath,
    JSON.stringify({
      sessionId,
      cwd: resolved.cwd,
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
  return name.length > maxLen ? name.slice(0, maxLen - 2) + ".." : name;
}


function renderPNG(sessions) {
  const canvas = createBitmapCanvas(WIDTH, HEIGHT);

  if (sessions.length === 0) {
    return encodeGrayscalePng(WIDTH, HEIGHT, canvas.pixels);
  }

  const PX = 10;
  const ICON_X = WIDTH - 24;
  const ROW_H = 44;
  const SCALE = 2; // 5×7 font at 2x = 10×14 effective

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const y = i * ROW_H;
    const textY = y + Math.floor((ROW_H - 7 * SCALE) / 2);
    const proj = abbreviate(s.cwd, 18);

    if (s.status === "done") {
      // DONE: inverted row + checkmark
      bitmapFillRect(canvas, 0, y, WIDTH, ROW_H, 0);
      bitmapDrawText(canvas, PX, textY, proj, SCALE, 255);
      bitmapDrawCheck(canvas, ICON_X, y + Math.floor(ROW_H / 2), 255);
    } else if (s.status === "perm") {
      // PERM: bold text + alert triangle
      bitmapDrawText(canvas, PX, textY, proj, SCALE, 0);
      bitmapDrawAlert(canvas, ICON_X, y + Math.floor(ROW_H / 2), 0);
    } else {
      // RUN: normal text + spinner
      bitmapDrawText(canvas, PX, textY, proj, SCALE, 0);
      bitmapDrawSpinner(canvas, ICON_X, y + Math.floor(ROW_H / 2), 0);
    }
  }

  // Small timestamp bottom-right
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const tsWidth = bitmapMeasureText(ts, 1);
  bitmapDrawText(canvas, WIDTH - PX - tsWidth, HEIGHT - 10, ts, 1, 0);

  return encodeGrayscalePng(WIDTH, HEIGHT, canvas.pixels);
}

// ── Status Icons (bitmap pixel art) ──

// Bresenham circle outline
function bitmapDrawCircle(canvas, cx, cy, r, color) {
  let x = r;
  let y = 0;
  let d = 1 - r;
  while (x >= y) {
    bitmapSetPixel(canvas, cx + x, cy + y, color);
    bitmapSetPixel(canvas, cx - x, cy + y, color);
    bitmapSetPixel(canvas, cx + x, cy - y, color);
    bitmapSetPixel(canvas, cx - x, cy - y, color);
    bitmapSetPixel(canvas, cx + y, cy + x, color);
    bitmapSetPixel(canvas, cx - y, cy + x, color);
    bitmapSetPixel(canvas, cx + y, cy - x, color);
    bitmapSetPixel(canvas, cx - y, cy - x, color);
    y++;
    if (d < 0) {
      d += 2 * y + 1;
    } else {
      x--;
      d += 2 * (y - x) + 1;
    }
  }
}

function bitmapDrawCheck(canvas, x, cy, color) {
  // Circle with checkmark, ~18px diameter
  bitmapDrawCircle(canvas, x, cy, 8, color);
  // Checkmark: short arm down-right, long arm up-right
  const pts = [
    [-4, 0], [-3, 1], [-2, 2], [-1, 3],
    [0, 2], [1, 1], [2, 0], [3, -1], [4, -2], [5, -3],
  ];
  for (const [dx, dy] of pts) {
    bitmapSetPixel(canvas, x + dx, cy + dy, color);
    bitmapSetPixel(canvas, x + dx, cy + dy + 1, color);
  }
}

function bitmapDrawAlert(canvas, x, cy, color) {
  // Triangle: 18px tall, 20px wide
  const top = cy - 8;
  const bot = cy + 8;
  const halfW = 9;
  // Draw triangle outline
  for (let row = 0; row <= bot - top; row++) {
    const y = top + row;
    const progress = row / (bot - top);
    const left = Math.round(x - halfW * progress);
    const right = Math.round(x + halfW * progress);
    bitmapSetPixel(canvas, left, y, color);
    bitmapSetPixel(canvas, right, y, color);
    if (row === bot - top) {
      // Bottom edge
      for (let px = left; px <= right; px++) {
        bitmapSetPixel(canvas, px, y, color);
      }
    }
  }
  // Exclamation mark
  for (let dy = -3; dy <= 2; dy++) {
    bitmapSetPixel(canvas, x, cy + dy, color);
  }
  bitmapSetPixel(canvas, x, cy + 5, color);
}

function bitmapDrawSpinner(canvas, x, cy, color) {
  // 3/4 arc using circle points, gap at top
  const r = 7;
  const points = [];
  // Collect circle points
  let px = r, py = 0, d = 1 - r;
  while (px >= py) {
    points.push([px, py], [-px, py], [px, -py], [-px, -py]);
    points.push([py, px], [-py, px], [py, -px], [-py, -px]);
    py++;
    if (d < 0) { d += 2 * py + 1; } else { px--; d += 2 * (py - px) + 1; }
  }
  // Draw points except those in the top-right quadrant gap (angle -90° to -10°)
  for (const [dx, dy] of points) {
    const angle = Math.atan2(dy, dx);
    // Skip gap from about -90° to 0° (top-right quarter)
    if (angle >= -Math.PI / 2 && angle <= 0) continue;
    bitmapSetPixel(canvas, x + dx, cy + dy, color);
  }
}


// --- Dot API ---

async function pushToDot(imageData) {
  const base64 = Buffer.isBuffer(imageData) ? imageData.toString("base64") : imageData;
  const body = JSON.stringify({
    image: base64,
    refreshNow: true,
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
          await pushUsageDisplay(usage, { force: true });
        } catch {}
      } else {
        await pushSessionsDisplay(sessions, { force: true });
      }
    }
  } catch {}
}

async function pushCurrentDisplay(options = {}) {
  const sessions = readAllSessions();
  if (sessions.length === 0) {
    const usage = await fetchAllUsage();
    await pushUsageDisplay(usage, options);
    return;
  }

  await pushSessionsDisplay(sessions, options);
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
        await pushUsageDisplay(usage, { force: true });
      } catch {}
      return;
    }
  } else {
    const changed = updateSession(session_id, cwd || "unknown", status);
    if (!changed) {
      await pushCurrentDisplay({ maxAgeMs: WORKING_REFRESH_MS });
      return;
    }
    // Schedule auto-expire for done/waiting
    if (status === "done" || status === "perm") {
      scheduleExpire(session_id);
    }
  }

  await pushCurrentDisplay({ force: true });
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

  if (name === "hook-fallback") {
    return runHookFallbackTests();
  }

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
      writeLastRenderState({ mode: "test", key: `usage:${new Date().toISOString()}` });
      console.log("Pushed usage to Dot");
    } catch (err) {
      console.error("Push failed:", err.message);
    }
    return;
  }

  if (name === "refresh") {
    await pushCurrentDisplay({ force: true });
    console.log("Refreshed Dot with current state");
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
    writeLastRenderState({ mode: "test", key: `sessions:${name}:${new Date().toISOString()}` });
    console.log("Pushed:", result.message);
  } catch (err) {
    console.error("Push failed:", err.message);
  }
}

function runHookFallbackTests() {
  const baseDir = __dirname;
  const expectedCwd = baseDir;
  const cases = [
    {
      name: "env-project-dir",
      event: { session_id: "hook-env", hook_event_name: "PreToolUse" },
      env: { CLAUDE_PROJECT_DIR: expectedCwd },
      expectedCwd,
    },
    {
      name: "runtime-session",
      event: { session_id: "hook-runtime", hook_event_name: "PreToolUse" },
      setup(tempHome) {
        const runtimeDir = path.join(tempHome, ".claude", "sessions");
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(
          path.join(runtimeDir, "123.json"),
          JSON.stringify({
            pid: 123,
            sessionId: "hook-runtime",
            cwd: expectedCwd,
            startedAt: Date.now(),
          })
        );
      },
      expectedCwd,
    },
    {
      name: "session-cache",
      event: { session_id: "hook-cache", hook_event_name: "PostToolUse" },
      setup(tempHome) {
        const statusDir = path.join(tempHome, ".claude", "dot-status");
        fs.mkdirSync(statusDir, { recursive: true });
        fs.writeFileSync(
          path.join(statusDir, "hook-cache.json"),
          JSON.stringify({
            sessionId: "hook-cache",
            cwd: expectedCwd,
            status: "working",
            updated: new Date().toISOString(),
          })
        );
      },
      expectedCwd,
    },
  ];

  let failed = false;

  for (const testCase of cases) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dot-hook-test-"));
    try {
      testCase.setup?.(tempHome);
      const result = spawnSync(process.execPath, [__filename], {
        cwd: baseDir,
        env: {
          ...process.env,
          HOME: tempHome,
          DOT_API_KEY: "x",
          DOT_DEVICE_ID: "x",
          DOT_BASE_URL: "https://127.0.0.1:1",
          DOT_MONITOR_CACHE_DIR: path.join(tempHome, ".cache"),
          ...testCase.env,
        },
        input: JSON.stringify(testCase.event),
        encoding: "utf8",
        timeout: 5000,
      });

      const statusPath = path.join(tempHome, ".claude", "dot-status", `${testCase.event.session_id}.json`);
      let resolvedCwd = null;
      try {
        resolvedCwd = JSON.parse(fs.readFileSync(statusPath, "utf8")).cwd;
      } catch {}

      const pass = result.status === 0 && resolvedCwd === testCase.expectedCwd;
      console.log(`${pass ? "PASS" : "FAIL"} ${testCase.name}: ${resolvedCwd || "missing"}`);
      if (!pass) {
        failed = true;
        if (result.stderr) {
          console.log(result.stderr.trim());
        }
      }
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }

  if (failed) {
    process.exitCode = 1;
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
