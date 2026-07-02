<div align="center">

<img src="apps/mobile/assets/images/icon.png" width="120" alt="Mindwtr Logo">

# Mindwtr

English | [中文](./README_zh.md)

The free, open-source, cross-platform GTD app. Local-first, no account required. _Mind Like Water._

_New to GTD? Read [GTD in 15 minutes](https://hamberg.no/gtd) for a quick introduction._

[Getting Started](https://docs.mindwtr.app/start/getting-started) · [FAQ](https://docs.mindwtr.app/start/faq) · [Docs](https://docs.mindwtr.app/) · [Data & Sync](https://docs.mindwtr.app/data-sync/) · [Cloud Deployment](https://docs.mindwtr.app/data-sync/cloud-deployment) · [MCP Server](https://docs.mindwtr.app/power-users/mcp)

[![CI](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml/badge.svg)](https://github.com/dongdongbh/Mindwtr/actions/workflows/ci.yml)
[![GitHub license](https://img.shields.io/github/license/dongdongbh/Mindwtr?color=brightgreen)](LICENSE)
[![GitHub downloads](https://img.shields.io/github/downloads/dongdongbh/Mindwtr/total)](https://github.com/dongdongbh/Mindwtr/releases)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/dongdongbh/Mindwtr)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/ahhFxuDBb4)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ff5f5f?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/dongdongbh)
[![Ko-fi](https://img.shields.io/badge/Sponsor-Ko--fi-29abe0?logo=kofi&logoColor=white)](https://ko-fi.com/D1D01T20WK)

<p align="center" style="text-align: center;">
  <a href="https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare" target="_blank">
    <img src="https://developer.microsoft.com/store/badges/images/English_get-it-from-MS.png"
         align="center"
         alt="Microsoft Store"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr" target="_blank">
    <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png"
         align="center"
         alt="Google Play"
         style="height: 74px"
         height="74" />
  </a>
  <a href="https://apps.apple.com/app/mindwtr/id6758597144" target="_blank">
    <img src="https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83"
         align="center"
         alt="App Store"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://flathub.org/apps/tech.dongdongbh.mindwtr" target="_blank">
    <img alt="Get it on Flathub"
         src="https://flathub.org/api/badge?locale=en"
         align="center"
         style="height: 50px"
         height="50" />
  </a>
  <a href="https://apt.izzysoft.de/packages/tech.dongdongbh.mindwtr" target="_blank">
    <img src="https://gitlab.com/IzzyOnDroid/repo/-/raw/master/assets/IzzyOnDroid.png"
         align="center"
         alt="Get it at IzzyOnDroid"
         style="height: 74px"
         height="74" />
  </a>
  <a href="https://f-droid.org/en/packages/tech.dongdongbh.mindwtr/" target="_blank">
    <img src="https://fdroid.gitlab.io/artwork/badge/get-it-on.png"
         align="center"
         alt="Get it on F-Droid"
         style="height: 74px"
         height="74" />
  </a>
  <a href="https://snapcraft.io/mindwtr" target="_blank">
    <img alt="Get it from the Snap Store"
         src="https://snapcraft.io/en/dark/install.svg"
         align="center"
         style="height: 50px"
         height="50" />
  </a>
</p>

</div>

<div align="center">
  <video src="https://github.com/user-attachments/assets/e62ac128-467d-4e2f-beb0-7fc3c947bfeb" width="60%" autoplay loop muted playsinline></video>
  
  <video src="https://github.com/user-attachments/assets/d6688a01-989f-41b9-b190-94b21b0ae821" width="25%" autoplay loop muted playsinline></video>

  <p>
    <i>Local-First GTD on Arch Linux & Android</i>
  </p>
</div>

## Why Mindwtr (Quick Comparison)

Mindwtr is built for people who want a complete GTD system without lock-in. Here is a brief, respectful comparison with mainstream task apps and GTD-focused alternatives.

| Capability                                                        | Mindwtr | Todoist | TickTick | Everdo | NirvanaHQ |
| ----------------------------------------------------------------- | ------- | ------- | -------- | ------ | --------- |
| Open source                                                       | ✅      | ❌      | ❌       | ❌     | ❌        |
| GTD-native workflow                                               | ✅      | ⚠️      | ⚠️       | ✅     | ✅        |
| All major platforms (desktop + mobile + web, incl. Linux desktop) | ✅      | ✅      | ✅       | ⚠️     | ⚠️        |
| Local-first + no account required                                 | ✅      | ❌      | ❌       | ✅     | ❌        |
| AI assistant (BYOK + local LLM)                                   | ✅      | ❌      | ❌       | ❌     | ❌        |
| Flexible sync (WebDAV / Dropbox / self-hosted / local file)       | ✅      | ❌      | ❌       | ⚠️     | ❌        |
| Completely free                                                   | ✅      | ❌      | ❌       | ❌     | ❌        |

Legend: `✅` = yes, `❌` = no, `⚠️` = partial/limited support.

_This comparison is based on the current public capabilities of each product. If any entry is outdated, feel free to open an issue or PR with sources._

## Philosophy

Mindwtr is built to be **simple by default and powerful when you need it**. We focus on reducing cognitive load, cutting the fat, and keeping you in flow. That means:

- **Progressive disclosure**: advanced options stay hidden until they matter.
- **Less by default**: fewer fields, fewer knobs, fewer distractions.
- **Avoid feature creep**: we prioritize clarity over clutter.

_Don't show me a cockpit when I just want to ride a bike._

## Features

- GTD workflow end-to-end: Capture, Clarify, Organize, Reflect, Engage.
- Focus view combines time-based agenda with next actions.
- Local-first data model with native iCloud / CloudKit sync on supported Apple builds, plus file sync, WebDAV, Dropbox, and self-hosted cloud options.
- Projects support sections, areas, and reorderable project task order for larger multi-step planning.
- Obsidian vault import with note deep links on desktop.
- Optional AI copilot (BYOK + local/self-hosted compatible models).
- Cross-platform apps for desktop and mobile, plus PWA.
- Optional automation helpers with desktop local REST API, CLI, and the published [`mindwtr-mcp`](https://www.npmjs.com/package/mindwtr-mcp) server.

<details>
<summary>See all features</summary>

### GTD Workflow

- **Capture** - Quick add tasks from anywhere (global hotkey popup, tray, share sheet, voice)
- **Clarify** - Guided inbox processing with 2-minute rule
- **Organize** - Projects, sections, contexts, and status lists
- **Reflect** - Weekly review wizard with reminders
- **Engage** - Context-filtered next actions
- **AI Assist (Optional)** - Clarify, break down, and review with BYOK AI (OpenAI, Gemini, Claude, or local/self-hosted OpenAI-compatible LLMs)

### Views

- 📥 **Inbox** - Capture zone with processing wizard
- 🎯 **Focus** - Agenda (time-based) + Next Actions in one view
- 📁 **Projects** - Multi-step outcomes with sections, areas, and manual task ordering
- 🏷️ **Contexts** - Slash-delimited contexts with parent matching (@work/meetings)
- ⏳ **Waiting For** - Delegated items
- 💭 **Someday/Maybe** - Deferred ideas
- 📅 **Calendar** - Time-based planning with adjustable mobile week density
- 📋 **Board** - Kanban-style drag-and-drop
- 📝 **Review** - Daily + weekly review workflows
- 📦 **Archived** - Hidden history, searchable when needed

### Productivity Features

- 🔍 **Global Search** - Search all areas globally with operators (`status:`, `context:`, `assigned:`, `location:`, `where:`, `id:`, `-id:`, `due:<=7d`)
- 📦 **Bulk Actions** - Multi-select, batch move/tag/delete
- 📎 **Attachments** - Files and links on tasks
- ✏️ **Markdown Notes** - Rich text descriptions with preview
- 🗂️ **Project States** - Active, Waiting, Someday, Archived
- ♾️ **Fluid Recurrence** - Next date is calculated after completion
- ♻️ **Reusable Lists** - Duplicate tasks or reset checklists
- ✅ **Checklist Mode** - Fast list-style checking for checklist tasks
- ✅ **Audio Capture** - Quick voice capture with automatic transcription and task creation
- 🧭 **Copilot Suggestions** - Optional context/tag/time hints while typing
- 🍅 **Pomodoro Focus (Optional)** - 15/3, 25/5, 50/10 timer panel in Focus view with one optional custom preset
- 🔔 **Notifications** - Separate start and due reminders with snooze
- 📊 **Daily Digest** - Morning briefing + evening review
- 📅 **Weekly Review** - Customizable weekly reminder

### Data & Sync

- 🔄 **Sync Options** - See the [Data & Sync docs](https://docs.mindwtr.app/data-sync/) for supported backends and setup
- 🍎 **Native iCloud / CloudKit Sync** - Apple-only structured sync on supported iPhone, iPad, and macOS builds
- ☁️ **Dropbox OAuth Sync (Optional)** - Native Dropbox App Folder sync in supported non-FOSS builds
- 📤 **Export/Backup** - Export data to JSON
- ♻️ **Restore from Backup** - Replace local data from a validated Mindwtr backup with a recovery snapshot first
- 📥 **TickTick + Todoist + DGT GTD + OmniFocus + Apple Reminders Import** - Import TickTick CSV/ZIP, Todoist CSV/ZIP, DGT GTD JSON/ZIP, OmniFocus exports, or incomplete Apple Reminders into Mindwtr
- 🔗 **Obsidian Integration** - Desktop vault task import with deep links back to source notes
- 🗓️ **External Calendars (System + ICS)** - Mobile reads system calendars and pushes dated tasks; macOS desktop reads Apple Calendar and can push dated tasks; desktop/web also support ICS subscriptions and task creation from events

### Automation

- 🔌 **CLI** - Add, list, complete, search from terminal by running the repo helper
- 🌐 **REST API** - Optional desktop localhost API server for token-authenticated scripting
- 🌍 **Web App (PWA)** - Browser access with offline support
- 🧠 **MCP Server** - Optional local stdio Model Context Protocol server for LLM automation, available as [`mindwtr-mcp`](https://www.npmjs.com/package/mindwtr-mcp) and in the [MCP Registry](https://registry.modelcontextprotocol.io/)

Desktop builds can start the local REST API from **Settings -> Advanced** on `127.0.0.1` with default port `3456` and a generated bearer token. The CLI remains a repo helper; the stdio MCP server can be installed from npm with `npm install -g mindwtr-mcp` or launched by MCP clients with `npx -y mindwtr-mcp`.

### Cross-Platform

- 🖥️ **Desktop** - Tauri v2 (macOS, Linux, Windows)
- 📱 **Mobile** - React Native/Expo (iOS via App Store/TestFlight, Android) with in-app tips for gestures and app shortcuts
- 📲 **Android Widget** - Home screen focus/next widget
- ⌨️ **Keyboard Shortcuts** - Vim and Emacs presets
- 🎨 **Themes** - Light/Dark
- 🌍 **i18n** - English, Vietnamese, Chinese (Simplified), Chinese (Traditional), Spanish, Hindi, Arabic, German, Russian, Japanese, French, Portuguese, Polish, Korean, Czech, Italian, Turkish, Dutch
- 🐳 **Docker** - Run the PWA + self-hosted sync server with Docker

</details>

## Installation

For the complete and current install guides, see [Desktop Installation](https://docs.mindwtr.app/start/desktop-installation) and [Mobile Installation](https://docs.mindwtr.app/start/mobile-installation).

Quick options:

- Windows: Microsoft Store, Winget, Chocolatey, Scoop, or GitHub Releases.
- macOS: Mac App Store, Homebrew, TestFlight beta, or GitHub Releases.
- Linux: Flathub, Snap, AUR, APT/RPM repos, or GitHub Releases.
- Android: Google Play, F-Droid, IzzyOnDroid, or GitHub Releases APK.
- iOS: App Store or TestFlight beta.
- Web / self-hosted: [Cloud Deployment](https://docs.mindwtr.app/data-sync/cloud-deployment) or the [Docker guide](docker/README.md).

<details>
<summary>Package manager quick commands</summary>

```bash
flatpak install flathub tech.dongdongbh.mindwtr
yay -S mindwtr-bin
brew install --cask mindwtr
```

```powershell
winget install dongdongbh.Mindwtr
```

For APT/RPM repo setup, source builds, portable ZIPs, mobile store variants, and Docker setup, use the full install guides above.

</details>

## Community

Mindwtr is shaped by its users and contributors. Thank you for helping improve it.

### :hearts: Contributing & Support

If you want to get involved, start with [CONTRIBUTING.md](docs/CONTRIBUTING.md).

You can help in several ways:

1. **Spread the word:** Share Mindwtr with friends and communities, and support it on [Product Hunt](https://www.producthunt.com/products/mindwtr) and [AlternativeTo](https://alternativeto.net/software/mindwtr/).
2. **Leave store reviews:** A good rating/review on the [App Store](https://apps.apple.com/app/mindwtr/id6758597144), [Google Play](https://play.google.com/store/apps/details?id=tech.dongdongbh.mindwtr), or [Microsoft Store](https://apps.microsoft.com/detail/9n0v5b0b6frx?ocid=webpdpshare) helps a lot.
3. **Star and share:** Star the repo and post about Mindwtr on [X](https://twitter.com/intent/tweet?text=I%20like%20Mindwtr%20https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr), [Reddit](https://www.reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr&title=I%20like%20Mindwtr), or [LinkedIn](https://www.linkedin.com/shareArticle?mini=true&url=https%3A%2F%2Fgithub.com%2Fdongdongbh%2FMindwtr&title=I%20like%20Mindwtr).
4. **Report bugs and request features:** Open issues on [GitHub Issues](https://github.com/dongdongbh/Mindwtr/issues).
5. **Join the community chat:** Come to [Discord](https://discord.gg/ahhFxuDBb4).
6. **Help with translations:** Contribute locale updates in [`packages/core/src/i18n/locales/`](packages/core/src/i18n/locales/).
7. **Contribute code/docs:** Open a pull request and follow the [contribution guide](docs/CONTRIBUTING.md) and commit conventions.
8. **Pick and build:** Community members are welcome to pick any open issue and submit a PR.
9. **Sponsor the project:** Support ongoing development via [GitHub Sponsors](https://github.com/sponsors/dongdongbh) or [Ko-fi](https://ko-fi.com/D1D01T20WK).

## Documentation

- 📚 [Official Docs](https://docs.mindwtr.app/) - Searchable documentation with better navigation
- 🚀 [Getting Started](https://docs.mindwtr.app/start/getting-started)
- ❓ [FAQ](https://docs.mindwtr.app/start/faq)
- 🔄 [Data & Sync](https://docs.mindwtr.app/data-sync/)
- 🔗 [Markdown Links](https://docs.mindwtr.app/use/markdown-links)
- 🛠️ [Cloud Deployment](https://docs.mindwtr.app/data-sync/cloud-deployment)
- ☁️ [Cloud API](https://docs.mindwtr.app/developers/cloud-api)
- 🧠 [MCP Server](https://docs.mindwtr.app/power-users/mcp)
- 📝 [Release Notes Index](docs/release-notes/README.md)

## Star History

<a href="https://www.star-history.com/?repos=dongdongbh%2FMindwtr&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=dongdongbh/Mindwtr&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=dongdongbh/Mindwtr&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=dongdongbh/Mindwtr&type=date&legend=top-left" />
 </picture>
</a>

## Sponsors

Thanks to these monthly sponsors for supporting Mindwtr.

<p align="center">
  <a href="https://github.com/jarrydstan" title="@jarrydstan">
    <img src="docs/assets/sponsors/jarrydstan.png" width="60" height="60" alt="@jarrydstan" />
  </a>
  <a href="https://github.com/ronmolenda" title="@ronmolenda">
    <img src="docs/assets/sponsors/ronmolenda.png" width="60" height="60" alt="@ronmolenda" />
  </a>
  <a href="https://github.com/bepolymathe" title="@bepolymathe">
    <img src="docs/assets/sponsors/bepolymathe.png" width="60" height="60" alt="@bepolymathe" />
  </a>
  <a href="https://github.com/karl1990" title="@karl1990">
    <img src="docs/assets/sponsors/karl1990.png" width="60" height="60" alt="@karl1990" />
  </a>
  <a href="https://github.com/srijan" title="@srijan">
    <img src="docs/assets/sponsors/srijan.png" width="60" height="60" alt="@srijan" />
  </a>
  <a href="https://github.com/davibicudo" title="@davibicudo">
    <img src="docs/assets/sponsors/davibicudo.png" width="60" height="60" alt="@davibicudo" />
  </a>
</p>

<p align="center">
  <sub><a href="https://github.com/jarrydstan">@jarrydstan</a> · <a href="https://github.com/ronmolenda">@ronmolenda</a> · <a href="https://github.com/bepolymathe">@bepolymathe</a> · <a href="https://github.com/karl1990">@karl1990</a> · <a href="https://github.com/srijan">@srijan</a> · <a href="https://github.com/davibicudo">@davibicudo</a></sub>
</p>
