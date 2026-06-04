'use client';

import { useState, useCallback, useRef } from 'react';
import {
  Upload,
  FileType,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Download,
  RotateCcw,
  Volume2,
  Clock,
  Radio,
  Mic,
  Waves,
  Users,
} from 'lucide-react';

interface CheckItem {
  id: string;
  name: string;
  description: string;
  passed: boolean;
  details: string;
  severity: 'critical' | 'warning' | 'info';
}

interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  duration: number;
}

interface ChannelOverlap {
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
}

interface DetectResult {
  fileName: string;
  fileSize: number;
  originalFormat: string;
  checks: CheckItem[];
  overallPassed: boolean;
  wavInfo?: WavInfo;
  channelOverlap?: ChannelOverlap;
}

type PageState = 'idle' | 'uploading' | 'analyzing' | 'done' | 'error';

const checkIcons: Record<string, React.ReactNode> = {
  channels: <Radio className="h-5 w-5" />,
  duration: <Clock className="h-5 w-5" />,
  sample_rate: <Waves className="h-5 w-5" />,
  noise: <Volume2 className="h-5 w-5" />,
  echo: <Mic className="h-5 w-5" />,
  channel_overlap: <Users className="h-5 w-5" />,
};

export default function VoiceCheckPage() {
  const [state, setState] = useState<PageState>('idle');
  const [result, setResult] = useState<DetectResult | null>(null);
  const [error, setError] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [analyzingStep, setAnalyzingStep] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback((file: File) => {
    const validExts = ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.wma'];
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    if (!validExts.includes(ext)) {
      setError(`不支持的文件格式: ${ext}，请上传 WAV/MP3/FLAC/OGG/M4A/AAC 等常见音频格式`);
      setState('error');
      return;
    }
    setSelectedFile(file);
    setResult(null);
    setError('');
    setState('idle');
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const startDetection = useCallback(async () => {
    if (!selectedFile) return;

    setState('analyzing');
    setAnalyzingStep('正在上传音频文件...');

    try {
      // Simulate step progression for UX
      const stepTimer = setInterval(() => {
        setAnalyzingStep((prev) => {
          if (prev.includes('上传')) return '正在解析音频文件...';
          if (prev.includes('解析')) return '正在检测声道格式...';
          if (prev.includes('声道')) return '正在分析音频时长和采样率...';
          if (prev.includes('采样率')) return '正在检测背景噪声...';
          if (prev.includes('噪声')) return '正在检测回响...';
          if (prev.includes('回响')) return '正在通过 ASR 检测声道踩脚...';
          return prev;
        });
      }, 2000);

      const formData = new FormData();
      formData.append('file', selectedFile);

      const response = await fetch('/api/detect', {
        method: 'POST',
        body: formData,
      });

      clearInterval(stepTimer);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '检测失败');
      }

      const data: DetectResult = await response.json();
      setResult(data);
      setState('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : '检测过程出错');
      setState('error');
    }
  }, [selectedFile]);

  const handleReset = useCallback(() => {
    setState('idle');
    setResult(null);
    setError('');
    setSelectedFile(null);
    setAnalyzingStep('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleExport = useCallback(() => {
    if (!result) return;

    const report = {
      检测报告: {
        文件名: result.fileName,
        文件大小: formatFileSize(result.fileSize),
        原始格式: result.originalFormat,
        检测时间: new Date().toLocaleString('zh-CN'),
        总体结论: result.overallPassed ? '符合声音克隆条件' : '不符合声音克隆条件',
        音频信息: result.wavInfo
          ? {
              声道数: result.wavInfo.channels,
              采样率: `${result.wavInfo.sampleRate}Hz`,
              位深度: `${result.wavInfo.bitsPerSample}bit`,
              时长: formatDuration(result.wavInfo.duration),
            }
          : null,
        检测项: result.checks.map((c) => ({
          检测项: c.name,
          结果: c.passed ? '通过' : '不通过',
          说明: c.details,
        })),
        声道踩脚详情: result.channelOverlap
          ? {
              左声道语音段数: result.channelOverlap.leftUtterances.length,
              右声道语音段数: result.channelOverlap.rightUtterances.length,
              踩脚次数: result.channelOverlap.overlaps.filter(o => o.isCrosstalk).length,
              时间重叠总次数: result.channelOverlap.overlaps.length,
              踩脚详情: result.channelOverlap.overlaps.map((o, i) => ({
                序号: i + 1,
                类型: o.isCrosstalk ? '踩脚（不同说话人）' : '同声（相同说话人）',
                时间段: `${formatMs(o.overlapStart)} - ${formatMs(o.overlapEnd)}`,
                重叠时长: `${((o.overlapEnd - o.overlapStart) / 1000).toFixed(2)}秒`,
                左声道内容: o.leftText,
                右声道内容: o.rightText,
                文字相似度: `${(o.textSimilarity * 100).toFixed(1)}%`,
              })),
            }
          : null,
      },
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voice-check-report-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [result]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}分${secs}秒`;
  };

  const formatMs = (ms: number): string => {
    const totalSec = ms / 1000;
    const mins = Math.floor(totalSec / 60);
    const secs = Math.floor(totalSec % 60);
    const msRemain = Math.floor(ms % 1000);
    return `${mins}:${secs.toString().padStart(2, '0')}.${msRemain.toString().padStart(3, '0')}`;
  };

  return (
    <div className="min-h-screen bg-voice-bg">
      {/* Header */}
      <header className="border-b border-voice-border/50 bg-voice-card/50 backdrop-blur-sm">
        <div className="mx-auto max-w-5xl px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-voice-accent/10">
              <Volume2 className="h-5 w-5 text-voice-accent" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-voice-text tracking-tight">
                声音克隆条件检测
              </h1>
              <p className="text-xs text-voice-text-secondary mt-0.5">
                Voice Clone Condition Checker
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* Upload Zone */}
        {(state === 'idle' || state === 'error') && (
          <div className="space-y-6">
            {/* Error Message */}
            {error && (
              <div className="rounded-lg border border-voice-error/30 bg-voice-error/5 px-4 py-3 text-sm text-voice-error">
                {error}
              </div>
            )}

            {/* Upload Area */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`relative cursor-pointer rounded-xl border-2 border-dashed p-12 transition-all duration-300 ${
                isDragOver
                  ? 'border-voice-accent bg-voice-accent/5'
                  : selectedFile
                    ? 'border-voice-accent/40 bg-voice-card'
                    : 'border-voice-border bg-voice-card upload-zone-idle'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".wav,.mp3,.flac,.ogg,.m4a,.aac,.wma,.opus,.aiff,.ape"
                onChange={handleInputChange}
                className="hidden"
              />

              <div className="flex flex-col items-center text-center">
                {selectedFile ? (
                  <>
                    <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-voice-accent/10">
                      <FileType className="h-8 w-8 text-voice-accent" />
                    </div>
                    <p className="text-base font-medium text-voice-text">
                      {selectedFile.name}
                    </p>
                    <p className="mt-1 text-sm text-voice-text-secondary">
                      {formatFileSize(selectedFile.size)} · 点击更换文件
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-voice-accent/10">
                      <Upload className="h-8 w-8 text-voice-accent" />
                    </div>
                    <p className="text-base font-medium text-voice-text">
                      拖拽音频文件至此处，或点击选择文件
                    </p>
                    <p className="mt-2 text-sm text-voice-text-secondary">
                      支持 WAV / MP3 / FLAC / OGG / M4A / AAC 等常见音频格式
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Detection Requirements */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { icon: <Radio className="h-4 w-4" />, label: '双声道' },
                { icon: <Clock className="h-4 w-4" />, label: '≥5分钟' },
                { icon: <Waves className="h-4 w-4" />, label: '≥24kHz' },
                { icon: <Volume2 className="h-4 w-4" />, label: '无噪声' },
                { icon: <Mic className="h-4 w-4" />, label: '无回响' },
                { icon: <Users className="h-4 w-4" />, label: '无踩脚' },
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-lg border border-voice-border/50 bg-voice-card px-3 py-2.5"
                >
                  <span className="text-voice-text-secondary">{item.icon}</span>
                  <span className="text-xs font-medium text-voice-text-secondary">
                    {item.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Start Button */}
            {selectedFile && (
              <div className="flex justify-center">
                <button
                  onClick={startDetection}
                  className="inline-flex items-center gap-2 rounded-lg bg-voice-accent px-8 py-3 text-sm font-semibold text-voice-bg transition-all hover:bg-voice-accent/90 hover:shadow-lg hover:shadow-voice-accent/20 active:scale-[0.98]"
                >
                  开始检测
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Analyzing State */}
        {state === 'analyzing' && (
          <div className="flex flex-col items-center py-20">
            <div className="relative mb-8">
              <div className="h-24 w-24 rounded-full border-4 border-voice-border" />
              <div className="absolute inset-0 h-24 w-24 animate-spin rounded-full border-4 border-transparent border-t-voice-accent" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-voice-accent" />
              </div>
            </div>
            <p className="text-lg font-medium text-voice-text">正在分析音频</p>
            <p className="mt-2 text-sm text-voice-text-secondary">{analyzingStep}</p>

            {/* Progress bar */}
            <div className="mt-8 h-1.5 w-64 overflow-hidden rounded-full bg-voice-border">
              <div className="progress-flow h-full w-full rounded-full" />
            </div>
          </div>
        )}

        {/* Results */}
        {state === 'done' && result && (
          <div className="space-y-6">
            {/* Overall Result */}
            <div
              className={`rounded-xl border p-6 ${
                result.overallPassed
                  ? 'border-voice-accent/30 bg-voice-accent/5'
                  : 'border-voice-error/30 bg-voice-error/5'
              }`}
            >
              <div className="flex items-center gap-4">
                {result.overallPassed ? (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-voice-accent/15">
                    <CheckCircle2 className="h-7 w-7 text-voice-accent" />
                  </div>
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-voice-error/15">
                    <XCircle className="h-7 w-7 text-voice-error" />
                  </div>
                )}
                <div>
                  <h2 className="text-xl font-semibold text-voice-text">
                    {result.overallPassed ? '检测通过' : '检测未通过'}
                  </h2>
                  <p className="mt-0.5 text-sm text-voice-text-secondary">
                    {result.overallPassed
                      ? '该音频文件符合声音克隆条件'
                      : '该音频文件存在不符合声音克隆条件的问题，请查看下方详情'}
                  </p>
                </div>
              </div>

              {/* Audio Info */}
              {result.wavInfo && (
                <div className="mt-4 grid grid-cols-5 gap-4 border-t border-voice-border/30 pt-4">
                  <div>
                    <p className="text-xs text-voice-text-secondary">原始格式</p>
                    <p className="font-mono text-base font-semibold text-voice-text">
                      {result.originalFormat}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-voice-text-secondary">声道数</p>
                    <p className="font-mono text-base font-semibold text-voice-text">
                      {result.wavInfo.channels}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-voice-text-secondary">采样率</p>
                    <p className="font-mono text-base font-semibold text-voice-text">
                      {(result.wavInfo.sampleRate / 1000).toFixed(1)}kHz
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-voice-text-secondary">位深度</p>
                    <p className="font-mono text-base font-semibold text-voice-text">
                      {result.wavInfo.bitsPerSample}bit
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-voice-text-secondary">时长</p>
                    <p className="font-mono text-base font-semibold text-voice-text">
                      {formatDuration(result.wavInfo.duration)}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Individual Check Items */}
            <div className="grid gap-4 md:grid-cols-2">
              {result.checks.map((check, index) => (
                <div
                  key={check.id}
                  className="check-item-enter rounded-xl border border-voice-border/50 bg-voice-card p-5 transition-all hover:border-voice-border"
                  style={{ animationDelay: `${index * 100}ms` }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                          check.passed
                            ? 'bg-voice-accent/10 text-voice-accent'
                            : check.severity === 'warning'
                              ? 'bg-voice-warning/10 text-voice-warning'
                              : 'bg-voice-error/10 text-voice-error'
                        }`}
                      >
                        {checkIcons[check.id] || <CheckCircle2 className="h-5 w-5" />}
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-voice-text">
                          {check.name}
                        </h3>
                        <p className="text-xs text-voice-text-secondary mt-0.5">
                          {check.description}
                        </p>
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      {check.passed ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-voice-accent/10 px-2.5 py-1 text-xs font-medium text-voice-accent">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          通过
                        </span>
                      ) : check.severity === 'warning' ? (
                        <span className="inline-flex items-center gap-1 rounded-md bg-voice-warning/10 px-2.5 py-1 text-xs font-medium text-voice-warning">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          警告
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-md bg-voice-error/10 px-2.5 py-1 text-xs font-medium text-voice-error">
                          <XCircle className="h-3.5 w-3.5" />
                          不通过
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-voice-text-secondary pl-12">
                    {check.details}
                  </p>
                </div>
              ))}
            </div>

            {/* Channel Overlap Details */}
            {result.channelOverlap && result.channelOverlap.overlaps.length > 0 && (
              <div className="rounded-xl border border-voice-warning/30 bg-voice-card p-5">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-voice-warning">
                  <AlertTriangle className="h-4 w-4" />
                  声道踩脚详情
                </h3>
                <p className="mt-1 text-xs text-voice-text-secondary">
                  以下时间段内左右声道同时存在语音活动，根据 ASR 识别内容判断是否为踩脚
                </p>

                {/* ASR Summary */}
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-voice-bg/50 px-3 py-2">
                    <div className="text-xs text-voice-text-secondary">左声道识别</div>
                    <div className="mt-1 font-mono text-xs text-voice-text leading-relaxed max-h-24 overflow-y-auto">
                      {result.channelOverlap.leftUtterances.map(u => u.text).join('') || '(无识别结果)'}
                    </div>
                  </div>
                  <div className="rounded-lg bg-voice-bg/50 px-3 py-2">
                    <div className="text-xs text-voice-text-secondary">右声道识别</div>
                    <div className="mt-1 font-mono text-xs text-voice-text leading-relaxed max-h-24 overflow-y-auto">
                      {result.channelOverlap.rightUtterances.map(u => u.text).join('') || '(无识别结果)'}
                    </div>
                  </div>
                </div>

                {/* Overlap Details */}
                <div className="mt-4 space-y-2">
                  {result.channelOverlap.overlaps.map((overlap, i) => (
                    <div
                      key={i}
                      className={`rounded-lg px-4 py-3 ${
                        overlap.isCrosstalk
                          ? 'bg-voice-error/5 border border-voice-error/20'
                          : 'bg-voice-warning/5 border border-voice-warning/10'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`font-mono text-xs ${
                          overlap.isCrosstalk ? 'text-voice-error' : 'text-voice-warning'
                        }`}>
                          #{i + 1}
                        </span>
                        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
                          overlap.isCrosstalk
                            ? 'bg-voice-error/10 text-voice-error'
                            : 'bg-voice-warning/10 text-voice-warning'
                        }`}>
                          {overlap.isCrosstalk ? '踩脚' : '同声'}
                        </span>
                        <span className="font-mono text-sm text-voice-text">
                          {formatMs(overlap.overlapStart)} — {formatMs(overlap.overlapEnd)}
                        </span>
                        <span className="text-xs text-voice-text-secondary">
                          (重叠 {((overlap.overlapEnd - overlap.overlapStart) / 1000).toFixed(2)}秒)
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="text-xs">
                          <span className="text-voice-text-secondary">左声道: </span>
                          <span className="text-voice-text">{overlap.leftText || '(静音)'}</span>
                        </div>
                        <div className="text-xs">
                          <span className="text-voice-text-secondary">右声道: </span>
                          <span className="text-voice-text">{overlap.rightText || '(静音)'}</span>
                        </div>
                      </div>
                      <div className="mt-1 text-xs text-voice-text-secondary">
                        文字相似度: {(overlap.textSimilarity * 100).toFixed(1)}%
                        {overlap.isCrosstalk
                          ? ' — 两侧内容不同，判定为踩脚'
                          : ' — 两侧内容相近，判定为同声（非踩脚）'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action Bar */}
            <div className="flex items-center justify-center gap-3 pt-4">
              <button
                onClick={handleReset}
                className="inline-flex items-center gap-2 rounded-lg border border-voice-border bg-voice-card px-5 py-2.5 text-sm font-medium text-voice-text transition-colors hover:bg-voice-card/80"
              >
                <RotateCcw className="h-4 w-4" />
                重新检测
              </button>
              <button
                onClick={handleExport}
                className="inline-flex items-center gap-2 rounded-lg bg-voice-accent px-5 py-2.5 text-sm font-semibold text-voice-bg transition-colors hover:bg-voice-accent/90"
              >
                <Download className="h-4 w-4" />
                导出报告
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-voice-border/30 py-4">
        <p className="text-center text-xs text-voice-text-secondary">
          声音克隆条件检测工具 · 支持 WAV/MP3/FLAC/OGG/M4A 等多格式音频 · 所有分析均在服务端完成
        </p>
      </footer>
    </div>
  );
}
