import {Profile, ProfileGroup, CallTreeProfileBuilder, FrameInfo} from '../lib/profile'
import {TextFileContent} from './utils'
import {TimeFormatter} from '../lib/value-formatters'
import {FileFormat} from '../lib/file-format-spec'

interface ParsedLogLine {
  level: number
  timestamp: number
  name: string
  file: string
  lineno: number
  code: string
}

interface CallStackFrame {
  frameId: number
  level: number
  timestamp: number
}

export function importFromZshTrace(
  contents: TextFileContent,
  fileName: string,
): ProfileGroup | null {
  try {
    // Parse and sort log lines (keep existing parsing code)...
    const reorderedLog = parseAndSortLogLines(contents)

    // Convert to Evented Profile format
    const [eventedProfile, frames] = convertToEventedProfile(reorderedLog)

    // Use similar pattern as importSpeedscopeProfile
    const profile = importEventedProfile(eventedProfile, frames)
    profile.setName(fileName)

    return {
      name: fileName,
      indexToView: 0,
      profiles: [profile],
    }
  } catch (e) {
    console.error('Failed to parse zsh trace:', e)
    return null
  }
}

function importEventedProfile(
  evented: FileFormat.EventedProfile,
  frames: FileFormat.Frame[],
): Profile {
  const {startValue, endValue, events} = evented
  const profile = new CallTreeProfileBuilder(endValue - startValue)

  // Set common properties like in importSpeedscopeProfile
  profile.setValueFormatter(new TimeFormatter('seconds'))
  profile.setName(evented.name)

  // Convert frames to FrameInfo array
  const frameInfos: FrameInfo[] = frames.map((frame, i) => ({
    key: i,
    name: frame.name,
    file: frame.file,
    line: frame.line,
  }))

  // Process events in order
  for (let ev of events) {
    switch (ev.type) {
      case FileFormat.EventType.OPEN_FRAME:
        profile.enterFrame(frameInfos[ev.frame], ev.at - startValue, ev.executedCode)
        break
      case FileFormat.EventType.CLOSE_FRAME:
        profile.leaveFrame(frameInfos[ev.frame], ev.at - startValue)
        break
    }
  }

  return profile.build()
}

function convertToEventedProfile(
  logLines: ParsedLogLine[],
): [FileFormat.EventedProfile, FileFormat.Frame[]] {
  const frames: FileFormat.Frame[] = []
  const events: FileFormat.EventedProfile['events'] = []
  const frameMap: Record<string, number> = {}
  const callStack: CallStackFrame[] = []

  for (const line of logLines) {
    const frameKey = `${line.name}:${line.lineno}`

    // Get or create frame index
    let frameIndex = frameMap[frameKey]
    if (frameIndex === undefined) {
      frameMap[frameKey] = frameIndex = frames.length
      frames.push({
        name: line.name,
        file: line.file,
        line: line.lineno,
      })
    }

    // Close frames that have ended
    while (callStack.length && callStack[callStack.length - 1].level >= line.level) {
      const lastFrame = callStack.pop()!

      // Add close event
      events.push({
        type: FileFormat.EventType.CLOSE_FRAME,
        at: line.timestamp,
        frame: lastFrame.frameId,
      })
    }

    // Open new frame
    events.push({
      type: FileFormat.EventType.OPEN_FRAME,
      at: line.timestamp,
      frame: frameIndex,
      executedCode: line.code,
    })

    callStack.push({
      frameId: frameIndex,
      level: line.level,
      timestamp: line.timestamp,
    })
  }

  // Close any remaining frames in the call stack
  if (callStack.length > 0) {
    const finalTimestamp = events[events.length - 1].at

    while (callStack.length > 0) {
      const lastFrame = callStack.pop()!

      // Add final close events
      events.push({
        type: FileFormat.EventType.CLOSE_FRAME,
        at: finalTimestamp,
        frame: lastFrame.frameId,
      })
    }
  }

  // Get time bounds
  const startValue = events.length ? events[0].at : 0
  const endValue = events.length ? events[events.length - 1].at : 0

  return [
    {
      type: FileFormat.ProfileType.EVENTED,
      name: 'Execution Profile',
      unit: 'seconds',
      startValue,
      endValue,
      events,
    },
    frames,
  ]
}

function parseAndSortLogLines(contents: TextFileContent): ParsedLogLine[] {
  const LOG_LINE_PATTERN =
    /^\+Z\|(?<level>\d+)\|(?<timestamp>[\d\.]+)\|(?<name>[^|]+)\|(?<file>[^|]+)\|(?<lineno>\d+)>\s(?<code>.*)$/
  const LOG_SEGMENT_PATTERN =
    /\+Z\|(?<level>\d+)\|(?<timestamp>[\d\.]+)\|(?<name>[^|]+)\|(?<file>[^|]+)\|(?<lineno>\d+)>\s(?<code>.+?)(?=$|\+Z\|[^%])/g

  const lines = contents.splitLines()
  const reorderedLog: ParsedLogLine[] = []

  // First pass - parse and collect all log entries
  for (const line of lines) {
    const trimmedLine = line.trim()
    if (!trimmedLine) continue

    // Sometimes multiple execution traces will be joined together in the same line.
    // We try first to match these as segments, and if that doesn't work, we'll try the single line match
    const segments = Array.from(trimmedLine.matchAll(LOG_SEGMENT_PATTERN))
    if (segments.length > 0) {
      for (const match of segments) {
        const {level, timestamp, name, file, lineno, code} = match.groups!
        reorderedLog.push({
          level: parseInt(level),
          timestamp: parseFloat(timestamp!),
          name: name.trim(),
          file: file.trim(),
          lineno: parseInt(lineno),
          code: code.trim(),
        })
      }
    } else {
      // Try single line match
      const match = trimmedLine.match(LOG_LINE_PATTERN)
      if (match) {
        const {level, timestamp, name, file, lineno, code} = match.groups!
        reorderedLog.push({
          level: parseInt(level),
          timestamp: parseFloat(timestamp!),
          name: name.trim(),
          file: file.trim(),
          lineno: parseInt(lineno),
          code: code.trim(),
        })
      }
    }
  }

  // Sort by timestamp
  reorderedLog.sort((a, b) => a.timestamp - b.timestamp)

  return reorderedLog
}
