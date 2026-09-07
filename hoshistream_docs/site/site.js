const contents = document.querySelector(".contents");
if (contents && window.matchMedia("(max-width: 900px)").matches) {
  contents.open = false;
}

const printButton = document.querySelector("#print-guide");
if (printButton) {
  printButton.hidden = false;
  printButton.addEventListener("click", () => window.print());
}

const closedForPrint = [];
window.addEventListener("beforeprint", () => {
  document.querySelectorAll("main details:not([open])").forEach((details) => {
    closedForPrint.push(details);
    details.open = true;
  });
});
window.addEventListener("afterprint", () => {
  closedForPrint.splice(0).forEach((details) => {
    details.open = false;
  });
});

// Hash links into collapsed reference sections must reveal their target.
function revealHashTarget() {
  const target = document.getElementById(window.location.hash.slice(1));
  if (!target) return;
  let parent = target.parentElement;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
}

window.addEventListener("hashchange", revealHashTarget);
revealHashTarget();

const links = Array.from(document.querySelectorAll(".contents nav a"));
const sections = Array.from(document.querySelectorAll(".guide-section"));
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.find((entry) => entry.isIntersecting);
      if (!visible) return;
      links.forEach((link) => {
        if (link.hash === `#${visible.target.id}`) {
          link.setAttribute("aria-current", "location");
        } else {
          link.removeAttribute("aria-current");
        }
      });
    },
    { rootMargin: "-5% 0px -75% 0px" },
  );
  sections.forEach((section) => observer.observe(section));
}
