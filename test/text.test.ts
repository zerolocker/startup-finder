import { describe, expect, it } from 'vitest';
import { formatUsd, normalizeName, slugify, stripHtml, truncate } from '../src/util/text.ts';

describe('normalizeName', () => {
  it('strips legal suffixes and punctuation', () => {
    expect(normalizeName('Flo Artificial Intelligence, Inc.')).toBe('flo artificial intelligence');
    expect(normalizeName('Acme Corp.')).toBe('acme');
    expect(normalizeName('Foo Technologies, LLC')).toBe('foo');
  });

  it('strips stacked suffixes', () => {
    expect(normalizeName('Bar Labs Holdings Inc')).toBe('bar');
  });

  it('drops parenthesized asides', () => {
    expect(normalizeName('Widget Co (formerly Gadget)')).toBe('widget');
  });

  it('keeps alphanumeric identity intact', () => {
    expect(normalizeName('X1 Systems')).toBe('x1 systems');
  });

  it('is stable under case and spacing noise', () => {
    expect(normalizeName('  ACME   ROBOTICS  ')).toBe(normalizeName('Acme Robotics'));
  });

  it('does not collapse genuinely different names', () => {
    expect(normalizeName('Ramp Inc')).not.toBe(normalizeName('Rampt Inc'));
  });
});

describe('slugify', () => {
  it('produces a url-safe id', () => {
    expect(slugify('Flo Artificial Intelligence, Inc.')).toBe('flo-artificial-intelligence');
  });

  it('keeps a bare suffix rather than reducing a name to nothing', () => {
    // Suffixes are only stripped when something precedes them, so a company
    // literally named "Inc." keeps an id instead of collapsing.
    expect(slugify('Inc.')).toBe('inc');
  });

  it('falls back to a hash when nothing survives normalization', () => {
    const slug = slugify('!!! ???');
    expect(slug).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    expect(stripHtml('<p>Raised &amp; closed</p>')).toBe('Raised & closed');
  });

  it('drops script and style bodies entirely', () => {
    expect(stripHtml('<script>evil()</script>Hello')).toBe('Hello');
  });

  it('decodes numeric entities', () => {
    expect(stripHtml('It&#8217;s here')).toBe('It’s here');
  });
});

describe('formatUsd', () => {
  it('scales to K/M/B', () => {
    expect(formatUsd(1_500_000)).toBe('$1.5M');
    expect(formatUsd(2_000_000_000)).toBe('$2.0B');
    expect(formatUsd(50_000)).toBe('$50K');
    expect(formatUsd(999)).toBe('$999');
  });

  it('renders unknown amounts explicitly rather than as zero', () => {
    expect(formatUsd(null)).toBe('undisclosed');
    expect(formatUsd(undefined)).toBe('undisclosed');
  });
});

describe('truncate', () => {
  it('cuts on a word boundary', () => {
    expect(truncate('the quick brown fox', 10)).toBe('the quick…');
  });

  it('leaves short strings alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });
});
