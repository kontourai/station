export interface AuthStatus {
  provider: string;
  status: 'valid' | 'expiring' | 'expired' | 'missing' | 'not-configured';
  expiresAt: string | null;
  message: string;
}

export interface RenewResult {
  success: boolean;
  message: string;
}

export interface UserIdentity {
  alias: string;
  name?: string;
  title?: string;
  email?: string;
  profileUrl?: string;
}

export interface UserDetailVM {
  alias: string;
  name: string;
  title?: string;
  team?: string;
  manager?: { alias: string; name?: string };
  email?: string;
  location?: string;
  avatarUrl?: string;
  profileUrl?: string;
  badges?: string[];
  tenure?: string;
  directReports?: number;
  extra?: Record<string, unknown>;
}
