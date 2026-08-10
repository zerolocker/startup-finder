import { describe, expect, it } from 'vitest';
import {
  cleanCompanyName,
  extractHeadlineFacts,
  isFundAnnouncement,
  isFundingNews,
  isRoundup,
  parseFeed,
  type Feed,
} from '../src/sources/news.ts';

const FEED: Feed = { slug: 'test', url: 'https://example.test/feed', label: 'Test' };

describe('extractHeadlineFacts', () => {
  it('pulls company, amount, and round from a clean headline', () => {
    expect(extractHeadlineFacts('Acme raises $20M Series A led by Sequoia')).toEqual({
      company: 'Acme',
      amountUsd: 20_000_000,
      round: 'Series A',
    });
  });

  it('handles billions', () => {
    expect(extractHeadlineFacts('Bigco raises $1.5 billion').amountUsd).toBe(1_500_000_000);
  });

  it('handles non-USD symbols at face value', () => {
    // Deliberately unconverted — see the note in extractHeadlineFacts.
    expect(extractHeadlineFacts('Mironid raises €39.9 million in Series B').amountUsd).toBe(39_900_000);
  });

  it('strips locality prefixes from the company name', () => {
    expect(extractHeadlineFacts('Glasgow-based Mironid raises €39.9 million in Series B').company).toBe('Mironid');
  });

  it('strips descriptor nouns from the company name', () => {
    expect(extractHeadlineFacts('Chip startup Olix raises $312M').company).toBe('Olix');
  });

  it('recognizes pre-seed and seed rounds', () => {
    expect(extractHeadlineFacts('Foo raises $3M seed round').round).toBe('Seed');
    expect(extractHeadlineFacts('Bar closed a pre-seed').round).toBe('Pre-Seed');
  });

  it('returns nulls for a headline that is not about one company', () => {
    const facts = extractHeadlineFacts('The Week’s 10 Biggest Funding Rounds: A Big Week For Big Checks');
    expect(facts.company).toBeNull();
  });

  it('does not mistake a long sentence for a company name', () => {
    const facts = extractHeadlineFacts(
      'After a difficult year for European venture capital the market finally raises its head',
    );
    expect(facts.company).toBeNull();
  });
});

describe('cleanCompanyName', () => {
  it.each([
    ["Glasgow-based Mironid", 'Mironid'],
    ['Chip startup Olix', 'Olix'],
    ['Exclusive: Acme', 'Acme'],
    ['London’s Safehire.ai', 'Safehire.ai'],
    ['AI company Foo', 'Foo'],
    ['Acme', 'Acme'],
  ])('cleans %s to %s', (input, expected) => {
    expect(cleanCompanyName(input)).toBe(expected);
  });

  it('rejects lowercase fragments that are not names', () => {
    expect(cleanCompanyName('the market')).toBeNull();
  });

  it('rejects overly long fragments', () => {
    expect(cleanCompanyName('one two three four five six seven')).toBeNull();
  });
});

describe('parseFeed', () => {
  it('parses RSS 2.0', () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Test</title>
        <item>
          <title>Acme raises $20M</title>
          <link>https://example.test/acme</link>
          <pubDate>Wed, 06 Aug 2026 10:00:00 +0000</pubDate>
          <description>&lt;p&gt;Acme, a robotics firm&lt;/p&gt;</description>
        </item>
      </channel></rss>`;
    const items = parseFeed(xml, FEED);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Acme raises $20M');
    expect(items[0]?.url).toBe('https://example.test/acme');
    expect(items[0]?.summary).toBe('Acme, a robotics firm');
    expect(items[0]?.publishedAt.slice(0, 10)).toBe('2026-08-06');
  });

  it('parses Atom', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Beta secures $5M seed</title>
          <link rel="alternate" href="https://example.test/beta"/>
          <published>2026-08-05T09:00:00Z</published>
          <summary>Beta does things</summary>
        </entry>
      </feed>`;
    const items = parseFeed(xml, FEED);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://example.test/beta');
  });

  it('gives the same url the same id, for cross-feed dedupe', () => {
    const mk = (title: string) => `<?xml version="1.0"?><rss version="2.0"><channel><item>
      <title>${title}</title><link>https://example.test/same</link>
      <pubDate>Wed, 06 Aug 2026 10:00:00 +0000</pubDate></item></channel></rss>`;
    const a = parseFeed(mk('One headline'), FEED)[0];
    const b = parseFeed(mk('A syndicated rewrite'), { ...FEED, slug: 'other' })[0];
    expect(a?.id).toBe(b?.id);
  });

  it('returns nothing for a malformed document rather than throwing', () => {
    expect(parseFeed('<html>not a feed</html>', FEED)).toEqual([]);
  });
});

describe('isFundingNews', () => {
  const item = (title: string) => ({ id: 'x', title, url: 'u', publishedAt: '', source: 'test', summary: '' });

  it('accepts obvious funding headlines', () => {
    expect(isFundingNews(item('Acme raises $20M Series A'), FEED)).toBe(true);
    expect(isFundingNews(item('Beta closes seed round'), FEED)).toBe(true);
  });

  it('rejects unrelated coverage', () => {
    expect(isFundingNews(item('Ten tips for better standups'), FEED)).toBe(false);
  });

  it('accepts everything from a funding-only feed', () => {
    expect(isFundingNews(item('Ten tips for better standups'), { ...FEED, allFunding: true })).toBe(true);
  });

  it('rejects roundups even on a funding-only feed', () => {
    // A roundup has no single subject, so the headline parser would invent a
    // company named after the article. Regression test for that bug.
    const roundup = item('July funding: European startups raised €4B last month');
    expect(isFundingNews(roundup, { ...FEED, allFunding: true })).toBe(false);
  });
});

describe('junk-subject rejection', () => {
  // Each of these produced a bogus "company" in the first real pipeline run.
  it.each([
    ['‘A Rare Land-Grab Moment’: Menlo Ventures’ Matt Murphy On The Next Wave of AI', 'quoted interview'],
    ['Travis Kalanick’s robotics company raises $1.7B, led by a16z', 'possessive description'],
    ['White Star Capital closes $250M Fund IV to back global startups', 'VC fund close'],
    ['Repeat founder Ryan Williams raises $10M seed for an AI startup', 'a person, not a company'],
  ])('rejects %s (%s)', (title) => {
    const facts = extractHeadlineFacts(title);
    const isJunk = facts.company === null || isRoundup(title) || isFundAnnouncement(title);
    expect(isJunk).toBe(true);
  });

  it('still extracts the real company from a descriptor-prefixed headline', () => {
    expect(extractHeadlineFacts('Defense tech Hadrian raises $1.37B at $8B valuation').company).toBe('Hadrian');
  });
});

describe('bare-infinitive false positives', () => {
  // All four produced a bogus company in a real run. The first three share one
  // cause: the verb list accepted bare stems, which are also nouns/adjectives.
  it.each([
    ['QMUL spinouts looking to raise', 'bare "raise"; subject is a truncated clause'],
    ['The browser is where attacks land. Why is security still focused on the endpoint?', 'bare "land" as a verb of "attacks"'],
    ['How to build secure and user-friendly AI: data in a silo sees part of the picture', 'bare "secure" as an adjective'],
    ['Edtech platform raises $4.5M to help teach students how to vibe code', 'subject is a category, not a name'],
  ])('rejects %s', (title) => {
    expect(extractHeadlineFacts(title).company).toBeNull();
  });

  it.each([
    ['Mironid raises €39.9 million in Series B', 'Mironid'],
    ['Platter lands follow-on funding from Verb Ventures', 'Platter'],
    ['Omilia secures €58.1 million in Series B funding', 'Omilia'],
    ['Monava closes funding round as demand grows', 'Monava'],
    ['10x Banking banks £40M in debt and equity raise', '10x Banking'],
    ['HappyRobot lands $150M Series C', 'HappyRobot'],
    ['Inevitable AI Group raises €5.2 million from Aleph', 'Inevitable AI Group'],
  ])('still extracts %s', (title, expected) => {
    expect(extractHeadlineFacts(title).company).toBe(expected);
  });
});

describe('isFundAnnouncement', () => {
  it.each([
    'White Star Capital closes $250M Fund IV to back global startups from Series A to B',
    'Acme Ventures raises $500M for its new fund',
    'Foo Capital launches $100M investment arm',
  ])('flags %s', (title) => {
    expect(isFundAnnouncement(title)).toBe(true);
  });

  it('does not flag a startup round', () => {
    expect(isFundAnnouncement('HappyRobot lands $150M Series C to scale agentic AI')).toBe(false);
    expect(isFundAnnouncement('Mironid raises €39.9 million in Series B')).toBe(false);
  });
});

describe('isRoundup', () => {
  it.each([
    'The Week’s 10 Biggest Funding Rounds: A Big Week For Big Checks',
    'Weekly funding round-up! All of the European startup funding rounds we tracked this week',
    'July funding: European startups raised €4B',
    'Top 5 startups to watch',
    'Here are the deals that closed this week',
  ])('flags %s as a roundup', (title) => {
    expect(isRoundup(title)).toBe(true);
  });

  it.each([
    'Acme raises $20M Series A led by Sequoia',
    'Glasgow-based Mironid raises €39.9 million in Series B',
  ])('does not flag single-company headline %s', (title) => {
    expect(isRoundup(title)).toBe(false);
  });
});
