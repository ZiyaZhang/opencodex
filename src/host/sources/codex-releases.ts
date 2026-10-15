/** Source 1: the New Features bullets of the stable openai/codex release notes, one candidate per bullet.
 * Bug Fixes, Chores and the Changelog list are not read. CLI features come from this source; the RSS source filters them out.
 */
import { join } from 'node:path';
import type { Evidence } from '../../core/candidate.js';
import { writeJsonAtomic, type CandidateStore } from '../../core/store.js';
import { GitHubError, type GitHubClient, type PullRequest } from '../github.js';

export interface ReleaseFeature { text: string; prs: number[] }

/** One check looks at this many of the newest stable tags; release bodies are fetched only for the tags inside the window. */
const RECENT_STABLE_TAGS = 12;
const TITLE_LIMIT = 160;
/** Paths kept in a pull request's evidence excerpt; the tail of a large pull request adds only noise. */
const EXCERPT_FILES = 20;

/** A pull request reference as the notes write it: `#50148`, or `[#50148](https://github.com/openai/codex/pull/50148)` (0.153.0). */
const PR_REF = String.raw`(?:#\d+|\[#\d+\]\([^)\s]*\))`;
/** The PR list that closes a bullet, `(#1, #2)`. Some older notes follow it with a period (0.123.0, 0.137.0). Whitespace is collapsed before this runs. */
const PR_LIST = new RegExp(String.raw`\s*\(${PR_REF}(?:,?\s*${PR_REF})*\)\s*\.?\s*$`);

/**
 * The bullets of the `## New Features` section as one line each. An indented line directly under a bullet continues it, as wrapped
 * text does. A blank line, a heading, or an un-indented line such as `**Full Changelog**: …` ends the bullet, and that line is not read.
 * A heading of level 1 or 2 ends the section, a deeper one does not.
 * Line endings are normalised first: the 0.158.0 notes ship with CRLF, and `.` in a pattern does not match `\r`.
 */
function newFeatureBullets(body: string): string[] {
  const bullets: string[] = [];
  let inSection = false, open = false;
  for (const line of body.split(/\r\n|\r|\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (level <= 2) inSection = level === 2 && /^New Features\b/i.test(heading[2]!.trim());
      open = false;
      continue;
    }
    if (!inSection) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { bullets.push(bullet[1]!); open = true; }
    else if (open && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ` ${line}`;
    else open = false;
  }
  return bullets;
}

/**
 * One feature per bullet of the New Features section, in the order of the notes. `prs` holds every PR number in the bullet,
 * each once, the first one first; `text` is the bullet without its closing PR list. A nested sub-bullet is a feature of its own
 * when it carries its own PR number, and a bullet without any PR number is dropped (it has no evidence to look at).
 */
export function parseReleaseBody(body: string): ReleaseFeature[] {
  return newFeatureBullets(body).flatMap(raw => {
    const line = raw.replace(/\s+/g, ' ').trim();
    const prs = [...new Set([...line.matchAll(/#(\d{3,7})(?!\d)/g)].map(m => Number(m[1])))];
    const text = line.replace(PR_LIST, '').trim();
    return text && prs.length ? [{ text, prs }] : [];
  });
}

export const minor = (tag: string): string => tag.replace(/^rust-v/, '').split('.').slice(0, 2).join('.');
export interface StableWindow { from: string; to: string; releases: string[] }
/**
 * Tags come newest first. With a checkpoint present in the list, the window runs from it to the newest tag and
 * covers every stable release in between. Without one, it starts at the newest tag whose minor differs from the latest.
 */
export function stableWindow(tags: string[], lastSeen?: string): StableWindow | undefined {
  const to = tags[0];
  if (!to || to === lastSeen) return undefined;
  const fromIndex = lastSeen && tags.includes(lastSeen) ? tags.indexOf(lastSeen) : tags.findIndex(tag => minor(tag) !== minor(to));
  if (fromIndex <= 0) return undefined;
  return { from: tags[fromIndex]!, to, releases: tags.slice(0, fromIndex) };
}

export interface ReleaseCollection {
  window?: StableWindow; added: number;
  /** The checkpoint is older than the fetched tags; intermediate releases were not collected. */
  gap: boolean;
  /** Pull request lookups of this run that failed, or were not made because GitHub had answered 403 or 429. Each left only a bare `#N` reference as evidence, and nothing retries them. */
  prLookupFailures: number;
  /** Tags of the window that have no release yet (a stable tag can exist before its release is published), newest first. They are not collected, and a newest tag among them is looked at again by the next run. */
  unreleased: string[];
}

/** At most `limit` code points, so an emoji is never cut in half. A longer text is cut to `limit - 1` code points and ends in `…`, the way the desktop source clips its messages. */
function clip(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text;
}

/** GitHub answers 403 or 429 when the rate limit is used up. */
const isRateLimit = (error: unknown): boolean => error instanceof GitHubError && (error.status === 403 || error.status === 429);

/**
 * Looks pull requests up for the bullets of one run. They are asked one at a time, because a rate limit answers the first request that
 * hits it and the ones already in flight would only add to it. After a 403 or 429 it asks no more for the rest of the run: every later
 * pull request gets its bare reference. Any other failure costs only its own pull request. `failures` counts both.
 */
function pullRequestLookup(github: Pick<GitHubClient, 'pullRequest'>, signal?: AbortSignal) {
  let rateLimited = false;
  return async (numbers: number[]): Promise<{ evidence: Evidence[]; failures: number }> => {
    const evidence: Evidence[] = [];
    let failures = 0;
    for (const n of numbers) {
      let pr: PullRequest | undefined;
      if (!rateLimited) {
        try { pr = await github.pullRequest(n, signal); } catch (error) {
          if (signal?.aborted) throw error; // an abort ends the run; it is not a missing pull request
          if (isRateLimit(error)) rateLimited = true;
        }
      }
      if (pr) evidence.push({ kind: 'pr', ref: `#${pr.number}`, url: pr.url, excerpt: [pr.title, ...pr.files.slice(0, EXCERPT_FILES).map(f => f.path)].join('\n') });
      else { evidence.push({ kind: 'pr', ref: `#${n}` }); failures++; }
    }
    return { evidence, failures };
  };
}

/**
 * Stores the New Features of every stable release in the window as `codex-release` candidates and returns how many were new.
 * The checkpoint moves only after the whole window went through, so a failed run is retried whole (the upserts are idempotent).
 * It moves to the newest tag of the window that has a release, so a newest tag whose release is not published yet is looked at again by the next run.
 */
export async function collectReleases(store: CandidateStore, github: Pick<GitHubClient, 'stableTags' | 'release' | 'pullRequest'>, snapshotDir: string, signal?: AbortSignal): Promise<ReleaseCollection> {
  const tags = await github.stableTags(RECENT_STABLE_TAGS, signal);
  const lastSeen = await store.checkpoint('lastStableTag');
  const gap = lastSeen !== undefined && !tags.includes(lastSeen);
  const window = stableWindow(tags, lastSeen);
  if (!window) return { added: 0, gap, prLookupFailures: 0, unreleased: [] };
  const lookUp = pullRequestLookup(github, signal);
  const unreleased: string[] = [];
  let added = 0, prLookupFailures = 0, newestReleased: string | undefined;
  // Oldest release first, and within a release the last bullet first: the store lists the latest write first, so the newest release
  // ends up on top and the first bullet of the notes leads its release.
  for (const tag of [...window.releases].reverse()) {
    const release = await github.release(tag, signal);
    if (!release) { unreleased.unshift(tag); continue; } // tagged before its release was published: nothing to read yet
    newestReleased = tag; // a tag flagged as prerelease counts as seen too
    if (release.prerelease) continue; // the tags endpoint has no prerelease flag; the release record is authoritative
    await writeJsonAtomic(join(snapshotDir, 'codex-releases', `${tag}.json`), release);
    for (const feature of parseReleaseBody(release.body).reverse()) {
      const { evidence, failures } = await lookUp(feature.prs);
      prLookupFailures += failures;
      const { created } = await store.upsert({
        source: 'codex-release', key: `pr:${feature.prs[0]}`, title: clip(feature.text, TITLE_LIMIT), summary: feature.text,
        evidence, window: { fromTag: window.from, toTag: tag },
      });
      if (created) added++;
    }
  }
  if (newestReleased) await store.setCheckpoint('lastStableTag', newestReleased);
  return { window, added, gap, prLookupFailures, unreleased };
}
