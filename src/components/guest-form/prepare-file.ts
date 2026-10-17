// Browser-side preparation of an ID file before upload (PDR 6.3).
//
//   * Photos are resized so the long edge is at most 1600 px and re-encoded as
//     JPEG at quality 0.85. A phone photo drops from ~4 MB to a few hundred KB,
//     which also keeps one submit under the host's ~4.5 MB request cap.
//   * PDFs pass through unchanged, up to MAX_PDF_BYTES.
//   * The file's content, not its name, decides what it is: that is re-checked
//     on the server by looking at the first bytes.

import {
  fitWithin,
  IMAGE_JPEG_QUALITY,
  IMAGE_MAX_EDGE,
  MAX_PDF_BYTES,
} from '@/lib/stays/files'

export type PrepareProblem = 'pdfTooLarge' | 'unreadable' | 'unsupported'

export class PrepareError extends Error {
  constructor(public problem: PrepareProblem) {
    super(problem)
  }
}

export interface PreparedFile {
  file: File
  isPdf: boolean
}

function looksLikePdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

function decode(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new PrepareError('unreadable'))
    }
    img.src = url
  })
}

export async function prepareIdFile(file: File): Promise<PreparedFile> {
  if (looksLikePdf(file)) {
    if (file.size > MAX_PDF_BYTES) throw new PrepareError('pdfTooLarge')
    return { file, isPdf: true }
  }
  if (file.type && !file.type.startsWith('image/')) throw new PrepareError('unsupported')

  const img = await decode(file)
  const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, IMAGE_MAX_EDGE)
  if (!width || !height) throw new PrepareError('unreadable')

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PrepareError('unreadable')
  // JPEG has no transparency: put PNG / WebP on white.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', IMAGE_JPEG_QUALITY),
  )
  if (!blob) throw new PrepareError('unreadable')
  return { file: new File([blob], 'id.jpg', { type: 'image/jpeg' }), isPdf: false }
}
