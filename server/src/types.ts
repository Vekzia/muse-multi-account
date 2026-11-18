export interface Fingerprint {
  uaMode: string;
  uaCustom: string;
  timezone: string;
  locale: string;
  /** Missing legacy policy: nonempty field is manual, blank follows proxy exit. */
  localeMode?: 'proxy' | 'manual' | 'native';
  timezoneMode?: 'proxy' | 'manual' | 'native';
  webdriver: boolean;
  noise: boolean;
  webrtc: boolean;
  /** Legacy profiles are disabled until explicitly enabled. */
  enabled?: boolean;
  /** Stable nonzero uint32; changed only by explicit profile generation. */
  readonly seed?: number;
  /** Empty strings and zero numeric options retain native browser values. */
  platform?: string;
  screenWidth?: number;
  screenHeight?: number;
  pixelRatio?: number;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  webglVendor?: string;
  webglRenderer?: string;
  audioNoise?: boolean;
  /** All policy effects are gated by enabled; missing values retain native behavior. */
  tlsProfile?: 'native' | 'chrome131' | 'chrome142';
  workerMode?: 'native' | 'profile';
  fontMode?: 'native' | 'standard';
  webgpuMode?: 'native' | 'disabled';
}

export interface KeepAlive {
  enabled: boolean;
  /** Integer minutes, inclusive range 30..1440; defaults to 360. */
  intervalMinutes: number;
  /** Explicit opt-in; a session check alone never wakes a VM. */
  wakeVm: boolean;
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
  /** Missing legacy settings normalize to disabled/360 minutes/no VM wake. */
  keepAlive?: KeepAlive;
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
  /** PATCH merges supplied fields; null restores defaults. */
  keepAlive?: Partial<KeepAlive> | null;
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
