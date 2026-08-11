import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const rootDir = process.cwd();
const buildDir = path.join(rootDir, "build");
const iconsDir = path.join(buildDir, "icons");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

await mkdir(iconsDir, { recursive: true });

const pngBySize = new Map();
for (const size of sizes) {
  const png = encodePng(size, size, renderIcon(size));
  pngBySize.set(size, png);
  await writeFile(path.join(iconsDir, `${size}x${size}.png`), png);
}

await writeFile(path.join(buildDir, "icon.png"), pngBySize.get(512));
await writeFile(path.join(buildDir, "icon.ico"), encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngBySize.get(size) }))));
await writeFile(
  path.join(buildDir, "icon.icns"),
  encodeIcns([
    { type: "icp4", png: pngBySize.get(16) },
    { type: "icp5", png: pngBySize.get(32) },
    { type: "icp6", png: pngBySize.get(64) },
    { type: "ic07", png: pngBySize.get(128) },
    { type: "ic08", png: pngBySize.get(256) },
    { type: "ic09", png: pngBySize.get(512) },
    { type: "ic10", png: pngBySize.get(1024) }
  ])
);

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 24;
  const iconPoint = (value) => value * scale;
  // Match src/assets/git-ui-pro-mark.svg — geometric "G" with open counter.
  const tileTop = [58, 220, 196];
  const tileMid = [43, 176, 212];
  const tileBottom = [69, 120, 236];
  const small = size <= 32;
  const stroke = Math.max(iconPoint(small ? 2.55 : 2.4), small ? 1.5 : 1.25);
  const nodeRadius = iconPoint(small ? 1.95 : 1.78);
  const mark = [255, 255, 255, 255];

  // Monogram geometry (SVG units). Spur lives in the right half only.
  const gCx = 11.05;
  const gCy = 11.85;
  const gR = 5.35;
  const gapDeg = 42;
  const spurStartX = 13.45;
  const spurEndX = 15.55;
  const nodeX = 16.05;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = roundedRectAlpha(
        x + 0.5,
        y + 0.5,
        iconPoint(0.5),
        iconPoint(0.5),
        iconPoint(23),
        iconPoint(23),
        iconPoint(6.35)
      );
      const svgX = (x + 0.5) / scale;
      const svgY = (y + 0.5) / scale;
      const t = clamp(((svgX - 3) * 18 + (svgY - 1.5) * 21) / (18 * 18 + 21 * 21), 0, 1);
      let color = t <= 0.5
        ? mixColor(tileTop, tileMid, t / 0.5)
        : mixColor(tileMid, tileBottom, (t - 0.5) / 0.5);
      const glow = clamp(1 - Math.hypot(svgX - 6.5, svgY - 5) / 13, 0, 1);
      const shade = clamp(1 - Math.hypot(svgX - 17.5, svgY - 18.5) / 11, 0, 1);
      color = mixColor(color, [255, 255, 255], glow * 0.2);
      color = mixColor(color, [27, 69, 176], shade * 0.16);
      setPixel(pixels, size, x, y, color[0], color[1], color[2], Math.round(alpha * 255));
    }
  }

  drawRoundedRectStroke(
    pixels,
    size,
    iconPoint(1.1),
    iconPoint(1.1),
    iconPoint(21.8),
    iconPoint(21.8),
    iconPoint(5.85),
    Math.max(iconPoint(0.65), 0.4),
    [255, 255, 255, 56]
  );

  // Open ring: gap on the right (±gapDeg). Sweep the long way via the left side.
  const startAngle = (gapDeg * Math.PI) / 180;
  const endAngle = ((360 - gapDeg) * Math.PI) / 180;
  drawArc(pixels, size, iconPoint(gCx), iconPoint(gCy), iconPoint(gR), startAngle, endAngle, stroke, mark);

  // Short spur — starts off-center so the counter stays open (less "dumbbell")
  drawLine(
    pixels,
    size,
    iconPoint(spurStartX),
    iconPoint(gCy),
    iconPoint(spurEndX),
    iconPoint(gCy),
    stroke,
    mark
  );

  // Terminal node
  drawCircle(pixels, size, iconPoint(nodeX), iconPoint(gCy), nodeRadius, mark);

  return pixels;
}

/**
 * Distance-field arc stroke from startAngle → endAngle (CCW, radians).
 * Round caps are added at both endpoints.
 */
function drawArc(pixels, size, cx, cy, radius, startAngle, endAngle, width, color) {
  let sweep = endAngle - startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }

  const half = width / 2;
  const pad = half + 1.25;
  const minX = Math.floor(cx - radius - pad);
  const maxX = Math.ceil(cx + radius + pad);
  const minY = Math.floor(cy - radius - pad);
  const maxY = Math.ceil(cy + radius + pad);
  const twoPi = Math.PI * 2;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (x < 0 || y < 0 || x >= size || y >= size) {
        continue;
      }

      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const radial = Math.abs(dist - radius);
      if (radial > half + 0.85) {
        continue;
      }

      let angle = Math.atan2(dy, dx);
      let delta = angle - startAngle;
      while (delta < 0) {
        delta += twoPi;
      }
      while (delta >= twoPi) {
        delta -= twoPi;
      }

      if (delta > sweep) {
        continue;
      }

      const alpha = clamp(half + 0.8 - radial, 0, 1);
      if (alpha > 0) {
        blendPixel(pixels, size, x, y, color[0], color[1], color[2], color[3] * alpha);
      }
    }
  }

  // Round caps
  const capR = half;
  drawCircle(
    pixels,
    size,
    cx + Math.cos(startAngle) * radius,
    cy + Math.sin(startAngle) * radius,
    capR,
    color
  );
  drawCircle(
    pixels,
    size,
    cx + Math.cos(endAngle) * radius,
    cy + Math.sin(endAngle) * radius,
    capR,
    color
  );
}

function drawRoundedRectStroke(pixels, size, x, y, width, height, radius, strokeWidth, color) {
  for (let py = Math.floor(y - 1); py <= Math.ceil(y + height + 1); py += 1) {
    for (let px = Math.floor(x - 1); px <= Math.ceil(x + width + 1); px += 1) {
      if (px < 0 || py < 0 || px >= size || py >= size) {
        continue;
      }
      const outer = roundedRectAlpha(px + 0.5, py + 0.5, x - strokeWidth / 2, y - strokeWidth / 2, width + strokeWidth, height + strokeWidth, radius + strokeWidth / 2);
      const inner = roundedRectAlpha(px + 0.5, py + 0.5, x + strokeWidth / 2, y + strokeWidth / 2, width - strokeWidth, height - strokeWidth, Math.max(0, radius - strokeWidth / 2));
      const alpha = clamp(outer - inner, 0, 1);
      if (alpha > 0) {
        blendPixel(pixels, size, px, py, color[0], color[1], color[2], color[3] * alpha);
      }
    }
  }
}

function drawCubicBezier(pixels, size, start, controlA, controlB, end, width, color) {
  const steps = Math.max(12, Math.ceil(Math.hypot(end[0] - start[0], end[1] - start[1]) * 1.4));
  let previous = start;
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const inverse = 1 - t;
    const current = [
      inverse ** 3 * start[0] + 3 * inverse ** 2 * t * controlA[0] + 3 * inverse * t ** 2 * controlB[0] + t ** 3 * end[0],
      inverse ** 3 * start[1] + 3 * inverse ** 2 * t * controlA[1] + 3 * inverse * t ** 2 * controlB[1] + t ** 3 * end[1]
    ];
    drawLine(pixels, size, previous[0], previous[1], current[0], current[1], width, color);
    previous = current;
  }
}

function drawRingCircle(pixels, size, cx, cy, radius, fill, stroke, strokeWidth) {
  drawCircle(pixels, size, cx, cy, radius, stroke);
  drawCircle(pixels, size, cx, cy, Math.max(0, radius - strokeWidth), fill);
}

function roundedRectAlpha(px, py, x, y, width, height, radius) {
  const qx = Math.abs(px - x - width / 2) - width / 2 + radius;
  const qy = Math.abs(py - y - height / 2) - height / 2 + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const distance = outside + inside - radius;
  return clamp(0.5 - distance, 0, 1);
}

function drawLine(pixels, size, x1, y1, x2, y2, width, color) {
  const minX = Math.floor(Math.min(x1, x2) - width * 2);
  const maxX = Math.ceil(Math.max(x1, x2) + width * 2);
  const minY = Math.floor(Math.min(y1, y2) - width * 2);
  const maxY = Math.ceil(Math.max(y1, y2) + width * 2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (x < 0 || y < 0 || x >= size || y >= size) {
        continue;
      }

      const t = clamp(((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / lengthSq, 0, 1);
      const px = x1 + t * dx;
      const py = y1 + t * dy;
      const distance = Math.hypot(x + 0.5 - px, y + 0.5 - py);
      const alpha = clamp(width / 2 + 0.8 - distance, 0, 1);
      blendPixel(pixels, size, x, y, color[0], color[1], color[2], color[3] * alpha);
    }
  }
}

function drawCircle(pixels, size, cx, cy, radius, color) {
  const minX = Math.floor(cx - radius - 2);
  const maxX = Math.ceil(cx + radius + 2);
  const minY = Math.floor(cy - radius - 2);
  const maxY = Math.ceil(cy + radius + 2);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (x < 0 || y < 0 || x >= size || y >= size) {
        continue;
      }

      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const alpha = clamp(radius + 0.8 - distance, 0, 1);
      blendPixel(pixels, size, x, y, color[0], color[1], color[2], color[3] * alpha);
    }
  }
}

function setPixel(pixels, size, x, y, r, g, b, a) {
  const offset = (y * size + x) * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
}

function blendPixel(pixels, size, x, y, r, g, b, a) {
  const offset = (y * size + x) * 4;
  const sourceAlpha = clamp(a / 255, 0, 1);
  const targetAlpha = pixels[offset + 3] / 255;
  const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outAlpha <= 0) {
    return;
  }

  pixels[offset] = Math.round((r * sourceAlpha + pixels[offset] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[offset + 1] = Math.round((g * sourceAlpha + pixels[offset + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[offset + 2] = Math.round((b * sourceAlpha + pixels[offset + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha);
  pixels[offset + 3] = Math.round(outAlpha * 255);
}

function mixColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

function encodePng(width, height, rgba) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let imageOffset = header.length + directory.length;
  for (const [index, image] of images.entries()) {
    const entryOffset = index * 16;
    directory[entryOffset] = image.size >= 256 ? 0 : image.size;
    directory[entryOffset + 1] = image.size >= 256 ? 0 : image.size;
    directory[entryOffset + 2] = 0;
    directory[entryOffset + 3] = 0;
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.png.length, entryOffset + 8);
    directory.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.png.length;
  }

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

function encodeIcns(images) {
  const chunks = images.map((image) => {
    const header = Buffer.alloc(8);
    header.write(image.type, 0, 4, "ascii");
    header.writeUInt32BE(image.png.length + header.length, 4);
    return Buffer.concat([header, image.png]);
  });
  const header = Buffer.alloc(8);
  const totalLength = header.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
