// Tags page: the registry behind entry tags and the Library filter. Add,
// rename (cascades to every entry), or delete (strips from entries) tags.
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { Shell } from "../components/shell.js";
import { useStore, load, loadTags } from "../store.js";

function TagRow({ tag }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  useEffect(() => setName(tag.name), [tag.name]);
  const rename = async (e) => {
    e.preventDefault();
    const next = name.trim();
    if (!next || next === tag.name) return setEditing(false);
    try {
      await api("tags/" + encodeURIComponent(tag.name), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      notify('Renamed "' + tag.name + '" to "' + next + '"');
      setEditing(false);
      await Promise.all([loadTags(), load()]);
    } catch (error) {
      notify(error.message);
    }
  };
  const remove = async () => {
    const inUse = tag.count
      ? " It is on " +
        tag.count +
        " title" +
        (tag.count === 1 ? "" : "s") +
        ", which will lose it."
      : "";
    if (!confirm('Delete the tag "' + tag.name + '"?' + inUse)) return;
    try {
      await api("tags/" + encodeURIComponent(tag.name), { method: "DELETE" });
      notify('Deleted "' + tag.name + '"');
      await Promise.all([loadTags(), load()]);
    } catch (error) {
      notify(error.message);
    }
  };
  return html`
    <li class="tag-row">
      ${
        editing
          ? html`<form class="row" onSubmit=${rename}>
              <input
                value=${name}
                maxlength="40"
                autofocus
                onInput=${(e) => setName(e.target.value)}
                onKeyDown=${(e) => {
                  if (e.key === "Escape") setEditing(false);
                }}
              />
              <button class="primary">Save</button>
              <button
                type="button"
                class="secondary"
                onClick=${() => setEditing(false)}
              >
                Cancel
              </button>
            </form>`
          : html`
              <a
                class="tag-name"
                href=${"#/library/tag/" + encodeURIComponent(tag.name)}
                title="Show in library"
              >
                ${tag.name}
              </a>
              <span class="inline-note tag-count">
                ${tag.count} title${tag.count === 1 ? "" : "s"}
              </span>
              <span class="row tag-actions">
                <button class="secondary" onClick=${() => setEditing(true)}>
                  Rename
                </button>
                <button class="danger" onClick=${remove}>Delete</button>
              </span>
            `
      }
    </li>
  `;
}

export function TagsView() {
  const { tags, entries } = useStore();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const tagged = entries.filter((entry) => entry.tags?.length).length;
  const add = async (e) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    try {
      await api("tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      notify('Added "' + name + '"');
      setDraft("");
      await loadTags();
    } catch (error) {
      notify(error.message);
    }
  };
  const visible = tags.filter((tag) =>
    tag.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return html`
    <${Shell}
      title="Tags"
      actions=${html`<form class="row" onSubmit=${add}>
        <input
          placeholder="New tag…"
          maxlength="40"
          value=${draft}
          onInput=${(e) => setDraft(e.target.value)}
        />
        <button class="primary" disabled=${!draft.trim()}>+ Add tag</button>
      </form>`}
    >
      <p class="muted">
        Genre-style labels for your titles. Tags filter the Library and appear
        as genres in Stremio's catalog picker. Renaming or deleting a tag
        updates every title that carries it.
      </p>
      <div class="controls">
        <span class="inline-note">
          ${tags.length} tags · ${tagged} of ${entries.length} titles tagged
        </span>
        <input
          type="search"
          placeholder="Filter tags…"
          value=${query}
          onInput=${(e) => setQuery(e.target.value)}
        />
      </div>
      <ul class="rows tag-list">
        ${
          visible.length
            ? visible.map(
                (tag) => html`<${TagRow} key=${tag.name} tag=${tag} />`,
              )
            : html`<li class="muted">No matching tags.</li>`
        }
      </ul>
    <//>
  `;
}
