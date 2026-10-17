---
name: debug-failing-test
description: Diagnose a failing test or command instead of guessing at a fix - reproduce it, read the failure, cut it down to the smallest failing input, test one hypothesis, then repair and re-run the original command. Use when something that used to pass now fails or a test was reported red.
when_to_use: fix the failing test, why is this test failing, debug this error, the suite is red, reproduce this bug
---

A failing test is a fact. Every step before the fix exists to stop you repairing the wrong thing.

## 1. Reproduce it yourself

Run the exact command that fails, through `run_command`, the way the project runs it (the CI script, the README, the package script). A failure you did not see is not a failure you can fix: it may be flaky, already fixed, or a different failure than the one described.

## 2. Read the failure

Read the whole error before touching anything: the assertion's expected and actual values, the top frame of the stack, the file and line. `read_file` that location. Then read the code the test calls into.

Do not guess the cause from the test's name, and do not start by re-reading a large area of the codebase. The failure text is the highest-signal thing you have.

## 3. Minimise

Make the failure as small as it can be while still failing: trim the input, comment out the second half of the test body, drop the cases that already pass. Keep the command one line you can paste again.

Smaller failing cases fail for fewer reasons. Stop when one more cut makes it pass.

## 4. One hypothesis, one test

Write down what you believe in a sentence, with the thing that would prove it wrong. Change one thing, re-run the same command, and read the new output against the prediction. If the output changed in a way the hypothesis did not predict, the hypothesis was wrong - say so and form another instead of layering another change on top.

Use the existing tests to check your model of the code before changing it.

## 5. Fix, then prove it

- Re-run the **original** command from step 1, not a narrowed one.
- Re-run the surrounding suite: a fix that breaks another test is not a fix.
- A test weakened to pass is not a fix. Deleting an assertion, loosening an equality, adding a skip, catching the error or editing the fixture to match the buggy output all turn a real failure into a hidden one. If the test itself encodes the wrong behaviour, say that explicitly, with evidence, and change the test as a separate, named decision.
- Report what the actual cause was. "It was a stale cache" is useful; "it works now" is not.

## What not to do

- Change code until the error text disappears without knowing why it appeared.
- "It passes now" after a retry - that makes it flaky, not fixed. Report a flaky test as flaky, with the two runs that differ.
- Bump a dependency, add a timeout, or add a retry as the first move.
