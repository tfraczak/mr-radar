#!/usr/bin/env bash
# Capture raw API fixtures for the test suite, into tests/fixtures/raw/
# (gitignored — raw responses contain real org data and MUST NOT be committed).
# Run scripts/sanitize-fixtures.mjs afterwards to produce the committable,
# anonymized derivatives under tests/fixtures/.
#
# Everything org-specific comes from the environment:
#   MR_RADAR_GITLAB_USER_ID   your numeric GitLab id   (glab api user --jq .id)
#   MR_RADAR_RWX_PROJECT      URL-encoded path of a repo whose specs run on RWX
#   MR_RADAR_RWX_MR_IID       an MR iid in that repo with a rich discussion
#   MR_RADAR_CI_PROJECT       URL-encoded path of a repo whose specs run in GitLab CI
#   MR_RADAR_CI_MR_IID        an MR iid in that repo with approvals + resolved threads
#   MR_RADAR_RWX_BRANCH       a branch with RWX runs (ideally all waiting)
set -euo pipefail

: "${MR_RADAR_GITLAB_USER_ID:?set to your numeric GitLab user id}"
: "${MR_RADAR_RWX_PROJECT:?set to the URL-encoded RWX-gated project path}"
: "${MR_RADAR_RWX_MR_IID:?set to an MR iid in the RWX project}"
: "${MR_RADAR_CI_PROJECT:?set to the URL-encoded GitLab-CI project path}"
: "${MR_RADAR_CI_MR_IID:?set to an MR iid in the CI project}"
: "${MR_RADAR_RWX_BRANCH:?set to a branch that has RWX runs}"

OUT="$(dirname "$0")/../tests/fixtures/raw"
mkdir -p "$OUT"

grab() {
  local name="$1" path="$2"
  echo "  $name"
  glab api "$path" > "$OUT/$name.json"
}

grab mrs-authored          "merge_requests?scope=all&author_id=$MR_RADAR_GITLAB_USER_ID&state=opened&per_page=100"
grab todos                 "todos?per_page=100"

# The RWX-gated repo: an MR whose branch has only waiting runs is the key case.
grab mr-rwx                "projects/$MR_RADAR_RWX_PROJECT/merge_requests/$MR_RADAR_RWX_MR_IID"
grab mr-rwx-commits        "projects/$MR_RADAR_RWX_PROJECT/merge_requests/$MR_RADAR_RWX_MR_IID/commits?per_page=100"
grab mr-rwx-discussions    "projects/$MR_RADAR_RWX_PROJECT/merge_requests/$MR_RADAR_RWX_MR_IID/discussions?per_page=100"
grab mr-rwx-approvals      "projects/$MR_RADAR_RWX_PROJECT/merge_requests/$MR_RADAR_RWX_MR_IID/approvals"
grab pipelines-rwx-repo    "projects/$MR_RADAR_RWX_PROJECT/pipelines?per_page=100"

# The GitLab-CI repo: approvals and resolved threads.
grab mr-ci                 "projects/$MR_RADAR_CI_PROJECT/merge_requests/$MR_RADAR_CI_MR_IID"
grab mr-ci-discussions     "projects/$MR_RADAR_CI_PROJECT/merge_requests/$MR_RADAR_CI_MR_IID/discussions?per_page=100"
grab mr-ci-approvals       "projects/$MR_RADAR_CI_PROJECT/merge_requests/$MR_RADAR_CI_MR_IID/approvals"
grab pipelines-ci-repo     "projects/$MR_RADAR_CI_PROJECT/pipelines?per_page=100"

if command -v rwx >/dev/null 2>&1; then
  echo "  rwx runs"
  rwx runs list --branch "$MR_RADAR_RWX_BRANCH" --limit 100 --json > "$OUT/rwx-runs-branch.json" || true
  rwx runs list --limit 100 --json > "$OUT/rwx-runs.json" || true
fi

echo "raw captures in $OUT — now run: yarn sanitize:fixtures"
