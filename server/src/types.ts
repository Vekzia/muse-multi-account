export interface Fingerprint {
  uaMode: string;
  uaCustom: string;
  timezone: string;
  locale: string;
  webdriver: boolean;
  noise: boolean;
  webrtc: boolean;
}

export interface Account {
  readonly id: number;
  name: string;
  avatar: string;
  proxy: string;
  proxyPool: string[];
  tags: string[];
  group: string;
  pinned: boolean;
  lastUsedAt: number;
  /** Runtime-only login state. It is never persisted by AccountStore. */
  logged: boolean;
  /** Optimistic-concurrency version for account updates. */
  version: number;
  /** Android-compatible fingerprint settings. */
  fp: Fingerprint;
}

export interface AccountInput {
  name: string;
  avatar?: string | null;
  proxy?: string | null;
  proxyPool?: string[] | null;
  tags?: string[] | null;
  group?: string | null;
  pinned?: boolean | null;
  lastUsedAt?: number | null;
  logged?: boolean | null;
  fp?: Partial<Fingerprint> | null;
}

export type AccountPatch = Partial<Omit<AccountInput, 'name'>> & { name?: string | null };

export type AccountSort = 'manual' | 'name' | 'recent';

export interface AccountListQuery {
  query?: string | null;
  group?: string | null;
  sort?: AccountSort | null;
}

export interface AccountStoreState {
  schema: 1;
  nextId: number;
  currentId: number | null;
  accounts: Account[];
}

export interface ServerConfig {
  bind: string;
  port: number;
  accessToken: string;
  upstreamOrigin: string;
  dataDir: string;
  mode: 'development' | 'production';
}
