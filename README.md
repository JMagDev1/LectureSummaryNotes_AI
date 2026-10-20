# Crib

Turn lecture slides, PDFs and notes into a two-page summary sheet and a revision slideshow.

Drop in PDFs, PowerPoints (.pptx), Word documents (.docx), text files or photos of handwritten notes. Crib sends them to Claude and gives you:

- a summary sheet that fits on two A4 pages: big idea, key concepts, how it works, a diagram where one helps, a worked example, gotchas, likely exam questions, a self-test and gaps in the notes
- a slideshow with quiz slides you can tap to reveal
- downloads: summary PDF, slides PDF (quiz answers on their own pages), or everything at once as a .zip (both PDFs, a Markdown copy of the summary and the raw kit as JSON)

Terms the lecturer stressed are highlighted. Anything Claude added that wasn't in your materials is marked "(added)" so you can check it.

## Put it on GitHub Pages

1. Create a new repository on GitHub and upload everything in this folder, keeping the folder structure (including the hidden `.nojekyll` file).
2. In the repository go to **Settings → Pages**. Under "Build and deployment" choose **Deploy from a branch**, pick `main` and `/ (root)`, then save.
3. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.
4. Tick **Enforce HTTPS** on the same settings page if it isn't already on.

There is no build step. It's plain HTML, CSS and JavaScript.

## Using it

You need a Claude API key from the [Anthropic Console](https://console.anthropic.com/settings/keys). Paste it into the "Add your Claude API key" panel. API usage is billed to that key, separately from any Claude.ai subscription.

Before you use it, set a monthly spend limit on the key in the Console. Each kit is one request: Sonnet is the default, Haiku is cheaper, Opus is the most thorough.

## Security and privacy

- **No API key is stored in this repository, and none should ever be.** Each visitor types in their own key. A stranger who finds your site can't spend your money unless they have your key.
- The key goes only from your browser to `api.anthropic.com`. By default it's kept in memory and forgotten when you close the tab. If you tick "Remember the key on this device", it's saved in that browser's local storage, so only do that on your own device. "Forget key" removes it.
- Your lecture files are read inside your browser. Only the extracted text and images are sent to Anthropic. Nothing goes to any other server, and there are no analytics.
- Photos are re-encoded before sending, which strips metadata such as GPS location.
- The last six kits are saved in your browser's local storage so you can reopen them. Clearing site data removes them.
- A Content Security Policy in `index.html` only allows scripts from this site and network requests to this site and `api.anthropic.com`.
- Everything Claude returns is inserted into the page as plain text, never as HTML, so a malicious lecture file can't inject code into the page.
- All libraries and fonts are copied into `vendor/` at pinned versions rather than loaded from a CDN. `vendor/VERSIONS.md` lists versions and SHA-256 checksums. `scripts/update-vendor.sh` re-downloads them from npm.
- PDF.js runs with `isEvalSupported: false`, and PDF scripting and XFA forms are turned off.

**If a key leaks**, delete it in the Anthropic Console straight away and make a new one.

### Known limits

- GitHub Pages can't send custom HTTP headers. The security policy is therefore set with a `<meta>` tag, and that can't stop other sites from embedding the page in a frame. This isn't a risk to your key, because a framing site can't read what's typed into the page.
- `npm audit` reports a moderate issue in `mammoth`'s command-line dependencies (`argparse` → `sprintf-js`). Those packages aren't included in the browser build in `vendor/`, so they don't affect this site.

## Supported files

| Type | Notes |
|---|---|
| PDF | Text is extracted. Scanned PDFs are sent as page images, up to 20 images per kit. |
| PowerPoint .pptx | Slide text and speaker notes |
| Word .docx | Text |
| .txt, .md, .csv | Text |
| Photos (.jpg, .png, .webp, .gif) | Sent as images, up to 20 per kit |

Older .ppt and .doc files need to be saved as .pptx, .docx or PDF first.

## Files

```
index.html          page markup and security policy
style.css           styles
app.js              all the app logic
favicon.svg
vendor/             pinned third-party libraries, fonts and their licences
scripts/            helper to refresh vendor/
```

## Licences

Third-party licences are in `vendor/licenses/` and `vendor/pdfjs/wasm/`. PDF.js is Apache-2.0, JSZip is MIT/GPLv3 dual-licensed, mammoth is BSD-2-Clause, jsPDF is MIT, and the fonts are SIL Open Font License.
