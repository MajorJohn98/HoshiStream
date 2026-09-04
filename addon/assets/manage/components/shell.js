// Shared layout components for the management views.
import { html } from "../vendor/preact-htm.js";

export const Shell = ({ title, actions, children }) => html`
  <div class="head">
    <div><h1>${title}</h1></div>
    ${actions}
  </div>
  ${children}
`;
