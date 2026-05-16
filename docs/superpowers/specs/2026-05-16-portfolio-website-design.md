# Samuel Maclar Portfolio Website Design

## Goal

Build an intuitive, immersive, single-page portfolio website for Samuel Maclar that presents him as a full-stack developer, cybersecurity student, AI builder, and founder of Radiant InnovaTech.

The site should work for recruiters, collaborators, and potential clients. It should feel premium and modern without becoming hard to scan.

## Audience

- Recruiters and remote collaborators looking for technical fit.
- Clients or partners evaluating Radiant InnovaTech credibility.
- Developers and cybersecurity peers reviewing project work.

## Visual Direction

The portfolio will use a hybrid professional and cybersecurity-inspired style:

- Dark mode as the default first impression.
- Light mode available through a clear theme toggle.
- Deep charcoal, clean white text, cyan/blue security accents, and a warm orange accent connected to Radiant InnovaTech.
- Subtle immersive effects: animated grid, glow states, smooth section transitions, and hover interactions.
- No cluttered neon hacker aesthetic. The site should remain readable, serious, and business-ready.

## Core Layout

The site will be a responsive one-page experience with sticky navigation.

### Hero

The first viewport introduces Samuel clearly:

- Name: Samuel Maclar.
- Title: Full-Stack Developer, Cybersecurity Enthusiast, Builder.
- Short positioning line about building secure, useful software.
- Personal photo area, ready for the image Samuel will provide.
- Primary actions: View Projects, Contact Me.
- Secondary links: GitHub, LinkedIn, X, Instagram.

The hero should feel immersive through layered background motion and depth, while keeping the text and actions obvious.

### About

This section will summarize:

- Final-year Cyber Security student at University of Mines and Technology, Tarkwa, Ghana.
- CEO of Radiant InnovaTech.
- Interest in secure full-stack systems, internal tooling, AI assistants, and client-facing platforms.
- Ghana-based and open to remote collaboration.

### Focus Areas

Use concise, scannable panels for:

- Full-stack web systems.
- Cybersecurity and GRC.
- AI assistants and automation.
- Business tooling and platform development.

### Featured Projects

Projects should be grouped into priority projects and supporting projects.

Priority projects:

- POS: POS system, TypeScript.
- hotel: hotel system and website.
- EMS: Employee Management system.
- GRC Auditor: STRIDE-based conversational threat modelling assistant.
- Ray AI Assistant: Jarvis-inspired assistant using FastAPI, LangGraph, and Claude API.
- Radiant InnovaTech: company platform and internal/client tooling identity.

Supporting projects:

- charity-website.
- my-portfolio.
- Radiant-Tech-Forums-.
- login-app.
- e-commerce-platform.
- signup-and-login.

Repository source: public GitHub profile `RadiantSeraph1`, checked on 2026-05-16.

Each project card should include:

- Project name.
- Short practical description.
- Stack or category.
- Link to GitHub when public.
- Visual distinction for featured projects.

### Tech Stack

Grouped skill chips:

- Frontend: HTML5, CSS3, JavaScript, React, Vite.
- Backend and databases: Node.js, FastAPI, PHP, PostgreSQL, MySQL.
- AI: LangChain, ChromaDB, Claude API.
- Infrastructure and tools: AWS EC2, Nginx, Docker, Git.
- Cybersecurity: Burp Suite, Ghidra, OWASP, STRIDE.

### Founder / Leadership

Present Radiant InnovaTech as a credibility section:

- CEO at Radiant InnovaTech, Tarkwa.
- Builds internal tools and client-facing platforms.
- Emphasize reliability, security, and practical business outcomes.

### Contact

Include clear contact actions:

- LinkedIn.
- GitHub.
- X / Twitter.
- Instagram.
- Facebook.
- Email placeholder until Samuel provides an email.

## Interaction Design

- Sticky section navigation.
- Dark/light theme toggle with persisted preference.
- Smooth scrolling.
- Project card hover states.
- Mobile-first layout that keeps actions reachable.
- Resume/download button only if Samuel provides a resume file.
- Photo placeholder until Samuel provides an image.

## Technical Approach

Because the current project folder is empty, build a lightweight static frontend first:

- `index.html`
- `styles.css`
- `script.js`
- `assets/` for the provided photo and any future media

This avoids unnecessary framework setup and makes deployment simple on GitHub Pages, Netlify, Vercel, or shared hosting. If the site later needs a blog, admin editing, or complex animation system, it can migrate to React/Vite.

## Responsive Behavior

- Desktop: split hero with content and portrait, multi-column project and stack grids.
- Tablet: reduced columns, hero remains visually rich.
- Mobile: single-column flow, compact navigation, large touch targets, no overlapping text.

## Accessibility

- Maintain strong color contrast in both themes.
- Use semantic HTML sections and headings.
- Add meaningful alt text for Samuel's photo.
- Ensure buttons and links are keyboard accessible.
- Avoid motion that blocks usability.

## Content Still Needed From Samuel

- Personal photo.
- Preferred contact email, if any.
- Whether to include a downloadable resume.
- Short descriptions for GRC Auditor and Ray if more detail is desired.
- Any live demo links for GitHub projects.

## Out Of Scope For First Build

- Blog CMS.
- Backend contact form.
- Admin dashboard.
- Auto-syncing GitHub repositories at runtime.
- Complex 3D scenes.

These can be added later after the portfolio is live and polished.

