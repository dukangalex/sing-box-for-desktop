import { preferredLocale } from "./locale";

export function userAgent(): string {
  return `AngelaBox (sing-box ${__APP_VERSION__}; language ${preferredLocale().replaceAll("-", "_")})`;
}
