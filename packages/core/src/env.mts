/** Read an environment variable in Netlify Functions, falling back to process.env (tests, scripts). */
export const env = (key: string): string => {
  try {
    // @ts-ignore Netlify global is only present in the Functions runtime
    return Netlify.env.get(key) || "";
  } catch {
    return process.env[key] || "";
  }
};

/** Comma-separated env var as a trimmed, non-empty list. */
export const envList = (key: string): string[] =>
  env(key)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Team slugs whose projects get the tracker. Empty means nothing is tracked. */
export const pulseTeams = () => envList("PULSE_TEAMS");

export const stripSlash = (url: string) => url.replace(/\/+$/, "");

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
