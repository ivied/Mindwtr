/**
 * Parse pixel dimensions from a PNG header. Cheap — reads only the IHDR
 * chunk (bytes 16-23). Throws if the buffer isn't a PNG.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface PngDimensions {
  width: number
  height: number
}

export function pngDimensions(buf: Buffer): PngDimensions {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG buffer')
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  }
}
