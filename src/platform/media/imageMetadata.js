// @ts-check

const MAX_IMAGE_DIMENSION = 100_000;
const MAX_IMAGE_PIXELS = 400_000_000;

function readImageMetadata(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const metadata = readPng(buffer)
    || readGif(buffer)
    || readJpeg(buffer)
    || readWebp(buffer)
    || readBmp(buffer)
    || readIco(buffer)
    || readPsd(buffer)
    || readTiff(buffer)
    || readSvg(buffer);
  if (!metadata) throw imageMetadataError("图片格式不受支持或文件已损坏。");
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1
    || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
    || width * height > MAX_IMAGE_PIXELS) {
    throw imageMetadataError("图片尺寸无效或超过安全上限。");
  }
  return { ...metadata, width, height };
}

function readPng(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { type: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readGif(buffer) {
  if (buffer.length < 10 || !["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return null;
  return { type: "gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let steps = 0;
  while (offset + 1 < buffer.length && steps < 65_536) {
    steps += 1;
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return {
        type: "jpg",
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += length;
  }
  return null;
}

function readWebp(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  let offset = 12;
  let steps = 0;
  while (offset + 8 <= buffer.length && steps < 1024) {
    steps += 1;
    const chunk = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (size > buffer.length - data) return null;
    if (chunk === "VP8X" && size >= 10) {
      return {
        type: "webp",
        width: 1 + readUInt24LE(buffer, data + 4),
        height: 1 + readUInt24LE(buffer, data + 7)
      };
    }
    if (chunk === "VP8 " && size >= 10 && buffer.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return {
        type: "webp",
        width: buffer.readUInt16LE(data + 6) & 0x3fff,
        height: buffer.readUInt16LE(data + 8) & 0x3fff
      };
    }
    if (chunk === "VP8L" && size >= 5 && buffer[data] === 0x2f) {
      return {
        type: "webp",
        width: 1 + buffer[data + 1] + ((buffer[data + 2] & 0x3f) << 8),
        height: 1 + (buffer[data + 2] >> 6) + (buffer[data + 3] << 2) + ((buffer[data + 4] & 0x0f) << 10)
      };
    }
    offset = data + size + (size % 2);
  }
  return null;
}

function readBmp(buffer) {
  if (buffer.length < 26 || buffer.toString("ascii", 0, 2) !== "BM") return null;
  const headerSize = buffer.readUInt32LE(14);
  if (headerSize === 12) {
    return { type: "bmp", width: buffer.readUInt16LE(18), height: buffer.readUInt16LE(20) };
  }
  return {
    type: "bmp",
    width: Math.abs(buffer.readInt32LE(18)),
    height: Math.abs(buffer.readInt32LE(22))
  };
}

function readIco(buffer) {
  if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0 || ![1, 2].includes(buffer.readUInt16LE(2))
    || buffer.readUInt16LE(4) < 1) return null;
  return {
    type: buffer.readUInt16LE(2) === 2 ? "cur" : "ico",
    width: buffer[6] || 256,
    height: buffer[7] || 256
  };
}

function readPsd(buffer) {
  if (buffer.length < 26 || buffer.toString("ascii", 0, 4) !== "8BPS" || ![1, 2].includes(buffer.readUInt16BE(4))) return null;
  return { type: "psd", height: buffer.readUInt32BE(14), width: buffer.readUInt32BE(18) };
}

function readTiff(buffer) {
  if (buffer.length < 8) return null;
  const byteOrder = buffer.toString("ascii", 0, 2);
  if (!['II', 'MM'].includes(byteOrder)) return null;
  const littleEndian = byteOrder === "II";
  const read16 = (offset) => littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const read32 = (offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  if (read16(2) !== 42) return null;
  const ifd = read32(4);
  if (ifd > buffer.length - 2) return null;
  const count = Math.min(read16(ifd), 4096);
  let width = 0;
  let height = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry > buffer.length - 12) return null;
    const tag = read16(entry);
    if (tag !== 256 && tag !== 257) continue;
    const value = readTiffScalar(buffer, entry, littleEndian);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
    if (width && height) return { type: "tiff", width, height };
  }
  return null;
}

function readTiffScalar(buffer, entry, littleEndian) {
  const read16 = (offset) => littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const read32 = (offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const type = read16(entry + 2);
  const count = read32(entry + 4);
  if (count !== 1 || ![3, 4].includes(type)) return 0;
  return type === 3 ? read16(entry + 8) : read32(entry + 8);
}

function readSvg(buffer) {
  const text = buffer.subarray(0, Math.min(buffer.length, 262_144)).toString("utf8");
  const svg = /<svg\b([^>]*)>/i.exec(text)?.[1] || "";
  if (!svg) return null;
  const width = svgNumber(svg, "width");
  const height = svgNumber(svg, "height");
  if (width && height) return { type: "svg", width: Math.round(width), height: Math.round(height) };
  const viewBox = /\bviewBox\s*=\s*["']\s*[-+\d.e]+[ ,]+[-+\d.e]+[ ,]+([-+\d.e]+)[ ,]+([-+\d.e]+)\s*["']/i.exec(svg);
  return viewBox ? { type: "svg", width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) } : null;
}

function svgNumber(attributes, name) {
  const value = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([-+\\d.e]+)`, "i").exec(attributes)?.[1];
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function imageMetadataError(message) {
  return Object.assign(new Error(message), { code: "IMAGE_METADATA_INVALID" });
}

module.exports = { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, readImageMetadata };
