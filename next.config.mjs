/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // avoid double-firing the stream fetch in dev
  eslint: { ignoreDuringBuilds: true }, // demo build: don't fail on lint
};
export default nextConfig;
