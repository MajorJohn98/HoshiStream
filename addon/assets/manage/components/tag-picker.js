// Tag chips for an entry form: toggle registered tags on and off, or type a
// new one. `value` is the entry's tag list; `onChange` is a state setter and
// receives an updater so rapid toggles never work from a stale list. New tags
// are registered server-side when the entry is saved.
import { html, useState } from "../vendor/preact-htm.js";
import { useStore } from "../store.js";

const key = (name) => name.trim().toLocaleLowerCase();

export function TagPicker({ value = [], onChange }) {
  const { tags } = useStore();
  const [draft, setDraft] = useState("");
  const selected = new Set(value.map(key));
  const toggle = (name) =>
    onChange((current) =>
      current.some((tag) => key(tag) === key(name))
        ? current.filter((tag) => key(tag) !== key(name))
        : [...current, name],
    );
  // Show every registered tag plus any tag on the entry the registry no
  // longer knows about, so nothing silently disappears from the form.
  const names = [...tags.map((tag) => tag.name)];
  for (const tag of value)
    if (!names.some((name) => key(name) === key(tag))) names.push(tag);
  const addDraft = () => {
    const name = draft.trim();
    if (!name) return;
    const existing = names.find((candidate) => key(candidate) === key(name));
    onChange((current) =>
      current.some((tag) => key(tag) === key(name))
        ? current
        : [...current, existing ?? name],
    );
    setDraft("");
  };
  return html`
    <div class="tag-picker">
      <div class="chips wrap">
        ${names.map(
          (name) => html`
            <button
              type="button"
              class="chip ${selected.has(key(name)) ? "active" : ""}"
              aria-pressed=${selected.has(key(name))}
              onClick=${() => toggle(name)}
              key=${name}
            >
              ${name}
            </button>
          `,
        )}
      </div>
      <div class="picker-row stacked-sm">
        <input
          placeholder="New tag…"
          maxlength="40"
          value=${draft}
          onInput=${(e) => setDraft(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
        />
        <button
          type="button"
          class="secondary"
          disabled=${!draft.trim()}
          onClick=${addDraft}
        >
          + Add tag
        </button>
      </div>
    </div>
  `;
}
