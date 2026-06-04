import type { Metadata } from 'next';
import VoiceCheckPage from '@/components/voice-check-page';

export const metadata: Metadata = {
  title: '声音克隆条件检测 | Voice Clone Checker',
  description: '检测语音文件是否符合声音克隆条件：双声道、时长、采样率、背景噪声、回响、声道踩脚',
};

export default function Page() {
  return <VoiceCheckPage />;
}
