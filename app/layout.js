import "./globals.css";

export const metadata = {
  title: "Quorum — the fleet shows you where it disagrees",
  description:
    "Five frontier open-weight models on one Nebius Token Factory bill. Consensus as a trust signal, disagreement as the product.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
