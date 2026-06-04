# AGENTS.md

## 项目概览
声音克隆条件检测工具 - 检测语音文件是否符合声音克隆要求，包括双声道、时长、采样率、背景噪声、回响、声道踩脚6项检测。

## 版本技术栈
- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **ASR**: coze-coding-dev-sdk (ASRClient)

## 目录结构
```
├── public/                 # 静态资源
├── src/
│   ├── app/                # 页面路由与布局
│   │   ├── api/detect/     # 音频检测 API 端点
│   │   │   └── route.ts    # POST 接收音频文件，返回检测结果
│   │   ├── globals.css     # 全局样式（深色主题）
│   │   ├── layout.tsx      # 根布局
│   │   └── page.tsx        # 首页入口
│   ├── components/
│   │   └── voice-check-page.tsx  # 主页面组件（上传+结果展示）
│   └── lib/
│       ├── audio-analyzer.ts     # 音频分析核心（WAV解析/噪声/回响/声道提取）
│       └── utils.ts              # 通用工具函数
```

## 核心模块

### audio-analyzer.ts
- `parseWav(buffer)`: 解析 WAV 文件头，提取声道数、采样率、位深度、时长
- `analyzeNoise(wavInfo)`: 基于 SNR 估计的背景噪声检测（帧能量分析）
- `analyzeEcho(wavInfo)`: 基于自相关的回响检测（10-500ms 延迟范围）
- `extractChannelAsMonoWav(wavInfo, channelIndex)`: 提取单声道并构建 WAV
- `resampleWav(wavBuffer, targetSampleRate)`: 重采样到目标采样率

### /api/detect (POST)
- 接收 multipart/form-data 上传的音频文件
- 仅支持 WAV 格式的完整检测
- 6项检测：双声道、时长≥5分钟、采样率≥24kHz、背景噪声、回响、声道踩脚
- 声道踩脚检测使用 ASRClient 对左右声道分别识别并比较时间戳

## 包管理规范
**仅允许使用 pnpm** 作为包管理器

## 开发规范
- TypeScript strict 模式
- 禁止隐式 any
- 使用 'use client' + useEffect/useState 处理客户端动态内容
- shadcn/ui 组件位于 src/components/ui/

## 设计规范
- 深色主题：控制室风格（背景 #0C0F14，卡片 #161B26）
- 强调色：青绿 #00D4AA（通过）、琥珀 #F5A623（警告）、珊瑚红 #FF4D6A（不通过）
- 等宽字体 JetBrains Mono 用于数据指标
- 详见 DESIGN.md
