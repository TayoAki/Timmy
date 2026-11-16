/**
 * The three small files a visitor's browser loads: the loader a business pastes into its website, and the
 * script and stylesheet of the chat's own frame. They are plain text files next to this one (in `embed/`),
 * served as they are. The build copies them beside the bundled server (see build.mjs).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';

export type EmbedFile = 'loader.js' | 'frame.js' | 'frame.css';

function embedDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Beside this file when run from source; beside the bundle when built.
  const found = [process.env.CHAT_EMBED_DIR, resolve(here, 'embed'), resolve(here, 'chat-embed')].find((d) => d && existsSync(join(d, 'loader.js')));
  if (!found) throw new Error('the website chat’s files were not found');
  return found;
}

const cache = new Map<EmbedFile, string>();

export function embedFile(name: EmbedFile): string {
  // On a developer's machine the files are read each time, so an edit shows on reload.
  if (config.stage === 'development') return readFileSync(join(embedDir(), name), 'utf8');
  if (!cache.has(name)) cache.set(name, readFileSync(join(embedDir(), name), 'utf8'));
  return cache.get(name)!;
}

/** The frame's page. It carries no data and no inline script: the script reads the site key from the address. */
export const FRAME_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Chat</title>
<link rel="stylesheet" href="/chat/frame.css">
</head>
<body>
<div id="chat"></div>
<script src="/chat/frame.js"></script>
</body>
</html>
`;

/** What a frame gets when its site key is unknown or its chat is off. No page may show it. */
export const NO_FRAME_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Chat</title></head><body></body></html>
`;
