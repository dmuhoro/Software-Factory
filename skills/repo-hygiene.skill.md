---
name: repo-hygiene
description: Before claiming a unit done, confirm the working tree contains only the files the unit claimed.
version: 1.0.0
tools: read, write
enabled: true
---

# Repo hygiene

A unit's commit stages the whole working tree. If a formatter, a codegen step, or a tool the unit
ran left a file behind, that file is committed under a message that describes only the claimed work.

- Compare the files the unit claims to change against the files that actually changed.
- A file that changed and was not claimed is a finding, not a footnote.
- Do not delete or revert a finding to make the check pass; report it.
