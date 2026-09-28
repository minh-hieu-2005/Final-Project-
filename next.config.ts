// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Prisma needs to be treated as external in server components / route handlers.
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
