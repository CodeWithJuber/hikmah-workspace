#!/usr/bin/env bash
# Store the immutable image pair on the shared compute runner. Deploy verifies the
# file list against a digest from GitHub's record of the originating build.
set -euo pipefail
umask 077
cd "${GITHUB_WORKSPACE:?}"
root="${XDG_DATA_HOME:-$HOME/.local/share}/hikmah-ci/images"
case "${1:-}" in
  save)
    [[ $GITHUB_RUN_ID =~ ^[0-9]+$ && $GITHUB_RUN_ATTEMPT =~ ^[0-9]+$ ]]
    mkdir -p -- "$root"
    stage=$(mktemp -d "$root/.incoming.XXXXXXXX")
    trap 'rm -rf -- "$stage"' EXIT
    mv -- artifact/{image.tar.gz,workbench.tar.gz,provenance.json} "$stage/"
    (cd "$stage" && sha256sum image.tar.gz workbench.tar.gz provenance.json > image.sha256)
    digest=$(sha256sum "$stage/image.sha256" | cut -d ' ' -f 1)
    target="$root/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
    mv -T -- "$stage" "$target"
    printf 'manifest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
    find "$root" -regextype posix-extended -mindepth 1 -maxdepth 1 -type d \
      -regex '.*/[0-9]+-[0-9]+' -mmin +10080 -exec rm -rf -- {} +
    ;;
  restore)
    [[ $BUILD_RUN =~ ^[0-9]+$ && $BUILD_ATTEMPT =~ ^[0-9]+$ ]]
    source_dir="$root/$BUILD_RUN-$BUILD_ATTEMPT"
    mkdir -m 700 -- artifact
    for file in image.tar.gz workbench.tar.gz provenance.json image.sha256; do
      [[ -f $source_dir/$file && ! -L $source_dir/$file ]]
      cp -P -- "$source_dir/$file" "artifact/$file"
      [[ -f artifact/$file && ! -L artifact/$file ]]
    done
    digest=$(sha256sum artifact/image.sha256 | cut -d ' ' -f 1)
    curl --fail --silent --show-error \
      --header "Authorization: Bearer $GITHUB_TOKEN" \
      "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/runs/$BUILD_RUN/attempts/$BUILD_ATTEMPT/jobs?per_page=100" |
      python3 -c 'import json, sys
jobs = json.load(sys.stdin)["jobs"]
expected = "Verified image manifest " + sys.argv[1]
if sum(j["name"] == expected and j["conclusion"] == "success" for j in jobs) != 1:
    sys.exit("The build did not record this image manifest for the triggering attempt.")' "$digest"
    (cd artifact && sha256sum --check --strict image.sha256)
    ;;
  *) exit 2 ;;
esac
