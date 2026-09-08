// ── Discovery Provider Interface (对标 Revor 数据源抽象层) ──────────────────
// A pluggable provider that turns an ICP / research / contact request into
// structured prospect data. The default stub provider produces deterministic,
// realistic-looking demo prospects so the full pipeline works end-to-end
// without a paid B2B database. Swap in a real provider (e.g. Apollo / Revor
// upstream / customs data) by implementing DiscoveryProvider and injecting it.

import { logger } from '../../utils/logger.js';

// ── Types shared across discovery operations ────────────────────────────────

export interface IcpCriteria {
  /** Natural-language description of the ideal customer profile */
  prompt: string;
  /** Optional structured filters */
  region?: string;
  industry?: string;
  role?: string;
  seniority?: string;
  companySize?: string;
  /** Requested result count (tier-bounded; provider may reject out-of-tier) */
  count?: number;
}

export interface CompanyProspect {
  name: string;
  domain: string;
  website: string;
  industry: string;
  headquarters: string;
  employeeRange: string;
  description: string;
  /** Public signals that make this a high-intent match (Revor "live signals") */
  signals: string[];
  matchScore: number;
}

export interface PersonProspect {
  name: string;
  title: string;
  company: string;
  companyDomain: string;
  linkedinUrl: string;
  location: string;
  seniority: string;
  matchScore: number;
}

export interface ContactRecord {
  name: string;
  title: string;
  email: string;
  linkedinUrl: string;
  phone: string | null;
  location: string;
  verified: boolean;
}

export interface ResearchFinding {
  query: string;
  answer: string;
  sources: Array<{ title: string; url: string; snippet: string }>;
}

export interface DiscoveryProvider {
  discoverCompanies(c: IcpCriteria): Promise<CompanyProspect[]>;
  discoverPeople(c: IcpCriteria): Promise<PersonProspect[]>;
  findContacts(domain: string, positions: string[], limit: number): Promise<ContactRecord[]>;
  researchPublicWeb(
    queries: string[],
    searchLimit: number,
    opts?: { category?: string; includeDomains?: string[]; userLocation?: string },
  ): Promise<ResearchFinding[]>;
}

// ── Stub provider ────────────────────────────────────────────────────────────
// Produces deterministic, varied demo data derived from the ICP prompt so the
// async job pipeline is fully exercisable. Determinism = same prompt → same
// results, so polling and pagination are stable.

const COMPANY_PREFIXES = [
  'Nimbus', 'Vertex', 'Atlas', 'Helio', 'Cobalt', 'Meridian', 'Northwind',
  'Quantum', 'Pioneer', 'Apex', 'Forge', 'Beacon', 'Lumen', 'Cardinal',
  'Sterling', 'Veridian', 'Arcadia', 'Solace', 'Tessera', 'Halcyon',
];
const COMPANY_SUFFIXES = [
  'Industries', 'Logistics', 'Trading', 'Manufacturing', 'Supply Co',
  'Group', 'Global', 'Solutions', 'Imports', 'Distributors', 'Wholesale',
  'Networks', 'Systems', 'Partners', 'Holdings',
];
const REGIONS = ['Hamburg, DE', 'Rotterdam, NL', 'São Paulo, BR', 'Singapore, SG', 'Dubai, AE', 'Sydney, AU', 'Toronto, CA', 'London, UK'];
const FIRST_NAMES = ['Lukas', 'Sofia', 'Mateo', 'Anya', 'Jonas', 'Priya', 'Oskar', 'Lena', 'Rafael', 'Mei', 'Hans', 'Carla', 'Diego', 'Nora', 'Emil'];
const LAST_NAMES = ['Bauer', 'Costa', 'Silva', 'Novak', 'Meyer', 'Patel', 'Lindqvist', 'Rossi', 'Müller', 'Tan', 'Schmidt', 'Dubois', 'Garcia', 'Khan', 'Andersen'];
const TITLES = ['Head of Procurement', 'Supply Chain Director', 'VP Operations', 'Chief Operating Officer', 'Import Manager', 'Director of Sourcing', 'Procurement Lead', 'Operations Manager'];

function seededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export const stubProvider: DiscoveryProvider = {
  async discoverCompanies(c: IcpCriteria): Promise<CompanyProspect[]> {
    const count = Math.min(c.count ?? 25, 25);
    const rng = seededRandom(hashString(c.prompt + (c.region ?? '') + (c.industry ?? '')));
    const industry = c.industry ?? pick(['Industrial Automation', 'Construction Equipment', 'Renewable Energy', 'Food & Beverage', 'Automotive Parts', 'Pharmaceuticals', 'Electronics Manufacturing'], rng);
    const prospects: CompanyProspect[] = [];
    for (let i = 0; i < count; i++) {
      const name = `${pick(COMPANY_PREFIXES, rng)} ${pick(COMPANY_SUFFIXES, rng)}`;
      const domain = `${slug(name)}.com`;
      prospects.push({
        name,
        domain,
        website: `https://${domain}`,
        industry,
        headquarters: c.region ?? pick(REGIONS, rng),
        employeeRange: pick(['11-50', '51-200', '201-500', '501-1000', '1001-5000'], rng),
        description: `${name} is a ${industry.toLowerCase()} company sourcing components and raw materials internationally, with an active import program and growing procurement needs.`,
        signals: [
          pick(['Recently posted an RFP for suppliers', 'New procurement leadership appointed', 'Expanding to a new regional market', 'Raised a growth funding round', 'Increased import volume quarter-over-quarter'], rng),
          pick(['Active on trade procurement platforms', 'Attending an upcoming industry trade show', 'Listed a buyer profile on a B2B marketplace', 'Hiring for sourcing/purchasing roles'], rng),
        ],
        matchScore: Math.round((92 - i * 1.5 - rng() * 4) * 10) / 10,
      });
    }
    logger.info({ count: prospects.length, industry }, 'stub discoverCompanies');
    return prospects;
  },

  async discoverPeople(c: IcpCriteria): Promise<PersonProspect[]> {
    const count = Math.min(c.count ?? 25, 25);
    const rng = seededRandom(hashString(c.prompt + (c.role ?? '') + (c.seniority ?? '')));
    const role = c.role ?? 'procurement';
    const people: PersonProspect[] = [];
    for (let i = 0; i < count; i++) {
      const company = `${pick(COMPANY_PREFIXES, rng)} ${pick(COMPANY_SUFFIXES, rng)}`;
      const companyDomain = `${slug(company)}.com`;
      const first = pick(FIRST_NAMES, rng);
      const last = pick(LAST_NAMES, rng);
      const name = `${first} ${last}`;
      people.push({
        name,
        title: c.seniority === 'c-level' ? pick(['Chief Operating Officer', 'Chief Procurement Officer', 'CEO'], rng) : pick(TITLES, rng),
        company,
        companyDomain,
        linkedinUrl: `https://linkedin.com/in/${slug(first)}-${slug(last)}`,
        location: c.region ?? pick(REGIONS, rng),
        seniority: c.seniority ?? pick(['manager', 'director', 'vp'], rng),
        matchScore: Math.round((90 - i * 1.2 - rng() * 4) * 10) / 10,
      });
    }
    logger.info({ count: people.length, role }, 'stub discoverPeople');
    return people;
  },

  async findContacts(domain: string, positions: string[], limit: number): Promise<ContactRecord[]> {
    const rng = seededRandom(hashString(domain + positions.join(',')));
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const base = cleanDomain.split('.')[0] || 'company';
    const contacts: ContactRecord[] = [];
    for (let i = 0; i < Math.min(limit, 10); i++) {
      const first = pick(FIRST_NAMES, rng);
      const last = pick(LAST_NAMES, rng);
      const title = positions.length ? pick(positions, rng) : pick(TITLES, rng);
      contacts.push({
        name: `${first} ${last}`,
        title,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@${base}.com`,
        linkedinUrl: `https://linkedin.com/in/${slug(first)}-${slug(last)}`,
        phone: rng() > 0.6 ? `+1 415 555 ${1000 + Math.floor(rng() * 8999)}` : null,
        location: pick(REGIONS, rng),
        verified: rng() > 0.25,
      });
    }
    logger.info({ domain, count: contacts.length }, 'stub findContacts');
    return contacts;
  },

  async researchPublicWeb(
    queries: string[],
    _searchLimit: number,
    opts?: { category?: string; includeDomains?: string[]; userLocation?: string },
  ): Promise<ResearchFinding[]> {
    const rng = seededRandom(hashString(queries.join('|')));
    const findings: ResearchFinding[] = queries.map((q) => ({
      query: q,
      answer: `Based on public information, ${q.toLowerCase().replace(/\?$/, '')}: the company operates in international markets with an active procurement program, a diversified supplier base, and recent expansion signals. ${
        opts?.userLocation ? `Operations in ${opts.userLocation.toUpperCase()} region show growing import activity.` : ''
      } Recent developments include new supplier partnerships and increased cross-border trade volume, indicating readiness for outbound supplier outreach.`,
      sources: Array.from({ length: 3 }, (_, i) => ({
        title: pick(['Company Annual Report', 'Industry Trade Publication', 'Procurement Marketplace Listing', 'Press Release', 'Trade Registry Filing'], rng),
        url: `https://example${i + 1}.com/${slug(q.split(' ').slice(0, 3).join('-'))}`,
        snippet: pick([
          'The company reported increased import volumes and is actively evaluating new suppliers.',
          'Recent filings show expanded procurement operations and new supplier contracts.',
          'Industry analysts note growing demand in the company\'s target categories.',
        ], rng),
      })),
    }));
    logger.info({ queries: queries.length }, 'stub researchPublicWeb');
    return findings;
  },
};
