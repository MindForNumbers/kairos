import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    // The agent page became "Approvals" in the main nav (Stage 7a).
    return [{ source: "/agent", destination: "/approvals", permanent: false }];
  },
};

export default nextConfig;
