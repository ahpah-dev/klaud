---
name: code-review
description: Review a change for defects before it is committed or merged - find the diff, read the touched files in full, and report only real problems with a file, a line and a reason. Use when the user asks for a review, a second pair of eyes, or whether a change is safe.
when_to_use: review this change, review my diff, check this before I commit, is this safe to merge, code review, find bugs in the diff
---

A review is a search for what breaks, not a summary of what changed. The change's own description is the least reliable evidence you have; the code is the evidence.

## Find the change

`run_command` with git, read-only:

- Uncommitted work: `git status --short`, then `git diff` (add `--staged` for already staged work).
- A branch: `git diff main...HEAD` (or wherever the branch diverged).
- A single commit: `git show <sha>`.

If the directory is not a git repository or the change was described in prose only, ask which files to review - do not review the whole tree as if that were the change.

## Read the files, not only the diff

A diff hides the function around the hunk, the caller, and the variable that was already broken. Open every touched file with `read_file` around each hunk (use `offset`/`limit`) before judging. A line that looks wrong in a diff is often right three lines later.

Also look for the code the diff does not show: `search_text` for the changed function or symbol, to see whether a renamed, re-typed or removed thing still has callers.

## What reviewers actually miss

Go through the changed code with this list. Only report a category when the change has that problem - checking is not finding.

- Error paths: what happens when the read, write, fetch or parse fails? Is the error swallowed, retried forever, or reported as success?
- Boundaries: off-by-one in a loop, a slice, an index; empty input; exactly one element; the last item; a zero or negative count.
- Missing await: an async call without `await` (or a returned promise nobody waits on) continues before the work finishes and loses its errors.
- Leaks: a handle, session, timer, subscription, listener or temp file opened on the new path but not closed on every exit, including the throw.
- Silent catch: `catch {}` or an empty `catch (err) {}` that hides a real failure, or a fallback that lets the caller believe it worked.
- Untrusted input: a path built from user data (escapes the root), a string interpolated into a shell command, SQL, HTML or a log, a value trusted straight after parsing.
- N+1 work: a file read, a stat, or a network call inside a loop that one call could batch.

## Report

- One finding per line: `path:line` - what is wrong, why it matters, and the smallest fix. A finding without a line number is a guess.
- Order by severity: crashes and data loss first, then wrong results, then robustness.
- When the change is fine, say so plainly and name what you checked. "No defects found: the error path at `src/x.js:42` closes the handle, the loop bound at `src/x.js:58` is correct for an empty list" is a real review result, not a failure to find something.
- Style, naming, formatting and structure preferences are **not** bugs. Do not report them as findings, and do not pad a short list with them. If the user asked about style separately, answer that separately.
- Say when you could not check something (generated code, a missing dependency, no tests to run) instead of implying the whole change was covered.
