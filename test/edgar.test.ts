import { describe, expect, it } from 'vitest';
import {
  indexDatesEnding,
  indexDatesFor,
  isLikelyOperatingStartup,
  parseFormD,
  parseFormIndex,
  primaryDocUrl,
} from '../src/sources/edgar.ts';
import type { FormDFiling } from '../src/types.ts';

/** Trimmed from a real filing (Flo Artificial Intelligence, accession 0001798621-26-000003). */
const SAMPLE_XML = `<?xml version="1.0"?>
<edgarSubmission>
  <submissionType>D</submissionType>
  <primaryIssuer>
    <cik>0001798621</cik>
    <entityName>Flo Artificial Intelligence, Inc.</entityName>
    <issuerAddress>
      <street1>6580 E McDowell Rd</street1>
      <city>Scottsdale</city>
      <stateOrCountry>AZ</stateOrCountry>
      <zipCode>85257</zipCode>
    </issuerAddress>
    <jurisdictionOfInc>DELAWARE</jurisdictionOfInc>
    <entityType>Corporation</entityType>
    <issuerSize><revenueRange>Decline to Disclose</revenueRange></issuerSize>
  </primaryIssuer>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Jatish</firstName><lastName>Patel</lastName></relatedPersonName>
      <relatedPersonRelationshipList>
        <relationship>Executive Officer</relationship>
        <relationship>Director</relationship>
      </relatedPersonRelationshipList>
    </relatedPersonInfo>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Rob</firstName><lastName>Leclerc</lastName></relatedPersonName>
      <relatedPersonRelationshipList><relationship>Director</relationship></relatedPersonRelationshipList>
    </relatedPersonInfo>
  </relatedPersonsList>
  <offeringData>
    <industryGroup><industryGroupType>Other Technology</industryGroupType></industryGroup>
    <typeOfFiling>
      <newOrAmendment><isAmendment>false</isAmendment></newOrAmendment>
      <dateOfFirstSale><value>2026-06-26</value></dateOfFirstSale>
    </typeOfFiling>
    <offeringSalesAmounts>
      <totalOfferingAmount>13992757</totalOfferingAmount>
      <totalAmountSold>13992757</totalAmountSold>
      <totalRemaining>0</totalRemaining>
    </offeringSalesAmounts>
    <investors><totalNumberAlreadyInvested>16</totalNumberAlreadyInvested></investors>
  </offeringData>
</edgarSubmission>`;

const CTX = { cik: '1798621', filedDate: '2026-07-06', accessionNumber: '0001798621-26-000003' };

function filing(overrides: Partial<FormDFiling> = {}): FormDFiling {
  return {
    cik: '0000000001',
    accessionNumber: 'x',
    entityName: 'Acme Robotics, Inc.',
    filedDate: '2026-08-01',
    dateOfFirstSale: '2026-07-20',
    industryGroup: 'Other Technology',
    totalOfferingAmount: 5_000_000,
    totalAmountSold: 5_000_000,
    totalRemaining: 0,
    investorCount: 4,
    isAmendment: false,
    jurisdictionOfIncorporation: 'DELAWARE',
    entityType: 'Corporation',
    revenueRange: null,
    relatedPersons: [],
    address: null,
    filingUrl: 'https://example.test',
    ...overrides,
  };
}

describe('parseFormD', () => {
  const parsed = parseFormD(SAMPLE_XML, CTX);

  it('extracts issuer identity', () => {
    expect(parsed?.entityName).toBe('Flo Artificial Intelligence, Inc.');
    expect(parsed?.cik).toBe('0001798621');
    expect(parsed?.entityType).toBe('Corporation');
  });

  it('extracts offering amounts as numbers', () => {
    expect(parsed?.totalAmountSold).toBe(13_992_757);
    expect(parsed?.totalOfferingAmount).toBe(13_992_757);
    expect(parsed?.investorCount).toBe(16);
  });

  it('prefers date of first sale over filing date', () => {
    expect(parsed?.dateOfFirstSale).toBe('2026-06-26');
    expect(parsed?.filedDate).toBe('2026-07-06');
  });

  it('collects related persons with their roles', () => {
    expect(parsed?.relatedPersons).toHaveLength(2);
    expect(parsed?.relatedPersons[0]).toEqual({
      name: 'Jatish Patel',
      relationships: ['Executive Officer', 'Director'],
    });
    // A single <relationship> child must still become an array.
    expect(parsed?.relatedPersons[1]?.relationships).toEqual(['Director']);
  });

  it('parses the address', () => {
    expect(parsed?.address?.city).toBe('Scottsdale');
    expect(parsed?.address?.state).toBe('AZ');
  });

  it('treats "Indefinite" offerings as unknown, not zero', () => {
    const xml = SAMPLE_XML.replace('<totalOfferingAmount>13992757</totalOfferingAmount>', '<totalOfferingAmount>Indefinite</totalOfferingAmount>');
    expect(parseFormD(xml, CTX)?.totalOfferingAmount).toBeNull();
  });

  it('returns null for XML that is not a Form D submission', () => {
    expect(parseFormD('<html><body>404</body></html>', CTX)).toBeNull();
  });
});

describe('parseFormIndex', () => {
  const IDX = `Description:           Daily Index
Form Type   Company Name                          CIK        Date Filed  File Name
---------------------------------------------------------------------------
1-A         BLUEMOUNT INTERNATIONAL INC           2140965    20260806    edgar/data/2140965/0002140965-26-000001.txt
D           ACME ROBOTICS INC                     2141915    20260806    edgar/data/2141915/0002141915-26-000001.txt
D/A         BETA LABS INC                         2145763    20260806    edgar/data/2145763/0000945621-26-000974.txt
8-K         SOME PUBLIC CO                        320193     20260806    edgar/data/320193/0000320193-26-000010.txt`;

  it('keeps only the requested form types', () => {
    const rows = parseFormIndex(IDX, ['D']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyName).toBe('ACME ROBOTICS INC');
  });

  it('can include amendments', () => {
    expect(parseFormIndex(IDX, ['D', 'D/A'])).toHaveLength(2);
  });

  it('formats the filing date as ISO', () => {
    expect(parseFormIndex(IDX, ['D'])[0]?.filedDate).toBe('2026-08-06');
  });

  it('ignores headers and separator lines', () => {
    expect(parseFormIndex(IDX, ['D', 'D/A', '1-A', '8-K'])).toHaveLength(4);
  });
});

describe('primaryDocUrl', () => {
  it('builds the XML url from an index path', () => {
    const { url, accessionNumber } = primaryDocUrl('edgar/data/1798621/0001798621-26-000003.txt');
    expect(accessionNumber).toBe('0001798621-26-000003');
    expect(url).toBe('https://www.sec.gov/Archives/edgar/data/1798621/000179862126000003/primary_doc.xml');
  });
});

describe('isLikelyOperatingStartup', () => {
  it('keeps a normal venture-backed corporation', () => {
    expect(isLikelyOperatingStartup(filing()).keep).toBe(true);
  });

  it('drops pooled investment funds by industry', () => {
    expect(isLikelyOperatingStartup(filing({ industryGroup: 'Pooled Investment Fund' })).keep).toBe(false);
  });

  // Real strings from a live EDGAR day. The exclusion list was written with
  // ampersands but EDGAR spells these with "and", so both rules silently never
  // fired and their filings were researched at ~$0.28 each.
  it.each([
    ['REITS and Finance', 'Center Street Lending REIT, LLC'],
    ['Oil and Gas', 'USEDC Opportunity Zone IV LP'],
  ])('drops %s, which EDGAR spells with "and" rather than "&"', (industryGroup, entityName) => {
    expect(isLikelyOperatingStartup(filing({ industryGroup, entityName })).keep).toBe(false);
  });

  it('still drops the ampersand spelling, in case EDGAR ever changes', () => {
    expect(isLikelyOperatingStartup(filing({ industryGroup: 'Oil & Gas' })).keep).toBe(false);
  });

  it('drops real estate vehicles', () => {
    expect(isLikelyOperatingStartup(filing({ industryGroup: 'Residential' })).keep).toBe(false);
  });

  it('drops a limited partnership filing under a fund-like industry', () => {
    expect(
      isLikelyOperatingStartup(filing({ entityType: 'Limited Partnership', industryGroup: 'Pooled Investment Fund' }))
        .keep,
    ).toBe(false);
  });

  // Measured: an audit re-judged all 175 filings this filter dropped on a real
  // day and found exactly one real company among them — Vehlo Holdings, LP,
  // auto-repair payments software — dropped purely for being an LP. The
  // industry rules had a false-negative rate of 0/160, so the entity type only
  // counts when the industry agrees.
  it('keeps a limited partnership that operates in a real industry', () => {
    expect(
      isLikelyOperatingStartup(filing({ entityType: 'Limited Partnership', industryGroup: 'Other Technology' })).keep,
    ).toBe(true);
  });

  it('still drops a limited partnership that states no industry at all', () => {
    expect(
      isLikelyOperatingStartup(filing({ entityType: 'Limited Partnership', industryGroup: null })).keep,
    ).toBe(false);
  });

  it.each([
    'AQR Flex 1 Series LLC - Series E19',
    'AP Lumina Co-Invest, L.P.',
    'ADVENIR@VARINA OAKS INVESTOR, LLC',
    'All Seas Capital II Rated Feeder, L.P.',
    'Chapul II, a series of Capitalize Investments LLC',
    'Sequoia Capital Partners',
    'Acme Growth Fund III',
  ])('drops investment vehicle named %s', (entityName) => {
    expect(isLikelyOperatingStartup(filing({ entityName })).keep).toBe(false);
  });

  it.each(['Anthropic, Inc.', 'Stripe Inc', 'Vercel Inc.', 'Modal Labs, Inc.', 'Figma, Inc.'])(
    'keeps real startup named %s',
    (entityName) => {
      expect(isLikelyOperatingStartup(filing({ entityName })).keep).toBe(true);
    },
  );
});

describe('indexDatesFor', () => {
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  // Early morning UTC, the exact condition under which the bug showed up.
  const NOW = new Date('2026-08-11T06:45:00Z');

  // EDGAR publishes a day's index only after that day closes, so asking for
  // today returns nothing. Counting it against the window made `--days 1`
  // fetch a single unpublished day and report zero filings.
  it('ends yesterday, never today', () => {
    expect(indexDatesFor(1, NOW).map(ymd)).toEqual(['2026-08-10']);
  });

  it('gives N complete days, newest first', () => {
    expect(indexDatesFor(4, NOW).map(ymd)).toEqual([
      '2026-08-10',
      '2026-08-09',
      '2026-08-08',
      '2026-08-07',
    ]);
  });

  it('crosses a month boundary', () => {
    expect(indexDatesFor(2, new Date('2026-09-01T00:30:00Z')).map(ymd)).toEqual([
      '2026-08-31',
      '2026-08-30',
    ]);
  });

  it('returns nothing for a zero-day window', () => {
    expect(indexDatesFor(0, NOW)).toEqual([]);
  });
});

describe('indexDatesEnding', () => {
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  it('scans the day it is given, not the day it is run', () => {
    expect(indexDatesEnding(1, new Date('2026-08-12T00:00:00Z')).map(ymd)).toEqual(['2026-08-12']);
  });

  it('walks back from the given day, newest first', () => {
    expect(indexDatesEnding(3, new Date('2026-09-01T00:00:00Z')).map(ymd)).toEqual([
      '2026-09-01',
      '2026-08-31',
      '2026-08-30',
    ]);
  });

  // The 2026-08-14 run covered two outstanding days and gave both of them
  // 2026-08-13's filings, so the 2026-08-12 shard is a copy of the 2026-08-13
  // one — 51 identical companies, including a Form D filed on the 13th.
  it('gives two covered days two different windows', () => {
    const covered = ['2026-08-13', '2026-08-12'];
    const scanned = covered.map((d) => indexDatesEnding(1, new Date(`${d}T00:00:00Z`)).map(ymd));
    expect(scanned).toEqual([['2026-08-13'], ['2026-08-12']]);
  });

  it('agrees with the clock-anchored window when that window ends yesterday', () => {
    const now = new Date('2026-08-11T04:51:00Z');
    expect(indexDatesFor(4, now).map(ymd)).toEqual(
      indexDatesEnding(4, new Date('2026-08-10T00:00:00Z')).map(ymd),
    );
  });
});
