import type { Metadata } from 'next';
import './globals.css';

const metadataBase = new URL(process.env.PUBLIC_SITE_URL || 'http://localhost:3000');

export const metadata: Metadata = {
  title: '催催｜会中干预型会议助手',
  description: '实时识别偏题、重复、争议与超时，让会议在失控之前回到正题。',
  metadataBase,
  icons: { icon: '/favicon.svg' },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    title: '催催｜会中干预型会议助手',
    description: '让会议在失控之前，被温柔地催回来。',
    images: [{ url: new URL('/og.png', metadataBase).toString(), width: 1732, height: 908, alt: '催催会议效率助手' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '催催｜会中干预型会议助手',
    description: '让会议在失控之前，被温柔地催回来。',
    images: [new URL('/og.png', metadataBase).toString()],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
