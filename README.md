# Translateer

An unlimited free Google Translate API backed by a real browser session.

> This service is provided to the public for **educational purposes only**.

## Demo and Usage

Try it out:

```bash
curl 'https://t.song.work/api?text=hello&from=en&to=zh-CN'
```

To include pronunciation audio as data URLs for the source text, translated
text, and dictionary headword when available:

```bash
curl 'https://t.song.work/api?text=chien&from=fr&to=en&audio=true'
```

Visit <https://t.song.work/> to see more usage.

This free demo is best-effort and does not collect any data.

## How It Works

Translateer keeps one long-lived Google Translate page alive and executes
browser-originated RPC requests from inside that page. Runtime requests do not
scrape the UI; they reuse the page's live cookies and request context to fetch:

- translations
- rich details such as examples, definitions, and translation groups
- pronunciation audio
- typo correction and autocomplete suggestions

## Self-Hosted

### Option 1: Serve with Docker (Recommended)

1. Clone the repository

   ```bash
   git clone https://github.com/songkeys/translateer.git
   ```

2. Build and run Dockerfile

   ```bash
   docker build -t translateer .
   docker run -d -p 8999:8999 translateer
   ```

### Option 2: Serve Locally

1. Clone the repository

   ```bash
   git clone https://github.com/songkeys/translateer.git
   ```

2. Run the server

   ```bash
   deno task start
   ```

### Environment Variables

See the markdown table below:

| Variable | Description       | Default |
| -------- | ----------------- | ------- |
| `PORT`   | Port to listen on | `8999`  |

## Audio Response

When `audio=true`, the API may return an `audio` object with:

- `source`: a `data:audio/mpeg;base64,...` URL for the source speaker button
- `translation`: a `data:audio/mpeg;base64,...` URL for the translated speaker
  button
- `dictionary`: a `data:audio/mpeg;base64,...` URL for the dictionary headword
  speaker button when Google exposes one

Audio fields are omitted when Google does not expose a matching speaker button
or audio payload for the current text.

## Raycast Extension

An easy-to-use [Raycast](https://www.raycast.com) extension is provided. Check
[songkeys/raycast-extension#Translateer](https://github.com/songkeys/raycast-extension#translateer)
for more details.

![raycast-extension-preview](https://user-images.githubusercontent.com/22665058/142718320-871b0c71-7e30-422a-889d-51d0bc6dcf88.png)
