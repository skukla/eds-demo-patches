# Releasing

**A push to `main` reaches nobody.** A published release is what storefronts read. This repository does
not use Demo Builder's release step: `lkg-gate.yml` verifies each new boilerplate against the patches every day,
and publishes the release itself when every patch holds and something a storefront reads has changed. A commit
that only touches docs, CI, these scripts or their tests publishes nothing (`scripts/release-needed.sh`).

It stays on normal versions, the one exception to the beta track the other components follow until Demo Builder
reaches 1.x, because every shipped build reads only this repository's normal releases.
