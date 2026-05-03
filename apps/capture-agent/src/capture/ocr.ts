/**
 * OCR provider — uses tesseract.js. Worker is created once and reused.
 *
 * Note: tesseract.js downloads ~10–30MB language data on first run; cached afterwards.
 */

import { createWorker, type Worker } from 'tesseract.js'

export interface OcrProvider {
  recognize(image: Buffer): Promise<string>
  shutdown(): Promise<void>
}

export class TesseractOcrProvider implements OcrProvider {
  private workerPromise: Promise<Worker> | null = null

  constructor(private lang: string = 'eng') {}

  private async getWorker(): Promise<Worker> {
    if (!this.workerPromise) {
      this.workerPromise = createWorker(this.lang)
    }
    return this.workerPromise
  }

  async recognize(image: Buffer): Promise<string> {
    const worker = await this.getWorker()
    const result = await worker.recognize(image)
    return (result.data.text ?? '').trim()
  }

  async shutdown(): Promise<void> {
    if (!this.workerPromise) return
    const worker = await this.workerPromise
    await worker.terminate()
    this.workerPromise = null
  }
}
