import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '声音克隆条件检测',
  description: '检测语音文件是否符合声音克隆条件',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="dark">
      <body className="min-h-screen bg-voice-bg text-voice-text antialiased">
        {children}
      </body>
    </html>
  );
}
