---
description: generate a commit message based on the current git diff
---

1. Run `git add -A; git diff --cached > "$TEMP/change.diff"; git status --short` in one shell call
2. Read `$TEMP/change.diff`, identify the primary change type (`feat`, `fix`, `refactor`, etc.), and apply rules from `.agents/rules/conventional-commits-agent-rule.md` — all in a single analysis step
3. Generate and propose a commit message in the format: `<type>[!scope]: <imperative summary>` with an optional body and `BREAKING CHANGE:` footer if applicable
4. Delete `$TEMP/change.diff`
