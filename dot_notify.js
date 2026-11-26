#!/usr/bin/env node

const { spawn, spawnSync, execSync } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
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
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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
  deviceIds: resolveDotDeviceIds(process.env),
  baseUrl: process.env.DOT_BASE_URL || "https://dot.mindreset.tech",
};

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_RUNTIME_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const CACHE_DIR = process.env.DOT_MONITOR_CACHE_DIR || path.join(__dirname, ".cache");
const LAST_RENDER_STATE_FILE = path.join(CACHE_DIR, "last_render_state.json");
const DEFAULT_TIME_ZONE = process.env.TZ || "Asia/Shanghai";
const REQUEST_TIMEOUT_MS = 15000;
const WORKING_REFRESH_MS = 60 * 1000;
const CODEX_USAGE_CACHE_TTL_MS = (() => {
  const value = Number(process.env.CODEX_USAGE_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
})();
const CODEX_USAGE_FAILURE_BACKOFF_MS = 60 * 1000;
const CODEX_APP_SERVER_TIMEOUT_MS = 10 * 1000;
const CODEX_USAGE_LOCK_STALE_MS = CODEX_APP_SERVER_TIMEOUT_MS + 5 * 1000;
const CODEX_USAGE_LOCK_WAIT_MS = CODEX_APP_SERVER_TIMEOUT_MS + 1000;
const AGY_USAGE_CACHE_TTL_MS = (() => {
  const value = Number(process.env.AGY_USAGE_CACHE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
})();
const AGY_USAGE_FAILURE_BACKOFF_MS = 60 * 1000;
const AGY_CLI_TIMEOUT_MS = (() => {
  const value = Number(process.env.AGY_CLI_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30 * 1000;
})();
const AGY_USAGE_LOCK_STALE_MS = AGY_CLI_TIMEOUT_MS + 5 * 1000;
const AGY_USAGE_LOCK_WAIT_MS = AGY_CLI_TIMEOUT_MS + 1000;
const AGY_QUOTA_GROUP = String(process.env.AGY_QUOTA_GROUP || "gemini").trim().toLowerCase();

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

function encodeRgbPng(width, height, pixels) {
  const channels = 3;
  const scanlineLength = width * channels + 1;
  const raw = Buffer.alloc(scanlineLength * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * scanlineLength;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const value = pixels[y * width + x];
      const pixelOffset = rowOffset + 1 + x * channels;
      raw[pixelOffset] = value;
      raw[pixelOffset + 1] = value;
      raw[pixelOffset + 2] = value;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", zlib.deflateSync(raw)),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeCanvasToPngBase64(canvas) {
  return encodeRgbPng(canvas.width, canvas.height, canvas.pixels).toString("base64");
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

const COMPACT_FONT = {
  "0": ["0110", "1001", "1011", "1101", "1001", "0110"],
  "1": ["0010", "0110", "0010", "0010", "0010", "0111"],
  "2": ["0110", "1001", "0001", "0010", "0100", "1111"],
  "3": ["1110", "0001", "0110", "0001", "0001", "1110"],
  "4": ["0010", "0110", "1010", "1111", "0010", "0010"],
  "5": ["1111", "1000", "1110", "0001", "0001", "1110"],
  "6": ["0111", "1000", "1110", "1001", "1001", "0110"],
  "7": ["1111", "0001", "0010", "0100", "0100", "0100"],
  "8": ["0110", "1001", "0110", "1001", "1001", "0110"],
  "9": ["0110", "1001", "0111", "0001", "0001", "1110"],
  "%": ["1001", "0010", "0010", "0100", "0100", "1001"],
  "-": ["0000", "0000", "1111", "0000", "0000", "0000"],
  D: ["1110", "1001", "1001", "1001", "1001", "1110"],
  F: ["1111", "1000", "1110", "1000", "1000", "1000"],
  H: ["1001", "1001", "1111", "1001", "1001", "1001"],
};

function bitmapDrawCompactText(canvas, x, y, text, color = 0) {
  const scale = 2;
  const letterSpacing = 2;
  let currentX = x;

  for (const rawChar of String(text)) {
    const glyph = COMPACT_FONT[rawChar] || COMPACT_FONT["-"];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === "1") {
          bitmapFillRect(canvas, currentX + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    currentX += 8 + letterSpacing;
  }

  return currentX - x - letterSpacing;
}

function bitmapMeasureCompactText(text) {
  if (!text) return 0;
  return String(text).length * 8 + (String(text).length - 1) * 2;
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

function bitmapDrawMissingBar(canvas, x, y, width, height) {
  bitmapStrokeRect(canvas, x, y, width, height, 0);
  for (let offsetY = 1; offsetY < height - 1; offsetY += 1) {
    for (let offsetX = 1; offsetX < width - 1; offsetX += 1) {
      if (((offsetX - offsetY + 60) % 6) < 2) {
        bitmapSetPixel(canvas, x + offsetX, y + offsetY, 0);
      }
    }
  }
}

function drawSplitColumnBlock(canvas, options) {
  const { x, width, title, headerReset, rows } = options;
  const rightX = x + width;
  const barHeight = 16;

  // Tight intra-block rhythm: header(5px) -> row1(3px) -> bar1(8px) -> row2(3px) -> bar2
  const headerY = 59;
  bitmapDrawText(canvas, x, headerY, title, 1, 0);
  if (headerReset) {
    bitmapDrawText(canvas, rightX - bitmapMeasureText(headerReset, 1), headerY, headerReset, 1, 0);
  }

  const row1Y = 71;
  const row1Pct = formatImagePercent(rows[0].value);
  bitmapDrawCompactText(canvas, x, row1Y, rows[0].label);
  bitmapDrawCompactText(canvas, rightX - bitmapMeasureCompactText(row1Pct), row1Y, row1Pct);

  const bar1Y = 86;
  if (rows[0].missing) {
    bitmapDrawMissingBar(canvas, x, bar1Y, width, barHeight);
  } else {
    bitmapDrawProgressBar(canvas, x, bar1Y, width, barHeight, rows[0].value);
  }

  const row2Y = 110;
  const row2Pct = formatImagePercent(rows[1].value);
  bitmapDrawCompactText(canvas, x, row2Y, rows[1].label);
  bitmapDrawCompactText(canvas, rightX - bitmapMeasureCompactText(row2Pct), row2Y, row2Pct);

  const bar2Y = 125;
  if (rows[1].missing) {
    bitmapDrawMissingBar(canvas, x, bar2Y, width, barHeight);
  } else {
    bitmapDrawProgressBar(canvas, x, bar2Y, width, barHeight, rows[1].value);
  }
}

function formatImagePercent(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(value)}%`;
}

function formatQuotaCountdown(resetsAt, now) {
  const resetAtMs = Date.parse(resetsAt || "");
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return "--";

  const totalMinutes = Math.max(0, Math.ceil((resetAtMs - now.getTime()) / 60000));
  if (totalMinutes < 24 * 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}H ${minutes}M`;
    if (hours > 0) return `${hours}H`;
    return `${Math.max(1, minutes)}M`;
  }

  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.ceil((totalMinutes - days * 24 * 60) / 60);
  return hours > 0 ? `${days}D ${hours}H` : `${days}D`;
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

function buildUsageImageBase64(codexData, claudeData, agyData, now, timeZone) {
  const canvas = createBitmapCanvas(WIDTH, HEIGHT);
  const marginX = 6;
  const colWidth = 131;
  const rightColX = WIDTH - marginX - colWidth;
  const rightEdge = WIDTH - marginX;

  // Block 1: CODEX (header tight to its bar; 24px outer gap below to Blocks 2 & 3)
  const codexReset = formatQuotaCountdown(codexData?.sevenDay?.resetsAt, now);
  const timeText = formatDisplayTime(now, timeZone);
  const timeX = Math.floor((WIDTH - bitmapMeasureText(timeText, 1)) / 2);
  bitmapDrawText(canvas, marginX, 8, "CODEX", 1, 0);
  bitmapDrawText(canvas, timeX, 8, timeText, 1, 0);
  bitmapDrawText(canvas, rightEdge - bitmapMeasureText(codexReset, 1), 8, codexReset, 1, 0);

  const codexBarY = 19;
  const codexBarHeight = 16;
  const codexLabelW = bitmapMeasureCompactText("7D");
  const codexBarX = marginX + codexLabelW + 7;
  const codexPctReserve = bitmapMeasureCompactText("100%") + 7;
  const codexBarW = rightEdge - codexPctReserve - codexBarX;
  const codexPctText = formatImagePercent(codexData?.sevenDay?.utilization);
  bitmapDrawCompactText(canvas, marginX, codexBarY + 2, "7D");
  bitmapDrawProgressBar(canvas, codexBarX, codexBarY, codexBarW, codexBarHeight, codexData?.sevenDay?.utilization);
  bitmapDrawCompactText(
    canvas,
    rightEdge - bitmapMeasureCompactText(codexPctText),
    codexBarY + 2,
    codexPctText
  );

  // Block 2: CLAUDE (left, 22px horizontal gutter to AGY)
  const claudeCount = Number(claudeData?.accountCount) || 1;
  const claudeTitle = claudeCount > 1 ? `CLAUDE x${claudeCount}` : "CLAUDE";
  const claudeReset = formatQuotaCountdown(
    claudeData?.sevenDay?.resetsAt || claudeData?.fable?.resetsAt,
    now
  );
  drawSplitColumnBlock(canvas, {
    x: marginX,
    width: colWidth,
    title: claudeTitle,
    headerReset: claudeReset,
    rows: [
      { label: "7D", value: claudeData?.sevenDay?.utilization },
      { label: "F", value: claudeData?.fable?.utilization, missing: !claudeData?.fable },
    ],
  });

  // Block 3: AGY (right, 22px horizontal gutter from CLAUDE)
  const agyReset = [
    formatQuotaCountdown(agyData?.fiveHour?.resetsAt, now),
    formatQuotaCountdown(agyData?.sevenDay?.resetsAt, now),
  ].join(" / ");
  drawSplitColumnBlock(canvas, {
    x: rightColX,
    width: colWidth,
    title: "AGY",
    headerReset: agyReset,
    rows: [
      { label: "5H", value: agyData?.fiveHour?.utilization },
      { label: "7D", value: agyData?.sevenDay?.utilization },
    ],
  });

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
  // Explicit configuration wins over implicit Keychain discovery.
  if (process.env.ANTHROPIC_OAUTH_TOKEN) {
    return fetchClaudeUsageFromAnthropic(process.env.ANTHROPIC_OAUTH_TOKEN);
  }

  const apiUrl = process.env.CLAUDE_USAGE_API_URL;
  const apiKey = process.env.CLAUDE_USAGE_API_KEY;
  if (apiUrl && apiKey) {
    return fetchClaudeUsageFromCustomAPI(apiUrl, apiKey);
  }

  const discoveredToken = discoverOAuthTokenFromKeychain();
  if (discoveredToken) {
    return fetchClaudeUsageFromAnthropic(discoveredToken);
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
  const selection = resolveClaudeUsageAccountSelection(process.env);
  const accountIds = selection.discover
    ? await discoverClaudeUsageAccountIds(baseUrl, apiKey)
    : selection.accountIds;
  if (!accountIds?.length) return null;

  const usages = await Promise.all(
    accountIds.map((accountId) => fetchClaudeUsageForAccount(baseUrl, apiKey, accountId))
  );
  if (usages.some((usage) => !usage)) return null;
  return aggregateClaudeUsage(usages);
}

function resolveClaudeUsageAccountSelection(env) {
  const configured = String(env.CLAUDE_USAGE_ACCOUNT_IDS || "").trim();
  if (configured.toLowerCase() === "all") {
    return { discover: true, accountIds: [] };
  }
  if (configured) {
    return { discover: false, accountIds: parseClaudeUsageAccountIds(configured) };
  }

  const legacy = String(env.CLAUDE_USAGE_ACCOUNT_ID || "").trim();
  if (legacy) {
    return { discover: false, accountIds: parseClaudeUsageAccountIds(legacy) };
  }

  return { discover: true, accountIds: [] };
}

function parseClaudeUsageAccountIds(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map((accountId) => accountId.trim())
      .filter((accountId) => /^\d+$/.test(accountId))
  )];
}

function supportsClaudeSubscriptionUsage(account) {
  return account?.platform === "anthropic" &&
    account?.status === "active" &&
    (account?.type === "oauth" || account?.type === "setup-token");
}

async function discoverClaudeUsageAccountIds(baseUrl, apiKey) {
  const accountIds = [];
  let page = 1;
  let pages = 1;

  do {
    const url = new URL("/api/v1/admin/accounts", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "100");
    const res = await fetchJson(url, {
      method: "GET",
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok || !res.json) return null;

    const payload = res.json.code === 0 ? res.json.data : res.json;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    for (const account of items) {
      if (supportsClaudeSubscriptionUsage(account) && account.id != null) {
        accountIds.push(String(account.id));
      }
    }

    pages = Number(payload?.pages) || 1;
    page += 1;
  } while (page <= pages);

  return [...new Set(accountIds)];
}

async function fetchClaudeUsageForAccount(baseUrl, apiKey, accountId) {
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

function aggregateClaudeUsage(usages) {
  const validUsages = usages.filter(Boolean);
  if (validUsages.length === 0) return null;
  return {
    sevenDay: aggregateUsageWindows(validUsages.map((usage) => usage.sevenDay)),
    fable: aggregateAvailableUsageWindows(validUsages.map((usage) => usage.fable)),
    accountCount: validUsages.length,
    fableAccountCount: validUsages.filter((usage) => usage.fable).length,
  };
}

function aggregateUsageWindows(windows) {
  const validWindows = windows.filter((window) => Number.isFinite(window?.utilization));
  if (validWindows.length !== windows.length || validWindows.length === 0) return null;

  const utilization = validWindows.reduce((sum, window) => sum + window.utilization, 0) / validWindows.length;
  const resetTimes = validWindows
    .map((window) => ({ value: window.resetsAt, timestamp: Date.parse(window.resetsAt || "") }))
    .filter((reset) => Number.isFinite(reset.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  return {
    utilization,
    resetsAt: resetTimes[0]?.value || null,
  };
}

function aggregateAvailableUsageWindows(windows) {
  const validWindows = windows.filter((window) => Number.isFinite(window?.utilization));
  if (validWindows.length === 0) return null;

  const utilization = validWindows.reduce((sum, window) => sum + window.utilization, 0) / validWindows.length;
  const resetTimes = validWindows
    .map((window) => ({ value: window.resetsAt, timestamp: Date.parse(window.resetsAt || "") }))
    .filter((reset) => Number.isFinite(reset.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
  return {
    utilization,
    resetsAt: resetTimes[0]?.value || null,
  };
}

function normalizeUsageData(data) {
  if (!data) return null;
  const usesCamel = 'sevenDay' in data || 'fable' in data;
  return {
    sevenDay: normalizeWindow(usesCamel ? data.sevenDay : data.seven_day),
    fable: normalizeWindow(usesCamel ? data.fable : data.seven_day_fable),
    accountCount: Number(data.accountCount) || 1,
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

function isNewerCodexSnapshot(candidate, current) {
  if (!current) {
    return true;
  }
  if (candidate.timestampMs !== current.timestampMs) {
    return candidate.timestampMs > current.timestampMs;
  }
  return candidate.lineNumber > current.lineNumber;
}

function isGlobalCodexRateLimit(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") {
    return false;
  }
  return !rateLimits.limit_id || rateLimits.limit_id === "codex";
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

      const candidate = {
        filePath,
        lineNumber,
        timestamp,
        timestampMs,
        event: parsed,
      };

      if (isNewerCodexSnapshot(candidate, currentBest.latest)) {
        currentBest.latest = candidate;
      }

      if (isGlobalCodexRateLimit(parsed?.payload?.rate_limits) &&
          isNewerCodexSnapshot(candidate, currentBest.global)) {
        currentBest.global = candidate;
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
  let best = { global: null, latest: null };

  for (const filePath of files) {
    best = await scanJsonlFileForLatestTokenCount(filePath, best);
  }

  const snapshot = best.global || best.latest;
  if (!snapshot) {
    throw new Error("No Codex token_count event found");
  }

  return snapshot;
}

function mapCodexWindows(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const result = { fiveHour: null, sevenDay: null };
  for (const key of ["primary", "secondary"]) {
    const item = rateLimits[key];
    if (!item) continue;
    const minutes = Number(item.windowDurationMins ?? item.window_minutes);
    const util = Number(item.usedPercent ?? item.used_percent);
    if (!Number.isFinite(util)) continue;
    const resetsAt = item.resetsAt ?? item.resets_at;
    const norm = {
      utilization: util,
      resetsAt: resetsAt !== null && resetsAt !== undefined && Number.isFinite(Number(resetsAt))
        ? new Date(Number(resetsAt) * 1000).toISOString()
        : null,
    };
    if (minutes === 300) result.fiveHour = norm;
    if (minutes === 10080) result.sevenDay = norm;
  }
  return (result.fiveHour || result.sevenDay) ? result : null;
}

function normalizeCachedCodexWindow(window) {
  if (!window || typeof window !== "object") return null;
  const utilization = Number(window.utilization);
  if (!Number.isFinite(utilization)) return null;
  const resetsAtMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return {
    utilization,
    resetsAt: Number.isFinite(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null,
  };
}

function normalizeCachedCodexUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const normalized = {
    fiveHour: normalizeCachedCodexWindow(usage.fiveHour),
    sevenDay: normalizeCachedCodexWindow(usage.sevenDay),
  };
  return (normalized.fiveHour || normalized.sevenDay) ? normalized : null;
}

function hasExpiredCodexUsageWindow(usage, nowMs) {
  return [usage?.fiveHour, usage?.sevenDay].some((window) => {
    const resetsAtMs = Date.parse(window?.resetsAt || "");
    return Number.isFinite(resetsAtMs) && resetsAtMs <= nowMs;
  });
}

function getCodexUsageCachePaths(cacheDir) {
  return {
    cacheFile: path.join(cacheDir, "codex_usage.json"),
    lockFile: path.join(cacheDir, "codex_usage.lock"),
  };
}

function readFreshCodexUsageCache(cacheDir, cacheTtlMs, nowMs = Date.now()) {
  const { cacheFile } = getCodexUsageCachePaths(cacheDir);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const fetchedAtMs = Date.parse(cached.fetchedAt || "");
    const entryMaxAgeMs = Number(cached.maxAgeMs);
    const maxAgeMs = Number.isFinite(entryMaxAgeMs) && entryMaxAgeMs > 0
      ? Math.min(cacheTtlMs, entryMaxAgeMs)
      : cacheTtlMs;
    const ageMs = nowMs - fetchedAtMs;
    if (!Number.isFinite(fetchedAtMs) || ageMs < 0 || ageMs >= maxAgeMs) {
      return null;
    }

    const usage = normalizeCachedCodexUsage(cached.usage);
    if (!usage && cached.source !== "error") {
      return null;
    }
    if (cached.source === "app-server" && usage && hasExpiredCodexUsageWindow(usage, nowMs)) {
      return null;
    }
    return { usage, source: cached.source || "unknown" };
  } catch {
    return null;
  }
}

function writeCodexUsageCache(cacheDir, usage, source, maxAgeMs) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const { cacheFile } = getCodexUsageCachePaths(cacheDir);
  const tempFile = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify({
      version: 1,
      fetchedAt: new Date().toISOString(),
      maxAgeMs,
      source,
      usage,
    }, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, cacheFile);
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function expandHomePath(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath;
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function resolveCodexBin(explicitBin = process.env.CODEX_BIN) {
  if (explicitBin) return expandHomePath(explicitBin);

  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executableName);
    if (isExecutableFile(candidate)) return candidate;
  }

  const knownCandidates = process.platform === "darwin" ? [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
  ] : [
    path.join(os.homedir(), ".local", "bin", executableName),
  ];
  return knownCandidates.find(isExecutableFile) || executableName;
}

function selectCodexRateLimits(result) {
  return result?.rateLimitsByLimitId?.codex || result?.rateLimits || null;
}

function requestCodexRateLimitsFromAppServer(options = {}) {
  const codexBin = resolveCodexBin(options.codexBin);
  const timeoutMs = options.timeoutMs || CODEX_APP_SERVER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
      cwd: __dirname,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let rateLimitRequestSent = false;
    let stdoutBuffer = "";
    let stderr = "";

    const stopChild = () => {
      try { child.stdin.end(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
    };

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopChild();
      if (error) reject(error);
      else resolve(result);
    };

    const send = (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handleMessage = (message) => {
      if (message?.id === 1) {
        if (message.error) {
          finish(new Error(`Codex app-server initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        if (!rateLimitRequestSent) {
          rateLimitRequestSent = true;
          send({ method: "account/rateLimits/read", id: 2 });
        }
        return;
      }

      if (message?.id === 2) {
        if (message.error) {
          finish(new Error(`Codex rate-limit request failed: ${JSON.stringify(message.error)}`));
          return;
        }
        finish(null, message.result);
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Codex app-server timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handleMessage(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    child.stdin.on("error", (error) => finish(error));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (settled) return;
      const detail = stderr.trim();
      finish(new Error(
        `Codex app-server exited before responding (${signal || `code ${code}`})${detail ? `: ${detail}` : ""}`
      ));
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "dot-ai-monitor",
          title: "Dot AI Monitor",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
    });
  });
}

function tryAcquireFileLock(lockFile, staleMs, nowMs = Date.now()) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;

  const acquire = () => {
    const fd = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date(nowMs).toISOString() }));
    fs.closeSync(fd);
    return { lockFile, token };
  };

  try {
    return acquire();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  try {
    const observedLock = fs.readFileSync(lockFile, "utf8");
    const ageMs = nowMs - fs.statSync(lockFile).mtimeMs;
    if (ageMs >= staleMs) {
      const currentLock = fs.readFileSync(lockFile, "utf8");
      if (currentLock === observedLock) {
        fs.unlinkSync(lockFile);
        return acquire();
      }
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      try { return acquire(); } catch (retryError) {
        if (retryError.code !== "EEXIST") throw retryError;
      }
    }
  }
  return null;
}

function releaseFileLock(lock) {
  if (!lock) return;
  try {
    const current = JSON.parse(fs.readFileSync(lock.lockFile, "utf8"));
    if (current.token === lock.token) {
      fs.unlinkSync(lock.lockFile);
    }
  } catch {}
}

function tryAcquireCodexUsageLock(cacheDir, staleMs, nowMs = Date.now()) {
  const { lockFile } = getCodexUsageCachePaths(cacheDir);
  return tryAcquireFileLock(lockFile, staleMs, nowMs);
}

function releaseCodexUsageLock(lock) {
  return releaseFileLock(lock);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCodexUsageCache(cacheDir, cacheTtlMs, lockFile, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const cached = readFreshCodexUsageCache(cacheDir, cacheTtlMs);
    if (cached) return cached;
    if (!fs.existsSync(lockFile)) return null;
    await delay(50);
  }
  return null;
}

async function fetchCodexUsageFromSessions(rootDir = CODEX_SESSIONS_DIR) {
  try {
    const snapshot = await findLatestCodexSnapshot(rootDir);
    return mapCodexWindows(snapshot.event?.payload?.rate_limits);
  } catch {
    return null;
  }
}

async function fetchCodexUsageWithFallback(options = {}) {
  const cacheDir = options.cacheDir || CACHE_DIR;
  const cacheTtlMs = options.cacheTtlMs || CODEX_USAGE_CACHE_TTL_MS;
  const sessionsDir = options.sessionsDir || CODEX_SESSIONS_DIR;
  const appServerTimeoutMs = options.appServerTimeoutMs || CODEX_APP_SERVER_TIMEOUT_MS;
  const lockStaleMs = options.lockStaleMs || CODEX_USAGE_LOCK_STALE_MS;
  const lockWaitMs = options.lockWaitMs || CODEX_USAGE_LOCK_WAIT_MS;

  const cached = readFreshCodexUsageCache(cacheDir, cacheTtlMs);
  if (cached) return cached.usage;

  const { lockFile } = getCodexUsageCachePaths(cacheDir);
  const lock = tryAcquireCodexUsageLock(cacheDir, lockStaleMs);
  if (!lock) {
    const shared = await waitForCodexUsageCache(cacheDir, cacheTtlMs, lockFile, lockWaitMs);
    if (shared) return shared.usage;
    return fetchCodexUsageFromSessions(sessionsDir);
  }

  try {
    try {
      const result = await requestCodexRateLimitsFromAppServer({
        codexBin: options.codexBin,
        timeoutMs: appServerTimeoutMs,
        env: options.env,
      });
      const usage = mapCodexWindows(selectCodexRateLimits(result));
      if (!usage) throw new Error("Codex app-server returned no supported usage windows");
      writeCodexUsageCache(cacheDir, usage, "app-server", cacheTtlMs);
      return usage;
    } catch {
      const fallback = await fetchCodexUsageFromSessions(sessionsDir);
      writeCodexUsageCache(
        cacheDir,
        fallback,
        fallback ? "sessions" : "error",
        Math.min(cacheTtlMs, CODEX_USAGE_FAILURE_BACKOFF_MS)
      );
      return fallback;
    }
  } finally {
    releaseFileLock(lock);
  }
}

let codexUsageRequestPromise = null;

async function fetchCodexUsage() {
  const cached = readFreshCodexUsageCache(CACHE_DIR, CODEX_USAGE_CACHE_TTL_MS);
  if (cached) return cached.usage;
  if (!codexUsageRequestPromise) {
    codexUsageRequestPromise = fetchCodexUsageWithFallback()
      .finally(() => { codexUsageRequestPromise = null; });
  }
  return codexUsageRequestPromise;
}

// --- Antigravity Usage Fetching ---

function parseAgyResetTime(bucket, nowMs = Date.now()) {
  if (!bucket || typeof bucket !== "object") return null;
  const rawTime = bucket.reset_time || bucket.resetTime;
  if (rawTime) {
    const parsedMs = Date.parse(rawTime);
    if (Number.isFinite(parsedMs) && parsedMs > 0) {
      return new Date(parsedMs).toISOString();
    }
  }
  const resetSeconds = Number(bucket.reset_in_seconds ?? bucket.resetInSeconds);
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return new Date(nowMs + resetSeconds * 1000).toISOString();
  }
  return null;
}

function mapAgyBucketToWindow(bucket, nowMs = Date.now()) {
  if (!bucket || typeof bucket !== "object" || bucket.disabled) return null;
  const remaining = Number(bucket.remaining_fraction ?? bucket.remainingFraction);
  if (!Number.isFinite(remaining)) return null;
  const utilization = Math.max(0, Math.min(100, (1 - remaining) * 100));
  return {
    utilization,
    resetsAt: parseAgyResetTime(bucket, nowMs),
  };
}

function mapAgyUsageCommandOutput(payload, group = AGY_QUOTA_GROUP, nowMs = Date.now()) {
  const groups = payload?.command?.data?.groups || payload?.data?.groups || payload?.groups;
  if (!Array.isArray(groups)) return null;

  const prefix = String(group || "gemini").trim().toLowerCase();
  const allBuckets = groups.flatMap((item) => Array.isArray(item?.buckets) ? item.buckets : []);
  let fiveHourBucket = allBuckets.find((b) => String(b?.id || "").toLowerCase() === `${prefix}-5h`);
  let sevenDayBucket = allBuckets.find((b) => String(b?.id || "").toLowerCase() === `${prefix}-weekly`);

  if (!fiveHourBucket && !sevenDayBucket) {
    const matchedGroup = groups.find((item) => String(item?.name || "").toLowerCase().includes(prefix));
    const groupBuckets = Array.isArray(matchedGroup?.buckets) ? matchedGroup.buckets : [];
    fiveHourBucket = groupBuckets.find((b) => String(b?.window || "").toLowerCase() === "5h");
    sevenDayBucket = groupBuckets.find((b) => String(b?.window || "").toLowerCase() === "weekly");
  }

  const result = {
    fiveHour: mapAgyBucketToWindow(fiveHourBucket, nowMs),
    sevenDay: mapAgyBucketToWindow(sevenDayBucket, nowMs),
  };
  return (result.fiveHour || result.sevenDay) ? result : null;
}

function mapAgyStatusLinePayload(payload, group = AGY_QUOTA_GROUP, nowMs = Date.now()) {
  const quota = payload?.quota || payload?.statusLine?.quota;
  if (!quota || typeof quota !== "object") return null;
  const prefix = String(group || "gemini").trim().toLowerCase();
  const result = {
    fiveHour: mapAgyBucketToWindow(quota[`${prefix}-5h`], nowMs),
    sevenDay: mapAgyBucketToWindow(quota[`${prefix}-weekly`], nowMs),
  };
  return (result.fiveHour || result.sevenDay) ? result : null;
}

function getAgyUsageCachePaths(cacheDir) {
  return {
    cacheFile: path.join(cacheDir, "antigravity_usage.json"),
    lockFile: path.join(cacheDir, "antigravity_usage.lock"),
  };
}

function normalizeCachedAgyUsage(usage) {
  return normalizeCachedCodexUsage(usage);
}

function readFreshAgyUsageCache(cacheDir, cacheTtlMs, nowMs = Date.now()) {
  const { cacheFile } = getAgyUsageCachePaths(cacheDir);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const fetchedAtMs = Date.parse(cached.fetchedAt || "");
    const entryMaxAgeMs = Number(cached.maxAgeMs);
    const maxAgeMs = Number.isFinite(entryMaxAgeMs) && entryMaxAgeMs > 0
      ? Math.min(cacheTtlMs, entryMaxAgeMs)
      : cacheTtlMs;
    const ageMs = nowMs - fetchedAtMs;
    if (!Number.isFinite(fetchedAtMs) || ageMs < 0 || ageMs >= maxAgeMs) {
      return null;
    }

    const usage = normalizeCachedAgyUsage(cached.usage);
    if (!usage && cached.source !== "error") {
      return null;
    }
    if (usage && hasExpiredCodexUsageWindow(usage, nowMs)) {
      return null;
    }
    return { usage, source: cached.source || "unknown" };
  } catch {
    return null;
  }
}

function readUnexpiredAgyUsageFallback(cacheDir, nowMs = Date.now()) {
  const { cacheFile } = getAgyUsageCachePaths(cacheDir);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const usage = normalizeCachedAgyUsage(cached.usage);
    if (!usage) return null;
    const filterWindow = (win) => {
      if (!win) return null;
      const resetMs = Date.parse(win.resetsAt || "");
      if (Number.isFinite(resetMs) && resetMs <= nowMs) return null;
      return win;
    };
    const fallback = {
      fiveHour: filterWindow(usage.fiveHour),
      sevenDay: filterWindow(usage.sevenDay),
    };
    return (fallback.fiveHour || fallback.sevenDay) ? fallback : null;
  } catch {
    return null;
  }
}

function writeAgyUsageCache(cacheDir, usage, source, maxAgeMs, nowMs = Date.now()) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const { cacheFile } = getAgyUsageCachePaths(cacheDir);
  const tempFile = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify({
      version: 1,
      fetchedAt: new Date(nowMs).toISOString(),
      maxAgeMs,
      source,
      usage,
    }, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, cacheFile);
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

function resolveAgyBin(explicitBin = process.env.AGY_BIN) {
  if (explicitBin) return expandHomePath(explicitBin);

  const executableName = process.platform === "win32" ? "agy.exe" : "agy";
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executableName);
    if (isExecutableFile(candidate)) return candidate;
  }

  const knownCandidates = [
    path.join(os.homedir(), ".local", "bin", executableName),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ];
  return knownCandidates.find(isExecutableFile) || null;
}

function parseJsonFromCliStdout(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}

  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    const clean = line.trim();
    if (!clean.startsWith("{")) continue;
    try {
      return JSON.parse(clean);
    } catch {}
  }
  return null;
}

function requestAgyUsageFromCli(options = {}) {
  const agyBin = resolveAgyBin(options.agyBin);
  if (!agyBin) {
    return Promise.reject(new Error("agy binary not found"));
  }
  const timeoutMs = options.timeoutMs || AGY_CLI_TIMEOUT_MS;
  const printTimeoutSec = Math.max(5, Math.floor((timeoutMs - 1000) / 1000));

  return new Promise((resolve, reject) => {
    const child = spawn(agyBin, ["-p", "/usage", "--output-format", "json", "--print-timeout", `${printTimeoutSec}s`], {
      cwd: __dirname,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill("SIGTERM"); } catch {}
      if (error) reject(error);
      else resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`agy CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim();
        finish(new Error(`agy CLI exited (${signal || `code ${code}`})${detail ? `: ${detail}` : ""}`));
        return;
      }
      const parsed = parseJsonFromCliStdout(stdout);
      if (!parsed) {
        finish(new Error("agy CLI returned non-JSON output"));
        return;
      }
      finish(null, parsed);
    });
  });
}

async function waitForAgyUsageCache(cacheDir, cacheTtlMs, lockFile, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const cached = readFreshAgyUsageCache(cacheDir, cacheTtlMs);
    if (cached) return cached;
    if (!fs.existsSync(lockFile)) return null;
    await delay(50);
  }
  return null;
}

async function fetchAntigravityUsageWithFallback(options = {}) {
  const cacheDir = options.cacheDir || CACHE_DIR;
  const cacheTtlMs = options.cacheTtlMs || AGY_USAGE_CACHE_TTL_MS;
  const cliTimeoutMs = options.cliTimeoutMs || AGY_CLI_TIMEOUT_MS;
  const lockStaleMs = options.lockStaleMs || AGY_USAGE_LOCK_STALE_MS;
  const lockWaitMs = options.lockWaitMs || AGY_USAGE_LOCK_WAIT_MS;
  const group = options.group || AGY_QUOTA_GROUP;

  const cached = readFreshAgyUsageCache(cacheDir, cacheTtlMs);
  if (cached) return cached.usage;

  const { lockFile } = getAgyUsageCachePaths(cacheDir);
  const lock = tryAcquireFileLock(lockFile, lockStaleMs);
  if (!lock) {
    const shared = await waitForAgyUsageCache(cacheDir, cacheTtlMs, lockFile, lockWaitMs);
    if (shared) return shared.usage;
    return readUnexpiredAgyUsageFallback(cacheDir);
  }

  try {
    try {
      const payload = await requestAgyUsageFromCli({
        agyBin: options.agyBin,
        timeoutMs: cliTimeoutMs,
        env: options.env,
      });
      const usage = mapAgyUsageCommandOutput(payload, group);
      if (!usage) throw new Error("agy CLI returned no supported quota buckets");
      writeAgyUsageCache(cacheDir, usage, "agy-cli", cacheTtlMs);
      return usage;
    } catch {
      const fallback = readUnexpiredAgyUsageFallback(cacheDir);
      writeAgyUsageCache(
        cacheDir,
        fallback,
        fallback ? "cache-fallback" : "error",
        Math.min(cacheTtlMs, AGY_USAGE_FAILURE_BACKOFF_MS)
      );
      return fallback;
    }
  } finally {
    releaseFileLock(lock);
  }
}

let agyUsageRequestPromise = null;

async function fetchAntigravityUsage() {
  const cached = readFreshAgyUsageCache(CACHE_DIR, AGY_USAGE_CACHE_TTL_MS);
  if (cached) return cached.usage;
  if (!agyUsageRequestPromise) {
    agyUsageRequestPromise = fetchAntigravityUsageWithFallback()
      .finally(() => { agyUsageRequestPromise = null; });
  }
  return agyUsageRequestPromise;
}

function handleAgyStatusLine(rawInput, options = {}) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) return false;
  try {
    const nowMs = options.nowMs || Date.now();
    const payload = JSON.parse(trimmed);
    const usage = mapAgyStatusLinePayload(payload, options.group || AGY_QUOTA_GROUP, nowMs);
    if (!usage) return false;
    writeAgyUsageCache(
      options.cacheDir || CACHE_DIR,
      usage,
      "statusline",
      options.cacheTtlMs || AGY_USAGE_CACHE_TTL_MS,
      nowMs
    );
    return true;
  } catch {
    return false;
  }
}

async function fetchAllUsage() {
  const [claude, codex, antigravity] = await Promise.all([
    fetchClaudeUsage().catch(() => null),
    fetchCodexUsage().catch(() => null),
    fetchAntigravityUsage().catch(() => null),
  ]);
  return { claude, codex, antigravity };
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
      antigravity: usage?.antigravity || null,
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

  const usageBase64 = buildUsageImageBase64(
    usage.codex,
    usage.claude,
    usage.antigravity,
    new Date(),
    DEFAULT_TIME_ZONE
  );
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
    return encodeRgbPng(WIDTH, HEIGHT, canvas.pixels);
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

  return encodeRgbPng(WIDTH, HEIGHT, canvas.pixels);
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

function parseDotDeviceIds(...values) {
  return [...new Set(
    values
      .filter(Boolean)
      .flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

function resolveDotDeviceIds(env) {
  return env.DOT_DEVICE_IDS
    ? parseDotDeviceIds(env.DOT_DEVICE_IDS)
    : parseDotDeviceIds(env.DOT_DEVICE_ID);
}

function pushToDotDevice(deviceId, body) {
  const url = new URL(
    `/api/authV2/open/device/${encodeURIComponent(deviceId)}/image`,
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
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ message: `Device ${deviceId} updated` });
            }
          } else {
            reject(new Error(`Dot API ${res.statusCode} for ${deviceId}: ${data}`));
          }
        });
      }
    );
    req.on("error", (error) => {
      reject(new Error(`Dot API request failed for ${deviceId}: ${error.message}`));
    });
    req.write(body);
    req.end();
  });
}

async function pushToDot(imageData) {
  if (CONFIG.deviceIds.length === 0) {
    throw new Error("DOT_DEVICE_IDS or DOT_DEVICE_ID is required");
  }

  const base64 = Buffer.isBuffer(imageData) ? imageData.toString("base64") : imageData;
  const body = JSON.stringify({
    image: base64,
    refreshNow: true,
  });

  const results = await Promise.allSettled(
    CONFIG.deviceIds.map((deviceId) => pushToDotDevice(deviceId, body))
  );
  const failures = results
    .map((result, index) => ({ result, deviceId: CONFIG.deviceIds[index] }))
    .filter(({ result }) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(failures.map(({ result }) => result.reason.message).join("; "));
  }

  return {
    message: `Updated ${results.length} Dot device${results.length === 1 ? "" : "s"}`,
    devices: CONFIG.deviceIds,
  };
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

  if (name === "png-format") {
    return runPngFormatTests();
  }

  if (name === "dot-devices") {
    return runDotDeviceTests();
  }

  if (name === "usage" || name === "usage-local") {
    const usage = await fetchAllUsage();
    const base64 = buildUsageImageBase64(
      usage.codex,
      usage.claude,
      usage.antigravity,
      new Date(),
      DEFAULT_TIME_ZONE
    );
    const pngBuf = Buffer.from(base64, "base64");
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const usageFile = path.join(CACHE_DIR, "test-usage.png");
    fs.writeFileSync(usageFile, pngBuf);
    console.log(`Saved ${usageFile}`);
    if (name === "usage-local") return;
    try {
      const result = await pushToDot(base64);
      writeLastRenderState({ mode: "test", key: `usage:${new Date().toISOString()}` });
      console.log(`Pushed usage: ${result.message}`);
    } catch (err) {
      console.error("Push failed:", err.message);
    }
    return;
  }

  if (name === "codex-usage") {
    return runCodexUsageSelectionTests();
  }

  if (name === "claude-usage") {
    return runClaudeUsageAggregationTests();
  }

  if (name === "agy-usage") {
    return runAntigravityUsageTests();
  }

  if (name === "refresh") {
    await pushCurrentDisplay({ force: true });
    console.log("Refreshed Dot with current state");
    return;
  }

  const testSessions = TEST_CASES[name];
  if (!testSessions) {
    console.log("Cases:", [
      ...Object.keys(TEST_CASES),
      "usage",
      "usage-local",
      "refresh",
      "hook-fallback",
      "usage-refresh",
      "codex-usage",
      "claude-usage",
      "agy-usage",
      "dot-devices",
      "png-format",
    ].join(", "));
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

function readPngHeader(buffer) {
  return {
    isPng: buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  };
}

function runPngFormatTests() {
  const cases = [
    {
      name: "usage-rgb-png",
      buffer: Buffer.from(buildUsageImageBase64(null, null, null, new Date("2026-06-08T10:00:00+08:00"), DEFAULT_TIME_ZONE), "base64"),
    },
    {
      name: "sessions-rgb-png",
      buffer: renderPNG(TEST_CASES.mix),
    },
  ];

  let failed = false;

  for (const testCase of cases) {
    const header = readPngHeader(testCase.buffer);
    const pass = header.isPng &&
      header.width === WIDTH &&
      header.height === HEIGHT &&
      header.bitDepth === 8 &&
      header.colorType === 2;

    console.log(`${pass ? "PASS" : "FAIL"} ${testCase.name}: ${JSON.stringify(header)}`);
    if (!pass) {
      failed = true;
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

function runDotDeviceTests() {
  const cases = [
    {
      name: "multiple-device-ids",
      actual: parseDotDeviceIds("device-a, device-b", null),
      expected: ["device-a", "device-b"],
    },
    {
      name: "device-ids-take-precedence",
      actual: resolveDotDeviceIds({ DOT_DEVICE_IDS: "device-a,device-b", DOT_DEVICE_ID: "legacy-device" }),
      expected: ["device-a", "device-b"],
    },
    {
      name: "legacy-device-id-compatible",
      actual: resolveDotDeviceIds({ DOT_DEVICE_ID: "legacy-device" }),
      expected: ["legacy-device"],
    },
  ];
  let failed = false;

  for (const testCase of cases) {
    const pass = JSON.stringify(testCase.actual) === JSON.stringify(testCase.expected);
    console.log(`${pass ? "PASS" : "FAIL"} ${testCase.name}: ${JSON.stringify(testCase.actual)}`);
    if (!pass) failed = true;
  }

  if (failed) process.exitCode = 1;
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
          DOT_DEVICE_IDS: "x",
          DOT_DEVICE_ID: "",
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

function runUsageRefreshTests() {
  const baseDir = __dirname;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dot-usage-test-"));

  try {
    const statusDir = path.join(tempHome, ".claude", "dot-status");
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(
      path.join(statusDir, "usage-refresh.json"),
      JSON.stringify({
        sessionId: "usage-refresh",
        cwd: baseDir,
        status: "perm",
        updated: new Date().toISOString(),
      })
    );

    const cacheDir = path.join(tempHome, ".cache");
    const result = spawnSync(process.execPath, [__filename, "--usage"], {
      cwd: baseDir,
      env: {
        ...process.env,
        HOME: tempHome,
        DOT_API_KEY: "x",
        DOT_DEVICE_IDS: "x",
        DOT_DEVICE_ID: "",
        DOT_BASE_URL: "https://127.0.0.1:1",
        DOT_MONITOR_CACHE_DIR: cacheDir,
      },
      encoding: "utf8",
      timeout: 5000,
    });

    let status = null;
    try {
      status = JSON.parse(fs.readFileSync(path.join(cacheDir, "last_usage_push.json"), "utf8"));
    } catch {}

    const pass = result.status === 0 &&
      status?.displayMode === "sessions" &&
      status?.result === "error";

    console.log(`${pass ? "PASS" : "FAIL"} usage-active-session-refresh: ${status ? JSON.stringify(status) : "missing"}`);
    if (!pass) {
      process.exitCode = 1;
      if (result.stderr) {
        console.log(result.stderr.trim());
      }
    }
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function buildCodexTokenCountLine(timestamp, limitId, fiveHourPercent, sevenDayPercent) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: limitId,
        limit_name: limitId === "codex" ? null : "GPT-5.3-Codex-Spark",
        primary: {
          used_percent: fiveHourPercent,
          window_minutes: 300,
          resets_at: 1777721023,
        },
        secondary: {
          used_percent: sevenDayPercent,
          window_minutes: 10080,
          resets_at: 1777959388,
        },
      },
    },
  });
}

async function runCodexUsageSelectionTests() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dot-codex-usage-test-"));
  let failed = false;

  const report = (name, pass, detail) => {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!pass) failed = true;
  };

  try {
    const sessionDir = path.join(tempHome, ".codex", "sessions", "2026", "05", "02");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-test.jsonl"),
      [
        buildCodexTokenCountLine("2026-05-02T09:21:45.994Z", "codex", 3, 44),
        buildCodexTokenCountLine("2026-05-02T09:21:45.996Z", "codex_bengalfox", 0, 0),
      ].join("\n") + "\n"
    );

    const snapshot = await findLatestCodexSnapshot(path.join(tempHome, ".codex", "sessions"));
    const windows = mapCodexWindows(snapshot.event?.payload?.rate_limits);
    const pass = snapshot.event?.payload?.rate_limits?.limit_id === "codex" &&
      windows?.fiveHour?.utilization === 3 &&
      windows?.sevenDay?.utilization === 44;

    report("codex-global-usage-selection", pass, JSON.stringify(windows));

    const fakeCodexBin = path.join(tempHome, "fake-codex");
    const countFile = path.join(tempHome, "app-server-requests.log");
    fs.writeFileSync(fakeCodexBin, [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const readline = require('readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      "  const request = JSON.parse(line);",
      "  if (request.id === 1) {",
      "    process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'fake' } }) + '\\n');",
      "  }",
      "  if (request.id === 2) {",
      "    fs.appendFileSync(process.env.FAKE_CODEX_COUNT_FILE, 'request\\n');",
      "    const result = {",
      "      rateLimits: { limitId: 'codex', primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1999999999 } },",
      "      rateLimitsByLimitId: {",
      "        codex: {",
      "          limitId: 'codex',",
      "          primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1999999999 },",
      "          secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 2000009999 }",
      "        },",
      "        codex_other: { limitId: 'codex_other', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1999999999 } }",
      "      }",
      "    };",
      "    setTimeout(() => process.stdout.write(JSON.stringify({ id: 2, result }) + '\\n'), Number(process.env.FAKE_CODEX_DELAY_MS || 0));",
      "  }",
      "});",
    ].join("\n"), { mode: 0o755 });

    const liveCacheDir = path.join(tempHome, "live-cache");
    const liveOptions = {
      cacheDir: liveCacheDir,
      cacheTtlMs: 10 * 60 * 1000,
      sessionsDir: path.join(tempHome, ".codex", "sessions"),
      codexBin: fakeCodexBin,
      appServerTimeoutMs: 2000,
      lockStaleMs: 2500,
      lockWaitMs: 2500,
      env: {
        ...process.env,
        FAKE_CODEX_COUNT_FILE: countFile,
        FAKE_CODEX_DELAY_MS: "150",
      },
    };
    const [firstLive, secondLive] = await Promise.all([
      fetchCodexUsageWithFallback(liveOptions),
      fetchCodexUsageWithFallback(liveOptions),
    ]);
    const requestCountAfterConcurrentFetch = fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
    const concurrentPass = firstLive?.fiveHour?.utilization === 21 &&
      firstLive?.sevenDay?.utilization === 42 &&
      JSON.stringify(firstLive) === JSON.stringify(secondLive) &&
      requestCountAfterConcurrentFetch === 1;
    report(
      "codex-app-server-single-flight",
      concurrentPass,
      `${JSON.stringify(firstLive)} requests=${requestCountAfterConcurrentFetch}`
    );

    const cachedLive = await fetchCodexUsageWithFallback(liveOptions);
    const requestCountAfterCacheHit = fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
    report(
      "codex-usage-cache",
      cachedLive?.fiveHour?.utilization === 21 && requestCountAfterCacheHit === 1,
      `requests=${requestCountAfterCacheHit}`
    );

    const failingCodexBin = path.join(tempHome, "failing-codex");
    fs.writeFileSync(failingCodexBin, "#!/usr/bin/env node\nprocess.exit(2);\n", { mode: 0o755 });
    const fallback = await fetchCodexUsageWithFallback({
      cacheDir: path.join(tempHome, "fallback-cache"),
      cacheTtlMs: 10 * 60 * 1000,
      sessionsDir: path.join(tempHome, ".codex", "sessions"),
      codexBin: failingCodexBin,
      appServerTimeoutMs: 1000,
      lockStaleMs: 1500,
      lockWaitMs: 1500,
    });
    report(
      "codex-session-fallback",
      fallback?.fiveHour?.utilization === 3 && fallback?.sevenDay?.utilization === 44,
      JSON.stringify(fallback)
    );
  } catch (error) {
    report("codex-usage-test-error", false, error.stack || error.message);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  if (failed) process.exitCode = 1;
}

async function runClaudeUsageAggregationTests() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");

    if (req.url.startsWith("/api/v1/admin/accounts?")) {
      res.end(JSON.stringify({
        code: 0,
        data: {
          items: [
            { id: 1, platform: "anthropic", status: "active", type: "oauth" },
            { id: 5, platform: "anthropic", status: "active", type: "setup-token" },
            { id: 7, platform: "anthropic", status: "disabled", type: "oauth" },
            { id: 8, platform: "openai", status: "active", type: "oauth" },
            { id: 9, platform: "anthropic", status: "active", type: "apikey" },
          ],
          pages: 1,
        },
      }));
      return;
    }

    const accountId = req.url.match(/\/accounts\/(\d+)\/usage/)?.[1];
    const usageByAccount = {
      1: {
        five_hour: { utilization: 10, resets_at: "2026-07-14T22:00:00+08:00" },
        seven_day: { utilization: 20, resets_at: "2026-07-18T00:00:00+08:00" },
        seven_day_fable: { utilization: 40, resets_at: "2026-07-19T00:00:00+08:00" },
      },
      5: {
        five_hour: { utilization: 30, resets_at: "2026-07-14T21:00:00+08:00" },
        seven_day: { utilization: 80, resets_at: "2026-07-17T00:00:00+08:00" },
      },
    };
    if (usageByAccount[accountId]) {
      res.end(JSON.stringify({ code: 0, data: usageByAccount[accountId] }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ code: 404 }));
  });

  let failed = false;
  const report = (name, pass, detail) => {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!pass) failed = true;
  };

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const originalIds = process.env.CLAUDE_USAGE_ACCOUNT_IDS;
    const originalLegacyId = process.env.CLAUDE_USAGE_ACCOUNT_ID;
    try {
      process.env.CLAUDE_USAGE_ACCOUNT_IDS = "all";
      delete process.env.CLAUDE_USAGE_ACCOUNT_ID;
      const aggregated = await fetchClaudeUsageFromCustomAPI(baseUrl, "test-key");
      const aggregatePass = aggregated?.accountCount === 2 &&
        !("fiveHour" in aggregated) &&
        aggregated?.sevenDay?.utilization === 50 &&
        aggregated?.sevenDay?.resetsAt === "2026-07-17T00:00:00+08:00" &&
        aggregated?.fable?.utilization === 40 &&
        aggregated?.fableAccountCount === 1;
      report("claude-auto-discovery-aggregation", aggregatePass, JSON.stringify(aggregated));

      requests.length = 0;
      process.env.CLAUDE_USAGE_ACCOUNT_IDS = "5";
      const selected = await fetchClaudeUsageFromCustomAPI(baseUrl, "test-key");
      const selectionPass = selected?.accountCount === 1 &&
        selected?.sevenDay?.utilization === 80 &&
        requests.length === 1 &&
        requests[0].startsWith("/api/v1/admin/accounts/5/usage?");
      report("claude-explicit-account-selection", selectionPass, `${JSON.stringify(selected)} requests=${requests.length}`);

      const partial = aggregateClaudeUsage([
        {
          sevenDay: { utilization: 20, resetsAt: "2026-07-18T00:00:00+08:00" },
        },
        {
          sevenDay: null,
        },
      ]);
      const partialPass = partial?.accountCount === 2 &&
        partial?.sevenDay === null;
      report("claude-incomplete-window-not-averaged", partialPass, JSON.stringify(partial));
    } finally {
      if (originalIds === undefined) delete process.env.CLAUDE_USAGE_ACCOUNT_IDS;
      else process.env.CLAUDE_USAGE_ACCOUNT_IDS = originalIds;
      if (originalLegacyId === undefined) delete process.env.CLAUDE_USAGE_ACCOUNT_ID;
      else process.env.CLAUDE_USAGE_ACCOUNT_ID = originalLegacyId;
    }
  } catch (error) {
    report("claude-usage-test-error", false, error.stack || error.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  if (failed) process.exitCode = 1;
}

async function runAntigravityUsageTests() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dot-agy-usage-test-"));
  let failed = false;

  const report = (name, pass, detail) => {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!pass) failed = true;
  };

  try {
    const futureFiveHour = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const futureSevenDay = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const sampleCommandPayload = {
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.796, reset_time: futureSevenDay },
                { id: "gemini-5h", window: "5h", remaining_fraction: 0.841, reset_time: futureFiveHour },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
                { id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
              ],
            },
          ],
        },
      },
    };

    const geminiMapped = mapAgyUsageCommandOutput(sampleCommandPayload, "gemini");
    report(
      "agy-cli-gemini-mapping",
      Math.round(geminiMapped?.fiveHour?.utilization) === 16 &&
        Math.round(geminiMapped?.sevenDay?.utilization) === 20 &&
        geminiMapped?.fiveHour?.resetsAt === futureFiveHour &&
        geminiMapped?.sevenDay?.resetsAt === futureSevenDay,
      JSON.stringify(geminiMapped)
    );

    const thirdPartyMapped = mapAgyUsageCommandOutput(sampleCommandPayload, "3p");
    report(
      "agy-cli-epoch-reset-ignored",
      thirdPartyMapped?.fiveHour?.utilization === 0 &&
        thirdPartyMapped?.fiveHour?.resetsAt === null &&
        thirdPartyMapped?.sevenDay?.resetsAt === null,
      JSON.stringify(thirdPartyMapped)
    );

    const statusCacheDir = path.join(tempHome, "statusline-cache");
    const fixedNowMs = Date.parse("2026-11-26T04:00:00Z");
    const statusOk = handleAgyStatusLine(JSON.stringify({
      quota: {
        "gemini-5h": { remaining_fraction: 0.75, reset_in_seconds: 3600 },
        "gemini-weekly": { remaining_fraction: 0.6, reset_time: futureSevenDay },
      },
    }), { cacheDir: statusCacheDir, nowMs: fixedNowMs });
    const statusCached = readFreshAgyUsageCache(statusCacheDir, 10 * 60 * 1000, fixedNowMs + 1000);
    report(
      "agy-statusline-cache-write",
      statusOk &&
        statusCached?.source === "statusline" &&
        statusCached?.usage?.fiveHour?.utilization === 25 &&
        statusCached?.usage?.fiveHour?.resetsAt === "2026-11-26T05:00:00.000Z" &&
        statusCached?.usage?.sevenDay?.utilization === 40,
      JSON.stringify(statusCached)
    );

    const fakeAgyBin = path.join(tempHome, "fake-agy");
    const countFile = path.join(tempHome, "agy-requests.log");
    fs.writeFileSync(fakeAgyBin, [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "fs.appendFileSync(process.env.FAKE_AGY_COUNT_FILE, 'req\\n');",
      `const payload = ${JSON.stringify(sampleCommandPayload)};`,
      "setTimeout(() => { process.stdout.write(JSON.stringify(payload) + '\\n'); }, Number(process.env.FAKE_AGY_DELAY_MS || 0));",
    ].join("\n"), { mode: 0o755 });

    const liveCacheDir = path.join(tempHome, "live-cache");
    const liveOptions = {
      cacheDir: liveCacheDir,
      cacheTtlMs: 10 * 60 * 1000,
      agyBin: fakeAgyBin,
      cliTimeoutMs: 5000,
      lockStaleMs: 6000,
      lockWaitMs: 6000,
      env: {
        ...process.env,
        FAKE_AGY_COUNT_FILE: countFile,
        FAKE_AGY_DELAY_MS: "150",
      },
    };
    const [firstLive, secondLive] = await Promise.all([
      fetchAntigravityUsageWithFallback(liveOptions),
      fetchAntigravityUsageWithFallback(liveOptions),
    ]);
    const reqCount = fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
    report(
      "agy-cli-single-flight",
      Math.round(firstLive?.fiveHour?.utilization) === 16 &&
        JSON.stringify(firstLive) === JSON.stringify(secondLive) &&
        reqCount === 1,
      `requests=${reqCount} usage=${JSON.stringify(firstLive)}`
    );

    const cachedLive = await fetchAntigravityUsageWithFallback(liveOptions);
    const reqCountAfterCache = fs.readFileSync(countFile, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
    report(
      "agy-usage-cache-hit",
      Math.round(cachedLive?.sevenDay?.utilization) === 20 && reqCountAfterCache === 1,
      `requests=${reqCountAfterCache}`
    );
  } catch (error) {
    report("agy-usage-test-error", false, error.stack || error.message);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  if (failed) process.exitCode = 1;
}

// --- Main ---

async function main() {
  if (process.argv.includes("--agy-statusline")) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    handleAgyStatusLine(input);
    return;
  }

  const testIdx = process.argv.indexOf("--test");
  if (testIdx !== -1) {
    const testName = process.argv[testIdx + 1];
    if (testName === "usage-refresh") {
      return runUsageRefreshTests();
    }
    return runTest(testName);
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
      status.displayMode = "sessions";
      try {
        await pushSessionsDisplay(sessions, { force: true });
        status.result = "pushed";
      } catch (err) {
        status.result = "error";
        status.error = err.message;
      }
    } else {
      status.displayMode = "usage";
      try {
        const usage = await fetchAllUsage();
        await pushUsageDisplay(usage, { force: true });
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
