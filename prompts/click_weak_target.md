<click_weak_target>

When interpreting **this** CLICK or **SCROLL**, the JSON **`target` is missing or weak** (no usable `label`, `title`, `description`, `value`, `url`, `document`, `help`, or `identifier`). Accessibility often hit a generic container (e.g. bare `AXGroup`) instead of the real control.

**Critical limitation — `siblings` is not “what was clicked” or “what was scrolled.”**  
`siblings` is usually a **sample of other controls in the same container** (toolbar, row, list). The pipeline **does not record which sibling was under the cursor**. Treat the list as **scene-setting**, not as a multiple-choice answer where you pick one label.

**Do not** write that the user clicked or scrolled a **specific** named control (e.g. “the delete all button”, “the 24h tab”) **only** because that string appears in `siblings`. That will often be **wrong** and is especially harmful for destructive actions (delete, remove, discard, send).

**Do** write something accurate and useful:

- Name the **region** or **control strip** using `siblings` + `context` (e.g. “events/tasks toolbar”, “time-range controls”, “activity header”) without asserting one button.
- For **SCROLL**, describe **scrolling in that area** (e.g. “Scrolled in the … sidebar”) using the same regional wording — not “scrolled the delete button.”
- You may summarize what **appears nearby** using neutral wording: *“among controls including …”*, *“in a toolbar with options such as …”*, *“near pause, time-range, and delete/copy actions”* — **without** claiming which control was the hit target.
- Use **`context`** (window title, URL, web area) to say **where** in the app the action was.

**Never** output vague hand-waving (“clicked something” / “scrolled”) **when** siblings or context give you a reasonable **area** description — but **also never** fabricate a single-control story from a sibling list.

Tab clicks in Chrome: `target` may be weak; siblings may show other tabs — same rule: do not claim which tab was clicked unless `target` or detail clearly identifies it; describe the tab strip / browser context instead.

</click_weak_target>
