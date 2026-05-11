import { describe, it, expect } from 'bun:test'
import { pngDimensions } from './png-dimensions'

function makePngHeader(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrLen = Buffer.from([0, 0, 0, 13])
  const ihdrType = Buffer.from('IHDR', 'ascii')
  const wh = Buffer.alloc(8)
  wh.writeUInt32BE(width, 0)
  wh.writeUInt32BE(height, 4)
  return Buffer.concat([sig, ihdrLen, ihdrType, wh])
}

describe('pngDimensions', () => {
  it('parses width and height from a synthetic header', () => {
    expect(pngDimensions(makePngHeader(3456, 2234))).toEqual({ width: 3456, height: 2234 })
    expect(pngDimensions(makePngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('throws on non-PNG buffer', () => {
    expect(() => pngDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toThrow()
    expect(() => pngDimensions(Buffer.alloc(10))).toThrow()
  })
})
