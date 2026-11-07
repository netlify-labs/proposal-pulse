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

/**
 * True when a project name contains any word in PULSE_EXCLUDE (comma-separated, case-insensitive),
 * e.g. PULSE_EXCLUDE=revops,internal. Matching projects are never tracked.
 */
export const isExcludedName = (name: string, words: string[] = envList("PULSE_EXCLUDE")) => {
  const n = name.toLowerCase();
  return words.some((w) => n.includes(w.toLowerCase()));
};

export const stripSlash = (url: string) => url.replace(/\/+$/, "");

/** This project's production URL. Netlify sets URL for every function; no config needed. */
export const ownUrl = () => stripSlash(env("URL"));

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
