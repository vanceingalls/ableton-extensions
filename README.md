# Ableton Extensions

An [Ableton Live 12](https://www.ableton.com/) Extension that generates an AI **feedback video**
with [HyperFrames](https://hyperframes.heygen.com): Claude reviews your project and *designs* a
video presenting the review, rendered and imported back into your Set. The shared engineering
notes live in [`docs/`](docs/).

## Extensions

| Project | What it does |
| --- | --- |
| [`hyperframes-feedback/`](hyperframes-feedback/) | Select an arrangement range across tracks → **Create Feedback Video from Selection…**. Claude reviews the selection, authors a HyperFrames composition of the review (lint-fixed until clean), renders it via HyperFrames Cloud, and imports the MP4 back into the Set. |

## Docs

- **[BUILDING-HYPERFRAMES-EXTENSIONS.md](docs/BUILDING-HYPERFRAMES-EXTENSIONS.md)** — a complete technical guide and template for building a HyperFrames extension: reading the Extensions SDK, the AI feedback flow, and connecting the Anthropic + HyperFrames Cloud APIs. Every speed bump and SDK limitation included.

## How it works, in one diagram

```
Ableton Live  ──▶  Extensions SDK  ──▶  Claude (review + author)  ──▶  HyperFrames  ──▶  MP4 → Set
  selection         project summary      structured JSON + comp        cloud render
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
