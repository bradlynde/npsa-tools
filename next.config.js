/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    domains: [],
  },
  // Nothing embeds the toolbox (it embeds the LOE app, not the other way round),
  // so refuse framing outright; that stops clickjacking on the edit and verify buttons.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ]
  },
  generateBuildId: async () => {
    return `build-${Date.now()}`
  },
}

module.exports = nextConfig
