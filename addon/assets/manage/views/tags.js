// Tags page: the registry behind entry tags and the Library filter. Add,
// rename (cascades to every entry), or delete (strips from entries) tags.
// Pinning a tag gives it a row on Stremio's Board (at most a handful).
import { html, useEffect, useState } from "../vendor/preact-htm.js";
import { api, notify } from "../api.js";
import { Shell } from "../components/shell.js";
import { useStore, load, loadTags } from "../store.js";

function TagRow({ tag, pinnedCount, pinnedLimit }) {
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
  const togglePin = async () => {
    try {
      await api("tags/" + encodeURIComponent(tag.name), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: !tag.pinned }),
      });
      notify(
        tag.pinned
          ? 'Removed "' + tag.name + '" from the Board'
          : '"' + tag.name + '" now has a Board row',
      );
      await loadTags();
    } catch (error) {
      notify(error.message);
    }
  };
  const pinFull = !tag.pinned && pinnedCount >= pinnedLimit;
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
                ${tag.pinned ? " · on the Board" : ""}
              </span>
              <span class="row tag-actions">
                <button
                  class="secondary"
                  disabled=${pinFull}
                  title=${
                    pinFull
                      ? "Up to " + pinnedLimit + " tags can be on the Board"
                      : tag.pinned
                        ? "Remove this tag's row from Stremio's Board"
                        : "Give this tag its own row on Stremio's Board"
                  }
                  onClick=${togglePin}
                >
                  ${tag.pinned ? "Unpin" : "Pin to Board"}
                </button>
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

function ContactEmail() {
  const [saved, setSaved] = useState(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("identity")
      .then((identity) => {
        setSaved(identity.contactEmail || "");
        setValue(identity.contactEmail || "");
      })
      .catch(() => setSaved(""));
  }, []);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const next = await api("identity", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactEmail: value.trim() }),
      });
      setSaved(next.contactEmail || "");
      setValue(next.contactEmail || "");
      notify(
        next.contactEmail
          ? "Contact address saved"
          : "Contact address removed from the manifest",
      );
    } catch (error) {
      notify(error.message);
    } finally {
      setBusy(false);
    }
  };
  return html`
    <form class="row" onSubmit=${save}>
      <input
        type="email"
        placeholder="Contact e-mail shown on the add-on tile (optional)"
        value=${value}
        disabled=${saved === null}
        onInput=${(e) => setValue(e.target.value)}
      />
      <button
        class="secondary"
        disabled=${busy || saved === null || value.trim() === saved}
      >
        Save
      </button>
    </form>
  `;
}

export function TagsView() {
  const { tags, entries, pinnedLimit } = useStore();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const tagged = entries.filter((entry) => entry.tags?.length).length;
  const pinnedCount = tags.filter((tag) => tag.pinned).length;
  const limit = pinnedLimit || 8;
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
        updates every title that carries it. Pin up to ${limit} tags to give
        each its own row on Stremio's Board, next to Recently added and
        Unwatched.
      </p>
      <${ContactEmail} />
      <div class="controls">
        <span class="inline-note">
          ${tags.length} tags · ${tagged} of ${entries.length} titles tagged ·
          ${pinnedCount} of ${limit} on the Board
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
                (tag) =>
                  html`<${TagRow}
                    key=${tag.name}
                    tag=${tag}
                    pinnedCount=${pinnedCount}
                    pinnedLimit=${limit}
                  />`,
              )
            : html`<li class="muted">No matching tags.</li>`
        }
      </ul>
    <//>
  `;
}
