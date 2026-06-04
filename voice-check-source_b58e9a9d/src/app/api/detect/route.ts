import { NextRequest, NextResponse } from 'next/server';
import { parseWav, analyzeNoise, analyzeEcho, analyzeStereoContent } from '@/lib/audio-analyzer';
import { ASRClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

/**
 * Convert any audio format to stereo 16-bit PCM WAV using ffmpeg.
 * Always decodes to 2 channels so we can analyze actual stereo content
 * even if the container metadata says mono (common for downmixed MP3s).
 * Returns the WAV buffer and the original audio metadata from container.
 */
async function convertToWav(inputBuffer: Buffer, originalExt: string): Promise<{
  wavBuffer: Buffer;
  originalChannels: number;
  originalSampleRate: number;
  originalDuration: number;
}> {
  const tmpDir = os.tmpdir();
  const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const inputPath = path.join(tmpDir, `voice-check-input-${uniqueId}${originalExt}`);
  const outputPath = path.join(tmpDir, `voice-check-output-${uniqueId}.wav`);

  try {
    // Write input file to temp
    await writeFile(inputPath, inputBuffer);

    // Use ffmpeg to convert to stereo 16-bit PCM WAV at original sample rate
    // First, probe the original metadata
    const { stdout: probeOutput } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      inputPath,
    ]);

    const probeData = JSON.parse(probeOutput);
    const audioStream = (probeData.streams || []).find(
      (s: Record<string, unknown>) => s.codec_type === 'audio'
    );
    const originalChannels = typeof audioStream?.channels === 'number' ? audioStream.channels : 0;
    const originalSampleRate = typeof audioStream?.sample_rate === 'number'
      ? audioStream.sample_rate
      : parseInt(String(audioStream?.sample_rate || '0'), 10) || 0;
    const originalDuration = typeof probeData.format?.duration === 'number'
      ? probeData.format.duration
      : parseFloat(String(probeData.format?.duration || '0')) || 0;

    // Always convert to stereo WAV so we can check for actual stereo content
    // Many "mono" MP3s are actually downmixed from stereo recordings
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-ac', '2',               // Always stereo output for analysis
      '-ar', String(originalSampleRate || 44100),  // preserve sample rate
      '-sample_fmt', 's16',     // 16-bit PCM
      '-f', 'wav',
      outputPath,
    ]);

    // Read the converted WAV file
    const { default: fs } = await import('fs');
    const wavBuffer = fs.readFileSync(outputPath);

    return {
      wavBuffer,
      originalChannels,
      originalSampleRate,
      originalDuration,
    };
  } finally {
    // Clean up temp files
    try { await unlink(inputPath); } catch { /* ignore */ }
    try { await unlink(outputPath); } catch { /* ignore */ }
  }
}

export interface CheckItem {
  id: string;
  name: string;
  description: string;
  passed: boolean;
  details: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface DetectResult {
  fileName: string;
  fileSize: number;
  originalFormat: string;
  checks: CheckItem[];
  overallPassed: boolean;
  wavInfo?: {
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    duration: number;
  };
  channelOverlap?: {
    leftUtterances: Array<{ text: string; start_time: number; end_time: number }>;
    rightUtterances: Array<{ text: string; start_time: number; end_time: number }>;
    overlaps: Array<{
      leftText: string;
      rightText: string;
      leftStart: number;
      leftEnd: number;
      rightStart: number;
      rightEnd: number;
      overlapStart: number;
      overlapEnd: number;
      isCrosstalk: boolean;
      textSimilarity: number;
    }>;
  };
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data') && !contentType.includes('application/x-www-form-urlencoded')) {
      return NextResponse.json({ error: '请使用 multipart/form-data 格式上传音频文件' }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: '请上传音频文件' }, { status: 400 });
    }

    // Validate file type
    const validExtensions = ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.opus', '.aiff', '.ape'];
    const fileName = file.name.toLowerCase();
    const ext = fileName.substring(fileName.lastIndexOf('.'));
    if (!validExtensions.includes(ext)) {
      return NextResponse.json(
        { error: `不支持的文件格式: ${ext}，请上传 WAV/MP3/FLAC/OGG/M4A/AAC 等常见音频格式` },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // For non-WAV formats, convert to WAV using ffmpeg first
    let wavBuffer: Buffer;
    let originalFormat = ext.toUpperCase().replace('.', '');
    let originalChannelsFromProbe: number | null = null;
    let originalSampleRateFromProbe: number | null = null;
    let originalDurationFromProbe: number | null = null;

    if (ext !== '.wav') {
      try {
        const conversionResult = await convertToWav(buffer, ext);
        wavBuffer = conversionResult.wavBuffer;
        originalChannelsFromProbe = conversionResult.originalChannels;
        originalSampleRateFromProbe = conversionResult.originalSampleRate;
        originalDurationFromProbe = conversionResult.originalDuration;
      } catch (e) {
        return NextResponse.json(
          { error: `音频格式转换失败: ${e instanceof Error ? e.message : '未知错误'}，请确认文件可正常播放后重试` },
          { status: 400 }
        );
      }
    } else {
      wavBuffer = buffer;
    }

    const checks: CheckItem[] = [];

    // Parse WAV header
    let wavInfo;
    try {
      wavInfo = parseWav(wavBuffer);
    } catch (e) {
      return NextResponse.json(
        { error: `音频文件解析失败: ${e instanceof Error ? e.message : '未知错误'}` },
        { status: 400 }
      );
    }

    // Use probed metadata for non-WAV (more reliable for sample rate/duration)
    const effectiveSampleRate = originalSampleRateFromProbe ?? wavInfo.sampleRate;
    const effectiveDuration = originalDurationFromProbe ?? wavInfo.duration;

    // Check 1: Dual channel
    // For WAV files, trust the header directly.
    // For non-WAV files, we need deeper analysis:
    //   - Container metadata (ffprobe) might say "mono" even if the original was stereo
    //   - After decoding to stereo WAV, we can check if L/R channels are actually different
    //   - If channels differ significantly → true stereo (container was wrong / downmixed)
    //   - If channels are identical → mono upmix (container was correct)
    let channelCheck: CheckItem;
    if (ext === '.wav') {
      // WAV: trust the header directly
      channelCheck = {
        id: 'channels',
        name: '双声道检测',
        description: '检查音频是否为双声道（立体声）格式',
        passed: wavInfo.channels === 2,
        details: wavInfo.channels === 2
          ? `检测到双声道，符合要求`
          : wavInfo.channels === 1
            ? `检测到单声道。声音克隆需要双声道音频，建议检查原始录制设备设置，确保以立体声模式录制`
            : `检测到 ${wavInfo.channels} 声道，声音克隆需要双声道（2声道）音频`,
        severity: 'critical',
      };
    } else {
      // Non-WAV: analyze actual stereo content in decoded audio
      const stereoAnalysis = analyzeStereoContent(wavInfo);
      if (stereoAnalysis.isStereo) {
        // Decoded audio has genuine stereo separation
        channelCheck = {
          id: 'channels',
          name: '双声道检测',
          description: '检查音频是否为双声道（立体声）格式',
          passed: true,
          details: `检测到双声道（声道差异度 ${(stereoAnalysis.correlation * 100).toFixed(1)}%），符合双声道要求`,
          severity: 'critical',
        };
      } else {
        // Left and right channels are identical (or nearly so) → mono content
        const containerSaysMono = originalChannelsFromProbe === 1;
        channelCheck = {
          id: 'channels',
          name: '双声道检测',
          description: '检查音频是否为双声道（立体声）格式',
          passed: false,
          details: containerSaysMono
            ? `检测到单声道。${originalFormat} 文件声道数为 1，解码后左右声道内容完全一致（差异度 ${(stereoAnalysis.correlation * 100).toFixed(1)}%），说明原始录音已被混缩为单声道。声音克隆需要双声道音频，建议使用原始双声道录音文件`
            : `检测到单声道内容。虽然 ${originalFormat} 文件标记为 ${originalChannelsFromProbe} 声道，但解码后左右声道内容一致（差异度 ${(stereoAnalysis.correlation * 100).toFixed(1)}%），实际为单声道音频。建议检查原始录制设备设置`,
          severity: 'critical',
        };
      }
    }
    checks.push(channelCheck);

    // Check 2: Duration >= 5 minutes
    const requiredDuration = 5 * 60; // 5 minutes in seconds
    const durationCheck: CheckItem = {
      id: 'duration',
      name: '时长检测',
      description: '检查音频时长是否达到5分钟或以上',
      passed: effectiveDuration >= requiredDuration,
      details: effectiveDuration >= requiredDuration
        ? `音频时长 ${formatDuration(effectiveDuration)}，满足5分钟要求`
        : `音频时长 ${formatDuration(effectiveDuration)}，未达到5分钟要求（还差 ${formatDuration(requiredDuration - effectiveDuration)}）`,
      severity: 'critical',
    };
    checks.push(durationCheck);

    // Check 3: Sample rate >= 24kHz
    const requiredSampleRate = 24000;
    const sampleRateCheck: CheckItem = {
      id: 'sample_rate',
      name: '采样率检测',
      description: '检查音频采样率是否不低于24kHz',
      passed: effectiveSampleRate >= requiredSampleRate,
      details: effectiveSampleRate >= requiredSampleRate
        ? `采样率 ${effectiveSampleRate}Hz，满足24kHz要求`
        : `采样率 ${effectiveSampleRate}Hz，低于要求的24kHz（差 ${(requiredSampleRate - effectiveSampleRate)}Hz）`,
      severity: 'critical',
    };
    checks.push(sampleRateCheck);

    // Check 4: Background noise
    const noiseResult = analyzeNoise(wavInfo);
    const noiseCheck: CheckItem = {
      id: 'noise',
      name: '背景噪声检测',
      description: '检测声音背景是否干净，无明显背景噪音',
      passed: noiseResult.isClean,
      details: noiseResult.details,
      severity: noiseResult.isClean ? 'info' : 'warning',
    };
    checks.push(noiseCheck);

    // Check 5: Echo/Reverb
    const echoResult = analyzeEcho(wavInfo);
    const echoCheck: CheckItem = {
      id: 'echo',
      name: '回响检测',
      description: '检测声音是否存在明显回响或其他不适合克隆的问题',
      passed: !echoResult.hasEcho || echoResult.echoStrength === 'weak',
      details: echoResult.details,
      severity: !echoResult.hasEcho ? 'info' : echoResult.echoStrength === 'weak' ? 'warning' : 'critical',
    };
    checks.push(echoCheck);

    // Check 6: Channel overlap (ASR-based) - only for genuinely stereo audio
    let channelOverlapData: DetectResult['channelOverlap'] = undefined;

    if (channelCheck.passed) {
      try {
        const overlapResult = await detectChannelOverlap(wavInfo, request);
        const crosstalkCount = overlapResult.overlaps.filter(o => o.isCrosstalk).length;
        const totalOverlaps = overlapResult.overlaps.length;
        const overlapCheck: CheckItem = {
          id: 'channel_overlap',
          name: '声道踩脚检测',
          description: '对左右声道分别进行语音识别并时间戳对齐，检查是否存在同时说话的情况',
          passed: crosstalkCount === 0,
          details: crosstalkCount === 0
            ? totalOverlaps === 0
              ? '左右声道语音时间戳未发现重叠，无踩脚情况'
              : `左右声道存在 ${totalOverlaps} 处时间重叠，但语音内容一致（同一说话人声音），不属于踩脚`
            : crosstalkCount <= 3
              ? `检测到 ${crosstalkCount} 处声道踩脚：左右声道在同一时间段识别到不同的语音内容，存在两人同时说话的情况，可能影响克隆质量`
              : `检测到 ${crosstalkCount} 处声道踩脚：左右声道同时说话情况较多，严重影响克隆质量`,
          severity: crosstalkCount === 0 ? 'info' : crosstalkCount <= 3 ? 'warning' : 'critical',
        };
        checks.push(overlapCheck);
        channelOverlapData = overlapResult;
      } catch (e) {
        const overlapCheck: CheckItem = {
          id: 'channel_overlap',
          name: '声道踩脚检测',
          description: '对左右声道分别进行语音识别并时间戳对齐，检查是否存在同时说话的情况',
          passed: false,
          details: `ASR 检测失败: ${e instanceof Error ? e.message : '未知错误'}，无法完成踩脚检测`,
          severity: 'warning',
        };
        checks.push(overlapCheck);
      }
    } else {
      const overlapCheck: CheckItem = {
        id: 'channel_overlap',
        name: '声道踩脚检测',
        description: '对左右声道分别进行语音识别并时间戳对齐，检查是否存在同时说话的情况',
        passed: false,
        details: '非双声道音频，无法进行声道踩脚检测',
        severity: 'critical',
      };
      checks.push(overlapCheck);
    }

    const overallPassed = checks.every(c => c.passed || c.severity === 'warning');

    const result: DetectResult = {
      fileName: file.name,
      fileSize: file.size,
      originalFormat,
      checks,
      overallPassed,
      wavInfo: {
        channels: channelCheck.passed ? 2 : (originalChannelsFromProbe ?? wavInfo.channels),
        sampleRate: effectiveSampleRate,
        bitsPerSample: wavInfo.bitsPerSample,
        duration: effectiveDuration,
      },
      channelOverlap: channelOverlapData,
    };

    return NextResponse.json(result);
  } catch (e) {
    console.error('Detection error:', e);
    return NextResponse.json(
      { error: `检测过程出错: ${e instanceof Error ? e.message : '未知错误'}` },
      { status: 500 }
    );
  }
}

/**
 * Detect channel overlap (crosstalk/踩脚) using a two-stage approach:
 * 1. Energy-based VAD: Detect speech segments on each channel using frame energy analysis
 * 2. ASR text comparison: For overlapping segments, run ASR on each channel's audio slice
 *    and compare the text to determine if it's true crosstalk (different content) or
 *    same-voice bleed (identical content).
 */
async function detectChannelOverlap(
  wavInfo: ReturnType<typeof parseWav>,
  request: NextRequest
): Promise<NonNullable<DetectResult['channelOverlap']>> {
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);
  const config = new Config();
  const asrClient = new ASRClient(config, customHeaders);

  const { sampleRate, channelData } = wavInfo;
  const leftChannel = channelData[0];
  const rightChannel = channelData[1];

  // ---- Stage 1: Energy-based VAD ----
  // Compute frame RMS energy for each channel
  const frameSize = Math.floor(sampleRate * 0.025); // 25ms frames
  const hopSize = Math.floor(sampleRate * 0.010);   // 10ms hop

  function computeEnergyEnvelope(channel: Float32Array): Float32Array {
    const numFrames = Math.floor((channel.length - frameSize) / hopSize) + 1;
    const energy = new Float32Array(numFrames);
    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      const start = i * hopSize;
      for (let j = 0; j < frameSize; j++) {
        const s = channel[start + j] || 0;
        sum += s * s;
      }
      energy[i] = Math.sqrt(sum / frameSize);
    }
    return energy;
  }

  function detectSpeechSegments(energy: Float32Array): Array<{ startMs: number; endMs: number }> {
    // Adaptive threshold: compute the 90th percentile of energy as "speech level"
    const sortedEnergy = Array.from(energy).sort((a, b) => a - b);
    const p90 = sortedEnergy[Math.floor(sortedEnergy.length * 0.9)] || 0;
    const threshold = Math.max(p90 * 0.15, 0.005); // 15% of speech level, min 0.005

    const minSpeechFrames = Math.floor(0.15 / 0.01); // minimum 150ms speech segment
    const minSilenceFrames = Math.floor(0.08 / 0.01); // minimum 80ms silence gap

    const segments: Array<{ startMs: number; endMs: number }> = [];
    let inSpeech = false;
    let segStart = 0;
    let silenceCount = 0;

    for (let i = 0; i < energy.length; i++) {
      if (energy[i] > threshold) {
        if (!inSpeech) {
          inSpeech = true;
          segStart = i;
        }
        silenceCount = 0;
      } else if (inSpeech) {
        silenceCount++;
        if (silenceCount >= minSilenceFrames) {
          const segEnd = i - silenceCount;
          if (segEnd - segStart >= minSpeechFrames) {
            segments.push({
              startMs: Math.round(segStart * hopSize / sampleRate * 1000),
              endMs: Math.round(segEnd * hopSize / sampleRate * 1000),
            });
          }
          inSpeech = false;
        }
      }
    }
    // Handle last segment
    if (inSpeech && energy.length - segStart >= minSpeechFrames) {
      segments.push({
        startMs: Math.round(segStart * hopSize / sampleRate * 1000),
        endMs: Math.round(energy.length * hopSize / sampleRate * 1000),
      });
    }
    return segments;
  }

  const leftEnergy = computeEnergyEnvelope(leftChannel);
  const rightEnergy = computeEnergyEnvelope(rightChannel);
  const leftSegments = detectSpeechSegments(leftEnergy);
  const rightSegments = detectSpeechSegments(rightEnergy);

  // Build utterance objects for display (from VAD segments)
  const leftUtterances = leftSegments.map(s => ({
    text: '',
    start_time: s.startMs,
    end_time: s.endMs,
  }));
  const rightUtterances = rightSegments.map(s => ({
    text: '',
    start_time: s.startMs,
    end_time: s.endMs,
  }));

  // ---- Stage 2: Find overlapping segments and run ASR ----
  const overlapThreshold = 200; // ms minimum overlap to consider
  const textSimilarityThreshold = 0.5; // above this = same content (not crosstalk)

  const overlaps: Array<{
    leftText: string;
    rightText: string;
    leftStart: number;
    leftEnd: number;
    rightStart: number;
    rightEnd: number;
    overlapStart: number;
    overlapEnd: number;
    isCrosstalk: boolean;
    textSimilarity: number;
  }> = [];

  for (const left of leftSegments) {
    for (const right of rightSegments) {
      const overlapStart = Math.max(left.startMs, right.startMs);
      const overlapEnd = Math.min(left.endMs, right.endMs);
      const overlapDuration = overlapEnd - overlapStart;

      if (overlapDuration >= overlapThreshold) {
        // Extract audio for the overlapping region from each channel
        const startSample = Math.floor(overlapStart / 1000 * sampleRate);
        const endSample = Math.min(Math.floor(overlapEnd / 1000 * sampleRate), leftChannel.length);
        const sliceLength = endSample - startSample;

        if (sliceLength <= 0) continue;

        // Build mono WAV buffers for the overlap slice
        const leftSlice = leftChannel.slice(startSample, endSample);
        const rightSlice = rightChannel.slice(startSample, endSample);

        const leftSliceWav = buildMonoWav(leftSlice, sampleRate);
        const rightSliceWav = buildMonoWav(rightSlice, sampleRate);

        // Run ASR on both overlap slices in parallel
        let leftText = '';
        let rightText = '';
        try {
          const [leftAsr, rightAsr] = await Promise.all([
            asrClient.recognize({ uid: 'voice-check-left', base64Data: leftSliceWav.toString('base64') }),
            asrClient.recognize({ uid: 'voice-check-right', base64Data: rightSliceWav.toString('base64') }),
          ]);
          leftText = leftAsr.text || '';
          rightText = rightAsr.text || '';
        } catch {
          // If ASR fails for this segment, mark as unknown but still report overlap
          leftText = '[ASR识别失败]';
          rightText = '[ASR识别失败]';
        }

        const similarity = computeTextSimilarity(leftText, rightText);
        const isCrosstalk = similarity < textSimilarityThreshold && leftText !== '[ASR识别失败]';

        overlaps.push({
          leftText,
          rightText,
          leftStart: left.startMs,
          leftEnd: left.endMs,
          rightStart: right.startMs,
          rightEnd: right.endMs,
          overlapStart,
          overlapEnd,
          isCrosstalk,
          textSimilarity: similarity,
        });
      }
    }
  }

  // Also run full-channel ASR to populate utterance text for display
  try {
    const leftWav = buildMonoWav(leftChannel, sampleRate);
    const rightWav = buildMonoWav(rightChannel, sampleRate);
    const [leftFullAsr, rightFullAsr] = await Promise.all([
      asrClient.recognize({ uid: 'voice-check-left-full', base64Data: leftWav.toString('base64') }),
      asrClient.recognize({ uid: 'voice-check-right-full', base64Data: rightWav.toString('base64') }),
    ]);
    // Assign full ASR text to the first (or only) utterance of each channel
    if (leftUtterances.length > 0) {
      leftUtterances[0].text = leftFullAsr.text || '';
    }
    if (rightUtterances.length > 0) {
      rightUtterances[0].text = rightFullAsr.text || '';
    }
  } catch {
    // Silently ignore full-channel ASR errors
  }

  return { leftUtterances, rightUtterances, overlaps };
}

/**
 * Build a mono WAV file from float32 sample data.
 */
function buildMonoWav(samples: Float32Array, sampleRate: number): Buffer {
  const numSamples = samples.length;
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);          // chunk size
  buffer.writeUInt16LE(1, 20);           // PCM format
  buffer.writeUInt16LE(1, 22);           // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);           // block align
  buffer.writeUInt16LE(16, 34);          // bits per sample

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write samples as 16-bit PCM
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.floor(s * 32767), 44 + i * 2);
  }

  return buffer;
}

/**
 * Compute text similarity between two strings.
 * Returns a value between 0 (completely different) and 1 (identical).
 * Uses character-level Jaccard similarity for Chinese text,
 * with word-level fallback for mixed content.
 */
function computeTextSimilarity(textA: string, textB: string): number {
  if (!textA && !textB) return 1.0; // both empty = identical
  if (!textA || !textB) return 0.0; // one empty = different

  // Normalize: remove punctuation and whitespace
  const normalize = (s: string) => s.replace(/[\s,.\u3001\u3002\uff0c\uff0e\uff1f\uff01\uff1b\uff1a\u201c\u201d\u2018\u2019]/g, '').toLowerCase();
  const a = normalize(textA);
  const b = normalize(textB);

  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  // Character-level Jaccard similarity (good for Chinese)
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  const intersection = new Set([...setA].filter(c => setB.has(c)));
  const union = new Set([...setA, ...setB]);

  return intersection.size / union.size;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}分${secs}秒`;
}
