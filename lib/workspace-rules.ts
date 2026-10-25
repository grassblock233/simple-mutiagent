export const DEFAULT_EXCLUDES = [".git/", "node_modules/", ".next/", "dist/", "build/", "coverage/", ".workflow-home/", ".workflow-tmp/", ".env*", "*.pem", "*.key", "*.p12", "*.crt", "*.png", "*.jpg", "*.pdf", "*.zip", "*.lock"];

export type ScanStats = { scanned: number; files: number; bytes: number; skipped: Record<string, number>; directories: { path: string; files: number; bytes: number }[] };
