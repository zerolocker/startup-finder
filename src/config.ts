/**
 * Loads and validates config/profile.yaml — the one file that defines what a
 * "good" startup means for this user. Everything else in the pipeline is
 * mechanism; this is policy.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { ProfileSchema, type Profile } from './types.ts';
import { PROFILE_PATH } from './paths.ts';

let cached: Profile | null = null;

/** Read, parse, and validate the profile. Cached for the process lifetime. */
export async function loadProfile(path: string = PROFILE_PATH): Promise<Profile> {
  if (cached && path === PROFILE_PATH) return cached;

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `No profile found at ${path}. Copy config/profile.example.yaml to config/profile.yaml and edit it.`,
      );
    }
    throw err;
  }

  const parsed = ProfileSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`config/profile.yaml is invalid:\n${issues}`);
  }

  if (path === PROFILE_PATH) cached = parsed.data;
  return parsed.data;
}

/**
 * Render the profile as the prompt fragment shown to the LLM.
 *
 * Kept here rather than inline in the prompts so that scoring and research
 * always describe the user identically — divergence between the two would make
 * scores and dossiers disagree for reasons that are invisible in the output.
 */
export function profileToPrompt(profile: Profile): string {
  const lines: string[] = [];
  lines.push(`ABOUT THE PERSON:\n${profile.about.trim()}`);

  const intents = profile.intent
    .map((i) => (i === 'join' ? 'JOINING a startup as an employee' : 'INVESTING as an angel'))
    .join(' and ');
  lines.push(`\nWHAT THEY WANT: They are evaluating startups for the purpose of ${intents}.`);

  const themes = profile.interests.themes
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((t) => `  - ${t.name} (importance ${t.weight.toFixed(2)})`)
    .join('\n');
  lines.push(`\nINTERESTS (higher weight = cares more):\n${themes}`);

  if (profile.interests.antiThemes.length > 0) {
    lines.push(`\nACTIVELY NOT INTERESTED IN:\n${profile.interests.antiThemes.map((t) => `  - ${t}`).join('\n')}`);
  }

  const { minRaiseUsd, maxRaiseUsd } = profile.stage;
  if (minRaiseUsd != null || maxRaiseUsd != null) {
    const lo = minRaiseUsd != null ? `$${(minRaiseUsd / 1e6).toFixed(1)}M` : 'any';
    const hi = maxRaiseUsd != null ? `$${(maxRaiseUsd / 1e6).toFixed(1)}M` : 'any';
    lines.push(`\nPREFERRED ROUND SIZE: between ${lo} and ${hi}.`);
  }

  const geo = profile.geography.preferred.length
    ? profile.geography.preferred.join(', ')
    : 'no strong preference';
  lines.push(
    `\nGEOGRAPHY: They live in ${profile.geography.basedIn}, and prefer ${geo}.` +
      `${profile.geography.remoteOk ? ' Remote-friendly companies are also fine.' : ' Remote is not a substitute for location.'}` +
      `\n  A company headquartered outside ${profile.geography.basedIn} is materially harder to join — ` +
      `visa, relocation, or a permanent time-zone gap — so score it lower than an otherwise ` +
      `identical domestic company, and say so in "concerns". Do not zero it out: a remote-friendly ` +
      `company that hires in ${profile.geography.basedIn} is only mildly penalised.`,
  );

  if (profile.notes.length > 0) {
    lines.push(`\nADDITIONAL NOTES:\n${profile.notes.map((n) => `  - ${n}`).join('\n')}`);
  }

  return lines.join('\n');
}
