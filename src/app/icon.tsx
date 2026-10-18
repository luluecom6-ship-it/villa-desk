import { ImageResponse } from "next/og";

// Favicon: the Mahinoor Stays mark (gabled roof over an arched doorway, brass on
// areca green). Same shapes as src/components/brand/logo-mark.tsx.
export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <svg width="32" height="32" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="8" fill="#1f4a41" />
        <path d="M6.5 15.5 16 7.5l9.5 8" fill="none" stroke="#e0a82e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12.25 25.5v-5.25a3.75 3.75 0 0 1 7.5 0v5.25" fill="none" stroke="#f3efe3" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    { ...size },
  );
}
