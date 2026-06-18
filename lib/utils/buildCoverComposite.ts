// Server-side blur-background + contain-foreground image composite using sharp.
// Used by instagram-card (1080×1080) and image-proxy (arbitrary dimensions).
export async function buildCoverComposite(
  inputBuf: Buffer,
  outW: number,
  outH: number,
  blurSigma = 22,
  feather = 40,
): Promise<Buffer> {
  const { default: sharp } = await import('sharp')

  const meta = await sharp(inputBuf).metadata()
  const iw = meta.width ?? outW
  const ih = meta.height ?? outH

  // 1. Blurred background: over-size then crop to eliminate edge artifacts
  const pad = Math.ceil(blurSigma * 2.5)
  const blurBuf = await sharp(inputBuf)
    .resize(outW + pad * 2, outH + pad * 2, { fit: 'cover', position: 'centre' })
    .blur(blurSigma)
    .extract({ left: pad, top: pad, width: outW, height: outH })
    .jpeg({ quality: 82 })
    .toBuffer()

  // 2. Foreground: contain (letter/pillar-box), centred
  const scale = Math.min(outW / iw, outH / ih)
  const fw = Math.round(iw * scale)
  const fh = Math.round(ih * scale)
  const fx = Math.round((outW - fw) / 2)
  const fy = Math.round((outH - fh) / 2)

  const fgBuf = await sharp(inputBuf)
    .resize(fw, fh, { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer()

  // 3. Feathering mask — only on sides that have letter/pillar-box space
  const fL = fx > 0 ? feather : 0
  const fR = fx > 0 ? feather : 0
  const fT = fy > 0 ? feather : 0
  const fB = fy > 0 ? feather : 0

  const maskData = new Uint8Array(fw * fh * 4)
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const i = (y * fw + x) * 4
      let a = 255
      if (fL > 0 && x < fL)        a = Math.min(a, Math.round((x / fL) * 255))
      if (fR > 0 && x >= fw - fR)   a = Math.min(a, Math.round(((fw - 1 - x) / fR) * 255))
      if (fT > 0 && y < fT)        a = Math.min(a, Math.round((y / fT) * 255))
      if (fB > 0 && y >= fh - fB)   a = Math.min(a, Math.round(((fh - 1 - y) / fB) * 255))
      maskData[i] = maskData[i + 1] = maskData[i + 2] = 255
      maskData[i + 3] = a
    }
  }

  const maskedFg = await sharp(fgBuf)
    .composite([{
      input: Buffer.from(maskData.buffer),
      raw: { width: fw, height: fh, channels: 4 },
      blend: 'dest-in',
    }])
    .png()
    .toBuffer()

  return sharp(blurBuf)
    .composite([{ input: maskedFg, left: fx, top: fy, blend: 'over' }])
    .jpeg({ quality: 88 })
    .toBuffer()
}
