# Ableton Extensions

A collection of [Ableton Live 12](https://www.ableton.com/) Extensions that turn a Live Set into
video using [HyperFrames](https://hyperframes.heygen.com). Each extension is a self-contained
TypeScript/Node project; the shared engineering notes live in [`docs/`](docs/).

## Extensions

| Extension | What it does |
| --- | --- |
| [`hyperframes-feedback/`](hyperframes-feedback/) | Right-click a clip/track → **Render Video…** for a beat-accurate music visualizer, or an arrangement selection → **Create Feedback Video from Selection…** where Claude reviews the project and *designs* the video presenting its review. Renders via HyperFrames Cloud and imports the MP4 back into the Set. |

## Docs

- **[Building Ableton × HyperFrames extensions](docs/building-ableton-hyperframes-extensions.html)** — a complete, from-scratch build guide (open in a browser): reading the Extensions SDK, wiring both render modes, and connecting the Anthropic + HyperFrames Cloud APIs. Every speed bump and SDK limitation included.
- **[BUILDING-HYPERFRAMES-EXTENSIONS.md](docs/BUILDING-HYPERFRAMES-EXTENSIONS.md)** — the same material as a technical reference/template for new extensions.

## How it works, in one diagram

```
Ableton Live  ──▶  Extensions SDK  ──▶  Timeline JSON  ──▶  HyperFrames  ──▶  MP4 → Set
  clips/notes       handles→objects      beats→seconds       canvas/GSAP       cloud render
```

## Building an extension

Each extension builds independently. From its folder:

```bash
cd hyperframes-feedback
npm install          # see the SDK note below
npm run build:ext    # bundle to dist/extension.js
npm test             # unit tests
npm run package:ext  # produce a .ablx to install in Live
```

### The Ableton Extensions SDK is not included

These build against `@ableton-extensions/sdk` **1.0.0-beta.0**, a **private Ableton beta**
distributed as tarballs. It is not ours to redistribute, so it is not in this repo. The
`package.json` files reference it via a relative `file:` path
(`../../extensions-sdk-1.0.0-beta.0/*.tgz`); place the SDK bundle alongside the repo, or adjust
the path, once you have access through the Ableton beta program. Without it, `npm install` will
not resolve the SDK.

## Requirements

- Node 20+ (extensions run inside Live's bundled Node 24 Extension Host)
- Ableton Live 12.4+ (beta, for the Extensions SDK)
- For the AI feedback mode: an [Anthropic](https://console.anthropic.com) API key (the review)
  and a [HeyGen](https://platform.heygen.com) API key (HyperFrames Cloud rendering) — two
  separate accounts, two separate bills.

## License

See individual extensions. The Ableton SDK and HyperFrames are governed by their own terms.
