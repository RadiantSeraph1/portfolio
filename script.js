document.documentElement.classList.add("js");

const root = document.documentElement;
const themeToggle = document.querySelector(".theme-toggle");
const navToggle = document.querySelector(".nav-toggle");
const siteNav = document.querySelector(".site-nav");
const navLinks = [...document.querySelectorAll(".site-nav a")];
const sections = navLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

const storedTheme = localStorage.getItem("samuel-portfolio-theme");

function applyTheme(theme) {
  root.dataset.theme = theme;
  localStorage.setItem("samuel-portfolio-theme", theme);

  const nextTheme = theme === "dark" ? "light" : "dark";
  themeToggle?.setAttribute("aria-label", `Switch to ${nextTheme} theme`);

  if (window.lucide) {
    themeToggle.innerHTML =
      theme === "dark"
        ? '<i data-lucide="sun"></i><span>Theme</span>'
        : '<i data-lucide="moon"></i><span>Theme</span>';
    window.lucide.createIcons();
  }
}

applyTheme(storedTheme || "dark");

themeToggle?.addEventListener("click", () => {
  applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
});

navToggle?.addEventListener("click", () => {
  const isOpen = siteNav.classList.toggle("is-open");
  navToggle.setAttribute("aria-expanded", String(isOpen));
  navToggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");

  if (window.lucide) {
    navToggle.innerHTML = isOpen ? '<i data-lucide="x"></i>' : '<i data-lucide="menu"></i>';
    window.lucide.createIcons();
  }
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    siteNav.classList.remove("is-open");
    navToggle?.setAttribute("aria-expanded", "false");
    navToggle?.setAttribute("aria-label", "Open navigation");

    if (window.lucide) {
      navToggle.innerHTML = '<i data-lucide="menu"></i>';
      window.lucide.createIcons();
    }
  });
});

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.14 }
);

document.querySelectorAll(".reveal").forEach((element) => revealObserver.observe(element));

const navObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;

      navLinks.forEach((link) => {
        link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`);
      });
    });
  },
  { rootMargin: "-35% 0px -55% 0px", threshold: 0 }
);

sections.forEach((section) => navObserver.observe(section));

const projectGrid = document.querySelector("#project-grid");
const showAll = document.querySelector(".show-all");

if (projectGrid && showAll) {
  const total = projectGrid.querySelectorAll(".project-card").length;
  const label = showAll.querySelector(".label");
  const iconSlot = showAll.querySelector(".icon-slot");
  label.textContent = `Show all ${total} projects`;
  showAll.hidden = false;

  showAll.addEventListener("click", () => {
    const expanded = projectGrid.classList.toggle("is-expanded");
    showAll.setAttribute("aria-expanded", String(expanded));
    label.textContent = expanded ? "Show fewer projects" : `Show all ${total} projects`;
    iconSlot.innerHTML = `<i data-lucide="${expanded ? "chevrons-up" : "chevrons-down"}"></i>`;
    window.lucide?.createIcons();

    if (!expanded) {
      document.querySelector("#projects").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

if (window.lucide) {
  window.lucide.createIcons();
}
