// Tag picker for an entry form: the entry's tags as removable chips plus one
// input that suggests registered tags and accepts new ones on Enter. `value`
// is the entry's tag list; `onChange` is a state setter and receives an
// updater so rapid edits never work from a stale list. New tags are
// registered server-side when the entry is saved.
import { html, useRef, useState } from "../vendor/preact-htm.js";
import { useStore } from "../store.js";

const key = (name) => name.trim().toLocaleLowerCase();

export function TagPicker({ value = [], onChange }) {
  const { tags } = useStore();
  const [draft, setDraft] = useState("");
  // The vendored preact predates useId; one id per mounted picker suffices.
  const listId = useRef(
    "tags-" + Math.random().toString(36).slice(2, 8),
  ).current;
  const selected = new Set(value.map(key));
  const suggestions = tags
    .map((tag) => tag.name)
    .filter((name) => !selected.has(key(name)));
  const remove = (name) =>
    onChange((current) => current.filter((tag) => key(tag) !== key(name)));
  const add = () => {
    const name = draft.trim();
    if (!name) return;
    // Prefer the registry's spelling so chips match the Tags page.
    const existing = tags.find((tag) => key(tag.name) === key(name))?.name;
    onChange((current) =>
      current.some((tag) => key(tag) === key(name))
        ? current
        : [...current, existing ?? name],
    );
    setDraft("");
  };
  return html`
    <div class="tag-picker">
      <div class="tag-picker-row">
        ${value.map(
          (name) => html`
            <span class="tag" key=${name}>
              ${name}
              <button
                type="button"
                class="tag-remove"
                aria-label=${"Remove " + name}
                onClick=${() => remove(name)}
              >
                <svg
                  viewBox="0 0 12 12"
                  width="10"
                  height="10"
                  aria-hidden="true"
                >
                  <path
                    d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </span>
          `,
        )}
        <input
          class="tag-input"
          list=${listId}
          placeholder=${value.length ? "Add a tag…" : "Add tags…"}
          maxlength="40"
          value=${draft}
          onInput=${(e) => setDraft(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && value.length) {
              remove(value[value.length - 1]);
            }
          }}
          onBlur=${add}
        />
        <datalist id=${listId}>
          ${suggestions.map((name) => html`<option value=${name} key=${name} />`)}
        </datalist>
      </div>
      <p class="inline-note stacked-xs">
        Enter adds a tag; type a new name to create one. Suggestions come from
        the Tags page.
      </p>
    </div>
  `;
}
