// Activity page: everything moving right now — connected clients, live
// playback, remote-pointer health, and stream-repair sessions. Devices and
// repair share the activity poller; #/activity/repair deep-links from the HUD.
import { html, useEffect } from "../vendor/preact-htm.js";
import { Shell } from "../components/shell.js";
import { DevicesSection } from "./devices.js";
import { RepairSection } from "./sessions.js";

export function ActivityView() {
  useEffect(() => {
    const scrollToSection = () => {
      if (!/^#\/activity\/repair/.test(location.hash)) return;
      document
        .querySelector("#activity-repair")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    scrollToSection();
    addEventListener("hashchange", scrollToSection);
    return () => removeEventListener("hashchange", scrollToSection);
  }, []);
  return html`
    <${Shell} title="Activity">
      <${DevicesSection} />
      <${RepairSection} />
    <//>
  `;
}
