/**
 * The first bytes of a PNG of the given size: the signature and an IHDR
 * chunk, which is all the catalog reads from an image. `extra` pads the file
 * so two images of the same size can differ.
 */
export function pngHeader(width: number, height: number, extra = ""): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    Buffer.from(extra),
  ]);
}
