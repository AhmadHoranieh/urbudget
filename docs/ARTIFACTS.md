# Local evidence and disposable artifacts

`reports/` is local, ignored evidence. It can contain account screenshots, private responses and
signing records; do not add the whole folder to Git. Checked-in documentation records the result
and the evidence location. Release keys stay in their existing protected storage outside source.

Keep:

- Final test/build logs, regression failures and their passing retests, performance measurements,
  lint/XML reports, screenshots demonstrating a result, and scripts needed to reproduce it.
- Signed published installers, updater signatures and hashes, upload-key certificate records,
  and signed Play bundles. Mark superseded bundles as evidence, not submission candidates.
- Account verification and deployment evidence, with its original access restrictions.
- Marketing source media and dated submission records; these are not build caches.

Disposable after checking that no running process uses them:

- Older unsigned/intermediate APKs and AABs once their identity, hashes and verification logs
  are retained and a newer validated build exists.
- Isolated QA WebView profiles, synthetic databases and generated performance input files when
  their generator and final results are retained. Never apply this rule to real budget data.
- Downloaded temporary lint tools and scratch version fixtures.

Before deletion, resolve every path inside the intended workspace, record file names, sizes and
SHA-256 hashes in a local cleanup manifest, and list the evidence kept. Do not recursively clean
worktrees, signing directories, private imports, or application data based on filename patterns.
The October 19 manifests are in `reports/docs-cleanup-20261019/cleanup-manifest.json`
and `cleanup-session-manifest.json` (the latter covers this session's fixture/profile and QA binary).

New capture sessions should use isolated fixture/profile directories and close only the processes
they started. Remove their temporary profiles after retaining screenshot provenance and results.
