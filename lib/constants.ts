/**
 * COLORS points at the CSS custom properties defined in app/globals.css.
 * Because every value is a `var(--x)`, any component using inline styles
 * follows the light/dark theme automatically — no per-component branching.
 * The raw hex values live in globals.css and nowhere else.
 */
export const COLORS = {
  // Surfaces
  sidebarBg: 'var(--card)',
  sidebarText: 'var(--ink)',
  sidebarMuted: 'var(--sec)',
  sidebarActive: 'var(--navy)',
  sidebarBorder: 'var(--hair)',
  sidebarHover: 'var(--hover)',

  // Brand — navy and olive are the only two hues
  accent: 'var(--navy)',
  accentLight: 'var(--navy)',
  green: 'var(--olive)',
  greenLight: 'var(--olive)',
  onAccent: 'var(--on-accent)',

  // Page
  pageBg: 'var(--bg)',
  cardBg: 'var(--card)',
  cardBorder: 'var(--bd)',
  cardShadow: 'var(--shadow-card)',
  cardShadowHover: 'var(--shadow-card-hover)',

  // Text
  textPrimary: 'var(--ink)',
  textSecondary: 'var(--sec)',
  textMuted: 'var(--mute)',
  textFaint: 'var(--faint)',

  // Lines & fills
  hairline: 'var(--hair)',
  hairlineSoft: 'var(--hair2)',
  track: 'var(--track)',
  inputBorder: 'var(--bd2)',
  hover: 'var(--hover)',

  // Status
  success: 'var(--ok-fg)',
  successBg: 'var(--ok-bg)',
  warning: 'var(--warn-fg)',
  warningBg: 'var(--warn-bg)',
  error: 'var(--err-fg)',
  errorBg: 'var(--err-bg)',
  running: 'var(--run-fg)',
  runningBg: 'var(--run-bg)',
  queued: 'var(--q-fg)',
  queuedBg: 'var(--q-bg)',
};

function ensureProtocol(url: string): string {
  if (!url) return url;
  return url.match(/^https?:\/\//) ? url : `https://${url}`;
}

export const API_URLS: Record<string, string> = {
  church: ensureProtocol(process.env.NEXT_PUBLIC_CHURCH_API_URL || 'https://church-scraper-production.up.railway.app'),
  school: ensureProtocol(process.env.NEXT_PUBLIC_SCHOOL_API_URL || 'https://npsa-scraper.up.railway.app'),
};

export const LOE_URL = ensureProtocol(process.env.NEXT_PUBLIC_LOE_URL || 'https://loe-generator-production.up.railway.app');

export const US_STATES = [
  { value: 'alabama', label: 'Alabama' },
  { value: 'alaska', label: 'Alaska' },
  { value: 'arizona', label: 'Arizona' },
  { value: 'arkansas', label: 'Arkansas' },
  { value: 'california', label: 'California' },
  { value: 'colorado', label: 'Colorado' },
  { value: 'connecticut', label: 'Connecticut' },
  { value: 'delaware', label: 'Delaware' },
  { value: 'florida', label: 'Florida' },
  { value: 'georgia', label: 'Georgia' },
  { value: 'hawaii', label: 'Hawaii' },
  { value: 'idaho', label: 'Idaho' },
  { value: 'illinois', label: 'Illinois' },
  { value: 'indiana', label: 'Indiana' },
  { value: 'iowa', label: 'Iowa' },
  { value: 'kansas', label: 'Kansas' },
  { value: 'kentucky', label: 'Kentucky' },
  { value: 'louisiana', label: 'Louisiana' },
  { value: 'maine', label: 'Maine' },
  { value: 'maryland', label: 'Maryland' },
  { value: 'massachusetts', label: 'Massachusetts' },
  { value: 'michigan', label: 'Michigan' },
  { value: 'minnesota', label: 'Minnesota' },
  { value: 'mississippi', label: 'Mississippi' },
  { value: 'missouri', label: 'Missouri' },
  { value: 'montana', label: 'Montana' },
  { value: 'nebraska', label: 'Nebraska' },
  { value: 'nevada', label: 'Nevada' },
  { value: 'new_hampshire', label: 'New Hampshire' },
  { value: 'new_jersey', label: 'New Jersey' },
  { value: 'new_mexico', label: 'New Mexico' },
  { value: 'new_york', label: 'New York' },
  { value: 'north_carolina', label: 'North Carolina' },
  { value: 'north_dakota', label: 'North Dakota' },
  { value: 'ohio', label: 'Ohio' },
  { value: 'oklahoma', label: 'Oklahoma' },
  { value: 'oregon', label: 'Oregon' },
  { value: 'pennsylvania', label: 'Pennsylvania' },
  { value: 'rhode_island', label: 'Rhode Island' },
  { value: 'south_carolina', label: 'South Carolina' },
  { value: 'south_dakota', label: 'South Dakota' },
  { value: 'tennessee', label: 'Tennessee' },
  { value: 'texas', label: 'Texas' },
  { value: 'utah', label: 'Utah' },
  { value: 'vermont', label: 'Vermont' },
  { value: 'virginia', label: 'Virginia' },
  { value: 'washington', label: 'Washington' },
  { value: 'west_virginia', label: 'West Virginia' },
  { value: 'wisconsin', label: 'Wisconsin' },
  { value: 'wyoming', label: 'Wyoming' },
];

export const SCRAPER_LABELS = {
  church: { singular: 'Church', plural: 'Churches', title: 'Church Scraper' },
  school: { singular: 'School', plural: 'Schools', title: 'School Scraper' },
};

/** County counts per state, from assets/data/state_counties/*.txt in the scraper backends. */
export const STATE_COUNTY_COUNTS: Record<string, number> = {
  alabama: 67, alaska: 29, arizona: 15, arkansas: 75, california: 58,
  colorado: 64, connecticut: 8, delaware: 3, florida: 67, georgia: 159,
  hawaii: 5, idaho: 44, illinois: 102, indiana: 92, iowa: 99,
  kansas: 105, kentucky: 120, louisiana: 64, maine: 16, maryland: 24,
  massachusetts: 14, michigan: 83, minnesota: 87, mississippi: 82, missouri: 115,
  montana: 56, nebraska: 93, nevada: 16, new_hampshire: 10, new_jersey: 21,
  new_mexico: 33, new_york: 62, north_carolina: 100, north_dakota: 53, ohio: 88,
  oklahoma: 77, oregon: 36, pennsylvania: 67, rhode_island: 5, south_carolina: 46,
  south_dakota: 66, tennessee: 95, texas: 254, utah: 29, vermont: 14,
  virginia: 95, washington: 39, west_virginia: 55, wisconsin: 72, wyoming: 23,
};

/**
 * Wall-clock minutes per county, used only for the "est." hint on the New Scrape
 * panel. Schools measured at ~14.5 min/county; churches run slower (~37.6).
 */
export const MINUTES_PER_COUNTY: Record<ScraperTypeKey, number> = {
  school: 14.7,
  church: 37.6,
};

type ScraperTypeKey = 'school' | 'church';

/** "254 counties · est. ~2d 14h" */
export function estimateRunTime(stateValue: string, type: ScraperTypeKey): string {
  const counties = STATE_COUNTY_COUNTS[stateValue] || 0;
  if (!counties) return 'select a state';
  const hrs = Math.round((counties * MINUTES_PER_COUNTY[type]) / 60);
  const dur = hrs >= 24 ? `${Math.floor(hrs / 24)}d ${hrs % 24}h` : `${hrs}h`;
  return `${counties} counties · est. ~${dur}`;
}
