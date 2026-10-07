import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Электронный дом. Проверка знаний",
  description: "Генератор вопросов для подготовки обходчиков",
  icons: {
    icon: "/il2-dev-black.png",
    apple: "/il2-dev-black.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
