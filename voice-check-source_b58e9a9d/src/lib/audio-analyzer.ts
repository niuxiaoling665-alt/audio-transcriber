/**
 * Audio Analyzer - WAV header parsing & signal analysis
 * Detects: channels, sample rate, duration, background noise, echo/reverb
 */

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  duration: number; // seconds
  dataSize: number;
  audioData: Buffer;
  channelData: Float32Array[]; // per-channel float32 samples [-1, 1]
}

export interface NoiseAnalysisResult {
  snr: number; // Signal-to-Noise Ratio in dB
  isClean: boolean;
  noiseLevel: string; // 'low' | 'medium' | 'high'
  details: string;
}

export interface EchoAnalysisResult {
  hasEcho: boolean;
  echoStrength: string; // 'none' | 'weak' | 'moderate' | 'strong'
  echoDelayMs: number; // estimated echo delay in ms
  details: string;
}

/**
 * Parse WAV file header and extract audio metadata + raw PCM data
 */
export function parseWav(buffer: Buffer): WavInfo {
  if (buffer.length < 44) {
    throw new Error('Invalid WAV file: file too short');
  }

  const chunkId = buffer.toString('ascii', 0, 4);
  if (chunkId !== 'RIFF') {
    throw new Error('Invalid WAV file: not RIFF format');
  }

  const format = buffer.toString('ascii', 8, 12);
  if (format !== 'WAVE') {
    throw new Error('Invalid WAV file: not WAVE format');
  }

  // Find fmt chunk
  let pos = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioData = Buffer.alloc(0);
  let dataSize = 0;

  while (pos < buffer.length - 8) {
    const subchunkId = buffer.toString('ascii', pos, pos + 4);
    const subchunkSize = buffer.readUInt32LE(pos + 4);

    if (subchunkId === 'fmt ') {
      audioFormat = buffer.readUInt16LE(pos + 8);
      channels = buffer.readUInt16LE(pos + 10);
      sampleRate = buffer.readUInt32LE(pos + 12);
      bitsPerSample = buffer.readUInt16LE(pos + 22);
    } else if (subchunkId === 'data') {
      dataSize = subchunkSize;
      audioData = Buffer.from(buffer.subarray(pos + 8, pos + 8 + subchunkSize));
      break;
    }

    pos += 8 + subchunkSize;
    // Align to even boundary
    if (subchunkSize % 2 !== 0) pos += 1;
  }

  if (channels === 0 || sampleRate === 0) {
    throw new Error('Invalid WAV file: missing fmt chunk');
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = dataSize / (channels * bytesPerSample);
  const duration = totalSamples / sampleRate;

  // Extract per-channel float32 data
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    channelData.push(audioToFloat32(audioData, bitsPerSample, channels, ch));
  }

  return {
    channels,
    sampleRate,
    bitsPerSample,
    duration,
    dataSize,
    audioData,
    channelData,
  };
}

/**
 * Convert Buffer of audio samples to Float32Array normalized to [-1, 1]
 */
function audioToFloat32(audioData: Buffer, bitsPerSample: number, channels: number, channelIndex: number = 0): Float32Array {
  const bytesPerSample = bitsPerSample / 8;
  const totalFrames = audioData.length / (channels * bytesPerSample);
  const samples = new Float32Array(totalFrames);

  for (let i = 0; i < totalFrames; i++) {
    const offset = (i * channels + channelIndex) * bytesPerSample;
    if (offset + bytesPerSample > audioData.length) break;

    let sample: number;
    if (bitsPerSample === 16) {
      sample = audioData.readInt16LE(offset) / 32768;
    } else if (bitsPerSample === 24) {
      sample = audioData.readIntLE(offset, 3) / 8388608;
    } else if (bitsPerSample === 32) {
      sample = audioData.readInt32LE(offset) / 2147483648;
    } else if (bitsPerSample === 8) {
      sample = (audioData[offset] - 128) / 128;
    } else {
      sample = 0;
    }
    samples[i] = sample;
  }

  return samples;
}

/**
 * Analyze stereo content to determine if L/R channels contain genuinely different audio.
 * Returns correlation-based difference metric and whether the audio is truly stereo.
 *
 * Algorithm:
 * 1. Extract L and R channel samples
 * 2. Compute normalized cross-correlation between L and R
 * 3. If correlation is very high (channels nearly identical) → mono content (possibly upmixed)
 * 4. If correlation is low (channels differ significantly) → true stereo
 */
export function analyzeStereoContent(wavInfo: WavInfo): {
  isStereo: boolean;
  correlation: number; // 0 = completely different, 1 = identical
  details: string;
} {
  if (wavInfo.channels < 2) {
    return { isStereo: false, correlation: 1.0, details: '音频为单声道，无左右声道差异可分析' };
  }

  const bytesPerSample = wavInfo.bitsPerSample / 8;
  const totalFrames = wavInfo.audioData.length / (wavInfo.channels * bytesPerSample);

  // Sample at most 100000 frames (about 2 seconds at 48kHz) spread across the file
  // for efficient analysis
  const maxAnalysisFrames = 100000;
  const step = Math.max(1, Math.floor(totalFrames / maxAnalysisFrames));
  const analysisFrames = Math.floor(totalFrames / step);

  let sumLL = 0;
  let sumRR = 0;
  let sumLR = 0;
  let count = 0;

  for (let i = 0; i < analysisFrames; i++) {
    const frameIndex = i * step;
    const leftOffset = (frameIndex * wavInfo.channels) * bytesPerSample;
    const rightOffset = (frameIndex * wavInfo.channels + 1) * bytesPerSample;

    if (rightOffset + bytesPerSample > wavInfo.audioData.length) break;

    let left: number;
    let right: number;
    if (wavInfo.bitsPerSample === 16) {
      left = wavInfo.audioData.readInt16LE(leftOffset) / 32768;
      right = wavInfo.audioData.readInt16LE(rightOffset) / 32768;
    } else if (wavInfo.bitsPerSample === 24) {
      left = wavInfo.audioData.readIntLE(leftOffset, 3) / 8388608;
      right = wavInfo.audioData.readIntLE(rightOffset, 3) / 8388608;
    } else if (wavInfo.bitsPerSample === 32) {
      left = wavInfo.audioData.readInt32LE(leftOffset) / 2147483648;
      right = wavInfo.audioData.readInt32LE(rightOffset) / 2147483648;
    } else if (wavInfo.bitsPerSample === 8) {
      left = (wavInfo.audioData[leftOffset] - 128) / 128;
      right = (wavInfo.audioData[rightOffset] - 128) / 128;
    } else {
      left = 0;
      right = 0;
    }

    sumLL += left * left;
    sumRR += right * right;
    sumLR += left * right;
    count++;
  }

  if (count === 0) {
    return { isStereo: false, correlation: 1.0, details: '音频数据不足，无法分析声道差异' };
  }

  // Normalized cross-correlation
  const denominator = Math.sqrt(sumLL * sumRR);
  let correlation = 1.0;
  if (denominator > 1e-10) {
    correlation = sumLR / denominator;
  }

  // Clamp to [0, 1] for our purposes
  // correlation close to 1 means channels are identical (mono)
  // correlation close to 0 means channels are very different (stereo)
  // Typical thresholds:
  //   > 0.98  → effectively mono (upmixed)
  //   0.90-0.98 → mostly mono with slight stereo (e.g., correlated noise)
  //   < 0.90  → genuine stereo content
  const clampedCorrelation = Math.max(0, Math.min(1, correlation));
  const isStereo = clampedCorrelation < 0.98;

  // Convert to "difference" percentage for user display
  const differencePercent = (1 - clampedCorrelation);

  return {
    isStereo,
    correlation: differencePercent,
    details: isStereo
      ? `左右声道存在明显差异（差异度 ${(differencePercent * 100).toFixed(1)}%），为真实双声道内容`
      : `左右声道内容一致（差异度 ${(differencePercent * 100).toFixed(1)}%），实际为单声道音频`,
  };
}

/**
 * Analyze background noise level using SNR estimation
 * Strategy: Find silent segments (low energy), estimate noise floor,
 * compare with speech segments energy
 */
export function analyzeNoise(wavInfo: WavInfo): NoiseAnalysisResult {
  const samples = audioToFloat32(wavInfo.audioData, wavInfo.bitsPerSample, wavInfo.channels, 0);

  // Divide into frames of 50ms
  const frameSize = Math.floor(wavInfo.sampleRate * 0.05);
  const numFrames = Math.floor(samples.length / frameSize);

  if (numFrames < 2) {
    return {
      snr: 0,
      isClean: true,
      noiseLevel: 'low',
      details: '音频时长过短，无法进行噪声分析',
    };
  }

  // Compute RMS energy for each frame
  const frameEnergies: number[] = [];
  for (let i = 0; i < numFrames; i++) {
    let sumSq = 0;
    const start = i * frameSize;
    for (let j = 0; j < frameSize; j++) {
      sumSq += samples[start + j] * samples[start + j];
    }
    frameEnergies.push(Math.sqrt(sumSq / frameSize));
  }

  // Sort energies to find noise floor and signal level
  const sortedEnergies = [...frameEnergies].sort((a, b) => a - b);

  // Noise floor: average of lowest 20% frames
  const noiseFrameCount = Math.max(1, Math.floor(numFrames * 0.2));
  let noiseFloor = 0;
  for (let i = 0; i < noiseFrameCount; i++) {
    noiseFloor += sortedEnergies[i];
  }
  noiseFloor /= noiseFrameCount;

  // Signal level: average of top 50% frames
  const signalFrameStart = Math.floor(numFrames * 0.5);
  let signalLevel = 0;
  const signalFrameCount = numFrames - signalFrameStart;
  for (let i = signalFrameStart; i < numFrames; i++) {
    signalLevel += sortedEnergies[i];
  }
  signalLevel /= signalFrameCount;

  // Calculate SNR
  const eps = 1e-10;
  const snr = 20 * Math.log10((signalLevel + eps) / (noiseFloor + eps));

  // Determine if clean
  // Typical clean recording: SNR > 20dB
  // Moderate noise: 10-20dB
  // Heavy noise: < 10dB
  const isClean = snr >= 20;
  let noiseLevel: 'low' | 'medium' | 'high';
  if (snr >= 20) noiseLevel = 'low';
  else if (snr >= 10) noiseLevel = 'medium';
  else noiseLevel = 'high';

  const details = isClean
    ? `信噪比 ${snr.toFixed(1)}dB，背景噪声低，适合声音克隆`
    : snr >= 10
      ? `信噪比 ${snr.toFixed(1)}dB，存在可感知的背景噪声，可能影响克隆效果`
      : `信噪比 ${snr.toFixed(1)}dB，背景噪声明显，不建议用于声音克隆`;

  return { snr, isClean, noiseLevel, details };
}

/**
 * Analyze echo/reverb using autocorrelation
 * Strategy: Look for periodic peaks in the autocorrelation function
 * that indicate echo/reverb patterns
 */
export function analyzeEcho(wavInfo: WavInfo): EchoAnalysisResult {
  const samples = audioToFloat32(wavInfo.audioData, wavInfo.bitsPerSample, wavInfo.channels, 0);

  // Use a segment of audio for analysis (up to 30 seconds)
  const maxAnalysisSamples = Math.min(samples.length, wavInfo.sampleRate * 30);
  const analysisSamples = samples.subarray(0, maxAnalysisSamples);

  // Normalize the audio
  let maxAmp = 0;
  for (let i = 0; i < analysisSamples.length; i++) {
    const abs = Math.abs(analysisSamples[i]);
    if (abs > maxAmp) maxAmp = abs;
  }
  if (maxAmp > 0) {
    for (let i = 0; i < analysisSamples.length; i++) {
      analysisSamples[i] /= maxAmp;
    }
  }

  // Compute autocorrelation for delays from 10ms to 500ms
  // (typical echo/reverb delays)
  const minDelayMs = 10;
  const maxDelayMs = 500;
  const minDelaySamples = Math.floor(wavInfo.sampleRate * minDelayMs / 1000);
  const maxDelaySamples = Math.floor(wavInfo.sampleRate * maxDelayMs / 1000);

  // Downsample for efficiency: compute autocorrelation on blocks
  const blockSize = 4096;
  const numBlocks = Math.floor(analysisSamples.length / blockSize);

  if (numBlocks < 2) {
    return {
      hasEcho: false,
      echoStrength: 'none',
      echoDelayMs: 0,
      details: '音频时长过短，无法进行回响分析',
    };
  }

  // Compute autocorrelation at key delay points
  const autocorrValues: { delay: number; value: number }[] = [];

  for (let delay = minDelaySamples; delay <= maxDelaySamples; delay += Math.max(1, Math.floor(wavInfo.sampleRate / 200))) {
    let sum = 0;
    let count = 0;
    for (let b = 0; b < numBlocks; b++) {
      const blockStart = b * blockSize;
      let blockSum = 0;
      const limit = Math.min(blockSize, analysisSamples.length - blockStart - delay);
      for (let i = 0; i < limit; i++) {
        blockSum += analysisSamples[blockStart + i] * analysisSamples[blockStart + i + delay];
      }
      if (limit > 0) {
        sum += blockSum / limit;
        count++;
      }
    }
    if (count > 0) {
      autocorrValues.push({ delay, value: sum / count });
    }
  }

  if (autocorrValues.length === 0) {
    return {
      hasEcho: false,
      echoStrength: 'none',
      echoDelayMs: 0,
      details: '无法计算自相关，跳过回响检测',
    };
  }

  // Find the zero-delay autocorrelation (energy)
  let energy = 0;
  for (let i = 0; i < analysisSamples.length; i++) {
    energy += analysisSamples[i] * analysisSamples[i];
  }
  energy /= analysisSamples.length;

  if (energy < 1e-10) {
    return {
      hasEcho: false,
      echoStrength: 'none',
      echoDelayMs: 0,
      details: '音频信号过弱，无法进行回响分析',
    };
  }

  // Normalize autocorrelation values
  for (const item of autocorrValues) {
    item.value /= energy;
  }

  // Find peaks in autocorrelation (significant correlation > threshold)
  // A significant echo produces a peak at the echo delay
  const echoThreshold = 0.3;
  let maxPeak = { delay: 0, value: 0 };

  for (const item of autocorrValues) {
    if (item.value > maxPeak.value) {
      maxPeak = item;
    }
  }

  const hasEcho = maxPeak.value > echoThreshold;
  let echoStrength: 'none' | 'weak' | 'moderate' | 'strong';
  if (maxPeak.value < 0.2) echoStrength = 'none';
  else if (maxPeak.value < 0.3) echoStrength = 'weak';
  else if (maxPeak.value < 0.5) echoStrength = 'moderate';
  else echoStrength = 'strong';

  const echoDelayMs = maxPeak.delay / wavInfo.sampleRate * 1000;

  const details = hasEcho
    ? echoStrength === 'strong'
      ? `检测到明显回响（自相关峰值 ${maxPeak.value.toFixed(2)}，延迟约 ${echoDelayMs.toFixed(0)}ms），回响会严重影响声音克隆质量`
      : `检测到轻微回响（自相关峰值 ${maxPeak.value.toFixed(2)}，延迟约 ${echoDelayMs.toFixed(0)}ms），可能对克隆效果有一定影响`
    : `未检测到明显回响（自相关峰值 ${maxPeak.value.toFixed(2)}），适合声音克隆`;

  return { hasEcho, echoStrength, echoDelayMs, details };
}

/**
 * Extract a single channel from stereo WAV data and create a mono WAV buffer
 */
export function extractChannelAsMonoWav(wavInfo: WavInfo, channelIndex: number): Buffer {
  const { channels, sampleRate, bitsPerSample, audioData } = wavInfo;
  const bytesPerSample = bitsPerSample / 8;
  const totalFrames = audioData.length / (channels * bytesPerSample);

  // Create mono PCM data
  const monoDataSize = totalFrames * bytesPerSample;
  const monoData = Buffer.alloc(monoDataSize);

  for (let i = 0; i < totalFrames; i++) {
    const srcOffset = (i * channels + channelIndex) * bytesPerSample;
    const dstOffset = i * bytesPerSample;

    if (srcOffset + bytesPerSample > audioData.length) break;

    audioData.copy(monoData, dstOffset, srcOffset, srcOffset + bytesPerSample);
  }

  // Build WAV file
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + monoDataSize);

  // RIFF header
  wavBuffer.write('RIFF', 0);
  wavBuffer.writeUInt32LE(36 + monoDataSize, 4);
  wavBuffer.write('WAVE', 8);

  // fmt chunk
  wavBuffer.write('fmt ', 12);
  wavBuffer.writeUInt32LE(16, 16); // chunk size
  wavBuffer.writeUInt16LE(1, 20); // PCM format
  wavBuffer.writeUInt16LE(1, 22); // mono
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  wavBuffer.writeUInt16LE(bytesPerSample, 32); // block align
  wavBuffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  wavBuffer.write('data', 36);
  wavBuffer.writeUInt32LE(monoDataSize, 40);
  monoData.copy(wavBuffer, 44);

  return wavBuffer;
}

/**
 * Resample audio to target sample rate (linear interpolation)
 */
export function resampleWav(wavBuffer: Buffer, targetSampleRate: number = 16000): Buffer {
  const wavInfo = parseWav(wavBuffer);
  const samples = audioToFloat32(wavInfo.audioData, wavInfo.bitsPerSample, wavInfo.channels, 0);

  const ratio = targetSampleRate / wavInfo.sampleRate;
  const newLength = Math.floor(samples.length * ratio);
  const resampled = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i / ratio;
    const index1 = Math.floor(srcIndex);
    const index2 = Math.min(index1 + 1, samples.length - 1);
    const frac = srcIndex - index1;
    resampled[i] = samples[index1] * (1 - frac) + samples[index2] * frac;
  }

  // Convert to 16-bit PCM
  const pcmData = Buffer.alloc(newLength * 2);
  for (let i = 0; i < newLength; i++) {
    const val = Math.max(-1, Math.min(1, resampled[i]));
    pcmData.writeInt16LE(Math.floor(val * 32767), i * 2);
  }

  // Build WAV
  const headerSize = 44;
  const dataSize = pcmData.length;
  const output = Buffer.alloc(headerSize + dataSize);

  output.write('RIFF', 0);
  output.writeUInt32LE(36 + dataSize, 4);
  output.write('WAVE', 8);
  output.write('fmt ', 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20); // PCM
  output.writeUInt16LE(1, 22); // mono
  output.writeUInt32LE(targetSampleRate, 24);
  output.writeUInt32LE(targetSampleRate * 2, 28); // byte rate
  output.writeUInt16LE(2, 32); // block align
  output.writeUInt16LE(16, 34); // bits per sample
  output.write('data', 36);
  output.writeUInt32LE(dataSize, 40);
  pcmData.copy(output, 44);

  return output;
}
