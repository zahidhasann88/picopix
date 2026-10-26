/**
 * Vanilla Vite demo for `picopix`.
 *
 * Drop an image -> it is decoded, oriented, resized, converted and compressed to
 * a byte budget, with all pixel work offloaded to a Web Worker. The before/after
 * sizes, dimensions and elapsed time are printed, and the result can be
 * downloaded.
 *
 * This is app code: it uses only the library's public API.
 */
import {
  canEncode,
  createImageWorker,
  compressImage,
  getImageInfo,
  stripMetadata,
} from 'picopix';

const els = {
  dropzone: document.getElementById('dropzone'),
  file: document.getElementById('file'),
  status: document.getElementById('status'),
  result: document.getElementById('result'),
  original: document.getElementById('original'),
  processed: document.getElementById('processed'),
  originalMeta: document.getElementById('originalMeta'),
  processedMeta: document.getElementById('processedMeta'),
  download: document.getElementById('download'),
  maxEdge: document.getElementById('maxEdge'),
  format: document.getElementById('format'),
  maxSizeKB: document.getElementById('maxSizeKB'),
  strip: document.getElementById('strip'),
};

// One worker for the whole page; pixel work stays off the main thread.
const worker = createImageWorker();

/** Recreated whenever a new image is processed, so the previous run can cancel. */
let controller = null;
const objectUrls = [];

function setStatus(message, kind = '') {
  els.status.textContent = message;
  els.status.className = `status ${kind}`.trim();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function trackUrl(url) {
  objectUrls.push(url);
  return url;
}

function releaseUrls() {
  while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop());
}

/** Maps the selected format to the canvas MIME type the library expects. */
function mimeFor(format) {
  return `image/${format === 'jpeg' ? 'jpeg' : format}`;
}

async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('Please choose an image file.', 'error');
    return;
  }

  controller?.abort();
  controller = new AbortController();
  releaseUrls();
  els.result.hidden = true;

  const maxEdge = Number(els.maxEdge.value) || 800;
  const format = els.format.value;
  const maxSizeKB = Number(els.maxSizeKB.value) || undefined;
  const mime = mimeFor(format);
  const started = performance.now();

  try {
    // 1. Metadata only — cheap, no pixels decoded.
    const info = await getImageInfo(file);
    setStatus(`Read ${info.format.toUpperCase()} ${info.width}x${info.height} (orientation ${info.orientation})...`);

    // 2. Decode + orient + resize + convert, in the worker.
    const raw = await worker.decode(file, { signal: controller.signal });
    const resized = await worker.process(
      raw,
      [
        { op: 'orient', orientation: info.orientation },
        { op: 'resize', width: maxEdge, height: maxEdge, fit: 'inside', kernel: 'lanczos3' },
      ],
      {
        signal: controller.signal,
        onProgress: ({ phase, ratio }) => {
          if (ratio !== undefined) setStatus(`${phase} ${Math.round(ratio * 100)}%...`);
        },
      },
    );

    // 3. Encode (off the main thread) and, if requested, hit the size budget.
    let blob;
    if (maxSizeKB && mime !== 'image/png') {
      // compressImage does its own binary search and downscaling.
      blob = await compressImage(file, {
        maxSizeKB,
        maxWidthOrHeight: maxEdge,
        format,
        signal: controller.signal,
      });
    } else {
      blob = await worker.encode(resized, { type: mime, quality: 0.85 }, { signal: controller.signal });
    }

    // 4. Optional lossless metadata strip on the encoded bytes.
    if (els.strip.checked) blob = await stripMetadata(blob);

    const outInfo = await getImageInfo(blob);
    const elapsed = Math.round(performance.now() - started);
    const ratio = ((1 - blob.size / file.size) * 100).toFixed(1);

    els.original.src = trackUrl(URL.createObjectURL(file));
    els.processed.src = trackUrl(URL.createObjectURL(blob));
    els.originalMeta.textContent = `${info.displayWidth}x${info.displayHeight} · ${formatBytes(file.size)}`;
    els.processedMeta.textContent = `${outInfo.width}x${outInfo.height} · ${formatBytes(blob.size)}`;
    els.download.href = els.processed.src;
    els.download.download = `processed.${format}`;
    els.result.hidden = false;

    setStatus(
      `Done in ${elapsed} ms (worker: ${worker.mode}) — ${format.toUpperCase()} at ${formatBytes(blob.size)}, ` +
        `${ratio}% smaller than the original.`,
      'done',
    );
  } catch (error) {
    if (error?.code === 'ABORTED') {
      setStatus('Cancelled (a new file was chosen).');
      return;
    }
    console.error(error);
    setStatus(`${error?.code ?? 'ERROR'}: ${error?.message ?? error}`, 'error');
  }
}

// --- wiring ----------------------------------------------------------------
els.dropzone.addEventListener('click', () => els.file.click());
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') els.file.click();
});
els.file.addEventListener('change', () => handleFile(els.file.files?.[0]));

for (const type of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove('dragging');
  });
}
els.dropzone.addEventListener('drop', (event) => handleFile(event.dataTransfer?.files?.[0]));

window.addEventListener('beforeunload', () => {
  controller?.abort();
  worker.dispose();
  releaseUrls();
});

// Report the environment once so the demo doubles as a capability check.
Promise.all([canEncode('webp'), canEncode('avif'), canEncode('jpeg')]).then(([webp, avif, jpeg]) => {
  if (!jpeg) {
    setStatus('This browser cannot encode images; the demo needs canvas support.', 'error');
    return;
  }
  const formats = [jpeg && 'JPEG', webp && 'WebP', avif && 'AVIF'].filter(Boolean).join(', ');
  setStatus(`Ready — encoders available: ${formats}. Drop an image to start.`);
});
