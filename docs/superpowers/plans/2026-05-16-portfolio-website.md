# Samuel Maclar Portfolio Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an immersive, intuitive, responsive one-page portfolio website for Samuel Maclar.

**Architecture:** Use a static website with focused files: HTML for content structure, CSS for theme and responsive presentation, JavaScript for navigation, reveal effects, and theme persistence. Keep the first version dependency-free so it can be opened directly or hosted anywhere.

**Tech Stack:** HTML5, CSS3, vanilla JavaScript, external CDN assets for fonts and icons.

---

### Task 1: Static Page Structure

**Files:**
- Create: `index.html`

- [ ] **Step 1: Create semantic HTML sections**

Create `index.html` with sections for hero, about, focus areas, projects, skills, leadership, and contact. Include theme toggle, sticky navigation, project links, and a photo placeholder that can be replaced when Samuel provides an image.

- [ ] **Step 2: Verify links and headings**

Run: open `index.html` in a browser.
Expected: all navigation anchors jump to the intended sections and all external social/project links open valid URLs.

### Task 2: Immersive Responsive Styling

**Files:**
- Create: `styles.css`

- [ ] **Step 1: Add dark and light theme variables**

Define CSS custom properties for default dark mode and `[data-theme="light"]`.

- [ ] **Step 2: Add layout and interaction styles**

Style the sticky nav, hero, portrait placeholder, project grids, skill chips, contact area, and mobile layouts. Use subtle background motion and hover states without sacrificing readability.

- [ ] **Step 3: Verify responsive behavior**

Run: resize browser to desktop, tablet, and mobile widths.
Expected: no text overlaps, hero actions remain visible, project cards reflow cleanly.

### Task 3: Client-Side Interactions

**Files:**
- Create: `script.js`

- [ ] **Step 1: Add theme persistence**

Implement dark/light toggle using `localStorage` and `data-theme`.

- [ ] **Step 2: Add navigation polish**

Implement active nav highlighting, mobile menu toggle, and reveal-on-scroll effects.

- [ ] **Step 3: Verify interaction states**

Run: click theme toggle, menu button, nav links, and project links.
Expected: theme persists after reload, mobile menu opens/closes, active nav updates while scrolling.

### Task 4: Local Preview Verification

**Files:**
- Modify: no source changes expected unless verification finds layout issues.

- [ ] **Step 1: Start local server**

Run: `python -m http.server 8080`
Expected: site available at `http://127.0.0.1:8080`.

- [ ] **Step 2: Browser verification**

Open `http://127.0.0.1:8080`.
Expected: page renders in both themes, desktop and mobile layouts are usable, no obvious console or visual failures.

