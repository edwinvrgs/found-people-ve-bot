export type SourceIdentity = {
  sourceUrl: string;
  isPersonSpecificSourceUrl: boolean;
  sourceUrlMatchKey: string | null;
};

export function sourceIdentityFor(sourceUrl: string): SourceIdentity {
  return {
    sourceUrl,
    isPersonSpecificSourceUrl: isPersonSpecificSourceUrl(sourceUrl),
    sourceUrlMatchKey: personSpecificSourceUrlMatchKey(sourceUrl),
  };
}

export function isPersonSpecificSourceUrl(sourceUrl: string) {
  return personSpecificSourceUrlMatchKey(sourceUrl) !== null;
}

export function personSpecificSourceUrlMatchKey(sourceUrl: string) {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname === "venezuelatebusca.com" && /^#record=.+/.test(url.hash)) return url.toString();
    if (url.searchParams.get("persona")) return url.toString();
    if (/\/p\/[A-Za-z0-9_-]+/.test(url.pathname)) return url.toString();
    if (url.hostname === "github.com" && /^#L\d+/.test(url.hash)) return url.toString();
    return null;
  } catch {
    return null;
  }
}
