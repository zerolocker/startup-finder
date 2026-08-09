import { describe, expect, it } from 'vitest';
import { isLikelyOperatingStartup, parseFormD, parseFormIndex, primaryDocUrl } from '../src/sources/edgar.ts';
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

  it('drops real estate vehicles', () => {
    expect(isLikelyOperatingStartup(filing({ industryGroup: 'Residential' })).keep).toBe(false);
  });

  it('drops limited partnerships', () => {
    expect(isLikelyOperatingStartup(filing({ entityType: 'Limited Partnership' })).keep).toBe(false);
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
