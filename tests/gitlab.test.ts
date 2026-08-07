import { describe, expect, it } from 'vitest';
import { mrKey, reviewerIdsAfterAdding, updateReviewersArgs } from '../src/core/sources/gitlab';
import type { ForgeMr } from '../src/core/types';

const mr = (reviewers?: { id: number; username: string; name: string }[]): ForgeMr =>
  ({ ...(reviewers ? { reviewers } : {}) }) as ForgeMr;

describe('reviewerIdsAfterAdding', () => {
  it('adds me while keeping existing reviewers, without duplicating', () => {
    expect(reviewerIdsAfterAdding(mr(), 7)).toEqual([7]);
    expect(
      reviewerIdsAfterAdding(mr([{ id: 3, username: 'sam.rios', name: 'Sam' }]), 7),
    ).toEqual([3, 7]);
    expect(reviewerIdsAfterAdding(mr([{ id: 7, username: 'me', name: 'Me' }]), 7)).toEqual([7]);
  });
});

describe('updateReviewersArgs', () => {
  // Regression: `-f reviewer_ids[]=N` sent a JSON body with a literal
  // 'reviewer_ids[]' key (glab does not build arrays from bracketed fields),
  // so GitLab saw no parameters and answered HTTP 400.
  it('puts the ids in the query string, never in -f fields', () => {
    const args = updateReviewersArgs(555, 42, [3, 7]);
    expect(args).toEqual([
      'api',
      '-X',
      'PUT',
      'projects/555/merge_requests/42?reviewer_ids[]=3&reviewer_ids[]=7',
    ]);
    expect(args).not.toContain('-f');
  });

  it('a single reviewer still uses the array form the API expects', () => {
    expect(updateReviewersArgs(1, 2, [9]).at(-1)).toBe('projects/1/merge_requests/2?reviewer_ids[]=9');
  });
});

describe('mrKey', () => {
  it('is the reference GitLab itself prints', () => {
    expect(mrKey('acme/rocket', 7576)).toBe('acme/rocket!7576');
  });
});
