// System page: one scrollable control center merging health, storage,
// devices, and stream repair. Section chips stay sticky at the top and the
// hash (#/system/<section>) deep-links from the sidebar HUD.
import { html, useEffect } from "../vendor/preact-htm.js";
import { Shell } from "../components/shell.js";
import { HealthSection } from "./status.js";
import { StorageSection } from "./storage.js";
import { DevicesSection } from "./devices.js";
import { RepairSection } from "./sessions.js";

const SECTIONS = [
  ["health", "Health", HealthSection],
  ["storage", "Storage", StorageSection],
  ["devices", "Devices", DevicesSection],
  ["repair", "Stream repair", RepairSection],
];

function requestedSection() {
  return /^#\/system\/([a-z]+)/.exec(location.hash)?.[1];
}

export function SystemView() {
  useEffect(() => {
    const scrollToSection = () => {
      const section = requestedSection();
      if (!section) return;
      document
        .querySelector("#system-" + section)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    scrollToSection();
    addEventListener("hashchange", scrollToSection);
    return () => removeEventListener("hashchange", scrollToSection);
  }, []);
  return html`
    <${Shell} title="System">
      <p class="muted">
        Everything running behind your library — services, storage, devices, and
        repair sessions.
      </p>
      <nav class="section-chips">
        ${SECTIONS.map(
          ([key, label]) => html`
            <a class="chip" href=${"#/system/" + key}>${label}</a>
          `,
        )}
      </nav>
      ${SECTIONS.map(
        ([key, label, Section]) => html`
          <section class="system-section" id=${"system-" + key} key=${key}>
            <h2 class="section-title">${label}</h2>
            <${Section} />
          </section>
        `,
      )}
    <//>
  `;
}
