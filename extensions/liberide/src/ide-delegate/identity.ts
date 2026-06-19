import { fetchAuthenticatedUser, getIntegrationIdentity, type AuthenticatedUserSnapshot } from "../api";

const FALLBACK_USER_ID = "default";

let cachedIdentity: AuthenticatedUserSnapshot | undefined = getIntegrationIdentity();
let warnedFallback = false;

export function currentIdeIdentity(): AuthenticatedUserSnapshot {
  return cachedIdentity ?? { id: FALLBACK_USER_ID };
}

export function currentIdeUserId(): string {
  return currentIdeIdentity().id || FALLBACK_USER_ID;
}

export async function refreshIdeIdentity(log?: (message: string) => void): Promise<AuthenticatedUserSnapshot> {
  const integrationIdentity = getIntegrationIdentity();
  if (integrationIdentity?.id) cachedIdentity = integrationIdentity;
  try {
    const user = await fetchAuthenticatedUser();
    cachedIdentity = user;
    warnedFallback = false;
    return user;
  } catch (err) {
    if (!cachedIdentity) {
      cachedIdentity = { id: FALLBACK_USER_ID };
      if (!warnedFallback) {
        warnedFallback = true;
        log?.(`Using fallback IDE identity "${FALLBACK_USER_ID}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return cachedIdentity;
  }
}

