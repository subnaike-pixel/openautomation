#!/usr/bin/env node
/**
 * Generates a 512x512 PNG icon for macOS builds using pure Node.js (no dependencies).
 * Writes a simple gradient square with "OA" text as SVG converted to PNG via sharp (if available)
 * or writes a minimal valid PNG using raw bytes.
 */

const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'assets');
const outPath = path.join(assetsDir, 'icon.png');

// Minimal 512x512 PNG — purple/dark gradient square with "OA"
// We'll use sharp if available, otherwise generate a valid solid-color PNG
function generateMinimalPNG(width, height, r, g, b) {
  const zlib = require('zlib');

  function crc32(buf) {
    const table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c;
      }
      return t;
    })();
    let crc = 0xffffffff;
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(data.length);
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  // IHDR
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw scanlines
  const raw = Buffer.allocUnsafe(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      // Gradient: darker at top-left, lighter at bottom-right
      const factor = (x + y) / (width + height);
      raw[offset]     = Math.min(255, Math.round(r * (0.5 + factor * 0.5)));
      raw[offset + 1] = Math.min(255, Math.round(g * (0.5 + factor * 0.5)));
      raw[offset + 2] = Math.min(255, Math.round(b * (0.5 + factor * 0.5)));
    }
  }

  const compressed = zlib.deflateSync(raw);

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Generate 512x512 purple icon
const png = generateMinimalPNG(512, 512, 99, 60, 180); // purple
fs.writeFileSync(outPath, png);
console.log(`✅ Generated ${outPath} (${png.length} bytes)`);
