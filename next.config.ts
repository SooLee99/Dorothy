import type { NextConfig } from "next";

const isElectronBuild = process.env.ELECTRON_BUILD === '1';

const nextConfig: NextConfig = {
  // Enable static export for Electron builds
  output: isElectronBuild ? 'export' : undefined,

  // For static export, we need to disable image optimization
  images: {
    unoptimized: true,
  },

  // Ensure trailing slashes for file:// protocol compatibility
  trailingSlash: true,

  // PR-0a closeout ⑥ — 검증용 풀 빌드를 dev 의 .next 를 덮어쓰지 않고 격리 출력으로 돌리기 위함.
  // 평소(dev/electron)엔 미설정 → 기본 '.next'. DOROTHY_BUILD_DIST 줄 때만 분리.
  distDir: process.env.DOROTHY_BUILD_DIST || '.next',

  // Allow cross-origin requests from Tailscale network for remote access
  allowedDevOrigins: ['http://100.92.4.122:3000'],

  // No assetPrefix needed - we use custom app:// protocol that handles absolute paths
};

export default nextConfig;
