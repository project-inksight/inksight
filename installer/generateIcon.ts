import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const SHIELD_SVG = `
<svg width="256" height="256" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0F172A" />
      <stop offset="100%" stop-color="#020617" />
    </linearGradient>
    <linearGradient id="emeraldGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#34D399" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
  </defs>
  <!-- Shield Body -->
  <path d="M128 16 L228 54 L228 128 C228 184 184 222 128 242 C72 222 28 184 28 128 L28 54 Z"
        fill="url(#bgGrad)" stroke="url(#emeraldGrad)" stroke-width="14" stroke-linejoin="round" />
  <!-- Camera Lens Outer Ring -->
  <circle cx="128" cy="124" r="46" fill="#0B1324" stroke="#10B981" stroke-width="10" />
  <!-- AI Vision Core -->
  <circle cx="128" cy="124" r="22" fill="url(#emeraldGrad)" />
  <!-- Lens Specular Highlight -->
  <circle cx="116" cy="112" r="7" fill="#ECFDF5" fill-opacity="0.9" />
</svg>
`;

async function buildIco(outputPath: string): Promise<void> {
  const sizes = [16, 32, 48, 256];
  const pngBuffers: Buffer[] = [];

  for (const sz of sizes) {
    const png = await sharp(Buffer.from(SHIELD_SVG))
      .resize(sz, sz)
      .png()
      .toBuffer();
    pngBuffers.push(png);
  }

  // Standard Windows ICO format: 6-byte ICONDIR + (16-byte ICONDIRENTRY * count) + PNG payloads
  const headerSize = 6 + 16 * sizes.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type: 1 = ICO
  header.writeUInt16LE(sizes.length, 4); // Image count

  let offset = headerSize;
  for (let i = 0; i < sizes.length; i++) {
    const sz = sizes[i];
    const png = pngBuffers[i];
    const entryOffset = 6 + i * 16;

    header.writeUInt8(sz === 256 ? 0 : sz, entryOffset + 0); // Width (0 means 256)
    header.writeUInt8(sz === 256 ? 0 : sz, entryOffset + 1); // Height (0 means 256)
    header.writeUInt8(0, entryOffset + 2); // Color palette
    header.writeUInt8(0, entryOffset + 3); // Reserved
    header.writeUInt16LE(1, entryOffset + 4); // Color planes
    header.writeUInt16LE(32, entryOffset + 6); // Bits per pixel
    header.writeUInt32LE(png.length, entryOffset + 8); // Image byte size
    header.writeUInt32LE(offset, entryOffset + 12); // Offset from start of file

    offset += png.length;
  }

  const icoBuffer = Buffer.concat([header, ...pngBuffers]);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, icoBuffer);
  console.log(`[IconGenerator] Generated multi-res shield icon: ${outputPath} (${icoBuffer.length} bytes)`);
}

const target = process.argv[2] || path.resolve(process.cwd(), 'installer', 'inksight.ico');
void buildIco(target);
