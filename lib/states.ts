/**
 * The 57 jurisdictions the grant knowledge base covers, and the two ways the app
 * names them: the USPS code everything NSGP uses ("TX"), and the snake_case slug
 * the map's path file and the scraper use ("texas").
 */
export type JurisdictionKind = "state" | "district" | "territory" | "federal";
export type Jurisdiction = { usps: string; slug: string; name: string; kind: JurisdictionKind };

const STATES: [string, string][] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"],
  ["CT", "Connecticut"], ["DE", "Delaware"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"],
  ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"],
  ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
  ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
  ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
];
const slugOf = (name: string) => name.toLowerCase().replace(/\./g, "").replace(/\s+/g, "_");

export const JURISDICTIONS: Jurisdiction[] = [
  ...STATES.map(([usps, name]) => ({ usps, name, slug: slugOf(name), kind: "state" as const })),
  { usps: "DC", name: "District of Columbia", slug: "district_of_columbia", kind: "district" },
  { usps: "PR", name: "Puerto Rico", slug: "puerto_rico", kind: "territory" },
  { usps: "GU", name: "Guam", slug: "guam", kind: "territory" },
  { usps: "VI", name: "U.S. Virgin Islands", slug: "us_virgin_islands", kind: "territory" },
  { usps: "AS", name: "American Samoa", slug: "american_samoa", kind: "territory" },
  { usps: "MP", name: "Northern Mariana Islands", slug: "northern_mariana_islands", kind: "territory" },
  { usps: "US", name: "Federal (United States)", slug: "united_states", kind: "federal" },
];

const BY_USPS = new Map(JURISDICTIONS.map((j) => [j.usps, j]));
const BY_SLUG = new Map(JURISDICTIONS.map((j) => [j.slug, j]));

export const jurisdiction = (usps: string) => BY_USPS.get(usps.toUpperCase());
export const uspsFromSlug = (slug: string) => BY_SLUG.get(slug)?.usps;
export const slugFromUsps = (usps: string) => BY_USPS.get(usps.toUpperCase())?.slug;
export const nameFromSlug = (slug: string) => BY_SLUG.get(slug)?.name;

/** Too small to hit on the map; offered as chips beside it. */
export const SMALL_ON_MAP = ["VT", "NH", "MA", "RI", "CT", "NJ", "DE", "MD", "DC"];
/** Not on the map at all. */
export const OFF_MAP = ["PR", "GU", "VI", "AS", "MP"];
