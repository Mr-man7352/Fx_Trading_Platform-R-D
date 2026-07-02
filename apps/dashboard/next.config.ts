import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // FE-002 — React Compiler enabled from day one.
  reactCompiler: true,
  // Shared workspace packages are consumed as TS source until they ship builds.
  transpilePackages: ['@fx/types', '@fx/api-client', '@fx/auth-client'],
};

export default nextConfig;
