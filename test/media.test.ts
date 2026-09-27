import { describe, expect, it } from 'vitest';
import { enrichMedia, extractMedia } from '../src/pipeline/media.ts';
import type { RunCompany } from '../src/types.ts';

const PAGE = 'https://acme.example/';

describe('extractMedia', () => {
  it('reads the shared image, resolving a relative path against the page', () => {
    const html = '<html><head><meta property="og:image" content="/social/card.png"></head><body></body></html>';
    expect(extractMedia(html, PAGE).image).toBe('https://acme.example/social/card.png');
  });

  // Attribute order is free, and plenty of sites put content first.
  it('does not care which attribute comes first', () => {
    const html = '<head><meta content="https://cdn.example/og.jpg" property="og:image" /></head>';
    expect(extractMedia(html, PAGE).image).toBe('https://cdn.example/og.jpg');
  });

  it('falls back to the Twitter card image', () => {
    const html = '<head><meta name="twitter:image" content="https://cdn.example/tw.jpg"></head>';
    expect(extractMedia(html, PAGE).image).toBe('https://cdn.example/tw.jpg');
  });

  it('decodes entities in the URL', () => {
    const html = '<head><meta property="og:image" content="https://cdn.example/i.png?w=1200&amp;h=630"></head>';
    expect(extractMedia(html, PAGE).image).toBe('https://cdn.example/i.png?w=1200&h=630');
  });

  // The dashboard is served over https, where an http image is blocked.
  it('upgrades http and refuses data: URIs', () => {
    expect(extractMedia('<head><meta property="og:image" content="http://cdn.example/a.png"></head>', PAGE).image)
      .toBe('https://cdn.example/a.png');
    expect(extractMedia('<head><meta property="og:image" content="data:image/png;base64,AAAA"></head>', PAGE).image)
      .toBeNull();
  });

  it('prefers the home-screen icon, and ignores a favicon too small to draw', () => {
    const html = `<head>
      <link rel="icon" href="/favicon.ico">
      <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    </head>`;
    expect(extractMedia(html, PAGE).logo).toBe('https://acme.example/apple-touch-icon.png');
    expect(extractMedia('<head><link rel="icon" href="/favicon.ico"></head>', PAGE).logo).toBeNull();
  });

  it('takes the largest declared icon, and an SVG scales to any size', () => {
    expect(extractMedia('<head><link rel="icon" sizes="192x192" href="/192.png"><link rel="icon" sizes="96x96" href="/96.png"></head>', PAGE).logo)
      .toBe('https://acme.example/192.png');
    expect(extractMedia('<head><link rel="icon" type="image/svg+xml" href="/logo.svg"></head>', PAGE).logo)
      .toBe('https://acme.example/logo.svg');
  });

  it('finds an embedded product video as a watch URL', () => {
    const yt = '<head></head><body><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0"></iframe></body>';
    expect(extractMedia(yt, PAGE).video).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const vimeo = '<body><iframe src="https://player.vimeo.com/video/123456789?h=abc"></iframe></body>';
    expect(extractMedia(vimeo, PAGE).video).toBe('https://vimeo.com/123456789');
    const loom = '<body><a href="https://www.loom.com/share/0123456789abcdef0123456789abcdef">Watch</a></body>';
    expect(extractMedia(loom, PAGE).video).toBe('https://www.loom.com/share/0123456789abcdef0123456789abcdef');
  });

  it('prefers a declared og:video over whatever the body links', () => {
    const html = '<head><meta property="og:video" content="https://www.youtube.com/embed/AAAAAAAAAAA"></head>' +
      '<body><a href="https://youtu.be/BBBBBBBBBBB">talk</a></body>';
    expect(extractMedia(html, PAGE).video).toBe('https://www.youtube.com/watch?v=AAAAAAAAAAA');
  });

  it('returns nulls for a page with none of it', () => {
    expect(extractMedia('<html><body>Hello</body></html>', PAGE)).toEqual({ image: null, logo: null, video: null });
  });
});

describe('enrichMedia', () => {
  const base = {
    normalizedName: '', sources: [], latestFunding: null, fundingEvents: [], location: null, people: [],
    evidence: [], firstSeenAt: '', lastUpdatedAt: '', researchedAt: null,
  };
  const assessment = {
    fit: 50, whatTheyDo: '', headquarters: '', isOperatingCompany: true, matchedInterests: [], concerns: [],
    rationale: '', confidence: 'low' as const, summary: '', product: '', team: '', funding: '', openRoles: [],
    techStack: [], competitors: [], redFlags: [], greenFlags: [], links: [{ label: 'Homepage', url: PAGE }],
  };

  // No network in tests: these are the paths that never fetch.
  it('records "no trustworthy homepage" as null, and leaves unresearched and visited companies alone', async () => {
    const companies: RunCompany[] = [
      { ...base, id: 'unsure', name: 'Unsure', assessment },
      { ...base, id: 'unresearched', name: 'Unresearched', assessment: null },
      { ...base, id: 'done', name: 'Done', assessment, media: { homepage: PAGE, image: null, logo: null, video: null, fetchedAt: '' } },
    ];
    const { companies: out, visited } = await enrichMedia(companies);
    expect(visited).toBe(1);
    expect(out.find((c) => c.id === 'unsure')?.media).toBeNull();
    expect(out.find((c) => c.id === 'unresearched')?.media).toBeUndefined();
    expect(out.find((c) => c.id === 'done')?.media?.homepage).toBe(PAGE);
  });
});
