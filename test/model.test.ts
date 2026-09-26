import { describe, expect, it } from 'vitest';
import {
  describeChanges,
  gradeOf,
  heroCandidates,
  initials,
  isLabelled,
  issueStats,
  labelKey,
  mergeLabelFile,
  parseLabels,
  pickHomepage,
  repoFromLocation,
  safeUrl,
  stateFromGrade,
  toLabelLine,
  tokenSetupUrl,
  toRow,
  youtubeId,
} from '../src/report/web/model.js';

const assessment = (over: Record<string, unknown> = {}) => ({
  fit: 72, whatTheyDo: 'Builds a thing.', headquarters: 'Seattle, WA', isOperatingCompany: true,
  matchedInterests: ['Databases'], concerns: [], rationale: 'Because.', confidence: 'medium',
  summary: 'A company.', product: 'A product.', team: '', funding: '', openRoles: [], techStack: [],
  competitors: [], redFlags: [], greenFlags: [], links: [{ label: 'Homepage', url: 'https://acme.example/' }],
  ...over,
});

const company = (over: Record<string, unknown> = {}) => ({
  id: 'acme', name: 'Acme, Inc.', normalizedName: 'acme', sources: [], location: 'SEATTLE, WA',
  latestFunding: { date: '2026-09-11', amountUsd: 5e6, round: null, investors: [], source: 'edgar', sourceUrl: '' },
  fundingEvents: [], people: [], evidence: [], firstSeenAt: '', lastUpdatedAt: '',
  assessment: assessment(), researchedAt: '',
  ...over,
});

describe('toRow', () => {
  // An SEC address is frequently the filing agent's, so the researched HQ wins.
  it('prefers the researched headquarters over the filing address', () => {
    expect(toRow(company()).location).toBe('Seattle, WA');
    expect(toRow(company({ assessment: assessment({ headquarters: '' }) })).location).toBe('Seattle, WA');
    expect(toRow(company({ location: 'PALO ALTO, CA', assessment: assessment({ headquarters: ' ' }) })).location).toBe('Palo Alto, CA');
  });

  // A null assessment means research failed — a defect worth seeing, so it
  // sorts last rather than disappearing.
  it('keeps a company whose research failed, at the bottom', () => {
    const r = toRow(company({ assessment: null }));
    expect(r.score).toBe(-1);
    expect(r.what).toMatch(/^Not assessed/);
  });

  it('drops links that are not http(s)', () => {
    const r = toRow(company({ assessment: assessment({ links: [
      { label: 'Homepage', url: 'javascript:alert(1)' },
      { label: 'Careers', url: 'https://acme.example/jobs' },
    ] }) }));
    expect(r.links).toEqual([{ label: 'Careers', url: 'https://acme.example/jobs' }]);
  });

  it('upgrades scraped pictures to https, which an https page can load', () => {
    const r = toRow(company({ media: { homepage: 'https://acme.example/', image: 'http://acme.example/og.png', logo: null, video: null, fetchedAt: '' } }));
    expect(r.image).toBe('https://acme.example/og.png');
  });

  // Issues written before the media stage have no `media`, and still get a
  // screenshot and a favicon from the homepage.
  it('falls back to the researched homepage when media was never looked for', () => {
    expect(toRow(company()).homepage).toBe('https://acme.example/');
    expect(toRow(company({ media: null })).homepage).toBeNull();
  });
});

describe('safeUrl', () => {
  it('passes http(s) and nothing else', () => {
    expect(safeUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<b>')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });
});

describe('pickHomepage', () => {
  it('takes the link labelled as the homepage', () => {
    expect(pickHomepage(assessment())).toBe('https://acme.example/');
    expect(pickHomepage(assessment({ links: [{ label: 'Company site', url: 'https://b.example/' }] }))).toBe('https://b.example/');
  });

  // A picture from the wrong company's site is worse than none.
  it('refuses when research was unsure who the company is', () => {
    expect(pickHomepage(assessment({ confidence: 'low' }))).toBeNull();
    expect(pickHomepage(assessment({ isOperatingCompany: false }))).toBeNull();
    expect(pickHomepage(null)).toBeNull();
  });

  it('never takes a registry, press or social site, whatever the label says', () => {
    expect(pickHomepage(assessment({ links: [{ label: 'Website (LinkedIn)', url: 'https://www.linkedin.com/company/acme' }] }))).toBeNull();
    expect(pickHomepage(assessment({ links: [{ label: 'SEC Form D filing', url: 'https://www.sec.gov/x' }] }))).toBeNull();
  });

  it('falls back to the domain of a careers or docs page on the company site', () => {
    expect(pickHomepage(assessment({ links: [{ label: 'Careers', url: 'https://acme.example/careers' }] }))).toBe('https://acme.example/');
    // A job board is not the company's domain.
    expect(pickHomepage(assessment({ links: [{ label: 'Careers', url: 'https://jobs.ashbyhq.com/acme' }] }))).toBeNull();
  });
});

describe('grades', () => {
  it('0 = not interested, 1 = opened, 2 = saved', () => {
    expect(gradeOf({ saved: true })).toBe(2);
    expect(gradeOf({ opened: true })).toBe(1);
    expect(gradeOf({ passed: true })).toBe(0);
  });

  // Opening the details implies a 1, which overstates a read that ended in a no.
  it('lets "not interested" take an opened company back down to 0', () => {
    expect(gradeOf({ opened: true, passed: true })).toBe(0);
  });

  // A company nobody judged is absent, never a 0.
  it('exports only companies that were actually judged', () => {
    expect(isLabelled({})).toBe(false);
    expect(toLabelLine({ companyId: 'a', runId: 'r', rank: 1, at: 't' })).toBeNull();
    expect(toLabelLine({ companyId: 'a', runId: 'r', rank: 1, at: 't', passed: true })).toEqual(
      { companyId: 'a', grade: 0, rank: 1, at: 't', runId: 'r' });
  });

  it('round-trips a grade through the file', () => {
    for (const g of [0, 1, 2]) expect(gradeOf(stateFromGrade(g))).toBe(g);
  });
});

describe('mergeLabelFile', () => {
  const line = (companyId: string, grade: number, runId = '2026-09-25') =>
    ({ companyId, grade, rank: 1, at: '2026-09-26T00:00:00.000Z', runId });
  const existing =
    '{"companyId":"daytona-platforms","grade":1,"rank":1,"at":"2026-08-22T19:23:17.581Z","runId":"2026-08-17"}\n' +
    '{"companyId":"windborne-systems","grade":2,"rank":2,"at":"2026-08-20T06:14:22.435Z","runId":"2026-08-17"}\n';

  it('appends new grades and leaves every other line byte-identical', () => {
    const out = mergeLabelFile(existing, [[labelKey('2026-09-25', 'acme'), line('acme', 2)]]);
    expect(out.startsWith(existing)).toBe(true);
    expect(parseLabels(out)).toHaveLength(3);
    expect(out.endsWith('\n')).toBe(true);
  });

  // Taste is allowed to change: a later grade replaces the earlier one, in place.
  it('replaces a regraded company where it stands', () => {
    const out = mergeLabelFile(existing, [[labelKey('2026-08-17', 'daytona-platforms'), line('daytona-platforms', 0, '2026-08-17')]]);
    const rows = parseLabels(out);
    expect(rows.map((r) => r.companyId)).toEqual(['daytona-platforms', 'windborne-systems']);
    expect(rows[0].grade).toBe(0);
  });

  // A company graded in two issues is signal about drift, not a duplicate.
  it('keeps one row per company per issue', () => {
    const out = mergeLabelFile(existing, [[labelKey('2026-09-25', 'windborne-systems'), line('windborne-systems', 0)]]);
    expect(parseLabels(out).filter((r) => r.companyId === 'windborne-systems')).toHaveLength(2);
  });

  it('removes a grade that was toggled back off', () => {
    const out = mergeLabelFile(existing, [[labelKey('2026-08-17', 'windborne-systems'), null]]);
    expect(parseLabels(out).map((r) => r.companyId)).toEqual(['daytona-platforms']);
  });

  it('starts a file from nothing, and keeps a line it cannot parse', () => {
    expect(mergeLabelFile('', [[labelKey('r', 'a'), line('a', 2, 'r')]])).toBe(JSON.stringify(line('a', 2, 'r')) + '\n');
    expect(mergeLabelFile('not json\n', [])).toBe('not json\n');
  });

  it('writes the same field order as every existing line', () => {
    const out = mergeLabelFile('', [[labelKey('r', 'a'), toLabelLine({ companyId: 'a', runId: 'r', rank: 3, at: 't', saved: true })]]);
    expect(out).toBe('{"companyId":"a","grade":2,"rank":3,"at":"t","runId":"r"}\n');
  });
});

describe('describeChanges', () => {
  it('reads as a commit title', () => {
    expect(describeChanges([
      { companyId: 'a', grade: 2, rank: 1, at: '', runId: '2026-09-25' },
      { companyId: 'b', grade: 0, rank: 2, at: '', runId: '2026-09-25' },
      null,
    ])).toBe('Grades: 1 saved, 1 not interested, 1 cleared (2026-09-25)');
  });
});

describe('repoFromLocation', () => {
  it('reads the repo off a GitHub Pages address', () => {
    expect(repoFromLocation({ hostname: 'zerolocker.github.io', pathname: '/startup-finder/' })).toBe('zerolocker/startup-finder');
    expect(repoFromLocation({ hostname: 'zerolocker.github.io', pathname: '/startup-finder/index.html' })).toBe('zerolocker/startup-finder');
    expect(repoFromLocation({ hostname: 'zerolocker.github.io', pathname: '/' })).toBe('zerolocker/zerolocker.github.io');
    expect(repoFromLocation({ hostname: 'localhost', pathname: '/' })).toBeNull();
  });

  it('asks GitHub for a token that can write contents and pull requests, nothing more', () => {
    const url = new URL(tokenSetupUrl('zerolocker/startup-finder'));
    expect(url.searchParams.get('contents')).toBe('write');
    expect(url.searchParams.get('pull_requests')).toBe('write');
    expect(url.searchParams.get('target_name')).toBe('zerolocker');
    expect([...url.searchParams.keys()].sort()).toEqual(
      ['contents', 'description', 'expires_in', 'name', 'pull_requests', 'target_name']);
  });
});

describe('pictures', () => {
  it('orders the company’s own image, then its video, then a screenshot', () => {
    const r = toRow(company({ media: {
      homepage: 'https://acme.example/', image: 'https://acme.example/og.png', logo: null,
      video: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', fetchedAt: '',
    } }));
    const c = heroCandidates(r);
    expect(c[0]).toBe('https://acme.example/og.png');
    expect(c[1]).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(c[2]).toContain('/mshots/v1/https%3A%2F%2Facme.example%2F');
  });

  it('has nothing to show without a homepage', () => {
    expect(heroCandidates(toRow(company({ media: null })))).toEqual([]);
  });

  it('reads YouTube ids from every URL shape', () => {
    for (const u of ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1']) {
      expect(youtubeId(u)).toBe('dQw4w9WgXcQ');
    }
    expect(youtubeId('https://vimeo.com/1')).toBeNull();
  });

  it('makes a monogram from the name, not the legal suffix', () => {
    expect(initials('Acme, Inc.')).toBe('A');
    expect(initials('Teyon AI Inc.')).toBe('TA');
  });
});

describe('issueStats', () => {
  const rows = [
    toRow(company({ id: 'a', assessment: assessment({ fit: 91, openRoles: ['SWE'] }) })),
    toRow(company({ id: 'b', assessment: assessment({ fit: 70 }) })),
    toRow(company({ id: 'c', assessment: assessment({ fit: 12 }), latestFunding: { date: '', amountUsd: 1, round: null, investors: [], source: 'edgar', sourceUrl: '' } })),
    toRow(company({ id: 'd', assessment: assessment({ fit: 99, isOperatingCompany: false }) })),
    toRow(company({ id: 'e', assessment: null })),
  ];
  const s = issueStats(rows);

  // Found is everything; scored is only what research judged a real company.
  it('counts what was found apart from what was scored', () => {
    expect(s.companies).toBe(5);
    expect(s.scored).toBe(3);
    expect(s.strong).toBe(2);
    expect(s.hiring).toBe(1);
  });

  it('bins fit in tens, with 100 in the top bin', () => {
    expect(s.bins.map((b) => b.count)).toEqual([0, 1, 0, 0, 0, 0, 0, 1, 0, 1]);
  });

  // Form D's $1 is a placeholder, not a round.
  it('leaves placeholder amounts out of the median raise', () => {
    expect(s.medianRaise).toBe(5e6);
    expect(s.raiseCount).toBe(2);
  });

  it('picks the best three real companies', () => {
    expect(s.best.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});
