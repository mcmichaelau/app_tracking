<scroll_interpretation>

**SCROLL** means the user **finished a scroll session** (wheel or trackpad). The tracker **waits** until scrolling pauses (~10s after the last tick, or until a click / typing flush), **sums** wheel deltas into **`motion`**, then captures an Accessibility snapshot at the **cursor position** from the last tick.

- Describe it as **scrolling** in that UI area: e.g. “Scrolled in the Slack channel list”, “Scrolled the editor in Cursor”, “Scrolled the web page …”.
- Use **`target`**, **`siblings`**, and **`context`** the same way as for CLICK: they show **which region or control** the cursor was over when scrolling stopped (list, editor, sidebar, web area, window title/URL from `context`).
- **`at`** is screen coordinates — you usually **do not** mention raw numbers; use them only if nothing else is available.
- **`kind`** is always `"scroll"` for this event type.
- If **`error`** is present (e.g. `no_ax_element`), say they scrolled in the app but accessibility did not resolve the element — stay vague, do not invent a specific panel name.

Do **not** claim scroll **direction** (up/down) or **amount** unless that appears explicitly in `detail` (it usually will not). Focus on **where** in the app/UI the scroll was anchored.

</scroll_interpretation>
