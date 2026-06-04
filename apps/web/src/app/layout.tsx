import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'amoCRM Analytics',
  description: 'Рабочий стол РОПа и конструктор отчётов по amoCRM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
