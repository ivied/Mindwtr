/**
 * Voice enrollment CLI — one-time setup so the diarizer can recognise
 * the user across captures.
 *
 *   bun run src/cli/enroll.ts [--duration 30] [--output ~/.gtd-voice-profile.json]
 *
 * Records a clean sample of the user speaking, wraps it as WAV, runs
 * gtd-audio-enroll, and writes the 256-d embedding profile.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { wrapPcmAsWav } from '../capture/wav-wrap'

interface Args {
  duration: number
  output: string
  capture: string
  enroll: string
  name: string
}

function parseArgs(): Args {
  const args: Args = {
    duration: 30,
    output: join(homedir(), '.gtd-voice-profile.json'),
    capture: process.env.AGENT_AUDIO_HELPER_PATH || './audio-helper/gtd-audio-capture',
    enroll: process.env.AGENT_AUDIO_ENROLL_BINARY || './audio-helper/gtd-audio-enroll',
    name: 'user',
  }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--duration':
        args.duration = Number(argv[++i] ?? args.duration)
        break
      case '--output':
        args.output = argv[++i] ?? args.output
        break
      case '--capture':
        args.capture = argv[++i] ?? args.capture
        break
      case '--enroll':
        args.enroll = argv[++i] ?? args.enroll
        break
      case '--name':
        args.name = argv[++i] ?? args.name
        break
      case '--help':
      case '-h':
        console.log(
          'Usage: bun run src/cli/enroll.ts [--duration 30] [--output ~/.gtd-voice-profile.json] [--name user]'
        )
        process.exit(0)
    }
  }
  return args
}

async function recordPcm(captureBin: string, durationSec: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(captureBin, ['--duration', String(durationSec)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (b: Buffer) => chunks.push(b))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`capture exit ${code}`))
    })
  })
}

async function runEnroll(
  enrollBin: string,
  wavPath: string,
  outPath: string,
  name: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      enrollBin,
      ['--input', wavPath, '--output', outPath, '--name', name],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`enroll exit ${code}`))))
  })
}

async function main() {
  const args = parseArgs()

  console.log('🎤 Voice enrollment — speak clearly for the next', args.duration, 'seconds.')
  console.log('   Use your normal speaking voice. A short paragraph in a single take is ideal.')
  console.log('   Recording starts in 3…')
  await new Promise((r) => setTimeout(r, 1000))
  console.log('   2…')
  await new Promise((r) => setTimeout(r, 1000))
  console.log('   1…')
  await new Promise((r) => setTimeout(r, 1000))
  console.log('🔴 Recording.')

  const pcm = await recordPcm(args.capture, args.duration)
  console.log(`   captured ${pcm.length} bytes (${pcm.length / (16000 * 2)}s @ 16kHz Int16)`)

  const wav = wrapPcmAsWav(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 })
  const workDir = await mkdtemp(join(tmpdir(), 'gtd-enroll-'))
  const wavPath = join(workDir, 'enroll.wav')
  await writeFile(wavPath, wav)

  console.log(`🧠 Running enroll → ${args.output} (will download models on first run)`)
  try {
    await runEnroll(args.enroll, wavPath, args.output, args.name)
    console.log(`✅ profile saved: ${args.output}`)
    console.log(`   add to .env.local:  AGENT_VOICE_PROFILE_PATH=${args.output}`)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
