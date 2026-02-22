import type { KeychainProvider } from "../../security/keychain-provider";
import type { OpenClawAuthProfile } from "../types";
import type { MapError, MapperOptions, MapResult } from "./types";

const BYOK_SERVICE = "reins-byok";
const TOKEN_SERVICE = "reins-token";
const OAUTH_ACCESS_SERVICE = "reins-oauth-access";
const OAUTH_REFRESH_SERVICE = "reins-oauth-refresh";

type AuthMode = "api_key" | "oauth" | "token";

interface AuthProfileLike extends OpenClawAuthProfile {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  name?: string;
  id?: string;
  type?: AuthMode;
}

export class CredentialMapper {
  private readonly keychainProvider: KeychainProvider;

  constructor(keychainProvider: KeychainProvider) {
    this.keychainProvider = keychainProvider;
  }

  public async map(
    authProfiles: OpenClawAuthProfile[],
    options?: MapperOptions,
  ): Promise<MapResult> {
    const errors: MapError[] = [];
    let converted = 0;
    let skipped = 0;

    for (let i = 0; i < authProfiles.length; i++) {
      const profile = authProfiles[i] as AuthProfileLike;
      const itemLabel = this.resolveItemLabel(profile);

      try {
        const mode = this.resolveMode(profile);
        if (!mode) {
          skipped += 1;
          options?.onProgress?.(i + 1, authProfiles.length);
          continue;
        }

        const didConvert = await this.mapProfile(profile, mode, options);
        if (didConvert) {
          converted += 1;
        } else {
          skipped += 1;
        }
      } catch {
        errors.push({
          item: itemLabel,
          reason: "Failed to store credential in keychain",
        });
        skipped += 1;
      }

      options?.onProgress?.(i + 1, authProfiles.length);
    }

    return { converted, skipped, errors };
  }

  private async mapProfile(
    profile: AuthProfileLike,
    mode: AuthMode,
    options?: MapperOptions,
  ): Promise<boolean> {
    const account = this.resolveAccount(profile);

    if (mode === "api_key") {
      const apiKey = this.resolveApiKey(profile);
      if (!apiKey) {
        return false;
      }

      if (!options?.dryRun) {
        await this.storeSecret(BYOK_SERVICE, account, apiKey);
      }

      return true;
    }

    if (mode === "token") {
      const token = this.resolveToken(profile);
      if (!token) {
        return false;
      }

      if (!options?.dryRun) {
        await this.storeSecret(TOKEN_SERVICE, account, token);
      }

      return true;
    }

    const accessToken = this.resolveAccessToken(profile);
    const refreshToken = this.resolveRefreshToken(profile);

    if (!accessToken && !refreshToken) {
      return false;
    }

    if (!options?.dryRun) {
      if (accessToken) {
        await this.storeSecret(OAUTH_ACCESS_SERVICE, `${account}:access`, accessToken);
      }

      if (refreshToken) {
        await this.storeSecret(OAUTH_REFRESH_SERVICE, `${account}:refresh`, refreshToken);
      }
    }

    return true;
  }

  private async storeSecret(service: string, account: string, secret: string): Promise<void> {
    const result = await this.keychainProvider.set(service, account, secret);
    if (!result.ok) {
      throw result.error;
    }
  }

  private resolveMode(profile: AuthProfileLike): AuthMode | null {
    const mode = profile.mode ?? profile.type;
    if (mode === "api_key" || mode === "oauth" || mode === "token") {
      return mode;
    }

    return null;
  }

  private resolveApiKey(profile: AuthProfileLike): string | null {
    const apiKey = profile.key ?? profile.apiKey;
    if (typeof apiKey !== "string") {
      return null;
    }

    const trimmed = apiKey.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private resolveToken(profile: AuthProfileLike): string | null {
    if (typeof profile.token !== "string") {
      return null;
    }

    const trimmed = profile.token.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private resolveAccessToken(profile: AuthProfileLike): string | null {
    if (typeof profile.accessToken !== "string") {
      return null;
    }

    const trimmed = profile.accessToken.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private resolveRefreshToken(profile: AuthProfileLike): string | null {
    if (typeof profile.refreshToken !== "string") {
      return null;
    }

    const trimmed = profile.refreshToken.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private resolveAccount(profile: AuthProfileLike): string {
    const candidate = profile.provider ?? profile.name ?? profile.id;
    if (typeof candidate !== "string") {
      return "unknown";
    }

    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : "unknown";
  }

  private resolveItemLabel(profile: AuthProfileLike): string {
    const candidate = profile.name ?? profile.provider ?? profile.id;
    if (typeof candidate !== "string") {
      return "unknown";
    }

    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed : "unknown";
  }
}
