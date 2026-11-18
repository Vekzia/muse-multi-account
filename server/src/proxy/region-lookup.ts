import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import type { Fingerprint } from '../types.js';
import { parseProxy } from './proxy-url.js';
import { requestUpstream } from './upstream.js';

export interface RegionObservation {
  ip: string;
  countryCode: string;
  timezone: string;
  locale: string | null;
}

const DEFAULT_ENDPOINT = 'https://ipwho.is/';
const DEADLINE_MS = 12_000;
const MAX_JSON_BYTES = 32 * 1024;
const FAILURE = 'Proxy region lookup failed';

// Assigned ISO 3166-1 alpha-2 codes. Recognition is separate from locale coverage:
// a valid country with no curated default still yields a useful timezone.
const COUNTRY_CODES = new Set(`
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ
VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW
`.split(/\s+/).filter(Boolean));

/**
 * Country-default language heuristic, not evidence of a user's native language.
 * Multilingual countries intentionally pick one default; manual locale settings
 * can override it. Unmapped countries never silently acquire an English locale.
 */
const COUNTRY_LOCALES = new Map<string, string>(Object.entries({
  AD: 'ca-AD', AE: 'ar-AE', AF: 'fa-AF', AG: 'en-AG', AI: 'en-AI', AL: 'sq-AL', AM: 'hy-AM', AO: 'pt-AO',
  AR: 'es-AR', AS: 'en-AS', AT: 'de-AT', AU: 'en-AU', AW: 'nl-AW', AX: 'sv-AX', AZ: 'az-AZ',
  BA: 'bs-BA', BB: 'en-BB', BD: 'bn-BD', BE: 'nl-BE', BF: 'fr-BF', BG: 'bg-BG', BH: 'ar-BH', BI: 'rn-BI',
  BJ: 'fr-BJ', BL: 'fr-BL', BM: 'en-BM', BN: 'ms-BN', BO: 'es-BO', BQ: 'nl-BQ', BR: 'pt-BR', BS: 'en-BS',
  BT: 'dz-BT', BW: 'en-BW', BY: 'be-BY', BZ: 'en-BZ', CA: 'en-CA', CC: 'en-CC', CD: 'fr-CD', CF: 'fr-CF',
  CG: 'fr-CG', CH: 'de-CH', CI: 'fr-CI', CK: 'en-CK', CL: 'es-CL', CM: 'fr-CM', CN: 'zh-CN', CO: 'es-CO',
  CR: 'es-CR', CU: 'es-CU', CV: 'pt-CV', CW: 'nl-CW', CX: 'en-CX', CY: 'el-CY', CZ: 'cs-CZ',
  DE: 'de-DE', DJ: 'fr-DJ', DK: 'da-DK', DM: 'en-DM', DO: 'es-DO', DZ: 'ar-DZ', EC: 'es-EC', EE: 'et-EE',
  EG: 'ar-EG', EH: 'ar-EH', ER: 'ti-ER', ES: 'es-ES', ET: 'am-ET', FI: 'fi-FI', FJ: 'en-FJ', FK: 'en-FK',
  FM: 'en-FM', FO: 'fo-FO', FR: 'fr-FR', GA: 'fr-GA', GB: 'en-GB', GD: 'en-GD', GE: 'ka-GE', GF: 'fr-GF',
  GG: 'en-GG', GH: 'en-GH', GI: 'en-GI', GL: 'kl-GL', GM: 'en-GM', GN: 'fr-GN', GP: 'fr-GP', GQ: 'es-GQ',
  GR: 'el-GR', GT: 'es-GT', GU: 'en-GU', GW: 'pt-GW', GY: 'en-GY', HK: 'zh-HK', HN: 'es-HN', HR: 'hr-HR',
  HT: 'ht-HT', HU: 'hu-HU', ID: 'id-ID', IE: 'en-IE', IL: 'he-IL', IM: 'en-IM', IN: 'hi-IN', IO: 'en-IO',
  IQ: 'ar-IQ', IR: 'fa-IR', IS: 'is-IS', IT: 'it-IT', JE: 'en-JE', JM: 'en-JM', JO: 'ar-JO', JP: 'ja-JP',
  KE: 'sw-KE', KG: 'ky-KG', KH: 'km-KH', KI: 'en-KI', KM: 'ar-KM', KN: 'en-KN', KP: 'ko-KP', KR: 'ko-KR',
  KW: 'ar-KW', KY: 'en-KY', KZ: 'kk-KZ', LA: 'lo-LA', LB: 'ar-LB', LC: 'en-LC', LI: 'de-LI', LK: 'si-LK',
  LR: 'en-LR', LS: 'en-LS', LT: 'lt-LT', LU: 'lb-LU', LV: 'lv-LV', LY: 'ar-LY', MA: 'ar-MA', MC: 'fr-MC',
  MD: 'ro-MD', ME: 'sr-ME', MF: 'fr-MF', MG: 'mg-MG', MH: 'en-MH', MK: 'mk-MK', ML: 'fr-ML', MM: 'my-MM',
  MN: 'mn-MN', MO: 'zh-MO', MP: 'en-MP', MQ: 'fr-MQ', MR: 'ar-MR', MS: 'en-MS', MT: 'mt-MT', MU: 'en-MU',
  MV: 'dv-MV', MW: 'en-MW', MX: 'es-MX', MY: 'ms-MY', MZ: 'pt-MZ', NA: 'en-NA', NC: 'fr-NC', NE: 'fr-NE',
  NF: 'en-NF', NG: 'en-NG', NI: 'es-NI', NL: 'nl-NL', NO: 'nb-NO', NP: 'ne-NP', NR: 'en-NR', NU: 'en-NU',
  NZ: 'en-NZ', OM: 'ar-OM', PA: 'es-PA', PE: 'es-PE', PF: 'fr-PF', PG: 'en-PG', PH: 'fil-PH', PK: 'ur-PK',
  PL: 'pl-PL', PM: 'fr-PM', PN: 'en-PN', PR: 'es-PR', PS: 'ar-PS', PT: 'pt-PT', PW: 'en-PW', PY: 'es-PY',
  QA: 'ar-QA', RE: 'fr-RE', RO: 'ro-RO', RS: 'sr-RS', RU: 'ru-RU', RW: 'rw-RW', SA: 'ar-SA', SB: 'en-SB',
  SC: 'fr-SC', SD: 'ar-SD', SE: 'sv-SE', SG: 'en-SG', SH: 'en-SH', SI: 'sl-SI', SJ: 'nb-SJ', SK: 'sk-SK',
  SL: 'en-SL', SM: 'it-SM', SN: 'fr-SN', SO: 'so-SO', SR: 'nl-SR', SS: 'en-SS', ST: 'pt-ST', SV: 'es-SV',
  SX: 'nl-SX', SY: 'ar-SY', SZ: 'en-SZ', TC: 'en-TC', TD: 'fr-TD', TG: 'fr-TG', TH: 'th-TH', TJ: 'tg-TJ',
  TK: 'en-TK', TL: 'pt-TL', TM: 'tk-TM', TN: 'ar-TN', TO: 'to-TO', TR: 'tr-TR', TT: 'en-TT', TV: 'en-TV',
  TW: 'zh-TW', TZ: 'sw-TZ', UA: 'uk-UA', UG: 'en-UG', UM: 'en-UM', US: 'en-US', UY: 'es-UY', UZ: 'uz-UZ',
  VA: 'it-VA', VC: 'en-VC', VE: 'es-VE', VG: 'en-VG', VI: 'en-VI', VN: 'vi-VN', VU: 'bi-VU', WF: 'fr-WF',
  WS: 'sm-WS', YE: 'ar-YE', YT: 'fr-YT', ZA: 'en-ZA', ZM: 'en-ZM', ZW: 'en-ZW',
}));

export function localeForCountry(code: string): string | null {
  return COUNTRY_LOCALES.get(code.trim().toUpperCase()) ?? null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function observation(value: unknown): RegionObservation {
  if (!record(value) || value.success !== true || typeof value.ip !== 'string' || !isIP(value.ip) ||
    typeof value.country_code !== 'string' || !COUNTRY_CODES.has(value.country_code) ||
    !record(value.timezone) || typeof value.timezone.id !== 'string') throw new Error(FAILURE);
  const timezone = value.timezone.id;
  // Reject dates and numeric offsets; newer Intl versions accept offset zones,
  // while this contract requires a named IANA timezone (including UTC aliases).
  if (!timezone || timezone !== timezone.trim() || /^[+-]/.test(timezone)) throw new Error(FAILURE);
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  return { ip: value.ip, countryCode: value.country_code, timezone, locale: localeForCountry(value.country_code) };
}

/**
 * Observe the account's proxy exit through the fixed provider. endpoint is a
 * server-side fixture seam, never an account-supplied URL. No jar, cookies or
 * target authorization are passed, and every failure has a fixed public error.
 */
export async function lookupProxyRegion(options: {
  proxy: string;
  endpoint?: string;
  fingerprint?: Fingerprint;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RegionObservation> {
  let body: Readable | undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;
  const abort = () => {
    controller.abort();
    body?.destroy();
    rejectAbort?.();
  };
  try {
    // In particular, an empty proxy must never select requestUpstream's direct path.
    const proxy = parseProxy(options.proxy).url;
    const requestedTimeout = options.timeoutMs ?? DEADLINE_MS;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) throw new Error(FAILURE);
    const timeoutMs = Math.min(requestedTimeout, DEADLINE_MS);
    const target = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.hash) throw new Error(FAILURE);
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error(FAILURE));
    });
    // Install the race before starting work so even a pending CONNECT, browser
    // worker acquisition or body read is bounded by the same absolute deadline.
    const work = async () => {
      const response = await requestUpstream({
        origin: target.origin, path: target.pathname + target.search, proxy,
        headers: { accept: 'application/json', 'accept-encoding': 'identity' },
        timeoutMs, signal: controller.signal,
        ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      });
      body = response.body;
      // A connector may settle just after cancellation; dispose of that late body.
      if (controller.signal.aborted) { body.destroy(); throw new Error(FAILURE); }
      if (response.statusCode !== 200) throw new Error(FAILURE);
      const encoding = response.headers['content-encoding'];
      if (encoding !== undefined && (typeof encoding !== 'string' || encoding.trim().toLowerCase() !== 'identity')) throw new Error(FAILURE);
      const contentType = response.headers['content-type'];
      if (contentType !== undefined && (typeof contentType !== 'string' || contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json')) throw new Error(FAILURE);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        if (controller.signal.aborted) throw new Error(FAILURE);
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_JSON_BYTES) throw new Error(FAILURE);
        chunks.push(bytes);
      }
      return observation(JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    // Avoid starting any request for a pre-aborted caller signal.
    if (options.signal?.aborted) throw new Error(FAILURE);
    timer = setTimeout(abort, timeoutMs);
    timer.unref();
    return await Promise.race([work(), aborted]);
  } catch {
    // Do not retain raw connector errors, provider fields, URLs, credentials or causes.
    throw new Error(FAILURE);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (body && !body.readableEnded) body.destroy();
  }
}
